#!/usr/bin/env python3
"""check-drift.py - compare a canvas app's CACHED Dataverse metadata with the LIVE environment.

A canvas app does not look Dataverse metadata up at run time. When a data source is added the app
freezes a copy of the table into its manifest, and the PUBLISHED player resolves against that
copy while Studio, Preview and the compiler resolve against live metadata. So a formula can
compile clean, work in Preview and fail for every user. This tool reads the cached copy out of
the artifact and compares it, read-only, with live metadata (or a saved dump of it).

Usage:
    python check-drift.py <app.msapp | app.msapr | solution.zip> [options]

Options:
    --org URL           environment URL (default: "environmentUrl" in scripts/canvas-app.json,
                        then the instance URL recorded inside the app itself - printed either way)
    --config PATH       identity config (default: ./scripts/canvas-app.json if present)
    --token-cmd CMD     command that prints an access token; "{org}" is replaced by the org URL
    --token-env NAME    environment variable holding a token (default: DATAVERSE_TOKEN)
    --offline DUMP      compare against a saved metadata dump instead of the Web API (CI)
    --dump PATH         write the live metadata this run fetched to PATH (for later --offline)
    --src DIR           .pa.yaml directory to search for references (default: the half of the
                        artifact that runs)
    --json              machine-readable report
    --selftest          run the built-in tests on synthetic fixtures and exit

Token, in order: --token-env variable, --token-cmd, `az account get-access-token --resource
<org>`, then Az PowerShell `Get-AzAccessToken`. The token is never printed or written.
Every Web API call is a GET; nothing in the environment is changed.

What it compares, for every Dataverse table the app binds:
  table         the table still exists live
  entity-set    entity set name in DataSources.json, the TableDefinition copy, Properties.json
                LocalDatabaseReferences and (solution zip) <DatabaseReferences>
  column        live columns the cache lacks, cached columns live no longer has - DRIFT only when a
                formula references the column, a note otherwise
  column-type   cached attribute type vs live
  choice        option-set members in BOTH caches: the OptionSetInfo entry (cache 1) and the
                table's TableDefinition (cache 2, the one the published player reads)
  lookup        cached navigation property name, lookup schema name and target vs live
  dbrefs        (solution zip) <DatabaseReferences> - what the player initialises - vs the
                app's DataSources.json - what it binds - by name and by value

Exit: 0 no drift, 1 drift found, 2 could not read the artifact, could not reach live metadata,
or some bound tables could not be verified. 2 is NEVER a pass.
"""
import argparse
import concurrent.futures
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
import zipfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DUMP_FORMAT = "power-platform-skill/metadata-dump/1"
API = "/api/data/v9.2/"

# Platform columns and lookups: the same in every environment, never what drift is about.
SYSTEM_ATTRS = {"createdby", "createdonbehalfby", "modifiedby", "modifiedonbehalfby", "ownerid",
                "owninguser", "owningteam", "owningbusinessunit", "organizationid",
                "statecode", "statuscode", "versionnumber", "importsequencenumber",
                "overriddencreatedon", "timezoneruleversionnumber", "utcconversiontimezonecode",
                "processid", "stageid", "traversedpath"}
SYSTEM_PREFIXES = ("created", "modified", "owning", "owner", "overridden", "import",
                   "timezonerule", "utcconversion", "versionnumber", "processid", "stageid",
                   "traversedpath")

# Choice kinds: cached bucket inside TableDefinition, and the OptionSetInfo type key.
CHOICE_BUCKETS = {"Picklist": "PicklistOptionSetAttribute",
                  "MultiSelectPicklist": "MultiSelectPicklistOptionSetAttribute",
                  "State": "StateOptionSetAttribute",
                  "Status": "StatusOptionSetAttribute",
                  "Boolean": "BooleanOptionSetAttribute"}
TYPEKEY_KIND = {"PicklistType": "Picklist", "MultiSelectPicklistType": "MultiSelectPicklist",
                "StateType": "State", "StatusType": "Status", "BooleanType": "Boolean"}
RECONCILABLE_CHOICES = {"Picklist", "MultiSelectPicklist"}
LOOKUP_TYPES = {"Lookup", "Customer", "Owner"}

FIX_RESHIP = ("re-ship with ship-canvas.py, which reconciles this cache from live metadata on every "
              "build and re-checks the finished artifact (a Studio refresh does not reliably update it)")
FIX_READD = ("in Studio: Data pane > the table > Remove, then Add data > the same table; Save AND "
             "Publish from Studio (a save alone never reaches the published app); confirm in a fresh "
             "download; then re-ship from git and confirm LoadFromYaml is true again")
FIX_TYPE = ("a cached column type is not reliably refreshed by any click path: revert the type change "
            "if you can; otherwise remove and re-add the source in Studio, Save AND Publish, and "
            "confirm the new type in a fresh download before re-shipping")


class ArtifactError(Exception):
    pass


class LiveError(Exception):
    pass


class NotFound(LiveError):
    pass


# --------------------------------------------------------------------------- small helpers

def norm(name):
    return name.replace("\\", "/")


def jload(raw):
    """Parse a JSON string or bytes; None if it is not JSON."""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8-sig", "replace")
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def label_of(obj):
    """The user-facing label of a Dataverse Label object (DisplayName, option Label)."""
    if not isinstance(obj, dict):
        return None
    ul = obj.get("UserLocalizedLabel")
    if isinstance(ul, dict) and ul.get("Label") is not None:
        return ul["Label"]
    for loc in obj.get("LocalizedLabels") or []:
        if isinstance(loc, dict) and loc.get("Label") is not None:
            return loc["Label"]
    return None


def options_of(option_set, kind):
    """{value-as-string: label} from an OptionSet object of the given kind."""
    out = {}
    if not isinstance(option_set, dict):
        return out
    if kind == "Boolean":
        for key in ("TrueOption", "FalseOption"):
            o = option_set.get(key)
            if isinstance(o, dict) and o.get("Value") is not None:
                lab = label_of(o.get("Label"))
                if lab is not None:
                    out[str(o["Value"])] = lab
        return out
    for o in option_set.get("Options") or []:
        if isinstance(o, dict) and o.get("Value") is not None:
            lab = label_of(o.get("Label"))
            if lab is not None:
                out[str(o["Value"])] = lab
    return out


def is_system(logical):
    return logical in SYSTEM_ATTRS or logical.startswith(SYSTEM_PREFIXES)


def attr_record(a):
    return {"schema": a.get("SchemaName"), "display": label_of(a.get("DisplayName")),
            "type": a.get("AttributeType"), "attributeOf": a.get("AttributeOf"),
            "read": a.get("IsValidForRead")}


def comparable_attr(logical, rec):
    """Columns a formula can name: not a sub-attribute, readable, not platform-owned."""
    return bool(logical) and not rec.get("attributeOf") and rec.get("read") is not False \
        and not is_system(logical)


# --------------------------------------------------------------------------- the cached side

def find_entry(names, suffix):
    hits = [n for n in names if norm(n).endswith(suffix)]
    hits.sort(key=lambda n: len(n))
    return hits[0] if hits else None


def parse_table_definition(raw):
    """Return (entity metadata dict, {bucket: envelope}) from a TableDefinition string."""
    td = jload(raw)
    if not isinstance(td, dict):
        return None, {}
    em = jload(td.get("EntityMetadata"))
    buckets = {}
    for kind, bucket in CHOICE_BUCKETS.items():
        env = jload(td.get(bucket))
        if isinstance(env, dict):
            buckets[kind] = env
    return (em if isinstance(em, dict) else None), buckets


