#!/usr/bin/env python3
"""deploy-tables.py - create Dataverse schema from a JSON manifest, idempotently, and prove it landed.

One command does the whole schema deployment through the Web API:

    publisher -> solution -> tables -> columns -> choice options -> lookups -> publish
    -> shared tables turned into references -> read back every table, column, option and lookup

Usage:
    python deploy-tables.py --manifest tables.json --org https://<org>.crm.dynamics.com --plan
    python deploy-tables.py --manifest tables.json --org https://<org>.crm.dynamics.com

Options:
    --manifest PATH     the schema manifest (see assets/tables.example.json)
    --org URL           environment URL
    --token-cmd CMD     command that prints an access token; "{org}" is replaced by the org URL
    --token-env NAME    environment variable holding a token (default: DATAVERSE_TOKEN)
    --plan              read-only: print every change it would make and write nothing
    --selftest          run the built-in tests against a simulated Web API and exit

Token, in order: --token-env variable, --token-cmd, `az account get-access-token --resource
<org>`, then Az PowerShell `Get-AzAccessToken`. The token is never printed or written. The
signed-in account needs System Customizer or System Administrator in the environment.

What it will and will not do:
  - Creates what is missing and skips what exists, so a re-run is a no-op and a run that stopped
    part-way is finished by running it again.
  - Never renames, retypes or deletes anything. A column that exists with another type is a
    CONFLICT: the run refuses to write anything until the manifest is changed (Dataverse cannot
    change an attribute's type; the remedy is a new column).
  - Choice options are append-only. Option N of a choice gets the value
    optionValuePrefix x 10000 + N, so options are added only at the END of the manifest list and
    never reordered or removed there. A live label that differs from the manifest is reported and
    left alone.
  - Lookup schema names must be all lower case. The lookup's navigation property takes the
    SchemaName's casing; lower case makes it equal the logical name, so `x@odata.bind`, `$expand`
    and a canvas app's cached navigation name can never disagree on case.
  - A lookup created with the solution header pulls a table owned by ANOTHER solution into this
    solution with its whole schema (rootcomponentbehavior 0); an import would then write that
    copy over the owner's table. After the lookups, every shared table in the solution is removed
    and added back as a reference (DoNotIncludeSubcomponents, behavior 1). Shared tables are the
    manifest's "sharedTables" patterns plus every lookup target that does not carry the prefix.
  - Security roles are deliberately not created here (references/security-and-access.md).

Exit: 0 applied (or planned) and read back complete; 1 a conflict, a blocked lookup, or something
missing on read-back; 2 a manifest error (refused before any call), no token, or the Web API failed
part-way (re-run: every step is idempotent). 2 is never a pass.
"""
import argparse
import fnmatch
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

API = "/api/data/v9.2/"
SLEEP = time.sleep          # the selftest replaces this so retries and settles cost nothing

# manifest type -> AttributeTypeName the platform reports for it
TYPES = {"string": "StringType", "autonumber": "StringType", "memotext": "MemoType",
         "integer": "IntegerType", "decimal": "DecimalType", "money": "MoneyType",
         "boolean": "BooleanType", "datetime": "DateTimeType", "datetimefull": "DateTimeType",
         "choice": "PicklistType", "lookup": "LookupType", "file": "FileType"}
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
PREFIX_RE = re.compile(r"^[a-z][a-z0-9]{1,7}$")


class ManifestError(Exception):
    pass


class ApiError(Exception):
    pass


class NotFound(ApiError):
    pass


# --------------------------------------------------------------------------- manifest

def load_manifest(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except OSError as e:
        raise ManifestError(["cannot read %s: %s" % (path, e)])
    except ValueError as e:
        raise ManifestError(["%s is not valid JSON: %s" % (path, e)])


def validate(m):
    """Every manifest problem at once, before any call. Raises ManifestError(list)."""
    errs = []
    if not isinstance(m, dict):
        raise ManifestError(["the manifest must be a JSON object"])
    sol = m.get("solution")
    if not isinstance(sol, str) or not NAME_RE.match(sol):
        errs.append("solution: a unique name of letters, digits and underscores is required")
    pub = m.get("publisher")
    prefix = None
    if not isinstance(pub, dict):
        errs.append("publisher: an object with uniqueName, friendlyName, prefix, optionValuePrefix is required")
        pub = {}
    else:
        if not isinstance(pub.get("uniqueName"), str) or not NAME_RE.match(pub.get("uniqueName") or ""):
            errs.append("publisher.uniqueName: letters, digits and underscores")
        if not isinstance(pub.get("friendlyName"), str) or not pub.get("friendlyName", "").strip():
            errs.append("publisher.friendlyName is required")
        prefix = pub.get("prefix")
        if not isinstance(prefix, str) or not PREFIX_RE.match(prefix) or prefix.startswith("mscrm"):
            errs.append("publisher.prefix: 2-8 lower-case letters or digits, starting with a letter, not 'mscrm'")
            prefix = None
        ovp = pub.get("optionValuePrefix")
        if not isinstance(ovp, int) or isinstance(ovp, bool) or not 10000 <= ovp <= 99999:
            errs.append("publisher.optionValuePrefix: an integer from 10000 to 99999 (option values are it x 10000 + n)")
    tables = m.get("tables")
    if not isinstance(tables, list) or not tables:
        errs.append("tables: a non-empty list is required")
        tables = []
    want = (prefix + "_") if prefix else None

    def named(where, obj, key="schemaName"):
        n = obj.get(key) if isinstance(obj, dict) else None
        if not isinstance(n, str) or not NAME_RE.match(n):
            errs.append("%s: %s must be letters, digits and underscores" % (where, key))
            return None
        if want and not n.lower().startswith(want):
            errs.append("%s: %s '%s' does not carry the publisher prefix '%s'" % (where, key, n, want))
        return n

    seen_tables, rel_names = {}, {}
    own = set()
    for i, t in enumerate(tables):
        where = "tables[%d]" % i
        if not isinstance(t, dict):
            errs.append("%s: must be an object" % where)
            continue
        tn = named(where, t)
        if tn:
            where = tn
            if tn.lower() in seen_tables:
                errs.append("%s: duplicate table (also tables[%d])" % (tn, seen_tables[tn.lower()]))
            seen_tables[tn.lower()] = i
            own.add(tn.lower())
        for k in ("displayName", "displayCollectionName"):
            if not isinstance(t.get(k), str) or not t.get(k).strip():
                errs.append("%s: %s is required" % (where, k))
        if t.get("ownership", "organization") not in ("organization", "user"):
            errs.append("%s: ownership must be 'organization' or 'user'" % where)
        pn = t.get("primaryName")
        cols_seen = {}
        if not isinstance(pn, dict):
            errs.append("%s: primaryName {schemaName, displayName} is required" % where)
        else:
            p = named(where + ".primaryName", pn)
            if p:
                cols_seen[p.lower()] = "primaryName"
            if not isinstance(pn.get("displayName"), str) or not pn["displayName"].strip():
                errs.append("%s.primaryName: displayName is required" % where)
            _check_len(errs, where + ".primaryName", pn.get("maxLength"), 1, 4000)
        cols = t.get("columns", [])
        if not isinstance(cols, list):
            errs.append("%s: columns must be a list" % where)
            cols = []
        for j, c in enumerate(cols):
            cw = "%s.columns[%d]" % (where, j)
            if not isinstance(c, dict):
                errs.append("%s: must be an object" % cw)
                continue
            cn = named(cw, c)
            if cn:
                cw = "%s.%s" % (where, cn)
                if cn.lower() in cols_seen:
                    errs.append("%s: duplicate column name (also %s)" % (cw, cols_seen[cn.lower()]))
                cols_seen[cn.lower()] = "columns[%d]" % j
            if not isinstance(c.get("displayName"), str) or not c["displayName"].strip():
                errs.append("%s: displayName is required" % cw)
            ty = c.get("type")
            if ty not in TYPES:
                errs.append("%s: unknown type %r (known: %s)" % (cw, ty, ", ".join(sorted(TYPES))))
                continue
            if ty == "string":
                _check_len(errs, cw, c.get("maxLength"), 1, 4000)
            elif ty == "memotext":
                _check_len(errs, cw, c.get("maxLength"), 1, 1048576)
            elif ty == "file":
                _check_len(errs, cw, c.get("maxSizeInKB"), 1, 10485760, key="maxSizeInKB")
            elif ty == "autonumber":
                if not isinstance(c.get("format"), str) or "{SEQNUM:" not in c["format"]:
                    errs.append("%s: autonumber needs a format containing {SEQNUM:n}, e.g. \"REQ-{SEQNUM:5}\"" % cw)
            elif ty == "choice":
                opts = c.get("options")
                if not isinstance(opts, list) or not opts or not all(isinstance(o, str) and o.strip() for o in opts):
                    errs.append("%s: choice needs a non-empty list of option labels" % cw)
                elif len({o.strip().lower() for o in opts}) != len(opts):
                    errs.append("%s: duplicate option labels" % cw)
            elif ty == "lookup":
                tg = c.get("target")
                if not isinstance(tg, str) or not re.match(r"^[a-z][a-z0-9_]*$", tg):
                    errs.append("%s: lookup target must be the target table's logical name (lower case)" % cw)
                if cn and cn != cn.lower():
                    errs.append("%s: lookup schemaName must be all lower case ('%s'); the navigation property "
                                "takes the schema name's casing" % (cw, cn.lower()))
                if cn and tn and prefix:
                    rel = relationship_name(prefix, tn, cn)
                    if rel in rel_names:
                        errs.append("%s: relationship name %s collides with %s" % (cw, rel, rel_names[rel]))
                    rel_names[rel] = cw
        # Names the platform reserves beside the manifest's own: <table>id, and the virtual
        # <column>name companion of every lookup, choice and yes/no column. Display names must be
        # unique too, or the app binds the wrong column by its label.
        named_cols = [c for c in cols if isinstance(c, dict) and isinstance(c.get("schemaName"), str)]
        logicals = {c["schemaName"].lower() for c in named_cols}
        if tn and tn.lower() + "id" in logicals:
            errs.append("%s: column %sid collides with the table's reserved id column" % (where, tn.lower()))
        for c in named_cols:
            if c.get("type") in ("lookup", "choice", "boolean") and c["schemaName"].lower() + "name" in logicals:
                errs.append("%s: column %sname collides with the virtual name column Dataverse creates for %s"
                            % (where, c["schemaName"].lower(), c["schemaName"].lower()))
        labels = [x.get("displayName", "").strip().lower() for x in [pn] + named_cols
                  if isinstance(x, dict) and isinstance(x.get("displayName"), str)]
        for d in sorted({d for d in labels if d and labels.count(d) > 1}):
            errs.append("%s: display name '%s' is used by more than one column" % (where, d))
    shared = m.get("sharedTables", [])
    if not isinstance(shared, list) or not all(isinstance(s, str) and s for s in shared):
        errs.append("sharedTables: a list of table logical names or patterns such as \"core_*\"")
    else:
        for s in shared:
            hit = sorted(t for t in own if fnmatch.fnmatchcase(t, s.lower()))
            if hit:
                errs.append("sharedTables: '%s' matches the manifest's own table(s) %s - a table this "
                            "manifest creates is never a reference" % (s, ", ".join(hit)))
    if errs:
        raise ManifestError(errs)


def _check_len(errs, where, v, lo, hi, key="maxLength"):
    if v is None:
        return
    if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
        errs.append("%s: %s must be an integer from %d to %d" % (where, key, lo, hi))


def relationship_name(prefix, table, col):
    """<prefix>_<table without prefix>_<column without prefix>, all lower case."""
    p = prefix + "_"
    t, c = table.lower(), col.lower()
    return "%s_%s_%s" % (prefix, t[len(p):] if t.startswith(p) else t, c[len(p):] if c.startswith(p) else c)


def shared_patterns(m):
    """Patterns for tables this solution must carry only as references."""
    prefix = m["publisher"]["prefix"] + "_"
    own = {t["schemaName"].lower() for t in m["tables"]}
    pats = [s.lower() for s in m.get("sharedTables", [])]
    for t in m["tables"]:
        for c in t.get("columns", []):
            tg = c.get("target") if c.get("type") == "lookup" else None
            if tg and tg not in own and not tg.startswith(prefix) and tg not in pats:
                pats.append(tg)
    return pats, own


# --------------------------------------------------------------------------- metadata bodies

def label(text, lcid):
    return {"@odata.type": "Microsoft.Dynamics.CRM.Label",
            "LocalizedLabels": [{"@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
                                 "Label": text, "LanguageCode": lcid}]}


def label_of(obj):
    if not isinstance(obj, dict):
        return None
    ul = obj.get("UserLocalizedLabel")
    if isinstance(ul, dict) and ul.get("Label") is not None:
        return ul["Label"]
    for loc in obj.get("LocalizedLabels") or []:
        if isinstance(loc, dict) and loc.get("Label") is not None:
            return loc["Label"]
    return None


def option_base(m):
    return m["publisher"]["optionValuePrefix"] * 10000


def attribute_body(c, base, lcid):
    """The typed metadata body for one non-lookup column. @odata.type first (key order matters)."""
    ty, sn, dn = c["type"], c["schemaName"], label(c["displayName"], lcid)
    req = {"Value": "None"}

    def body(odata, **kw):
        b = {"@odata.type": "Microsoft.Dynamics.CRM." + odata, "SchemaName": sn, "DisplayName": dn,
             "RequiredLevel": req}
        if c.get("description"):
            b["Description"] = label(c["description"], lcid)
        b.update(kw)
        return b

    if ty == "string":
        return body("StringAttributeMetadata", MaxLength=c.get("maxLength") or 200, FormatName={"Value": "Text"})
    if ty == "autonumber":
        return body("StringAttributeMetadata", MaxLength=c.get("maxLength") or 100, FormatName={"Value": "Text"},
                    AutoNumberFormat=c["format"])
    if ty == "memotext":
        return body("MemoAttributeMetadata", MaxLength=c.get("maxLength") or 100000, Format="TextArea")
    if ty == "integer":
        return body("IntegerAttributeMetadata", Format="None", MinValue=-2147483648, MaxValue=2147483647)
    if ty == "decimal":
        return body("DecimalAttributeMetadata", Precision=2, MinValue=-100000000000, MaxValue=100000000000)
    if ty == "money":
        return body("MoneyAttributeMetadata", Precision=2, PrecisionSource=2,
                    MinValue=-922337203685477, MaxValue=922337203685477)
    if ty == "boolean":
        return body("BooleanAttributeMetadata", OptionSet={
            "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
            "TrueOption": {"Value": 1, "Label": label("Yes", lcid)},
            "FalseOption": {"Value": 0, "Label": label("No", lcid)}})
    if ty == "datetime":
        return body("DateTimeAttributeMetadata", Format="DateOnly", DateTimeBehavior={"Value": "DateOnly"})
    if ty == "datetimefull":
        return body("DateTimeAttributeMetadata", Format="DateAndTime", DateTimeBehavior={"Value": "UserLocal"})
    if ty == "file":
        return body("FileAttributeMetadata", MaxSizeInKB=c.get("maxSizeInKB") or 32768)
    if ty == "choice":
        return body("PicklistAttributeMetadata", OptionSet={
            "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata", "IsGlobal": False,
            "OptionSetType": "Picklist",
            "Options": [{"Value": base + i, "Label": label(o, lcid)} for i, o in enumerate(c["options"])]})
    raise ManifestError(["no body for type %s" % ty])


def table_body(t, lcid):
    pn = t["primaryName"]
    primary = {"@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata", "SchemaName": pn["schemaName"],
               "DisplayName": label(pn["displayName"], lcid), "RequiredLevel": {"Value": "ApplicationRequired"},
               "MaxLength": pn.get("maxLength") or 200, "FormatName": {"Value": "Text"}, "IsPrimaryName": True}
    b = {"@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata", "SchemaName": t["schemaName"],
         "DisplayName": label(t["displayName"], lcid),
         "DisplayCollectionName": label(t["displayCollectionName"], lcid),
         "OwnershipType": "UserOwned" if t.get("ownership") == "user" else "OrganizationOwned",
         "IsActivity": False, "HasActivities": False, "HasNotes": bool(t.get("hasNotes")),
         "Attributes": [primary]}
    if t.get("description"):
        b["Description"] = label(t["description"], lcid)
    return b


def relationship_body(m, t, c, lcid):
    return {"@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
            "SchemaName": relationship_name(m["publisher"]["prefix"], t["schemaName"], c["schemaName"]),
            "ReferencedEntity": c["target"], "ReferencingEntity": t["schemaName"].lower(),
            "Lookup": {"@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
                       "SchemaName": c["schemaName"], "DisplayName": label(c["displayName"], lcid),
                       "RequiredLevel": {"Value": "None"}},
            "CascadeConfiguration": {"Assign": "NoCascade", "Delete": "RemoveLink", "Merge": "NoCascade",
                                     "Reparent": "NoCascade", "Share": "NoCascade", "Unshare": "NoCascade"}}


# --------------------------------------------------------------------------- Web API

def _run_capture(cmd, shell=False, timeout=120):
    r = subprocess.run(cmd, capture_output=True, shell=shell, timeout=timeout)
    return r.returncode, r.stdout.decode("utf-8", "replace").strip(), r.stderr.decode("utf-8", "replace").strip()


def get_token(org, token_cmd=None, token_env="DATAVERSE_TOKEN"):
    """(token, how it was obtained). Raises ApiError. Never prints the token."""
    if token_env and os.environ.get(token_env):
        return os.environ[token_env].strip(), "environment variable %s" % token_env
    tried = []
    if token_cmd:
        rc, out, err = _run_capture(token_cmd.replace("{org}", org), shell=True)
        if rc == 0 and out:
            return out.splitlines()[-1].strip(), "--token-cmd"
        raise ApiError("--token-cmd failed (exit %d): %s" % (rc, err[-300:]))
    az = shutil.which("az")
    if az:
        rc, out, err = _run_capture([az, "account", "get-access-token", "--resource", org,
                                     "--query", "accessToken", "-o", "tsv"])
        if rc == 0 and out:
            return out.splitlines()[-1].strip(), "az account get-access-token"
        tried.append("az (exit %d: %s)" % (rc, err[-200:]))
    else:
        tried.append("az (not on PATH)")
    ps = shutil.which("pwsh") or shutil.which("powershell")
    if ps:
        script = ("$ErrorActionPreference='Stop'; $t=(Get-AzAccessToken -ResourceUrl '%s').Token; "
                  "if ($t -is [securestring]) { [System.Net.NetworkCredential]::new('', $t).Password } "
                  "else { $t }" % org)
        rc, out, err = _run_capture([ps, "-NoProfile", "-NonInteractive", "-Command", script])
        if rc == 0 and out:
            return out.splitlines()[-1].strip(), "Az PowerShell Get-AzAccessToken"
        tried.append("Az PowerShell (exit %d)" % rc)
    raise ApiError("no access token: tried %s. Sign in (az login / Connect-AzAccount) or pass "
                   "--token-cmd / set %s" % ("; ".join(tried), token_env))


def odata_literal(value):
    """A string literal for $filter: apostrophes doubled; the URL encoding happens on send."""
    return "'%s'" % value.replace("'", "''")


class WebApi:
    """Dataverse Web API client. With read_only=True it refuses anything but GET, structurally."""

    METADATA_POSTS = ("EntityDefinitions", "RelationshipDefinitions", "InsertOptionValue")

    def __init__(self, org, token, read_only, timeout=120):
        self.base = org.rstrip("/") + API
        self.token = token
        self.read_only = read_only
        self.timeout = timeout
        self.opener = urllib.request.build_opener()
        self.calls = []                     # (method, path), for the summary and the selftest

    def get(self, path):
        merged, url = None, path
        while url:
            body = self.call("GET", url)
            if merged is None:
                merged = body
            else:
                merged.setdefault("value", []).extend(body.get("value") or [])
            url = body.get("@odata.nextLink") if isinstance(body, dict) else None
        if isinstance(merged, dict):
            merged.pop("@odata.nextLink", None)
        return merged

    def post(self, path, body, solution=None):
        return self.call("POST", path, body, solution)

    def call(self, method, path, body=None, solution=None):
        if self.read_only and method != "GET":
            raise RuntimeError("plan mode refused a %s to %s - a plan never writes" % (method, path))
        url = path if path.startswith("http") else self.base + path
        url = urllib.parse.quote(url, safe=":/?&=$,()'@.%-_~*")
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json",
                   "OData-MaxVersion": "4.0", "OData-Version": "4.0"}
        data = None
        if method != "GET":
            headers["Content-Type"] = "application/json; charset=utf-8"
            data = json.dumps(body if body is not None else {}).encode("utf-8")
        if solution:
            headers["MSCRM.SolutionUniqueName"] = solution
        short = path.replace(self.base, "")
        metadata_post = method == "POST" and short.startswith(self.METADATA_POSTS)
        last = None
        for attempt in range(1, 5):
            self.calls.append((method, short))
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with self.opener.open(req, timeout=self.timeout) as r:
                    raw = r.read().decode("utf-8", "replace")
                    return json.loads(raw) if raw.strip() else {}
            except urllib.error.HTTPError as e:
                text = e.read().decode("utf-8", "replace")
                detail = text
                try:
                    detail = (json.loads(text).get("error") or {}).get("message") or text
                except ValueError:
                    pass
                if e.code == 404 and method == "GET":
                    raise NotFound(short)
                if e.code in (401, 403):
                    raise ApiError("HTTP %d on %s %s - the token is not valid for this org, or the account "
                                   "lacks System Customizer: %s" % (e.code, method, short, detail[:300]))
                # Retry throttling and gateway errors, and on a metadata create the two
                # eventual-consistency signatures: a spurious 400 straight after a table create,
                # and 0x80040216. Everything else is rethrown with the server's message.
                transient = e.code in (429, 502, 503, 504) or (
                    metadata_post and (e.code == 400 or "0x80040216" in text))
                last = "HTTP %d - %s" % (e.code, detail[:500])
                if transient and attempt < 4:
                    SLEEP(float(e.headers.get("Retry-After") or 3 * attempt))
                    continue
                raise ApiError("%s %s failed: %s" % (method, short, last))
            except (urllib.error.URLError, OSError) as e:
                last = str(e)
                if attempt < 4:
                    SLEEP(2 ** attempt)
                    continue
        raise ApiError("%s %s gave up after retries: %s" % (method, short, last))