def cached_source(entry):
    """Everything the manifest froze about one NativeCDSDataSourceInfo entry."""
    src = {"name": entry.get("Name"), "logical": entry.get("LogicalName"),
           "set": entry.get("EntitySetName"), "td_set": None, "parsed": False,
           "attributes": {}, "lookups": [], "choices": {}}
    em, buckets = parse_table_definition(entry.get("TableDefinition"))
    if em is None:
        return src
    src["parsed"] = True
    src["td_set"] = em.get("EntitySetName")
    for a in em.get("Attributes") or []:
        if isinstance(a, dict) and a.get("LogicalName"):
            src["attributes"][a["LogicalName"]] = attr_record(a)
    for r in em.get("ManyToOneRelationships") or []:
        if isinstance(r, dict) and r.get("ReferencingAttribute"):
            src["lookups"].append({"attr": r["ReferencingAttribute"],
                                   "nav": r.get("ReferencingEntityNavigationPropertyName"),
                                   "target": r.get("ReferencedEntity")})
    for kind, env in buckets.items():
        for a in env.get("value") or []:
            if not isinstance(a, dict) or not a.get("LogicalName"):
                continue
            oset = a.get("OptionSet") or {}
            src["choices"][a["LogicalName"]] = {
                "kind": kind, "name": oset.get("Name"), "global": bool(oset.get("IsGlobal")),
                "options": options_of(oset, kind)}
    return src


class AppPackage:
    """One canvas app package (.msapp, or the msapp/ subtree of a .msapr), held in memory."""

    def __init__(self, label, entries):
        self.label = label
        self.entries = entries                       # {name: bytes}
        names = list(entries)
        self.ds_key = find_entry(names, "References/DataSources.json")
        if not self.ds_key:
            raise ArtifactError("%s: no References/DataSources.json - is this a canvas app?" % label)
        self.prefix = norm(self.ds_key)[: -len("References/DataSources.json")]
        self.doc = jload(entries[self.ds_key])
        if not isinstance(self.doc, dict) and not isinstance(self.doc, list):
            raise ArtifactError("%s: References/DataSources.json is not JSON" % label)
        self.props_key = next((n for n in names if norm(n) == self.prefix + "Properties.json"), None)
        self.props = jload(entries[self.props_key]) if self.props_key else None
        packed = next((n for n in names if norm(n) == self.prefix + "packed.json"), None)
        lfy = None
        if packed:
            p = jload(entries[packed]) or {}
            lfy = (p.get("LoadConfiguration") or {}).get("LoadFromYaml")
        self.load_from_yaml = lfy

    def data_sources(self):
        d = self.doc
        return d.get("DataSources", []) if isinstance(d, dict) else d

    def sources(self):
        return [cached_source(e) for e in self.data_sources()
                if e.get("Type") == "NativeCDSDataSourceInfo" and e.get("LogicalName")]

    def optionset_infos(self):
        by_name = {e.get("Name"): e.get("LogicalName") for e in self.data_sources()
                   if e.get("Type") == "NativeCDSDataSourceInfo"}
        out = []
        for e in self.data_sources():
            if e.get("Type") != "OptionSetInfo":
                continue
            kind = TYPEKEY_KIND.get(e.get("OptionSetTypeKey"))
            mapping = e.get("OptionSetInfoNameMapping")
            if not kind or not isinstance(mapping, dict):
                continue
            out.append({"name": e.get("Name"), "kind": kind, "global": bool(e.get("OptionSetIsGlobal")),
                        "source": e.get("RelatedEntityName"),
                        "table": by_name.get(e.get("RelatedEntityName")),
                        "column": e.get("RelatedColumnInvariantName"),
                        "options": {str(k): v for k, v in mapping.items()}})
        return out

    def local_db_refs(self):
        """{source name: {entitySetName, logicalName}} from Properties.json LocalDatabaseReferences."""
        if not isinstance(self.props, dict):
            return {}
        ldr = self.props.get("LocalDatabaseReferences")
        ldr = jload(ldr) if isinstance(ldr, str) else ldr
        out = {}
        if isinstance(ldr, dict):
            for db in ldr.values():
                if isinstance(db, dict):
                    out.update(db.get("dataSources") or {})
        return out

    def instance_url(self):
        if not isinstance(self.props, dict):
            return None
        ldr = self.props.get("LocalDatabaseReferences")
        ldr = jload(ldr) if isinstance(ldr, str) else ldr
        if isinstance(ldr, dict):
            for db in ldr.values():
                if isinstance(db, dict) and db.get("instanceUrl"):
                    return db["instanceUrl"].rstrip("/")
        return None

    def formula_files(self):
        """(name, text) for the half of the app that RUNS: Src/ when LoadFromYaml, else Controls/."""
        src = [n for n in self.entries if norm(n).startswith(self.prefix + "Src/") and n.endswith(".pa.yaml")]
        ctl = [n for n in self.entries if norm(n).startswith(self.prefix + "Controls/") and n.endswith(".json")]
        if self.load_from_yaml is True or (self.load_from_yaml is None and src):
            pick, half = src, "Src/"
        else:
            pick, half = ctl, "Controls/"
        return half, [(norm(n), self.entries[n].decode("utf-8", "replace")) for n in sorted(pick)]


def read_zip(path_or_bytes):
    zf = zipfile.ZipFile(io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else path_or_bytes)
    try:
        return {i.filename: zf.read(i.filename) for i in zf.infolist() if not i.is_dir()}
    finally:
        zf.close()


def canvas_meta_location(names, app_name):
    """Which solution entry carries an app's <DatabaseReferences>. Raises if none - a repair or a
    comparison that finds nothing to look at must not read as 'in step'."""
    metas = [n for n in names if norm(n).startswith("CanvasApps/") and n.endswith(".meta.xml")]
    if metas:
        hit = [n for n in metas if os.path.basename(norm(n)).startswith(app_name)] or (metas if len(metas) == 1 else [])
        if len(hit) == 1:
            return hit[0]
        raise ArtifactError("cannot tell which CanvasApps/*.meta.xml belongs to %s: %s" % (app_name, metas))
    if "customizations.xml" in names:
        return "customizations.xml"
    raise ArtifactError("no CanvasApps/*.meta.xml and no customizations.xml in the solution")


def canvas_block(xml, app_name):
    """(start, end) of the <CanvasApp> element for app_name inside customizations.xml, or the whole
    text for a standalone meta.xml."""
    blocks = list(re.finditer(r"<CanvasApp>.*?</CanvasApp>", xml, re.S))
    if not blocks:
        return 0, len(xml)
    for m in blocks:
        nm = re.search(r"<Name>([^<]+)</Name>", m.group(0))
        if nm and nm.group(1).strip() == app_name:
            return m.start(), m.end()
    if len(blocks) == 1:
        return blocks[0].start(), blocks[0].end()
    raise ArtifactError("customizations.xml has %d <CanvasApp> blocks and none is named %s"
                        % (len(blocks), app_name))


def xml_json(raw):
    """JSON stored as element text, raw or XML-escaped. Returns (value, was_escaped)."""
    raw = raw.strip()
    escaped = "&quot;" in raw
    if escaped:
        raw = raw.replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    return json.loads(raw), escaped


def player_sources(xml, app_name):
    """{display name: {entitySetName, logicalName}} from the app's <DatabaseReferences>."""
    s, e = canvas_block(xml, app_name)
    m = re.search(r"<DatabaseReferences>(.*?)</DatabaseReferences>", xml[s:e], re.S)
    if not m:
        raise ArtifactError("no <DatabaseReferences> for %s" % app_name)
    body, _ = xml_json(m.group(1))
    out = {}
    for db in (body or {}).values():
        if isinstance(db, dict):
            out.update(db.get("dataSources") or {})
    return out


def app_name_from_path(path):
    base = os.path.basename(norm(path))
    base = re.sub(r"\.msapp$", "", base, flags=re.I)
    return re.sub(r"_DocumentUri$", "", base)


def load_artifact(path):
    """[(AppPackage, player_sources or None)] for every canvas app in the artifact."""
    if not os.path.isfile(path):
        raise ArtifactError("no such file: %s" % path)
    try:
        entries = read_zip(path)
    except zipfile.BadZipFile as e:
        raise ArtifactError("%s is not a zip archive (%s)" % (path, e))
    names = list(entries)
    if "solution.xml" in names and "customizations.xml" in names:
        apps = [n for n in names if n.lower().endswith(".msapp")]
        if not apps:
            raise ArtifactError("solution has no CanvasApps/*.msapp - nothing to check")
        out = []
        for n in apps:
            pkg = AppPackage(norm(n), read_zip(entries[n]))
            app = app_name_from_path(n)
            loc = canvas_meta_location(names, app)
            xml = entries[loc].decode("utf-8-sig", "replace")
            out.append((pkg, player_sources(xml, app)))
        return out
    return [(AppPackage(path, entries), None)]


# --------------------------------------------------------------------------- the live side

def resolve_org(args_org, config, pkg):
    if args_org:
        return args_org.rstrip("/"), "--org"
    if config and config.get("environmentUrl") and "yourorg" not in config["environmentUrl"]:
        return config["environmentUrl"].rstrip("/"), "canvas-app.json environmentUrl"
    if pkg is not None and pkg.instance_url():
        return pkg.instance_url(), "the instance URL recorded inside the app (pass --org to be explicit)"
    return None, None


def _run_capture(cmd, shell=False, timeout=120):
    r = subprocess.run(cmd, capture_output=True, shell=shell, timeout=timeout)
    return r.returncode, r.stdout.decode("utf-8", "replace").strip(), r.stderr.decode("utf-8", "replace").strip()


def get_token(org, token_cmd=None, token_env="DATAVERSE_TOKEN"):
    """(token, how it was obtained). Raises LiveError. Never prints the token."""
    if token_env and os.environ.get(token_env):
        return os.environ[token_env].strip(), "environment variable %s" % token_env
    tried = []
    if token_cmd:
        rc, out, err = _run_capture(token_cmd.replace("{org}", org), shell=True)
        if rc == 0 and out:
            return out.splitlines()[-1].strip(), "--token-cmd"
        raise LiveError("--token-cmd failed (exit %d): %s" % (rc, err[-300:]))
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
    raise LiveError("no access token: tried %s. Sign in (az login / Connect-AzAccount) or pass "
                    "--token-cmd / set %s" % ("; ".join(tried), token_env))


class WebApi:
    """Read-only Dataverse Web API client. It only ever issues GET."""

    def __init__(self, org, token, timeout=90, opener=None):
        self.base = org.rstrip("/") + API
        self.token = token
        self.timeout = timeout
        self.opener = opener or urllib.request.build_opener()
        self.calls = 0

    def get(self, path):
        url = path if path.startswith("http") else self.base + path
        merged = None
        while url:
            body = self._get_one(url)
            if merged is None:
                merged = body
            else:
                merged.setdefault("value", []).extend(body.get("value") or [])
            url = body.get("@odata.nextLink") if isinstance(body, dict) else None
        if isinstance(merged, dict):
            merged.pop("@odata.nextLink", None)
        return merged

    def _get_one(self, url):
        url = urllib.parse.quote(url, safe=":/?&=$,()'@.%+-_~*")
        last = None
        for attempt in range(4):
            req = urllib.request.Request(url, method="GET", headers={
                "Authorization": "Bearer " + self.token, "Accept": "application/json",
                "OData-MaxVersion": "4.0", "OData-Version": "4.0",
                "Prefer": "odata.maxpagesize=5000"})
            self.calls += 1
            try:
                with self.opener.open(req, timeout=self.timeout) as r:
                    return json.loads(r.read().decode("utf-8", "replace"))
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    raise NotFound(url)
                if e.code in (401, 403):
                    raise LiveError("HTTP %d from the Web API - the token is not valid for this org, "
                                    "or the account cannot read metadata" % e.code)
                last = "HTTP %d" % e.code
                if e.code in (429, 500, 502, 503, 504):
                    time.sleep(float(e.headers.get("Retry-After") or (2 ** attempt)))
                    continue
                raise LiveError("%s for %s" % (last, url))
            except (urllib.error.URLError, OSError, ValueError) as e:
                last = str(e)
                time.sleep(2 ** attempt)
        raise LiveError("gave up after retries: %s" % last)


def fetch_table(api, logical):
    """Live metadata for one table, in the same shape cached_source() produces. Raises NotFound."""
    q = urllib.parse.quote(logical)
    ent = api.get("EntityDefinitions(LogicalName='%s')?$select=LogicalName,EntitySetName"
                  "&$expand=Attributes($select=LogicalName,SchemaName,DisplayName,AttributeType,"
                  "IsValidForRead,AttributeOf),ManyToOneRelationships($select=ReferencingAttribute,"
                  "ReferencingEntityNavigationPropertyName,ReferencedEntity)" % q)
    t = {"set": ent.get("EntitySetName"), "attributes": {}, "lookups": [], "choices": {}}
    for a in ent.get("Attributes") or []:
        if a.get("LogicalName"):
            t["attributes"][a["LogicalName"]] = attr_record(a)
    for r in ent.get("ManyToOneRelationships") or []:
        if r.get("ReferencingAttribute"):
            t["lookups"].append({"attr": r["ReferencingAttribute"],
                                 "nav": r.get("ReferencingEntityNavigationPropertyName"),
                                 "target": r.get("ReferencedEntity")})
    for kind in CHOICE_BUCKETS:
        expand = "OptionSet,GlobalOptionSet" if kind in RECONCILABLE_CHOICES else "OptionSet"
        d = api.get("EntityDefinitions(LogicalName='%s')/Attributes/Microsoft.Dynamics.CRM.%sAttributeMetadata"
                    "?$select=LogicalName&$expand=%s" % (q, kind, expand))
        for a in d.get("value") or []:
            oset = a.get("OptionSet") or {}
            opts = options_of(oset, kind)
            if not opts and a.get("GlobalOptionSet"):
                oset = a["GlobalOptionSet"]
                opts = options_of(oset, kind)
            t["choices"][a["LogicalName"]] = {"kind": kind, "name": oset.get("Name"),
                                              "global": bool(oset.get("IsGlobal")), "options": opts}
    return t