# --------------------------------------------------------------------------- live state

def type_name(a):
    tn = a.get("AttributeTypeName")
    if isinstance(tn, dict) and tn.get("Value"):
        return tn["Value"]
    return (a.get("AttributeType") or "") + "Type"


def fetch_table(api, logical, choices=False, lookups=False):
    """None if the table does not exist; otherwise its columns, choice options and lookup targets."""
    try:
        em = api.get("EntityDefinitions(LogicalName='%s')?$select=LogicalName,MetadataId"
                     "&$expand=Attributes($select=LogicalName,AttributeType,AttributeTypeName)" % logical)
    except NotFound:
        return None
    st = {"id": em.get("MetadataId"),
          "attrs": {a["LogicalName"]: type_name(a) for a in em.get("Attributes") or [] if a.get("LogicalName")},
          "options": {}, "targets": {}}
    if choices:
        r = api.get("EntityDefinitions(LogicalName='%s')/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata"
                    "?$select=LogicalName&$expand=OptionSet($select=Options)" % logical)
        for a in r.get("value") or []:
            st["options"][a["LogicalName"]] = {int(o["Value"]): label_of(o.get("Label"))
                                               for o in (a.get("OptionSet") or {}).get("Options") or []}
    if lookups:
        r = api.get("EntityDefinitions(LogicalName='%s')/Attributes/Microsoft.Dynamics.CRM.LookupAttributeMetadata"
                    "?$select=LogicalName,Targets" % logical)
        for a in r.get("value") or []:
            st["targets"][a["LogicalName"]] = [x.lower() for x in a.get("Targets") or []]
    return st