def fetch_live(api, logicals, workers=6, log=None):
    """{"entity_sets", "tables", "errors"} - a table maps to its metadata, {"missing": True}, or is
    absent (could not be read)."""
    live = {"format": DUMP_FORMAT, "captured_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "entity_sets": {}, "tables": {}, "errors": {}}
    d = api.get("EntityDefinitions?$select=LogicalName,EntitySetName")
    live["entity_sets"] = {e["LogicalName"]: e.get("EntitySetName") for e in d.get("value") or []
                           if e.get("LogicalName")}

    def one(ln):
        try:
            return ln, fetch_table(api, ln), None
        except NotFound:
            return ln, {"missing": True}, None
        except LiveError as e:
            return ln, None, str(e)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for ln, t, err in ex.map(one, sorted(set(logicals))):
            if t is not None:
                live["tables"][ln] = t
            else:
                live["errors"][ln] = err
            if log:
                log(ln, t, err)
    return live


def load_dump(path):
    d = jload(open(path, "rb").read())
    if not isinstance(d, dict) or d.get("format") != DUMP_FORMAT:
        raise LiveError("%s is not a metadata dump written by check-drift.py --dump (format %r)"
                        % (path, DUMP_FORMAT))
    d.setdefault("tables", {})
    d.setdefault("entity_sets", {})
    return d


def write_dump(live, path, org):
    out = {k: v for k, v in live.items() if k != "errors"}
    out["org"] = org
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, indent=1, sort_keys=True, ensure_ascii=False)


# --------------------------------------------------------------------------- comparison

def find_reference(label, logical, files):
    """'file:line' of the first formula that names this column, or None. Quoted display names
    always count; an identifier-shaped display name or logical name counts when it stands alone."""
    pats = []
    if label:
        pats.append(re.compile(r"'%s'" % re.escape(label)))
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", label):
            pats.append(re.compile(r"(?<![\w'])%s(?![\w'])" % re.escape(label)))
    if logical:
        pats.append(re.compile(r"(?<![\w'])%s(?![\w'])" % re.escape(logical)))
    for name, text in files:
        for p in pats:
            m = p.search(text)
            if m:
                return "%s:%d" % (name, text.count("\n", 0, m.start()) + 1)
    return None


def diff_options(cached, live):
    added = sorted((v for v in live if v not in cached), key=lambda x: (len(x), x))
    removed = sorted((v for v in cached if v not in live), key=lambda x: (len(x), x))
    relabelled = sorted((v for v in live if v in cached and cached[v] != live[v]), key=lambda x: (len(x), x))
    return added, removed, relabelled


class Findings(list):
    """A findings list that also counts what was compared, so a clean result can show it was
    not vacuous."""

    def __init__(self):
        super().__init__()
        self.compared = {}

    def count(self, what, n=1):
        self.compared[what] = self.compared.get(what, 0) + n


def finding(sev, check, src, what, breaks=None, fix=None, evidence=None):
    f = {"severity": sev, "check": check, "source": src.get("name"), "table": src.get("logical"),
         "what": what}
    if breaks:
        f["breaks"] = breaks
    if fix:
        f["fix"] = fix
    if evidence:
        f["evidence"] = evidence
    return f


def choice_findings(src, where, kind, cached_opts, live_opts, column, findings):
    findings.compared["choice sets"] = findings.compared.get("choice sets", 0) + 1
    added, removed, relabelled = diff_options(cached_opts, live_opts)
    fix = FIX_RESHIP if kind in RECONCILABLE_CHOICES else FIX_READD
    if added:
        findings.append(finding(
            "drift", "choice", src,
            "%s.%s (%s): live has member(s) the %s lacks: %s" % (
                src["logical"], column, kind, where,
                ", ".join('%s "%s"' % (v, live_opts[v]) for v in added[:8]) + (" ..." if len(added) > 8 else "")),
            "a formula naming the new member compiles (Studio reads live) and fails in the published app; "
            "in App.OnStart the throw abandons every statement after it", fix))
    if relabelled:
        findings.append(finding(
            "drift", "choice", src,
            "%s.%s (%s): label(s) differ in the %s: %s" % (
                src["logical"], column, kind, where,
                ", ".join('%s cached "%s" live "%s"' % (v, cached_opts[v], live_opts[v]) for v in relabelled[:6])),
            "text comparisons against the live label fail silently in the published app; member "
            "references bind to the cached name", fix))
    if removed:
        findings.append(finding(
            "note", "choice", src,
            "%s.%s (%s): the %s still lists member(s) live no longer has: %s" % (
                src["logical"], column, kind, where, ", ".join(removed[:8])),
            "nothing until a user picks one: the write is then rejected by Dataverse"))


def compare_app(pkg, live, files, player=None):
    """Findings for one app package against a live (or dumped) metadata dict."""
    findings, unverified, checked = Findings(), [], 0
    ldr = pkg.local_db_refs()
    sources = pkg.sources()
    for src in sources:
        lt = live["tables"].get(src["logical"])
        if lt is None:
            unverified.append(src["logical"])
            continue
        checked += 1
        if lt.get("missing"):
            findings.append(finding(
                "drift", "table", src, "%s: the app binds table %s, which the environment does not have"
                % (src["name"], src["logical"]),
                "every read and write of the source fails at run time; a formula that touches it is "
                "abandoned silently", "restore the table, or remove the source and every formula using it "
                "in Studio; Save AND Publish; re-ship from git"))
            continue
        want = lt.get("set") or live["entity_sets"].get(src["logical"])
        stale = []
        for place, have in (("DataSources.json EntitySetName", src["set"]),
                             ("TableDefinition", src["td_set"]),
                             ("Properties.json LocalDatabaseReferences", (ldr.get(src["name"]) or {}).get("entitySetName")),
                             ("solution <DatabaseReferences>", ((player or {}).get(src["name"]) or {}).get("entitySetName"))):
            if want and have and have != want:
                stale.append("%s=%s" % (place, have))
        if stale:
            findings.append(finding(
                "drift", "entity-set", src, "%s (%s): live entity set is %s; cached %s"
                % (src["name"], src["logical"], want, "; ".join(stale)),
                "the published app asks for a set the environment does not serve: \"Resource not found "
                "for the segment '<old>'\"; every read fails and a button that reads it does nothing",
                FIX_RESHIP))
        findings.count("entity sets")
        if not src["parsed"]:
            unverified.append(src["logical"] + " (TableDefinition unreadable: columns, choices, lookups not compared)")
            continue

        cached_attrs, live_attrs = src["attributes"], lt.get("attributes") or {}
        for ln, rec in sorted(live_attrs.items()):
            if not comparable_attr(ln, rec) or ln in cached_attrs:
                continue
            ev = find_reference(rec.get("display"), ln, files)
            if ev:
                findings.append(finding(
                    "drift", "column", src, "%s: column '%s' (%s) exists live but not in the app's cached "
                    "column list, and a formula uses it" % (src["name"], rec.get("display"), ln),
                    "the published app cannot bind it; the formula is abandoned in silence (dead button), and "
                    "in a measured case every read of the table came back empty", FIX_READD, ev))
            else:
                findings.append(finding(
                    "note", "column", src, "%s: new column '%s' (%s) is not in the cache; nothing references it yet"
                    % (src["name"], rec.get("display"), ln),
                    "nothing yet - it becomes a dead formula the day one names it before the source is re-added"))
        for ln, rec in sorted(cached_attrs.items()):
            if not comparable_attr(ln, rec):
                continue
            lrec = live_attrs.get(ln)
            findings.count("columns")
            if lrec is None:
                ev = find_reference(rec.get("display"), ln, files)
                findings.append(finding(
                    "drift" if ev else "note", "column", src,
                    "%s: cached column '%s' (%s) no longer exists live%s" % (
                        src["name"], rec.get("display"), ln, "" if ev else "; nothing references it"),
                    "reads and writes that name it fail at run time" if ev else None,
                    "remove the references, then remove and re-add the source in Studio; Save AND Publish; re-ship"
                    if ev else None, ev))
                continue
            if rec.get("type") and lrec.get("type") and rec["type"] != lrec["type"]:
                findings.append(finding(
                    "drift", "column-type", src, "%s.%s: cached type %s, live type %s"
                    % (src["logical"], ln, rec["type"], lrec["type"]),
                    "the player decodes the column as %s while Dataverse returns %s - e.g. a choice's integer "
                    "where text is expected, so label comparisons fail and dialogs lose their content, with "
                    "no error" % (rec["type"], lrec["type"]), FIX_TYPE))
            if rec.get("display") and lrec.get("display") and rec["display"] != lrec["display"]:
                ev = find_reference(rec["display"], None, files)
                if ev:
                    findings.append(finding(
                        "note", "column", src, "%s.%s: display name renamed live '%s' -> '%s'; formulas still "
                        "use the old name" % (src["logical"], ln, rec["display"], lrec["display"]),
                        "nothing until the source is next refreshed in Studio; then every formula naming "
                        "'%s' stops binding" % rec["display"],
                        "refresh the source and rewrite every reference in the same change", ev))
            if rec.get("type") in LOOKUP_TYPES and lrec.get("schema") and rec.get("schema") \
                    and rec["schema"] != lrec["schema"]:
                findings.append(finding(
                    "drift", "lookup", src, "%s.%s: lookup schema name cached %r, live %r"
                    % (src["logical"], ln, rec["schema"], lrec["schema"]),
                    "a lookup field is keyed by its schema/navigation name, case included; the column "
                    "cannot be read or written, and the error names the column as its own closest match",
                    FIX_RESHIP))

        live_lk = {}
        for r in lt.get("lookups") or []:
            live_lk.setdefault(r["attr"], []).append(r)
        for r in src["lookups"]:
            if r["attr"] in SYSTEM_ATTRS or r["attr"] not in live_lk:
                continue
            findings.count("lookups")
            same = [x for x in live_lk[r["attr"]] if x.get("target") == r.get("target")]
            if not same:
                findings.append(finding(
                    "drift", "lookup", src, "%s.%s: cached lookup targets %s; live targets %s" % (
                        src["logical"], r["attr"], r.get("target"),
                        ", ".join(sorted(set(str(x.get("target")) for x in live_lk[r["attr"]])))),
                    "the published app fails with \"Could not find a property named ...\" on reads and "
                    "writes through the lookup; compile stays clean", FIX_READD))
            elif r.get("nav") and same[0].get("nav") and r["nav"] != same[0]["nav"]:
                findings.append(finding(
                    "drift", "lookup", src, "%s.%s: navigation property cached %r, live %r%s" % (
                        src["logical"], r["attr"], r["nav"], same[0]["nav"],
                        " (differs by case only)" if r["nav"].lower() == same[0]["nav"].lower() else ""),
                    "OData navigation names are case sensitive: every $expand and @odata.bind through this "
                    "lookup fails, so reads and writes of it fail in the published app", FIX_RESHIP))

        live_ch = lt.get("choices") or {}
        for col, ch in sorted(src["choices"].items()):
            lch = live_ch.get(col)
            if lch is None or not lch.get("options") or not ch["options"]:
                continue
            choice_findings(src, "TableDefinition cache (the copy the player reads)", ch["kind"],
                            ch["options"], lch["options"], col, findings)

    by_logical = {s["logical"]: s for s in sources}
    for info in pkg.optionset_infos():
        src = by_logical.get(info["table"])
        if not src:
            continue
        lt = live["tables"].get(info["table"])
        if not lt or lt.get("missing"):
            continue
        lch = (lt.get("choices") or {}).get(info["column"])
        if not lch or not lch.get("options"):
            continue
        choice_findings(src, "OptionSetInfo cache (%s)" % info["name"], info["kind"], info["options"],
                        lch["options"], info["column"], findings)

    if player is not None:
        findings.count("player list", len(player))
        bound = {s["name"]: s for s in sources}
        for name in sorted(set(bound) - set(player)):
            findings.append(finding(
                "drift", "dbrefs", bound[name], "%s (%s): bound by the app but missing from the solution's "
                "<DatabaseReferences>" % (name, bound[name]["logical"]),
                "dead in the published app: the player never initialises it, issues no request, and "
                "CountRows() on it errors; a source the app only writes to fails with no visible symptom",
                "re-ship with ship-canvas.py, which rewrites <DatabaseReferences>/<CdsDependencies> from "
                "DataSources.json; never import a solution built from a stale solution/src"))
        for name in sorted(set(player) - set(bound)):
            findings.append(finding(
                "note", "dbrefs", {"name": name, "logical": (player[name] or {}).get("logicalName")},
                "%s: listed in <DatabaseReferences> but the app no longer binds it" % name))
        for name in sorted(set(player) & set(bound)):
            p, b = player[name] or {}, bound[name]
            if p.get("logicalName") and p["logicalName"] != b["logical"]:
                findings.append(finding(
                    "drift", "dbrefs", b, "%s: <DatabaseReferences> says logical %r, the app binds %r"
                    % (name, p["logicalName"], b["logical"]),
                    "the player initialises a different table under this name", FIX_RESHIP))
    return findings, unverified, checked, len(sources)


# --------------------------------------------------------------------------- CLI

def load_config(path):
    if path:
        return jload(open(path, "rb").read()) or {}
    for cand in (os.path.join("scripts", "canvas-app.json"), "canvas-app.json"):
        if os.path.isfile(cand):
            return jload(open(cand, "rb").read()) or {}
    return {}


def src_files(directory):
    out = []
    for root, _, files in os.walk(directory):
        for f in sorted(files):
            if f.endswith(".pa.yaml"):
                p = os.path.join(root, f)
                out.append((norm(os.path.relpath(p, directory)), open(p, encoding="utf-8", errors="replace").read()))
    return out


def print_report(results, meta):
    print("check-drift  %s" % meta["artifact"])
    print("  live metadata : %s" % meta["live"])
    for r in results:
        print("  canvas app    : %s   (LoadFromYaml=%s; formulas searched: %s, %d file(s))"
              % (r["app"], r["load_from_yaml"], r["formulas_from"], r["formula_files"]))
        print("  tables bound  : %d   compared: %d   could not verify: %d"
              % (r["tables"], r["checked"], len(r["unverified"])))
        print("  compared      : %s" % (", ".join("%d %s" % (v, k) for k, v in sorted(r["compared"].items()))
                                       or "nothing"))
    print()
    drift = [f for r in results for f in r["findings"] if f["severity"] == "drift"]
    notes = [f for r in results for f in r["findings"] if f["severity"] == "note"]
    for f in drift + notes:
        print("%-5s  [%s]  %s" % ("DRIFT" if f["severity"] == "drift" else "note", f["check"], f["what"]))
        if f.get("evidence"):
            print("       used at: %s" % f["evidence"])
        if f.get("breaks"):
            print("       breaks:  %s" % f["breaks"])
        if f.get("fix"):
            print("       fix:     %s" % f["fix"])
    for r in results:
        for u in r["unverified"]:
            print("UNVERIFIED  %s - live metadata could not be read; nothing about it was compared" % u)
    print()
    print("summary: %d drift, %d note(s), %d table(s) unverified" % (
        len(drift), len(notes), sum(len(r["unverified"]) for r in results)))