def fetch_publisher(api, unique):
    r = api.get("publishers?$select=publisherid,uniquename,customizationprefix,customizationoptionvalueprefix"
                "&$filter=uniquename eq %s" % odata_literal(unique))
    v = r.get("value") or []
    return v[0] if v else None


def fetch_solution(api, unique):
    r = api.get("solutions?$select=solutionid,uniquename&$expand=publisherid($select=uniquename,customizationprefix)"
                "&$filter=uniquename eq %s" % odata_literal(unique))
    v = r.get("value") or []
    return v[0] if v else None


def table_components(api, solution_id):
    """[(logical name, MetadataId, rootcomponentbehavior)] for every table in the solution."""
    comps = api.get("solutioncomponents?$select=objectid,rootcomponentbehavior"
                    "&$filter=_solutionid_value eq %s and componenttype eq 1" % solution_id).get("value") or []
    ents = api.get("EntityDefinitions?$select=LogicalName,MetadataId").get("value") or []
    by_id = {str(e.get("MetadataId")).lower(): e.get("LogicalName") for e in ents}
    out = []
    for c in comps:
        oid = str(c.get("objectid")).lower()
        out.append((by_id.get(oid), c.get("objectid"), c.get("rootcomponentbehavior")))
    return out


def is_shared(logical, pats):
    return bool(logical) and any(fnmatch.fnmatchcase(logical, p) for p in pats)


# --------------------------------------------------------------------------- plan

class Plan:
    def __init__(self):
        self.actions = []        # (text, fn)
        self.conflicts = []      # refuse to write
        self.warnings = []       # reported, nothing changed
        self.present = 0

    def add(self, text, fn):
        self.actions.append((text, fn))


def build_plan(api, m, ctx):
    """Compare the manifest with live metadata (GET only) and list every change."""
    p = Plan()
    pub, sol_name, lcid = m["publisher"], m["solution"], m.get("languageCode", 1033)
    base = option_base(m)
    live_pub = fetch_publisher(api, pub["uniqueName"])
    if live_pub:
        p.present += 1
        ctx["publisherid"] = live_pub.get("publisherid")
        if (live_pub.get("customizationprefix") or "").lower() != pub["prefix"] or \
                live_pub.get("customizationoptionvalueprefix") != pub["optionValuePrefix"]:
            p.conflicts.append("publisher %s exists with prefix '%s' and option value prefix %s; the manifest says "
                               "'%s' and %s. A publisher is never changed here - fix the manifest."
                               % (pub["uniqueName"], live_pub.get("customizationprefix"),
                                  live_pub.get("customizationoptionvalueprefix"), pub["prefix"],
                                  pub["optionValuePrefix"]))
    else:
        def mk_pub():
            api.post("publishers", {"uniquename": pub["uniqueName"], "friendlyname": pub["friendlyName"],
                                    "customizationprefix": pub["prefix"],
                                    "customizationoptionvalueprefix": pub["optionValuePrefix"]})
            got = fetch_publisher(api, pub["uniqueName"])
            if not got:
                raise ApiError("publisher %s was created but cannot be read back" % pub["uniqueName"])
            ctx["publisherid"] = got["publisherid"]
        p.add("+ publisher %s (prefix %s, option values from %d)" % (pub["uniqueName"], pub["prefix"], base), mk_pub)
    live_sol = fetch_solution(api, sol_name)
    if live_sol:
        p.present += 1
        ctx["solutionid"] = live_sol.get("solutionid")
        owner = live_sol.get("publisherid") or {}
        if owner.get("uniquename") and owner.get("uniquename") != pub["uniqueName"]:
            p.conflicts.append("solution %s belongs to publisher %s, not %s" % (sol_name, owner.get("uniquename"),
                                                                                 pub["uniqueName"]))
    else:
        def mk_sol():
            api.post("solutions", {"uniquename": sol_name, "friendlyname": m.get("solutionFriendlyName") or sol_name,
                                   "version": "1.0.0.0",
                                   "publisherid@odata.bind": "/publishers(%s)" % ctx["publisherid"]})
            got = fetch_solution(api, sol_name)
            ctx["solutionid"] = got and got.get("solutionid")
        p.add("+ solution %s" % sol_name, mk_sol)

    own = {t["schemaName"].lower() for t in m["tables"]}
    states = {}
    for t in m["tables"]:
        ln = t["schemaName"].lower()
        cols = t.get("columns", [])
        states[ln] = fetch_table(api, ln, choices=any(c["type"] == "choice" for c in cols),
                                 lookups=any(c["type"] == "lookup" for c in cols))
    target_exists = {}
    for t in m["tables"]:
        for c in t.get("columns", []):
            tg = c.get("target") if c["type"] == "lookup" else None
            if tg and tg not in own and tg not in target_exists:
                target_exists[tg] = fetch_table(api, tg) is not None

    # pass 1: tables and non-lookup columns
    for t in m["tables"]:
        ln, st = t["schemaName"].lower(), states[t["schemaName"].lower()]
        if st is None:
            def mk_table(t=t):
                api.post("EntityDefinitions", table_body(t, lcid), solution=sol_name)
                SLEEP(3)          # let the new table's metadata commit before its first column
            p.add("+ table %s (%s, primary name %s)" % (t["schemaName"], t.get("ownership", "organization"),
                                                       t["primaryName"]["schemaName"]), mk_table)
        else:
            p.present += 1
            pn = t["primaryName"]["schemaName"].lower()
            if pn not in st["attrs"]:
                p.conflicts.append("%s exists but has no column %s; the primary name is fixed at creation - "
                                   "match the live primary name in the manifest" % (ln, pn))
        for c in t.get("columns", []):
            if c["type"] == "lookup":
                continue
            cl = c["schemaName"].lower()
            have = st["attrs"].get(cl) if st else None
            if have is None:
                desc = c["type"]
                if c["type"] == "choice":
                    desc += ", %d options %d..%d" % (len(c["options"]), base, base + len(c["options"]) - 1)
                p.add("+ column %s.%s (%s)" % (ln, c["schemaName"], desc),
                      lambda ln=ln, c=c: api.post("EntityDefinitions(LogicalName='%s')/Attributes" % ln,
                                                  attribute_body(c, base, lcid), solution=sol_name))
                continue
            p.present += 1
            if have != TYPES[c["type"]]:
                p.conflicts.append("%s.%s exists as %s; the manifest says %s (%s). Dataverse cannot change a "
                                   "column's type - add a new column instead" % (ln, cl, have, c["type"],
                                                                                 TYPES[c["type"]]))
                continue
            if c["type"] == "choice":
                live = st["options"].get(cl, {})
                for i, lab in enumerate(c["options"]):
                    v = base + i
                    if v in live:
                        p.present += 1
                        if live[v] != lab:
                            p.warnings.append("%s.%s option %d is '%s' live and '%s' in the manifest - not changed "
                                              "(options are append-only)" % (ln, cl, v, live[v], lab))
                        continue
                    p.add("+ option %s.%s %d '%s'" % (ln, cl, v, lab),
                          lambda ln=ln, cl=cl, v=v, lab=lab: api.post("InsertOptionValue", {
                              "EntityLogicalName": ln, "AttributeLogicalName": cl, "Value": v,
                              "Label": label(lab, lcid), "SolutionUniqueName": sol_name}))
                extra = sorted(v for v in live if not base <= v < base + len(c["options"]))
                if extra:
                    p.warnings.append("%s.%s has live option value(s) %s that the manifest does not list - left "
                                      "alone" % (ln, cl, ", ".join(map(str, extra))))

    # pass 2: lookups, once every table exists
    for t in m["tables"]:
        ln, st = t["schemaName"].lower(), states[t["schemaName"].lower()]
        for c in t.get("columns", []):
            if c["type"] != "lookup":
                continue
            cl, tg = c["schemaName"].lower(), c["target"]
            have = st["attrs"].get(cl) if st else None
            if have is not None:
                p.present += 1
                if have != "LookupType":
                    p.conflicts.append("%s.%s exists as %s, not a lookup" % (ln, cl, have))
                elif tg not in st["targets"].get(cl, [tg]):
                    p.conflicts.append("%s.%s is a lookup to %s; the manifest says %s - a lookup's target is "
                                       "never changed" % (ln, cl, ", ".join(st["targets"][cl]), tg))
                continue
            if tg not in own and not target_exists.get(tg):
                p.conflicts.append("%s.%s: lookup target %s does not exist and this manifest does not create it - "
                                   "deploy its owner first" % (ln, cl, tg))
                continue
            rel = relationship_name(m["publisher"]["prefix"], t["schemaName"], c["schemaName"])
            p.add("+ lookup %s.%s -> %s (relationship %s)" % (ln, cl, tg, rel),
                  lambda t=t, c=c: api.post("RelationshipDefinitions", relationship_body(m, t, c, lcid),
                                            solution=sol_name))
    return p