def run(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("artifact", nargs="?")
    ap.add_argument("--org")
    ap.add_argument("--config")
    ap.add_argument("--token-cmd")
    ap.add_argument("--token-env", default="DATAVERSE_TOKEN")
    ap.add_argument("--offline")
    ap.add_argument("--dump")
    ap.add_argument("--src")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.artifact:
        ap.error("an artifact path is required")
    if a.offline and a.dump:
        ap.error("--dump writes LIVE metadata; it cannot be combined with --offline")

    try:
        apps = load_artifact(a.artifact)
    except (ArtifactError, OSError, ValueError, KeyError) as e:
        print("could not read %s: %s - this is NOT a pass" % (a.artifact, e))
        return 2

    logicals = sorted({s["logical"] for pkg, _ in apps for s in pkg.sources()})
    if not logicals:
        print("%s binds no Dataverse tables - nothing to compare. This is NOT a pass." % a.artifact)
        return 2
    try:
        if a.offline:
            live = load_dump(a.offline)
            desc = "saved dump %s (captured %s%s) - it describes the environment as it was then" % (
                a.offline, live.get("captured_utc", "?"), ", org " + live["org"] if live.get("org") else "")
        else:
            config = load_config(a.config)
            org, how = resolve_org(a.org, config, apps[0][0])
            if not org:
                print("no org URL: pass --org or set environmentUrl in scripts/canvas-app.json - NOT a pass")
                return 2
            token, tok_how = get_token(org, a.token_cmd, a.token_env)
            api = WebApi(org, token)
            if not a.json:
                print("reading live metadata for %d table(s) from %s (org from %s; token from %s)..."
                      % (len(logicals), org, how, tok_how), flush=True)
            live = fetch_live(api, logicals)
            desc = "%s, read live (%d GET request(s), token from %s)" % (org, api.calls, tok_how)
            if a.dump:
                write_dump(live, a.dump, org)
                desc += "; dump written to %s" % a.dump
    except LiveError as e:
        print("could not reach live metadata: %s - this is NOT a pass" % e)
        return 2
    except OSError as e:
        print("could not read metadata: %s - this is NOT a pass" % e)
        return 2

    results = []
    for pkg, player in apps:
        if a.src:
            half, files = "--src " + a.src, src_files(a.src)
        else:
            half, files = pkg.formula_files()
        findings, unverified, checked, total = compare_app(pkg, live, files, player)
        if not files:
            unverified.append("formula references (no .pa.yaml or Controls/*.json to search - a missing "
                              "column cannot be told apart from an unused one)")
        for ln, err in (live.get("errors") or {}).items():
            unverified = [u if u != ln else "%s (%s)" % (ln, err) for u in unverified]
        results.append({"app": pkg.label, "load_from_yaml": pkg.load_from_yaml, "formulas_from": half,
                        "formula_files": len(files), "tables": total, "checked": checked,
                        "compared": dict(findings.compared),
                        "unverified": unverified, "findings": findings})

    meta = {"artifact": a.artifact, "live": desc}
    if a.json:
        print(json.dumps({"meta": meta, "apps": results}, indent=2, ensure_ascii=False))
    else:
        print_report(results, meta)

    drift = any(f["severity"] == "drift" for r in results for f in r["findings"])
    unver = any(r["unverified"] for r in results)
    if not any(r["checked"] for r in results):
        if not a.json:
            print("live metadata could not be read for ANY bound table - this is NOT a pass")
        return 2
    if drift:
        return 1
    if unver:
        if not a.json:
            print("no drift among the tables compared, but some could not be verified - NOT a pass")
        return 2
    if not a.json:
        print("no drift. This proves the cached metadata matches the environment it was compared with - "
              "not that the app works; perform the task in the published app.")
    return 0


# --------------------------------------------------------------------------- selftest

def _label(text):
    return {"LocalizedLabels": [{"Label": text, "LanguageCode": 1033}],
            "UserLocalizedLabel": {"Label": text, "LanguageCode": 1033}}


def _option(value, text):
    return {"Value": value, "Label": _label(text), "MetadataId": None}


def fixture_table(logical="app_order", entity_set="app_orders", status_opts=None, priority_opts=None,
                  extra_attrs=(), nav="app_customer", customer_schema="app_customer",
                  target="core_customer", total_type="Decimal"):
    """Live-shaped metadata for one synthetic table, used for both sides of the fixtures."""
    priority_opts = priority_opts or {"1": "Low", "2": "High"}
    status_opts = status_opts or {"1": "Active", "2": "Inactive"}
    attrs = {
        "app_orderid": {"schema": "app_OrderId", "display": "Order", "type": "Uniqueidentifier", "attributeOf": None, "read": True},
        "app_name": {"schema": "app_Name", "display": "Name", "type": "String", "attributeOf": None, "read": True},
        "app_total": {"schema": "app_Total", "display": "Order Total", "type": total_type, "attributeOf": None, "read": True},
        "app_priority": {"schema": "app_Priority", "display": "Priority", "type": "Picklist", "attributeOf": None, "read": True},
        "app_customer": {"schema": customer_schema, "display": "Customer", "type": "Lookup", "attributeOf": None, "read": True},
        "app_customername": {"schema": "app_customerName", "display": None, "type": "String", "attributeOf": "app_customer", "read": True},
        "statuscode": {"schema": "StatusCode", "display": "Status Reason", "type": "Status", "attributeOf": None, "read": True},
        "createdon": {"schema": "CreatedOn", "display": "Created On", "type": "DateTime", "attributeOf": None, "read": True},
    }
    for ln, disp, typ in extra_attrs:
        attrs[ln] = {"schema": ln, "display": disp, "type": typ, "attributeOf": None, "read": True}
    return {"set": entity_set,
            "attributes": attrs,
            "lookups": [{"attr": "app_customer", "nav": nav, "target": target},
                        {"attr": "createdby", "nav": "createdby", "target": "systemuser"}],
            "choices": {"app_priority": {"kind": "Picklist", "name": "app_priority", "global": True, "options": priority_opts},
                        "statuscode": {"kind": "Status", "name": "app_order_statuscode", "global": False, "options": status_opts}}}


def fixture_entry(t, logical="app_order", name="Orders"):
    """A NativeCDSDataSourceInfo entry with TableDefinition nested as JSON strings, like the real thing."""
    em = {"LogicalName": logical, "EntitySetName": t["set"], "Attributes": [], "ManyToOneRelationships": []}
    for ln, r in t["attributes"].items():
        em["Attributes"].append({"LogicalName": ln, "SchemaName": r["schema"], "AttributeType": r["type"],
                                 "AttributeOf": r["attributeOf"], "IsValidForRead": r["read"],
                                 "DisplayName": _label(r["display"]) if r["display"] else {"LocalizedLabels": [], "UserLocalizedLabel": None}})
    for l in t["lookups"]:
        em["ManyToOneRelationships"].append({"ReferencingAttribute": l["attr"], "ReferencedEntity": l["target"],
                                             "ReferencingEntityNavigationPropertyName": l["nav"],
                                             "SchemaName": "%s_%s" % (logical, l["attr"])})
    td = {"TableName": logical, "EntityMetadata": json.dumps(em)}
    for kind, bucket in CHOICE_BUCKETS.items():
        vals = []
        for col, ch in t["choices"].items():
            if ch["kind"] != kind:
                continue
            vals.append({"LogicalName": col, "SchemaName": col,
                         "OptionSet": {"Name": ch["name"], "IsGlobal": ch["global"],
                                       "Options": [_option(int(v), lab) for v, lab in ch["options"].items()]}})
        td[bucket] = json.dumps({"@odata.context": "x", "value": vals})
    return {"Name": name, "Type": "NativeCDSDataSourceInfo", "DatasetName": "default.cds",
            "EntitySetName": t["set"], "LogicalName": logical, "TableDefinition": json.dumps(td)}


def fixture_msapp(t, formulas, load_from_yaml=True, info_opts=None, ldr_set=None, prefix=""):
    """Bytes of a minimal .msapp (or, with prefix 'msapp/', the inside of a .msapr)."""
    entry = fixture_entry(t)
    info = {"Type": "OptionSetInfo", "Name": "app_priority", "DatasetName": "default.cds",
            "RelatedEntityName": "Orders", "RelatedColumnInvariantName": "app_priority",
            "OptionSetInfoNameMapping": info_opts or t["choices"]["app_priority"]["options"],
            "OptionSetIsGlobal": True, "OptionSetTypeKey": "PicklistType"}
    ldr = {"default.cds": {"instanceUrl": "https://example.invalid/", "dataSources": {
        "Orders": {"entitySetName": ldr_set or t["set"], "logicalName": "app_order"}}}}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(prefix + "References/DataSources.json", json.dumps({"DataSources": [info, entry]}, indent=2))
        z.writestr(prefix + "Properties.json", json.dumps({"Name": "Fixture", "LocalDatabaseReferences": json.dumps(ldr)}))
        z.writestr(prefix + "packed.json", json.dumps({"LoadConfiguration": {"LoadFromYaml": load_from_yaml}}))
        z.writestr(prefix + "Header.json", "{}")
        if not prefix:
            z.writestr("Src/App.pa.yaml", "App:\n  Properties:\n    OnStart: |-\n      =Set(gblBuild, \"unshipped\");\n")
            z.writestr("Src/Main.pa.yaml", formulas)
            z.writestr("Controls/1.json", json.dumps({"formula": "Old half"}))
    return buf.getvalue()


def fixture_solution(msapp_bytes, sources, app="app_fixture_1a2b3", roles=True, entities=("app_order",)):
    db = {"default.cds": {"databaseDetails": {"referenceType": "Environmental"}, "dataSources": sources}}
    deps = {"cdsdependencies": [{"componenttype": 1, "logicalname": v["logicalName"]} for v in sources.values()]}
    cx = ('<?xml version="1.0" encoding="utf-8"?><ImportExportXml><Entities>' +
          "".join("<Entity><Name>%s</Name></Entity>" % e for e in entities) + '</Entities>'
          '<Roles>%s</Roles><CanvasApps><CanvasApp><Name>%s</Name><DatabaseReferences>%s</DatabaseReferences>'
          '<CdsDependencies>%s</CdsDependencies><DocumentUri>/CanvasApps/%s_DocumentUri.msapp</DocumentUri>'
          '</CanvasApp></CanvasApps></ImportExportXml>') % (
        '<Role id="{0}" name="App User"></Role>' if roles else "", app, json.dumps(db), json.dumps(deps), app)
    roots = "".join('<RootComponent type="1" schemaName="%s" behavior="0" />' % e for e in entities)
    roots += '<RootComponent type="300" schemaName="%s" behavior="0" />' % app
    if roles:
        roots += '<RootComponent type="20" id="{00000000-0000-0000-0000-000000000001}" behavior="0" />'
    sx = ('<?xml version="1.0" encoding="utf-8"?><ImportExportXml><SolutionManifest><UniqueName>Fixture</UniqueName>'
          '<Version>1.0.0.4</Version><Managed>0</Managed><RootComponents>%s</RootComponents>'
          '</SolutionManifest></ImportExportXml>') % roots
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("solution.xml", b"\xef\xbb\xbf" + sx.encode("utf-8"))
        z.writestr("customizations.xml", b"\xef\xbb\xbf" + cx.encode("utf-8"))
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("CanvasApps/%s_DocumentUri.msapp" % app, msapp_bytes)
    return buf.getvalue()


FIXTURE_FORMULAS = ("Screens:\n  Main:\n    Children:\n      - Btn:\n          Properties:\n"
                    "            OnSelect: =Patch(Orders, Defaults(Orders), {'Order Total': 5, Priority: 'Priority'.High})\n")


def fixture_dump(t, extra_tables=None):
    tables = {"app_order": t}
    tables.update(extra_tables or {})
    return {"format": DUMP_FORMAT, "captured_utc": "fixture", "entity_sets": {"app_order": t["set"], "core_customer": "core_customers"},
            "tables": tables}


def selftest():
    import tempfile
    failures = []

    def check(name, cond):
        print("  %s  %s" % ("ok  " if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    def run_quiet(argv):
        buf, old = io.StringIO(), sys.stdout
        sys.stdout = buf
        try:
            rc = run(argv)
        finally:
            sys.stdout = old
        return rc, buf.getvalue()

    tmp = tempfile.mkdtemp(prefix="check-drift-selftest-")
    try:
        def write(name, data):
            p = os.path.join(tmp, name)
            with open(p, "wb" if isinstance(data, bytes) else "w") as f:
                f.write(data)
            return p

        base = fixture_table()
        app = write("clean.msapp", fixture_msapp(base, FIXTURE_FORMULAS))
        dump = write("live.json", json.dumps(fixture_dump(base)))

        def drift_of(live_table, msapp_path=None, **kw):
            d = write("d.json", json.dumps(fixture_dump(live_table, **kw)))
            rc, out = run_quiet([msapp_path or app, "--offline", d, "--json"])
            rep = jload(out) if out.strip().startswith("{") else None
            fs = [f for r in (rep or {}).get("apps", []) for f in r["findings"]]
            return rc, fs, out

        print("check-drift selftest")
        rc, out = run_quiet([app, "--offline", dump])
        check("clean app vs matching metadata exits 0", rc == 0)

        rc, fs, _ = drift_of(fixture_table(entity_set="app_orderses"))
        check("entity set renamed live -> drift, all cached places named",
              rc == 1 and any(f["check"] == "entity-set" and "TableDefinition" in f["what"]
                              and "LocalDatabaseReferences" in f["what"] for f in fs))

        rc, fs, _ = drift_of(fixture_table(priority_opts={"1": "Low", "2": "High", "3": "Urgent"}))
        kinds = [f["what"] for f in fs if f["check"] == "choice" and "3" in f["what"]]
        check("choice member added live -> drift in BOTH caches",
              rc == 1 and any("TableDefinition" in k for k in kinds) and any("OptionSetInfo" in k for k in kinds))

        stale_info = write("info.msapp", fixture_msapp(base, FIXTURE_FORMULAS, info_opts={"1": "Low"}))
        rc, fs, _ = drift_of(base, stale_info)
        check("only cache 1 stale -> drift reported for cache 1 alone",
              rc == 1 and all("OptionSetInfo" in f["what"] for f in fs if f["check"] == "choice") and fs)

        rc, fs, _ = drift_of(fixture_table(priority_opts={"1": "Low", "2": "Critical"}))
        check("choice relabelled live -> drift", rc == 1 and any("Critical" in f["what"] for f in fs))

        rc, fs, _ = drift_of(fixture_table(priority_opts={"1": "Low"}))
        check("choice member removed live -> note only, exit 0",
              rc == 0 and fs and all(f["severity"] == "note" for f in fs))

        rc, fs, _ = drift_of(fixture_table(status_opts={"1": "Active", "2": "Inactive", "3": "On Hold"}))
        check("status reason added live -> drift, fix is a Studio re-add (not reconciled)",
              rc == 1 and any(f["check"] == "choice" and "Remove" in f.get("fix", "") for f in fs))

        rc, fs, _ = drift_of(fixture_table(nav="app_Customer", customer_schema="app_Customer"))
        check("lookup navigation property re-cased live -> drift (case only flagged)",
              rc == 1 and any(f["check"] == "lookup" and "case only" in f["what"] for f in fs))

        rc, fs, _ = drift_of(fixture_table(target="core_account"))
        check("lookup re-targeted live -> drift", rc == 1 and any("targets" in f["what"] for f in fs))

        rc, fs, _ = drift_of(fixture_table(total_type="String"))
        check("column type changed live -> drift", rc == 1 and any(f["check"] == "column-type" for f in fs))

        rc, fs, _ = drift_of(fixture_table(extra_attrs=[("app_region", "Region", "String")]))
        check("new live column nothing uses -> note, exit 0",
              rc == 0 and any(f["check"] == "column" and f["severity"] == "note" for f in fs))

        uses = write("uses.msapp", fixture_msapp(base, FIXTURE_FORMULAS + "            Text: =ThisItem.'Ship Date'\n"))
        rc, fs, _ = drift_of(fixture_table(extra_attrs=[("app_shipdate", "Ship Date", "DateTime")]), uses)
        check("new live column a formula uses -> drift with file:line evidence",
              rc == 1 and any(f["check"] == "column" and f["severity"] == "drift" and ":" in f.get("evidence", "") for f in fs))

        gone = fixture_table()
        del gone["attributes"]["app_total"]
        rc, fs, _ = drift_of(gone)
        check("cached column deleted live while referenced -> drift", rc == 1 and any("no longer exists" in f["what"] for f in fs))

        rc, fs, _ = drift_of(base, extra_tables=None)
        d = fixture_dump(base)
        d["tables"]["app_order"] = {"missing": True}
        rc, out = run_quiet([app, "--offline", write("m.json", json.dumps(d))])
        check("table deleted live -> drift", rc == 1 and "does not have" in out)

        d = fixture_dump(base)
        del d["tables"]["app_order"]
        rc, out = run_quiet([app, "--offline", write("u.json", json.dumps(d))])
        check("table absent from the dump -> exit 2 (unverified, never a pass)", rc == 2)

        rc, out = run_quiet([write("junk.msapp", b"not a zip"), "--offline", dump])
        check("unreadable artifact -> exit 2", rc == 2 and "NOT a pass" in out)

        rc, out = run_quiet([app, "--offline", write("bad.json", "{}")])
        check("dump in the wrong format -> exit 2", rc == 2)

        # The Controls/ half must be ignored when Src/ runs, and searched when it does not.
        pkg = AppPackage("x", read_zip(fixture_msapp(base, FIXTURE_FORMULAS, load_from_yaml=False)))
        check("LoadFromYaml false -> formulas read from Controls/", pkg.formula_files()[0] == "Controls/")

        msapr = write("app.msapr", fixture_msapp(fixture_table(entity_set="app_orderses"), "", prefix="msapp/"))
        rc, out = run_quiet([msapr, "--offline", dump])
        check(".msapr layout (msapp/References/...) is read", rc == 1 and "entity-set" in out)

        # Solution zip: the player list vs the app list, by name and by value.
        good_refs = {"Orders": {"entitySetName": "app_orders", "logicalName": "app_order"}}
        sol = write("sol.zip", fixture_solution(fixture_msapp(base, FIXTURE_FORMULAS), good_refs))
        rc, out = run_quiet([sol, "--offline", dump])
        check("solution with player list in step -> exit 0", rc == 0)
        sol = write("sol2.zip", fixture_solution(fixture_msapp(base, FIXTURE_FORMULAS), {}))
        rc, out = run_quiet([sol, "--offline", dump])
        check("source missing from <DatabaseReferences> -> drift (dead in the player)", rc == 1 and "dbrefs" in out)
        sol = write("sol3.zip", fixture_solution(fixture_msapp(base, FIXTURE_FORMULAS),
                                                 {"Orders": {"entitySetName": "app_orderses", "logicalName": "app_order"}}))
        rc, out = run_quiet([sol, "--offline", dump])
        check("<DatabaseReferences> entity set stale by value -> drift", rc == 1 and "solution <DatabaseReferences>" in out)

        # The live path, end to end, against a local HTTP server: GET only, paging, 404 = missing.
        rc_live, seen = _selftest_http(base, app, write, run_quiet)
        check("live mode reads a Web API with GET only, follows nextLink, writes a usable --dump",
              rc_live == 0 and seen and all(m == "GET" for m, _ in seen))
        rc, out = run_quiet([app, "--offline", os.path.join(tmp, "from-live.json")])
        check("--dump written in live mode replays offline with the same result", rc == 0)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    print("selftest: %s" % ("PASSED" if not failures else "FAILED %d: %s" % (len(failures), ", ".join(failures))))
    return 0 if not failures else 1


def _selftest_http(table, app_path, write, run_quiet):
    import http.server
    import threading
    seen = []
    em_payload = {"LogicalName": "app_order", "EntitySetName": table["set"],
                  "Attributes": [{"LogicalName": ln, "SchemaName": r["schema"], "AttributeType": r["type"],
                                  "AttributeOf": r["attributeOf"], "IsValidForRead": r["read"],
                                  "DisplayName": _label(r["display"]) if r["display"] else {}}
                                 for ln, r in table["attributes"].items()],
                  "ManyToOneRelationships": [{"ReferencingAttribute": l["attr"], "ReferencedEntity": l["target"],
                                              "ReferencingEntityNavigationPropertyName": l["nav"]} for l in table["lookups"]]}

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            seen.append(("GET", self.path))
            if self.headers.get("Authorization") != "Bearer fixture-token":
                return self._send(401, {})
            p = urllib.parse.unquote(self.path)
            host = "http://127.0.0.1:%d" % self.server.server_port
            if p.startswith(API + "EntityDefinitions?"):
                if "page2" in p:
                    return self._send(200, {"value": [{"LogicalName": "core_customer", "EntitySetName": "core_customers"}]})
                return self._send(200, {"value": [{"LogicalName": "app_order", "EntitySetName": table["set"]}],
                                        "@odata.nextLink": host + API + "EntityDefinitions?$select=LogicalName&page2=1"})
            if "LogicalName='app_order'" not in p:
                return self._send(404, {})
            for kind in CHOICE_BUCKETS:
                if "Microsoft.Dynamics.CRM.%sAttributeMetadata" % kind in p:
                    vals = [{"LogicalName": c, "OptionSet": {"Name": ch["name"], "IsGlobal": ch["global"],
                                                             "Options": [_option(int(v), l) for v, l in ch["options"].items()]}}
                            for c, ch in table["choices"].items() if ch["kind"] == kind]
                    return self._send(200, {"value": vals})
            return self._send(200, em_payload)

        def do_POST(self):
            seen.append(("POST", self.path))
            self._send(405, {})

        do_PATCH = do_PUT = do_DELETE = do_POST

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    try:
        os.environ["CHECK_DRIFT_SELFTEST_TOKEN"] = "fixture-token"
        dump_path = os.path.join(os.path.dirname(app_path), "from-live.json")
        rc, out = run_quiet([app_path, "--org", "http://127.0.0.1:%d" % srv.server_port,
                             "--token-env", "CHECK_DRIFT_SELFTEST_TOKEN", "--dump", dump_path])
        if "fixture-token" in out:
            return 99, seen
        return rc, seen
    finally:
        os.environ.pop("CHECK_DRIFT_SELFTEST_TOKEN", None)
        srv.shutdown()


def main():
    return run(sys.argv[1:])


if __name__ == "__main__":
    sys.exit(main())