# --------------------------------------------------------------------------- shared references

def shared_step(api, m, apply, out):
    """Turn every shared table carried with its schema into a reference. Returns (ok, lines)."""
    pats, own = shared_patterns(m)
    sol = fetch_solution(api, m["solution"])
    if not sol:
        out.append("  shared tables: the solution does not exist yet - lookups created by the apply will pull "
                   "%s in with their schema; the apply turns each into a reference" % (", ".join(pats) or "none"))
        return True, 0
    comps = table_components(api, sol["solutionid"])
    todo = [(n, oid, b) for n, oid, b in comps if n not in own and is_shared(n, pats) and b != 1]
    refs = [n for n, _, b in comps if n not in own and is_shared(n, pats) and b == 1]
    if not todo:
        out.append("  shared tables: %d listed as references, none carry schema" % len(refs))
        return True, 0
    for n, oid, b in sorted(todo, key=lambda x: x[0] or ""):
        if not apply:
            out.append("  ~ reference %s (now rootcomponentbehavior %s, carries its schema)" % (n, b))
            continue
        # Remove keys the reference on the TABLE's MetadataId (the component's objectid), not the
        # membership row's id; Add takes the id plainly. RemoveSolutionComponent only unlinks.
        api.post("RemoveSolutionComponent", {
            "SolutionComponent": {"@odata.type": "Microsoft.Dynamics.CRM.solutioncomponent",
                                  "solutioncomponentid": oid},
            "ComponentType": 1, "SolutionUniqueName": m["solution"]})
        api.post("AddSolutionComponent", {"ComponentId": oid, "ComponentType": 1,
                                          "SolutionUniqueName": m["solution"], "AddRequiredComponents": False,
                                          "DoNotIncludeSubcomponents": True})
        out.append("  ~ %s re-added as a reference (was behavior %s)" % (n, b))
    return True, len(todo)


# --------------------------------------------------------------------------- read back

def read_back(api, m):
    """(problems, warnings, counts): every table, column, option, lookup and shared reference, live."""
    problems, warnings = [], []
    n = {"tables": 0, "columns": 0, "options": 0, "lookups": 0, "references": 0}
    base = option_base(m)
    if not fetch_publisher(api, m["publisher"]["uniqueName"]):
        problems.append("publisher %s missing" % m["publisher"]["uniqueName"])
    sol = fetch_solution(api, m["solution"])
    if not sol:
        problems.append("solution %s missing" % m["solution"])
    for t in m["tables"]:
        ln = t["schemaName"].lower()
        cols = t.get("columns", [])
        st = fetch_table(api, ln, choices=any(c["type"] == "choice" for c in cols),
                         lookups=any(c["type"] == "lookup" for c in cols))
        if st is None:
            problems.append("table %s MISSING" % ln)
            continue
        n["tables"] += 1
        want = [(t["primaryName"]["schemaName"], "string")] + [(c["schemaName"], c["type"]) for c in cols]
        for sn, ty in want:
            cl = sn.lower()
            have = st["attrs"].get(cl)
            if have is None:
                problems.append("%s.%s MISSING" % (ln, cl))
                continue
            if have != TYPES[ty]:
                problems.append("%s.%s is %s, expected %s" % (ln, cl, have, TYPES[ty]))
                continue
            n["columns"] += 1
        for c in cols:
            cl = c["schemaName"].lower()
            if c["type"] == "choice" and cl in st["attrs"]:
                live = st["options"].get(cl, {})
                for i, lab in enumerate(c["options"]):
                    if base + i not in live:
                        problems.append("%s.%s option %d '%s' MISSING" % (ln, cl, base + i, lab))
                    else:
                        n["options"] += 1
                        if live[base + i] != lab:
                            warnings.append("%s.%s option %d reads '%s', manifest '%s'" % (ln, cl, base + i,
                                                                                         live[base + i], lab))
            if c["type"] == "lookup" and cl in st["attrs"]:
                if c["target"] not in st["targets"].get(cl, []):
                    problems.append("%s.%s does not target %s (live: %s)" % (ln, cl, c["target"],
                                                                            ", ".join(st["targets"].get(cl, [])) or "none"))
                else:
                    n["lookups"] += 1
    if sol:
        pats, own = shared_patterns(m)
        for name, _, b in table_components(api, sol["solutionid"]):
            if name in own or not is_shared(name, pats):
                continue
            if b != 1:
                problems.append("shared table %s is in the solution WITH its schema (behavior %s) - an import "
                                "would overwrite its owner's copy" % (name, b))
            else:
                n["references"] += 1
    return problems, warnings, n


# --------------------------------------------------------------------------- run

def run(argv):
    ap = argparse.ArgumentParser(prog="deploy-tables.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("--manifest")
    ap.add_argument("--org")
    ap.add_argument("--token-cmd")
    ap.add_argument("--token-env", default="DATAVERSE_TOKEN")
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.manifest:
        print("deploy-tables: --manifest is required")
        return 2
    try:
        m = load_manifest(a.manifest)
        validate(m)
    except ManifestError as e:
        print("MANIFEST REFUSED - nothing was called. Fix these and run again:")
        for x in e.args[0]:
            print("  - " + x)
        return 2
    if not a.org:
        print("deploy-tables: --org https://<org>.crm.dynamics.com is required")
        return 2
    org = a.org.rstrip("/")
    mode = "PLAN (read-only)" if a.plan else "APPLY"
    try:
        token, how = get_token(org, a.token_cmd, a.token_env)
    except ApiError as e:
        print("deploy-tables: %s" % e)
        return 2
    api = WebApi(org, token, read_only=a.plan)
    print("%s: %s -> %s, solution %s (token from %s)" % (mode, a.manifest, org, m["solution"], how))
    ctx = {}
    try:
        p = build_plan(api, m, ctx)
        print()
        print("Changes (%d), in order:" % len(p.actions))
        for text, _ in p.actions:
            print("  " + text)
        if not p.actions:
            print("  none - every publisher, solution, table, column, option and lookup is present")
        print("  (%d item(s) already present and left as they are)" % p.present)
        for w in p.warnings:
            print("  ! " + w)
        for c in p.conflicts:
            print("  CONFLICT " + c)
        if p.conflicts:
            print()
            print("REFUSED: %d conflict(s). Nothing was written; nothing is renamed, retyped or deleted here. "
                  "Change the manifest and run again." % len(p.conflicts))
            return 1
        if a.plan:
            lines = []
            shared_step(api, m, False, lines)
            print()
            print("\n".join(lines))
            print()
            print("PLAN ONLY: %d change(s) would be made in %s. Nothing was written (%d GET request(s))."
                  % (len(p.actions), org, len(api.calls)))
            return 0
        print()
        for text, fn in p.actions:
            fn()
            print("  done " + text)
        if p.actions:
            api.post("PublishAllXml", {})
            print("  done publish customizations")
        lines = []
        shared_step(api, m, True, lines)
        print("\n".join(lines))
        problems, warns, n = read_back(api, m)
    except ApiError as e:
        print()
        print("FAILED: %s" % e)
        print("Every step is idempotent: fix the cause and run again; it continues where this stopped.")
        return 2
    print()
    print("Read back: %d table(s), %d column(s), %d option(s), %d lookup(s), %d shared reference(s)"
          % (n["tables"], n["columns"], n["options"], n["lookups"], n["references"]))
    for w in warns:
        print("  ! " + w)
    for x in problems:
        print("  FAIL " + x)
    writes = sum(1 for meth, _ in api.calls if meth != "GET")
    if problems:
        print("NOT DONE: %d item(s) missing or wrong after the apply. Re-run (idempotent); if it persists, read the "
              "server's answer for that item." % len(problems))
        return 1
    print("DEPLOYED AND READ BACK: everything in the manifest is live (%d write request(s))." % writes)
    return 0


# --------------------------------------------------------------------------- selftest

SELFTEST_MANIFEST = {
    "solution": "abc_requests",
    "publisher": {"uniqueName": "abcpublisher", "friendlyName": "ABC Publisher", "prefix": "abc",
                  "optionValuePrefix": 10000},
    "sharedTables": ["core_*"],
    "tables": [
        {"schemaName": "abc_category", "displayName": "Category", "displayCollectionName": "Categories",
         "primaryName": {"schemaName": "abc_name", "displayName": "Name", "maxLength": 100},
         "columns": [{"schemaName": "abc_active", "displayName": "Active", "type": "boolean"}]},
        {"schemaName": "abc_request", "displayName": "Request", "displayCollectionName": "Requests",
         "description": "A request someone raised.", "hasNotes": True, "ownership": "user",
         "primaryName": {"schemaName": "abc_title", "displayName": "Title", "maxLength": 200},
         "columns": [
             {"schemaName": "abc_number", "displayName": "Number", "type": "autonumber", "format": "REQ-{SEQNUM:5}"},
             {"schemaName": "abc_details", "displayName": "Details", "type": "memotext", "maxLength": 4000},
             {"schemaName": "abc_status", "displayName": "Status", "type": "choice",
              "options": ["New", "In Progress", "Done"]},
             {"schemaName": "abc_DueDate", "displayName": "Due Date", "type": "datetime"},
             {"schemaName": "abc_estimate", "displayName": "Estimate", "type": "decimal"},
             {"schemaName": "abc_category", "displayName": "Category", "type": "lookup", "target": "abc_category"},
             {"schemaName": "abc_requester", "displayName": "Requester", "type": "lookup", "target": "core_person"}]}]}


class FakeDataverse:
    """An in-memory Web API: metadata, solutions, components, and the platform's lookup side effect."""

    def __init__(self):
        self.n = 0
        self.publishers, self.solutions, self.components = [], [], []
        self.entities = {}
        self.calls = []
        self.drop = set()            # column logical names whose create is "accepted" but never lands
        self.flaky = set()           # metadata paths that answer 400 once (the post-create race)
        self.publishes = 0
        owner = self.add_solution("core_shared", self.add_publisher("corepublisher", "core", 20000))
        self.add_entity("core_person", owner, {"core_name": "StringType"})

    def gid(self):
        self.n += 1
        return "00000000-0000-0000-0000-%012d" % self.n

    def add_publisher(self, unique, prefix, ovp):
        p = {"publisherid": self.gid(), "uniquename": unique, "customizationprefix": prefix,
             "customizationoptionvalueprefix": ovp}
        self.publishers.append(p)
        return p["publisherid"]

    def add_solution(self, unique, pubid):
        s = {"solutionid": self.gid(), "uniquename": unique, "publisherid": pubid}
        self.solutions.append(s)
        return s["solutionid"]

    def add_entity(self, logical, solution_id, attrs):
        e = {"id": self.gid(), "attrs": {k: {"type": v, "options": {}, "targets": []} for k, v in attrs.items()}}
        self.entities[logical] = e
        if solution_id:
            self.components.append({"solutionid": solution_id, "objectid": e["id"], "behavior": 0})
        return e

    def sol_id(self, unique):
        return next((s["solutionid"] for s in self.solutions if s["uniquename"] == unique), None)

    def include(self, unique, objectid):
        sid = self.sol_id(unique)
        if sid and not any(c["solutionid"] == sid and c["objectid"] == objectid for c in self.components):
            self.components.append({"solutionid": sid, "objectid": objectid, "behavior": 0})

    def handle(self, method, p, body, headers):
        """(status, body). p is the decoded path after /api/data/v9.2/."""
        self.calls.append((method, p))
        sol = headers.get("mscrm.solutionuniquename")
        lab = lambda b: label_of((b or {}).get("Label") if "Label" in (b or {}) else b)
        if method == "POST" and p in self.flaky:
            self.flaky.discard(p)
            return 400, {"error": {"message": "metadata not yet committed"}}
        if method == "GET":
            q = re.search(r"uniquename eq '([^']*)'", p)
            if p.startswith("publishers?"):
                return 200, {"value": [x for x in self.publishers if x["uniquename"] == q.group(1)]}
            if p.startswith("solutions?"):
                out = []
                for s in self.solutions:
                    if s["uniquename"] == q.group(1):
                        pub = next(x for x in self.publishers if x["publisherid"] == s["publisherid"])
                        out.append({"solutionid": s["solutionid"], "uniquename": s["uniquename"],
                                    "publisherid": {"uniquename": pub["uniquename"],
                                                    "customizationprefix": pub["customizationprefix"]}})
                return 200, {"value": out}
            if p.startswith("solutioncomponents?"):
                sid = re.search(r"_solutionid_value eq ([0-9a-f-]+)", p).group(1)
                return 200, {"value": [{"objectid": c["objectid"], "rootcomponentbehavior": c["behavior"]}
                                       for c in self.components if c["solutionid"] == sid]}
            if p.startswith("EntityDefinitions?"):
                return 200, {"value": [{"LogicalName": k, "MetadataId": e["id"]} for k, e in self.entities.items()]}
            mt = re.match(r"EntityDefinitions\(LogicalName='([^']+)'\)(/Attributes/Microsoft\.Dynamics\.CRM\."
                          r"(Picklist|Lookup)AttributeMetadata)?", p)
            if mt:
                e = self.entities.get(mt.group(1))
                if e is None:
                    return 404, {"error": {"message": "Could not find entity"}}
                if mt.group(3) == "Picklist":
                    return 200, {"value": [{"LogicalName": k, "OptionSet": {"Options": [
                        {"Value": v, "Label": {"UserLocalizedLabel": {"Label": l}}} for v, l in a["options"].items()]}}
                        for k, a in e["attrs"].items() if a["type"] == "PicklistType"]}
                if mt.group(3) == "Lookup":
                    return 200, {"value": [{"LogicalName": k, "Targets": a["targets"]}
                                           for k, a in e["attrs"].items() if a["type"] == "LookupType"]}
                return 200, {"LogicalName": mt.group(1), "MetadataId": e["id"],
                             "Attributes": [{"LogicalName": k, "AttributeTypeName": {"Value": a["type"]}}
                                            for k, a in e["attrs"].items()]}
            return 404, {"error": {"message": "no route " + p}}
        # writes
        if p == "publishers":
            self.add_publisher(body["uniquename"], body["customizationprefix"], body["customizationoptionvalueprefix"])
            return 204, None
        if p == "solutions":
            pubid = re.search(r"\(([^)]+)\)", body["publisherid@odata.bind"]).group(1)
            self.add_solution(body["uniquename"], pubid)
            return 204, None
        if p == "EntityDefinitions":
            if body.get("@odata.type") != "Microsoft.Dynamics.CRM.EntityMetadata" or not sol:
                return 400, {"error": {"message": "bad entity body or no solution header"}}
            pn = body["Attributes"][0]
            self.add_entity(body["SchemaName"].lower(), self.sol_id(sol), {pn["SchemaName"].lower(): "StringType"})
            return 204, None
        mt = re.match(r"EntityDefinitions\(LogicalName='([^']+)'\)/Attributes$", p)
        if mt:
            if list(body)[0] != "@odata.type" or not sol:
                return 400, {"error": {"message": "0x80040216 An unexpected error occurred"}}
            cl = body["SchemaName"].lower()
            if cl in self.drop:
                return 204, None
            ty = {"StringAttributeMetadata": "StringType", "MemoAttributeMetadata": "MemoType",
                  "IntegerAttributeMetadata": "IntegerType", "DecimalAttributeMetadata": "DecimalType",
                  "MoneyAttributeMetadata": "MoneyType", "BooleanAttributeMetadata": "BooleanType",
                  "DateTimeAttributeMetadata": "DateTimeType", "PicklistAttributeMetadata": "PicklistType",
                  "FileAttributeMetadata": "FileType"}[body["@odata.type"].split(".")[-1]]
            a = {"type": ty, "options": {}, "targets": []}
            if ty == "PicklistType":
                a["options"] = {o["Value"]: label_of(o["Label"]) for o in body["OptionSet"]["Options"]}
            self.entities[mt.group(1)]["attrs"][cl] = a
            return 204, None
        if p == "RelationshipDefinitions":
            ref, tgt = body["ReferencingEntity"], body["ReferencedEntity"]
            if tgt not in self.entities:
                return 400, {"error": {"message": "referenced entity does not exist"}}
            self.entities[ref]["attrs"][body["Lookup"]["SchemaName"].lower()] = {
                "type": "LookupType", "options": {}, "targets": [tgt]}
            if sol:   # the platform's side effect: the target joins the solution WITH its schema
                self.include(sol, self.entities[tgt]["id"])
            return 204, None
        if p == "InsertOptionValue":
            a = self.entities[body["EntityLogicalName"]]["attrs"][body["AttributeLogicalName"]]
            if body["Value"] in a["options"]:
                return 400, {"error": {"message": "option value already exists"}}
            a["options"][body["Value"]] = lab(body)
            return 204, None
        if p == "PublishAllXml":
            self.publishes += 1
            return 204, None
        if p == "RemoveSolutionComponent":
            sid = self.sol_id(body["SolutionUniqueName"])
            key = body["SolutionComponent"]["solutioncomponentid"]
            hit = [c for c in self.components if c["solutionid"] == sid and c["objectid"] == key]
            if not hit:
                return 400, {"error": {"message": "Cannot find solution component Entity %s" % key}}
            self.components.remove(hit[0])
            return 204, None
        if p == "AddSolutionComponent":
            sid = self.sol_id(body["SolutionUniqueName"])
            self.components.append({"solutionid": sid, "objectid": body["ComponentId"],
                                    "behavior": 1 if body.get("DoNotIncludeSubcomponents") else 0})
            return 204, None
        return 404, {"error": {"message": "no route " + p}}


def _serve(fake):
    import http.server
    import threading

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _reply(self, code, body):
            data = json.dumps(body).encode() if body is not None else b""
            self.send_response(code)
            if data:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _do(self, method):
            if self.headers.get("Authorization") != "Bearer fixture-token":
                return self._reply(401, {"error": {"message": "unauthorised"}})
            p = urllib.parse.unquote(self.path)
            if not p.startswith(API):
                return self._reply(404, None)
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n).decode("utf-8")) if n else None
            code, out = fake.handle(method, p[len(API):], body, {k.lower(): v for k, v in self.headers.items()})
            self._reply(code, out)

        def do_GET(self):
            self._do("GET")

        def do_POST(self):
            self._do("POST")

        def do_PATCH(self):
            self._do("PATCH")

        do_PUT = do_DELETE = do_PATCH

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def selftest():
    import copy
    import tempfile
    global SLEEP
    failures = []
    real_sleep, SLEEP = SLEEP, (lambda s: None)

    def check(name, cond):
        print("  %s  %s" % ("ok  " if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    tmp = tempfile.mkdtemp(prefix="deploy-tables-selftest-")
    os.environ["DEPLOY_TABLES_SELFTEST_TOKEN"] = "fixture-token"
    servers = []

    def env():
        fake = FakeDataverse()
        srv = _serve(fake)
        servers.append(srv)
        return fake, "http://127.0.0.1:%d" % srv.server_port

    def manifest_file(m, name="tables.json"):
        path = os.path.join(tmp, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(m, f)
        return path

    def go(m, org, *extra):
        buf, old = io.StringIO(), sys.stdout
        sys.stdout = buf
        try:
            rc = run(["--manifest", manifest_file(m), "--org", org,
                      "--token-env", "DEPLOY_TABLES_SELFTEST_TOKEN"] + list(extra))
        finally:
            sys.stdout = old
        return rc, buf.getvalue()

    def writes(fake, start=0):
        return [(m_, p) for m_, p in fake.calls[start:] if m_ != "GET"]

    try:
        base = copy.deepcopy(SELFTEST_MANIFEST)

        # --- manifest validation: refused before any call
        fake, org = env()
        bad_cases = {
            "unknown type": lambda m: m["tables"][1]["columns"].append(
                {"schemaName": "abc_x", "displayName": "X", "type": "currency"}),
            "prefix mismatch": lambda m: m["tables"][0].update(schemaName="xyz_category"),
            "duplicate table": lambda m: m["tables"].append(copy.deepcopy(m["tables"][0])),
            "duplicate column": lambda m: m["tables"][1]["columns"].append(
                {"schemaName": "abc_Status", "displayName": "Again", "type": "string"}),
            "mixed-case lookup": lambda m: m["tables"][1]["columns"][5].update(schemaName="abc_Category"),
            "choice without options": lambda m: m["tables"][1]["columns"][2].update(options=[]),
            "sharedTables covering an own table": lambda m: m.update(sharedTables=["abc_*"]),
            "option value prefix out of range": lambda m: m["publisher"].update(optionValuePrefix=99),
            "a column on a lookup's reserved name companion": lambda m: m["tables"][1]["columns"].append(
                {"schemaName": "abc_categoryname", "displayName": "Category Name", "type": "string"}),
            "two columns with one display name": lambda m: m["tables"][1]["columns"].append(
                {"schemaName": "abc_status2", "displayName": "Status", "type": "string"}),
        }
        for name, mutate in bad_cases.items():
            m = copy.deepcopy(base)
            mutate(m)
            rc, out = go(m, org, "--plan")
            check("manifest error refused with exit 2 and no call: %s" % name,
                  rc == 2 and "MANIFEST REFUSED" in out and not fake.calls)
        m = copy.deepcopy(base)
        m["tables"][0]["schemaName"] = "xyz_category"
        m["tables"][1]["columns"].append({"schemaName": "abc_x", "displayName": "X", "type": "currency"})
        rc, out = go(m, org)
        check("every manifest error is listed at once, and apply mode is refused too",
              rc == 2 and "xyz_category" in out and "currency" in out and not fake.calls)

        example = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "tables.example.json")
        if os.path.exists(example):
            try:
                validate(load_manifest(example))
                ok = True
            except ManifestError as e:
                ok = False
                print("    " + "; ".join(e.args[0]))
            check("the bundled assets/tables.example.json validates", ok)

        # --- plan on an empty environment
        rc, out = go(base, org, "--plan")
        check("plan on an empty environment exits 0", rc == 0)
        check("plan issues GET only", fake.calls and not writes(fake))
        check("plan lists publisher, solution, both tables, every column and both lookups",
              all(s in out for s in ("+ publisher abcpublisher", "+ solution abc_requests", "+ table abc_category",
                                     "+ table abc_request", "+ column abc_request.abc_DueDate (datetime)",
                                     "+ column abc_request.abc_status (choice, 3 options 100000000..100000002)",
                                     "+ lookup abc_request.abc_category -> abc_category",
                                     "+ lookup abc_request.abc_requester -> core_person")))
        check("plan says the shared table will be turned into a reference", "core_person" in out
              and "reference" in out)
        check("the token is never printed", "fixture-token" not in out)

        # --- apply
        fake.flaky.add("EntityDefinitions(LogicalName='abc_request')/Attributes")
        n0 = len(fake.calls)
        rc, out = go(base, org)
        check("apply exits 0 with DEPLOYED AND READ BACK", rc == 0 and "DEPLOYED AND READ BACK" in out)
        req = fake.entities.get("abc_request", {"attrs": {}})["attrs"]
        check("columns created with their types and lower-case logical names",
              req.get("abc_duedate", {}).get("type") == "DateTimeType"
              and req.get("abc_number", {}).get("type") == "StringType"
              and req.get("abc_title", {}).get("type") == "StringType")
        check("choice option values come from the publisher prefix (100000000 + n)",
              req.get("abc_status", {}).get("options") == {100000000: "New", 100000001: "In Progress",
                                                         100000002: "Done"})
        check("lookups created with their targets", req.get("abc_category", {}).get("targets") == ["abc_category"]
              and req.get("abc_requester", {}).get("targets") == ["core_person"])
        check("the post-create 400 on a column is retried, not fatal", rc == 0 and not fake.flaky)
        check("customizations published once", fake.publishes == 1)
        sid = fake.sol_id("abc_requests")
        beh = {c["objectid"]: c["behavior"] for c in fake.components if c["solutionid"] == sid}
        check("the shared table pulled in by the lookup is now a reference (behavior 1)",
              beh.get(fake.entities["core_person"]["id"]) == 1)
        check("the manifest's own tables stay in the solution with their schema",
              beh.get(fake.entities["abc_request"]["id"]) == 0 and beh.get(fake.entities["abc_category"]["id"]) == 0)
        order = [p for _, p in writes(fake, n0)]
        first = lambda s: next(i for i, p in enumerate(order) if p.startswith(s))
        check("write order: publisher, solution, tables, columns, lookups, publish, then references",
              first("publishers") < first("solutions") < first("EntityDefinitions") <
              first("RelationshipDefinitions") < first("PublishAllXml") < first("RemoveSolutionComponent")
              < first("AddSolutionComponent"))

        # --- re-run is a no-op
        n1 = len(fake.calls)
        rc, out = go(base, org)
        check("re-run exits 0 and writes nothing", rc == 0 and not writes(fake, n1)
              and "Changes (0)" in out and fake.publishes == 1)

        # --- choice append
        m2 = copy.deepcopy(base)
        m2["tables"][1]["columns"][2]["options"].append("Cancelled")
        rc, out = go(m2, org, "--plan")
        check("plan shows exactly one appended option", rc == 0 and "Changes (1)" in out
              and "+ option abc_request.abc_status 100000003 'Cancelled'" in out)
        n2 = len(fake.calls)
        rc, out = go(m2, org)
        w = [p for _, p in writes(fake, n2)]
        check("apply inserts only the new option, then publishes",
              rc == 0 and w == ["InsertOptionValue", "PublishAllXml"]
              and req["abc_status"]["options"].get(100000003) == "Cancelled")

        # --- a relabel in the manifest is reported, never written
        m3 = copy.deepcopy(m2)
        m3["tables"][1]["columns"][2]["options"][0] = "Open"
        n3 = len(fake.calls)
        rc, out = go(m3, org)
        check("a changed label is reported and left alone", rc == 0 and "is 'New' live and 'Open'" in out
              and not writes(fake, n3) and req["abc_status"]["options"][100000000] == "New")

        # --- shared table re-referenced when something pulled it back in with its schema
        cp = fake.entities["core_person"]["id"]
        for c in fake.components:
            if c["solutionid"] == sid and c["objectid"] == cp:
                c["behavior"] = 0
        rc, out = go(base, org, "--plan")
        check("plan names the shared table that carries schema", rc == 0 and "~ reference core_person" in out)
        n4 = len(fake.calls)
        rc, out = go(base, org)
        w = [p for _, p in writes(fake, n4)]
        check("apply re-adds it as a reference and touches nothing else",
              rc == 0 and w == ["RemoveSolutionComponent", "AddSolutionComponent"]
              and {c["objectid"]: c["behavior"] for c in fake.components if c["solutionid"] == sid}[cp] == 1)

        # --- type conflict: refused before any write
        m4 = copy.deepcopy(base)
        m4["tables"][1]["columns"][4]["type"] = "integer"
        n5 = len(fake.calls)
        rc, out = go(m4, org)
        check("a column that exists with another type is a CONFLICT, exit 1, nothing written",
              rc == 1 and "CONFLICT abc_request.abc_estimate exists as DecimalType" in out and not writes(fake, n5))

        # --- read-back failure on a fresh environment
        fake2, org2 = env()
        fake2.drop.add("abc_details")
        rc, out = go(base, org2)
        check("a column the server accepted but never created fails the read-back (exit 1)",
              rc == 1 and "FAIL abc_request.abc_details MISSING" in out and "NOT DONE" in out)
        n6 = len(fake2.calls)
        fake2.drop.clear()
        rc, out = go(base, org2)
        check("a re-run creates only the missing column and then reads back clean",
              rc == 0 and [p for _, p in writes(fake2, n6)] ==
              ["EntityDefinitions(LogicalName='abc_request')/Attributes", "PublishAllXml"])

        # --- a lookup whose target does not exist blocks the apply
        fake3, org3 = env()
        m5 = copy.deepcopy(base)
        m5["tables"][1]["columns"][6]["target"] = "core_missing"
        m5["sharedTables"] = []
        rc, out = go(m5, org3)
        check("a lookup to a table that does not exist is refused before any write",
              rc == 1 and "lookup target core_missing does not exist" in out and not writes(fake3))

        # --- a bad token is exit 2, never a pass
        os.environ["DEPLOY_TABLES_SELFTEST_TOKEN"] = "wrong"
        rc, out = go(base, org3, "--plan")
        check("a rejected token is exit 2", rc == 2 and "HTTP 401" in out)
    finally:
        os.environ.pop("DEPLOY_TABLES_SELFTEST_TOKEN", None)
        for s in servers:
            s.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
        SLEEP = real_sleep

    print()
    print("selftest: %s" % ("PASSED" if not failures else "FAILED %d: %s" % (len(failures), ", ".join(failures))))
    return 0 if not failures else 1


def main():
    return run(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
