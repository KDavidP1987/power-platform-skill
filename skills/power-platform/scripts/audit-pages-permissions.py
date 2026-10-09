#!/usr/bin/env python3
"""audit-pages-permissions.py - audit a Power Pages site's data security from its source.

Reads a site folder written by `pac pages download --modelVersion 2` and compares what the site's
code does with what its configuration allows:

  table permissions   table, scope, privileges, parent, web roles
  Web API settings    Webapi/<table>/enabled, /fields, /UseFieldsFromView, Webapi/error/innererror
  site code           Liquid {% fetchxml %} reads, Pages Web API calls (/_api/<entity set>) with
                      their method, the columns written and the lookups bound (@odata.bind)
  server logic        server-logic/*.js: Server.Connector.Dataverse calls (direct, or through a helper
                      that passes its first parameter on) and the lookups they bind (@odata.bind);
                      /_api/serverlogics/<name> is the endpoint, never a table
  header settings     HTTP/Content-Security-Policy, HTTP/X-Frame-Options, CORS, SameSite
  Liquid names        LIQUID-CASE-CLASH: variables that differ only by case in a page and the
                      templates it includes (Liquid names ignore case and includes share scope)

Usage:
    python audit-pages-permissions.py <site folder> [options]

Options:
    --url URL           also read the live site's response headers with ONE anonymous GET (no
                        redirects followed, nothing sent but the request); reports CSP, framing,
                        HSTS, cookies and whether an anonymous visitor is sent to sign-in
    --entity-sets JSON  {"<entity set>": "<logical name>"} for sets the plural rule cannot map
    --sensitive REGEX   columns that must not be client-writable (default: process columns such as
                        stage, status, owner, decision, score, rank, approval)
    --json              machine-readable report
    --selftest          run the built-in tests on synthetic site folders and exit

Severities: critical (data exposed, or the site's own code will be refused), warning (broader than
the code needs, or a setting to review), info (inventory notes). Exit 0 when there is no critical or
warning finding, 1 when there is, 2 when nothing was examined (no permissions, settings or code).

It reads files only (and, with --url, one anonymous GET). It never signs in, never calls Dataverse,
never changes the site. It cannot see column permissions, the "Power Pages Web API Columns" view,
or anything configured only in the studio since the last download - download first.

Row exposure: Web API enabled on a table that any role reads with Global scope is reported as
WEBAPI-GLOBAL-READ (every row is reachable through /_api whatever the pages show), and a wildcard
allow-list on a table the roles may create in or write to as WEBAPI-WILDCARD-WRITE. Global read with
the Web API off only by default is GLOBAL-READ-UNGUARDED (one setting away from exposure); with
Webapi/<table>/enabled = false set explicitly it is GLOBAL-READ-GUARDED (info).

Privilege rule used: a lookup the code binds through the Web API needs Append AND Append To on
both tables (measured on a real site; the documented one-sided rule returned 403), so the audit
expects both on every table in a bind and flags them only on tables in no bind. A bind made in
server logic follows the same rule (measured: CreateRecord with binds returned 403 until it held).
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCOPES = {"756150000": "Global", "756150001": "Contact", "756150002": "Account",
          "756150003": "Parent", "756150004": "Self", "756150005": "Custom"}
PRIVS = ["read", "write", "create", "delete", "append", "appendto"]
DEFAULT_SENSITIVE = r"(^|_)(stage|status|statecode|statuscode|owner|ownerid|decision|decided|score|rank|priority|approv\w*|reviewer|assignee|internal\w*)$"
CODE_EXT = (".html", ".js", ".liquid", ".htm")


# --------------------------------------------------------------------------- minimal YAML reader
# pac pages writes plain YAML: a mapping or a list of mappings, scalars, quoted scalars, folded
# block scalars and lists of scalars under a key. This reads exactly that, so no PyYAML is needed.

def _scalar(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        inner = v[1:-1]
        return inner.replace("''", "'") if v[0] == "'" else inner
    return v


def read_yaml(path):
    with open(path, encoding="utf-8-sig") as f:
        lines = f.read().splitlines()
    records, cur = [], None
    i = 0
    is_list = any(l.startswith("- ") for l in lines if l.strip())

    def put(rec, key, val, base_indent, idx):
        # block scalar or nested list follows?
        if val in (">-", ">", "|", "|-", ">+", "|+"):
            parts, j = [], idx + 1
            while j < len(lines) and (not lines[j].strip() or len(lines[j]) - len(lines[j].lstrip()) > base_indent):
                parts.append(lines[j].strip()); j += 1
            rec[key] = " ".join(p for p in parts if p)
            return j
        if val == "":
            items, j = [], idx + 1
            while j < len(lines) and lines[j].strip().startswith("- ") and len(lines[j]) - len(lines[j].lstrip()) >= base_indent:
                items.append(_scalar(lines[j].strip()[2:])); j += 1
            rec[key] = items if items else ""
            return j
        rec[key] = _scalar(val)
        return idx + 1

    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1; continue
        if is_list and line.startswith("- "):
            cur = {}; records.append(cur)
            body = line[2:]
            m = re.match(r"([^:]+):\s?(.*)$", body)
            if m:
                i = put(cur, m.group(1).strip(), m.group(2), 2, i)
            else:
                i += 1
            continue
        indent = len(line) - len(line.lstrip())
        m = re.match(r"\s*([^:]+):\s?(.*)$", line)
        if not m:
            i += 1; continue
        if cur is None:
            cur = {}; records.append(cur)
        i = put(cur, m.group(1).strip(), m.group(2), indent, i)
    return records


def truthy(v):
    return str(v).strip().lower() == "true"


# --------------------------------------------------------------------------- site model

def find_site_root(path):
    """Accept the site folder itself or a parent holding exactly one site folder."""
    if os.path.isdir(os.path.join(path, "table-permissions")) or os.path.isfile(os.path.join(path, "sitesetting.yml")):
        return path
    subs = [os.path.join(path, d) for d in os.listdir(path) if os.path.isdir(os.path.join(path, d))]
    hits = [s for s in subs if os.path.isfile(os.path.join(s, "sitesetting.yml")) or os.path.isdir(os.path.join(s, "table-permissions"))]
    return hits[0] if len(hits) == 1 else path


def load_site(root):
    site = {"permissions": [], "roles": {}, "settings": {}, "code_files": [], "server_files": []}
    tp = os.path.join(root, "table-permissions")
    if os.path.isdir(tp):
        for fn in sorted(os.listdir(tp)):
            if fn.endswith(".yml"):
                for r in read_yaml(os.path.join(tp, fn)):
                    r["_file"] = fn
                    site["permissions"].append(r)
    wr = os.path.join(root, "webrole.yml")
    if os.path.isfile(wr):
        for r in read_yaml(wr):
            site["roles"][r.get("adx_webroleid", "")] = r
    ss = os.path.join(root, "sitesetting.yml")
    if os.path.isfile(ss):
        for r in read_yaml(ss):
            if r.get("adx_name"):
                site["settings"][r["adx_name"]] = r.get("adx_value", None)
    for d in ("web-templates", "web-pages", "web-files", "content-snippets", "page-templates"):
        base = os.path.join(root, d)
        for dp, _, fns in os.walk(base):
            for fn in fns:
                if fn.lower().endswith(CODE_EXT) and not fn.endswith(".min.js"):
                    site["code_files"].append(os.path.join(dp, fn))
    # web template name -> source file, for {% include '<name>' %}
    site["templates"] = {}
    for dp, _, fns in os.walk(os.path.join(root, "web-templates")):
        src = [os.path.join(dp, fn) for fn in fns if fn.endswith(".webtemplate.source.html")]
        for fn in fns:
            if fn.endswith(".webtemplate.yml") and src:
                for r in read_yaml(os.path.join(dp, fn)):
                    if r.get("adx_name"):
                        site["templates"][r["adx_name"].strip().lower()] = src[0]
    for dp, _, fns in os.walk(os.path.join(root, "server-logic")):
        for fn in fns:
            if fn.lower().endswith(".js"):
                site["server_files"].append(os.path.join(dp, fn))
    return site


def singular(entity_set):
    s = entity_set
    if s.endswith("ies"):
        return [s[:-3] + "y", s[:-1]]
    if s.endswith("ses") or s.endswith("xes") or s.endswith("ches") or s.endswith("shes"):
        return [s[:-2], s[:-1]]
    if s.endswith("s"):
        return [s[:-1]]
    return [s]


FETCH_RE = re.compile(r"\{%-?\s*fetchxml\b.*?%\}(.*?)\{%-?\s*endfetchxml\s*-?%\}", re.S | re.I)
ENTITY_RE = re.compile(r"<(link-)?entity\b[^>]*\bname\s*=\s*[\"']([a-z0-9_]+)[\"']", re.I)
API_RE = re.compile(r"/_api/([A-Za-z0-9_]+)(\(([^)]*)\))?")
METHOD_RE = re.compile(r"\b(?:type|method)\s*:\s*[\"'](GET|POST|PATCH|PUT|DELETE)[\"']", re.I)
FETCH_METHOD_RE = re.compile(r"\bmethod\s*:\s*[\"'](GET|POST|PATCH|PUT|DELETE)[\"']", re.I)
# both "col@odata.bind": "/set(..." in an object literal and row["col@odata.bind"] = "/set(..." afterwards
BIND_RE = re.compile(r"[\"']([a-z0-9_]+)@odata\.bind[\"']\s*(?::|\]\s*=)\s*[\"'`]?/?([A-Za-z0-9_]+)\(", re.I)
KEY_RES = [
    re.compile(r"[{,]\s*[\"']?([a-z][a-z0-9]*_[a-z0-9_]+)[\"']?\s*:(?!:)"),       # object literal key
    re.compile(r"\bput\(\s*[\"']([a-z][a-z0-9]*_[a-z0-9_]+)[\"']"),               # put('col', v)
    re.compile(r"\.\s*([a-z][a-z0-9]*_[a-z0-9_]+)\s*=(?!=)"),                     # body.col = v
    re.compile(r"\[\s*[\"']([a-z][a-z0-9]*_[a-z0-9_]+)[\"']\s*\]\s*=(?!=)"),     # body['col'] = v
]
SELECT_RE = re.compile(r"\$select=([A-Za-z0-9_,]+)")
# Server logic reads and writes Dataverse on the server, under the visitor's table permissions, without
# the Web API: it needs the privileges but no Webapi/<table>/enabled. The page reaches it through
# /_api/serverlogics/<name>, which is the server logic endpoint, not a table.
SERVER_RE = re.compile(r"Server\.Connector\.Dataverse\.(CreateRecord|UpdateRecord|DeleteRecord|RetrieveRecord|RetrieveMultipleRecords)"
                       r"\(\s*[\"']([A-Za-z0-9_]+)[\"']")
SERVER_METHOD = {"CreateRecord": "POST", "UpdateRecord": "PATCH", "DeleteRecord": "DELETE", "RetrieveRecord": "GET",
                 "RetrieveMultipleRecords": "GET"}
API_NOT_TABLES = {"serverlogics"}
# A helper that passes its first parameter to a Dataverse call, e.g. function list(set, q) { ...
# RetrieveMultipleRecords(set, q) ... }: its calls with a literal entity set are that operation too.
WRAP_RE = re.compile(r"function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{")


def scan_code(site, set_map):
    """Return per-table usage: reads (liquid / webapi), methods, written columns, binds."""
    use = {}

    def u(t):
        return use.setdefault(t, {"liquid": set(), "methods": set(), "server": set(), "written": set(), "selected": set(),
                                  "bind_from": set(), "bind_to": set(), "files": set()})

    known = set(p.get("adx_entitylogicalname", "") for p in site["permissions"])
    known |= set(k.split("/")[1] for k in site["settings"] if k.lower().startswith("webapi/") and k.count("/") >= 2)

    def to_logical(es):
        if es in set_map:
            return set_map[es]
        cands = singular(es)
        for c in cands:
            if c in known:
                return c
        return cands[0]

    for path in site["code_files"]:
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        rel = path
        for block in FETCH_RE.findall(text):
            for _, ent in ENTITY_RE.findall(block):
                u(ent)["liquid"].add(rel); u(ent)["files"].add(rel)
        calls = list(API_RE.finditer(text))
        write_tables = []
        for m in calls:
            if m.group(1).lower() in API_NOT_TABLES:
                continue
            t = to_logical(m.group(1))
            window = text[max(0, m.start() - 400): m.end() + 400]
            meths = METHOD_RE.findall(window) or FETCH_METHOD_RE.findall(window)
            meth = meths[0].upper() if meths else "GET"
            u(t)["methods"].add(meth); u(t)["files"].add(rel)
            if meth in ("POST", "PATCH", "PUT"):
                write_tables.append(t)
            for sel in SELECT_RE.findall(window):
                u(t)["selected"].update(c for c in sel.split(",") if c)
        if write_tables:
            cols = set()
            for rx in KEY_RES:
                cols.update(rx.findall(text))
            binds = BIND_RE.findall(text)
            for col, target_set in binds:
                cols.add(col)
                tgt = to_logical(target_set)
                for t in write_tables:
                    u(t)["bind_from"].add(tgt)
                u(tgt)["bind_to"].update(write_tables); u(tgt)["files"].add(rel)
            cols = {c for c in cols if not c.startswith("odata")}
            for t in write_tables:
                u(t)["written"].update(cols)
    for path in site["server_files"]:
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        calls = [(m.start(), m.group(1), m.group(2)) for m in SERVER_RE.finditer(text)]
        for w in WRAP_RE.finditer(text):
            body = text[w.end(): w.end() + 800]
            inner = re.search(r"Server\.Connector\.Dataverse\.(%s)\(\s*%s\b" % ("|".join(SERVER_METHOD), re.escape(w.group(2))), body)
            if inner:
                rx = re.compile(r"(?<![\w$.])%s\(\s*[\"']([A-Za-z0-9_]+)[\"']" % re.escape(w.group(1)))
                calls += [(m.start(), inner.group(1), m.group(1)) for m in rx.finditer(text)]
        calls.sort()
        for _, op, es in calls:
            t = to_logical(es)
            u(t)["server"].add(SERVER_METHOD[op]); u(t)["files"].add(path)
        # A lookup bound in server logic needs Append and Append To like a Web API bind (measured: a
        # CreateRecord with binds returned 403 until both tables had both). Each bind belongs to the
        # next create or update after it in the file (the row is built, then written), else the last one.
        writes = [(pos, to_logical(es)) for pos, op, es in calls if op in ("CreateRecord", "UpdateRecord")]
        for m in BIND_RE.finditer(text):
            if not writes:
                break
            after = [w for w in writes if w[0] > m.start()]
            t = after[0][1] if after else writes[-1][1]
            tgt = to_logical(m.group(2))
            u(t)["bind_from"].add(tgt)
            u(tgt)["bind_to"].add(t); u(tgt)["files"].add(path)
    return use


# --------------------------------------------------------------------------- audit

def audit(root, set_map=None, sensitive=DEFAULT_SENSITIVE, live=None):
    site = load_site(root)
    use = scan_code(site, set_map or {})
    findings = []

    def f(sev, code, msg):
        findings.append({"severity": sev, "code": code, "message": msg})

    anon = {rid for rid, r in site["roles"].items() if truthy(r.get("adx_anonymoususersrole"))}
    auth = {rid for rid, r in site["roles"].items() if truthy(r.get("adx_authenticatedusersrole"))}
    perm_by_id = {p.get("adx_entitypermissionid"): p for p in site["permissions"]}

    def roles_of(p, depth=0):
        r = p.get("adx_entitypermission_webrole") or []
        if isinstance(r, str):
            r = [r] if r else []
        if not r and p.get("adx_parententitypermission") and depth < 10:
            parent = perm_by_id.get(p["adx_parententitypermission"])
            return roles_of(parent, depth + 1) if parent else []
        return r

    perms_by_table = {}
    for p in site["permissions"]:
        t = p.get("adx_entitylogicalname", "")
        perms_by_table.setdefault(t, []).append(p)
        name = p.get("adx_entityname", p.get("_file"))
        scope = SCOPES.get(str(p.get("adx_scope", "")), str(p.get("adx_scope", "?")))
        roles = roles_of(p)
        granted = [x for x in PRIVS if truthy(p.get("adx_" + x))]
        parent_id = p.get("adx_parententitypermission")
        if parent_id and parent_id not in perm_by_id:
            f("warning", "PARENT-MISSING", "%s: parent permission %s is not in this site's source; the child has no effect" % (name, parent_id))
        if not roles:
            f("warning", "NO-ROLE", "%s: no web role (and no parent to inherit from); the permission grants nothing" % name)
        if scope == "Global" and set(roles) & anon:
            sev = "critical" if set(granted) - {"read"} else "warning"
            f(sev, "GLOBAL-ANON", "%s: Global access on %s for anonymous visitors (%s)" % (name, t, ",".join(granted)))
        elif scope == "Global" and set(roles) & auth:
            sev = "critical" if set(granted) & {"write", "delete"} else "warning"
            f(sev, "GLOBAL-AUTH", "%s: Global access on %s for every signed-in user (%s) - every row, not just their own" % (name, t, ",".join(granted)))

    for t, ps in sorted(perms_by_table.items()):
        granted = set()
        for p in ps:
            granted |= {x for x in PRIVS if truthy(p.get("adx_" + x))}
        uu = use.get(t)
        need = set()
        if uu:
            meths = uu["methods"] | uu["server"]
            if uu["liquid"] or "GET" in meths:
                need.add("read")
            if "POST" in meths:
                need.add("create")
            if meths & {"PATCH", "PUT"}:
                need.add("write")
            if "DELETE" in meths:
                need.add("delete")
            if uu["bind_from"] or uu["bind_to"]:
                need |= {"append", "appendto"}
        names = ", ".join(p.get("adx_entityname", p.get("_file")) for p in ps)
        for x in sorted(need - granted):
            f("critical", "PRIV-MISSING", "%s: the site's code needs %s on %s but no permission grants it (%s); the call will be refused" % (t, x, t, names))
        for x in sorted((granted & {"write", "create", "delete"}) - need):
            f("warning", "PRIV-UNUSED", "%s: %s is granted (%s) but no code in the site uses it - remove it unless a form or list needs it" % (t, x, names))
        for x in sorted((granted & {"append", "appendto"}) - need):
            f("info", "APPEND-UNUSED", "%s: %s granted but the code binds no lookup to or from %s" % (t, x, t))
        if not uu:
            f("info", "PERM-NO-CODE", "%s: permission exists but no fetchxml, Web API or server logic call in the source uses %s (a form, list or lookup may)" % (t, t))

    for t, uu in sorted(use.items()):
        if t not in perms_by_table:
            f("critical", "NO-PERMISSION", "%s: used by the site's code (%s) but no table permission covers it; every read returns nothing and every write is refused"
              % (t, ", ".join(sorted(os.path.basename(x) for x in uu["files"]))))

    # Web API settings
    s = site["settings"]
    webapi_tables = sorted({k.split("/")[1] for k in s if k.lower().startswith("webapi/") and k.count("/") == 2 and k.split("/")[1] != "error"})
    sens = re.compile(sensitive, re.I)
    for t in webapi_tables:
        enabled = truthy(s.get("Webapi/%s/enabled" % t, "false"))
        fields_raw = s.get("Webapi/%s/fields" % t)
        from_view = truthy(s.get("Webapi/%s/UseFieldsFromView" % t, "false"))
        fields = [x.strip() for x in (fields_raw or "").split(",") if x.strip()]
        if not enabled:
            continue
        tperms = perms_by_table.get(t, [])
        global_read = [p for p in tperms if SCOPES.get(str(p.get("adx_scope", ""))) == "Global"
                       and truthy(p.get("adx_read")) and roles_of(p)]
        if global_read:
            f("warning", "WEBAPI-GLOBAL-READ", "Webapi/%s/enabled is true and %s grants Global read: every %s row is reachable through /_api "
              "and $filter, whatever the pages show. Scope it (Contact, Account, Parent, a Custom FetchXML filter) or turn the Web API off "
              "for %s and read it in Liquid or server logic" % (t, ", ".join(p.get("adx_entityname", p.get("_file")) for p in global_read), t, t))
        if "*" in fields:
            f("critical", "WEBAPI-WILDCARD", "Webapi/%s/fields is *: the wildcard is deprecated and requests now fail; list the columns" % t)
            writers = [p for p in tperms if truthy(p.get("adx_create")) or truthy(p.get("adx_write"))]
            if writers:
                f("critical", "WEBAPI-WILDCARD-WRITE", "Webapi/%s/fields is * and %s grants create or write: every column, process columns "
                  "included, is client-writable wherever the wildcard is still honoured; list only the columns the person owns"
                  % (t, ", ".join(p.get("adx_entityname", p.get("_file")) for p in writers)))
        elif not fields and not from_view:
            f("critical", "WEBAPI-NO-FIELDS", "Webapi/%s/enabled is true with no fields and no UseFieldsFromView; every request is refused" % t)
        if t not in perms_by_table:
            f("warning", "WEBAPI-NO-PERMISSION", "Webapi/%s/enabled is true but no table permission covers %s" % (t, t))
        uu = use.get(t)
        if uu is None or not uu["methods"]:
            f("warning", "WEBAPI-UNUSED", "Webapi/%s/enabled is true but no code calls /_api for %s - disable it" % (t, t))
        if "*" not in fields:
            written = uu["written"] if uu else set()
            for c in sorted(c for c in written if c not in fields and not from_view):
                f("critical", "FIELD-NOT-ALLOWED", "%s: the code writes %s but Webapi/%s/fields does not list it; the request is refused" % (t, c, t))
            used = (uu["written"] | uu["selected"]) if uu else set()
            for c in sorted(c for c in fields if c not in used):
                f("info", "FIELD-UNUSED", "%s: %s is allow-listed but the code neither writes nor selects it - narrow the list" % (t, c))
            for c in sorted(c for c in fields if sens.search(c)):
                f("warning", "FIELD-SENSITIVE", "%s: %s is allow-listed; a process column the client can set (stage, owner, decision...) belongs to the back office" % (t, c))
    # Global read with the Web API off only because nobody switched it on: every row is one setting away
    # from /_api. A measured site read through Liquid with Global read for every signed-in person; safe
    # that day, exposed the day someone enables the Web API for a list. Make the guard explicit
    # (Webapi/<table>/enabled = false, with a description naming the risk) or scope the read.
    for t, ps in sorted(perms_by_table.items()):
        greads = [p for p in ps if SCOPES.get(str(p.get("adx_scope", ""))) == "Global" and truthy(p.get("adx_read")) and roles_of(p)]
        key = "Webapi/%s/enabled" % t
        if not greads or truthy(s.get(key, "false")):
            continue   # enabled: WEBAPI-GLOBAL-READ above already covers it
        names = ", ".join(p.get("adx_entityname", p.get("_file")) for p in greads)
        if key in s:
            f("info", "GLOBAL-READ-GUARDED", "%s: Global read (%s) with %s = false set explicitly; keep it off and list it in the hand-back" % (t, names, key))
        else:
            f("warning", "GLOBAL-READ-UNGUARDED", "%s: Global read (%s) and the Web API is off only because %s is not set; one setting exposes every row "
              "through /_api. Add %s = false with a description naming the risk, list it in the hand-back, or scope the read "
              "(Contact, Parent, Custom access)" % (t, names, key, key))

    for t, uu in sorted(use.items()):
        if uu["methods"] and t not in webapi_tables:
            f("critical", "WEBAPI-OFF", "%s: the code calls /_api for %s but Webapi/%s/enabled is not set" % (t, t, t))
    if truthy(s.get("Webapi/error/innererror", "false")):
        f("warning", "WEBAPI-INNERERROR", "Webapi/error/innererror is true: server error detail is returned to the browser")

    # headers
    csp = s.get("HTTP/Content-Security-Policy")
    if "HTTP/Content-Security-Policy" not in s:
        f("info", "CSP-NOT-SET", "HTTP/Content-Security-Policy is not in the source: sites created since late 2025 get the platform default; older sites send none. Confirm with --url")
    elif not (csp or "").strip():
        f("warning", "CSP-DISABLED", "HTTP/Content-Security-Policy is empty: CSP is switched off")
    elif re.search(r"script-src[^;]*'unsafe-inline'", csp or ""):
        f("warning", "CSP-UNSAFE-INLINE", "HTTP/Content-Security-Policy allows 'unsafe-inline' scripts; use the platform nonce instead")
    xfo = s.get("HTTP/X-Frame-Options")
    if xfo is None and not re.search(r"frame-ancestors", csp or ""):
        f("info", "FRAME-NOT-SET", "neither HTTP/X-Frame-Options nor a CSP frame-ancestors directive is in the source; confirm framing protection with --url")
    for k, v in s.items():
        if k.lower().startswith("http/access-control-allow-origin") and (v or "").strip() == "*":
            f("warning", "CORS-ANY", "%s is *: any origin may read responses" % k)
    if (s.get("HTTP/SameSite/Default") or "").strip().lower() == "none":
        f("warning", "SAMESITE-NONE", "HTTP/SameSite/Default is None: the site's cookies are sent on cross-site requests")
    if truthy(s.get("Authentication/Registration/OpenRegistrationEnabled", "false")):
        f("info", "OPEN-REGISTRATION", "Authentication/Registration/OpenRegistrationEnabled is true: any visitor who can authenticate gets a contact; on a Private site the visibility list still gates entry")

    liquid_case_findings(site, f)

    if live:
        live_findings(live, f)

    examined = len(site["permissions"]) + len(site["settings"]) + len(site["code_files"])
    return site, use, findings, examined


# Liquid names ignore case, and an included template shares the including page's scope: `aP` in one
# template and `ap` in the template it includes are one variable (measured: a per-period table read
# zero while its total was right). Names a template sets: assign, capture, increment, decrement, the
# variable of a for loop, and a fetchxml result.
LIQ_SET_RE = re.compile(r"\{%-?\s*(?:(?:assign|capture|increment|decrement)\s+([A-Za-z_][\w-]*)|for\s+([A-Za-z_]\w*)\s+in\b|fetchxml\s+([A-Za-z_]\w*))", re.I)
LIQ_INCLUDE_RE = re.compile(r"\{%-?\s*include\s+[\"']([^\"']+)[\"']", re.I)


def liquid_case_findings(site, f):
    texts = {}

    def text_of(path):
        if path not in texts:
            try:
                texts[path] = open(path, encoding="utf-8", errors="replace").read()
            except OSError:
                texts[path] = ""
        return texts[path]

    reported = set()
    for start in site["code_files"]:
        if start.lower().endswith(".js"):
            continue
        names, seen, todo = {}, set(), [start]
        while todo:
            p = todo.pop()
            if p in seen or len(seen) > 50:
                continue
            seen.add(p)
            t = text_of(p)
            for m in LIQ_SET_RE.finditer(t):
                n = next(g for g in m.groups() if g)
                names.setdefault(n.lower(), {}).setdefault(n, set()).add(os.path.basename(p))
            for inc in LIQ_INCLUDE_RE.findall(t):
                q = site["templates"].get(inc.strip().lower())
                if q:
                    todo.append(q)
        for low, spellings in sorted(names.items()):
            if len(spellings) < 2:
                continue
            key = frozenset(spellings)
            if key in reported:
                continue
            reported.add(key)
            where = "; ".join("%s in %s" % (n, ", ".join(sorted(fs))) for n, fs in sorted(spellings.items()))
            f("warning", "LIQUID-CASE-CLASH", "Liquid variables %s are one variable: names ignore case, and an included template shares the "
              "page's scope (%s). Rename one so they differ by more than case" % (" and ".join(sorted(spellings)), where))


def live_findings(url, f):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    try:
        resp = opener.open(urllib.request.Request(url, method="GET", headers={"User-Agent": "audit-pages-permissions"}), timeout=30)
        status, headers = resp.status, resp.headers
    except urllib.error.HTTPError as e:
        status, headers = e.code, e.headers
    except Exception as e:  # noqa: BLE001
        f("warning", "LIVE-UNREACHABLE", "could not read %s: %s" % (url, e))
        return
    h = {k.lower(): v for k, v in headers.items()}
    loc = h.get("location", "")
    if status in (301, 302, 303, 307, 308) and re.search(r"login\.(windows|microsoftonline)", loc):
        f("info", "LIVE-PRIVATE", "anonymous GET is redirected to Entra sign-in (%d): the site is Private or the page requires sign-in" % status)
    else:
        f("info", "LIVE-STATUS", "anonymous GET returned %d" % status)
    csp = h.get("content-security-policy")
    if not csp:
        f("warning", "LIVE-NO-CSP", "the live site sends no Content-Security-Policy header")
    else:
        if "'unsafe-eval'" in csp:
            f("info", "LIVE-CSP-UNSAFE-EVAL", "live CSP allows 'unsafe-eval' (observed as the platform default on a site with the setting unset)")
        if re.search(r"script-src[^;]*'unsafe-inline'", csp):
            f("warning", "LIVE-CSP-UNSAFE-INLINE", "live CSP allows 'unsafe-inline' scripts")
    if not h.get("x-frame-options") and "frame-ancestors" not in (csp or ""):
        f("warning", "LIVE-NO-FRAME", "the live site sends neither X-Frame-Options nor frame-ancestors")
    if not h.get("strict-transport-security"):
        f("warning", "LIVE-NO-HSTS", "the live site sends no Strict-Transport-Security header")
    for name in ("x-content-type-options", "referrer-policy", "permissions-policy"):
        if not h.get(name):
            f("info", "LIVE-NO-" + name.upper(), "the live site sends no %s header" % name)


# --------------------------------------------------------------------------- report

def report(root, site, use, findings, examined, as_json):
    order = {"critical": 0, "warning": 1, "info": 2}
    findings.sort(key=lambda x: (order[x["severity"]], x["code"], x["message"]))
    if as_json:
        print(json.dumps({"site": root, "examined": examined, "findings": findings,
                          "permissions": [{k: v for k, v in p.items()} for p in site["permissions"]],
                          "code_use": {t: {k: sorted(v) for k, v in u.items()} for t, u in use.items()}}, indent=2))
    else:
        print("audit-pages-permissions: %s" % root)
        print("examined: %d table permission(s), %d site setting(s), %d code file(s)"
              % (len(site["permissions"]), len(site["settings"]), len(site["code_files"])))
        print("\nTable permissions")
        roles = site["roles"]
        for p in site["permissions"]:
            rl = p.get("adx_entitypermission_webrole") or []
            rl = rl if isinstance(rl, list) else [rl]
            rn = ", ".join(roles.get(r, {}).get("adx_name", r[:8]) for r in rl) or ("(inherits parent)" if p.get("adx_parententitypermission") else "(none)")
            print("  %-28s %-8s %-36s roles: %s" % (p.get("adx_entitylogicalname", "?"),
                  SCOPES.get(str(p.get("adx_scope", "")), "?"),
                  ",".join(x for x in PRIVS if truthy(p.get("adx_" + x))) or "-", rn))
        print("\nCode use")
        for t, u in sorted(use.items()):
            print("  %-28s liquid:%d  api:%s  server:%s  writes:%d  binds:%s" % (t, len(u["liquid"]), ",".join(sorted(u["methods"])) or "-",
                  ",".join(sorted(u["server"])) or "-", len(u["written"]), ",".join(sorted(u["bind_from"] | u["bind_to"])) or "-"))
        print("\nFindings")
        if not findings:
            print("  none")
        for x in findings:
            print("  %-8s %-22s %s" % (x["severity"].upper(), x["code"], x["message"]))
    if examined == 0:
        print("NOTHING EXAMINED - no table permissions, site settings or code found under %s" % root)
        return 2
    return 1 if any(x["severity"] in ("critical", "warning") for x in findings) else 0


# --------------------------------------------------------------------------- selftest

def _write(base, rel, text):
    p = os.path.join(base, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


ROLES = """- adx_anonymoususersrole: false
  adx_authenticatedusersrole: true
  adx_name: Authenticated Users
  adx_webroleid: 11111111-0000-0000-0000-000000000001
- adx_anonymoususersrole: true
  adx_authenticatedusersrole: false
  adx_name: Anonymous Users
  adx_webroleid: 11111111-0000-0000-0000-000000000002
- adx_anonymoususersrole: false
  adx_authenticatedusersrole: false
  adx_name: Staff
  adx_webroleid: 11111111-0000-0000-0000-000000000003
"""

PAGE_JS = """var body = {
  app_name: title,
  app_notes: notes,
  'app_customer@odata.bind': '/contacts(' + id + ')'
};
put('app_amount', amount);
$.ajax({ type: 'POST', url: '/_api/app_orders', data: JSON.stringify(body) });
"""

PAGE_HTML = """{% fetchxml mine %}<fetch><entity name="app_order"><attribute name="app_name" /></entity></fetch>{% endfetchxml %}
{% fetchxml lines %}<fetch><entity name="app_orderline"><attribute name="app_name" /></entity></fetch>{% endfetchxml %}
"""


def _perm(name, table, scope, privs, roles=None, parent=None, pid="22222222-0000-0000-0000-000000000001", rel=None):
    lines = ["adx_entityname: %s" % name, "adx_entitylogicalname: %s" % table, "adx_scope: %s" % scope,
             "adx_entitypermissionid: %s" % pid]
    for x in PRIVS:
        lines.append("adx_%s: %s" % (x, "true" if x in privs else "false"))
    if roles:
        lines.append("adx_entitypermission_webrole:")
        lines += ["- %s" % r for r in roles]
    if parent:
        lines.append("adx_parententitypermission: %s" % parent)
    if rel:
        lines.append("adx_contactrelationship: %s" % rel)
    return "\n".join(lines) + "\n"


AUTH = "11111111-0000-0000-0000-000000000001"
ANON = "11111111-0000-0000-0000-000000000002"
STAFF = "11111111-0000-0000-0000-000000000003"


def _site(base, fixed):
    _write(base, "webrole.yml", ROLES)
    _write(base, "web-pages/orders/content-pages/Orders.en-US.webpage.copy.html", PAGE_HTML)
    _write(base, "web-pages/orders/content-pages/Orders.en-US.webpage.custom_javascript.js", PAGE_JS)
    if fixed:
        _write(base, "table-permissions/Order-Mine.tablepermission.yml",
               _perm("Order - mine", "app_order", "756150001", ["read", "create", "append", "appendto"], [AUTH], rel="app_order_customer",
                     pid="22222222-0000-0000-0000-000000000001"))
        _write(base, "table-permissions/Line-On-Mine.tablepermission.yml",
               _perm("Line - on my orders", "app_orderline", "756150003", ["read"], parent="22222222-0000-0000-0000-000000000001",
                     pid="22222222-0000-0000-0000-000000000003"))
        _write(base, "table-permissions/Contact-Self.tablepermission.yml",
               _perm("Contact - self", "contact", "756150004", ["read", "append", "appendto"], [AUTH], pid="22222222-0000-0000-0000-000000000002"))
        # Global read for a custom role on a table whose Web API is OFF (read in Liquid only): not a finding.
        _write(base, "table-permissions/Line-All-Staff.tablepermission.yml",
               _perm("Line - all for staff", "app_orderline", "756150000", ["read"], [STAFF], pid="22222222-0000-0000-0000-000000000004"))
        _write(base, "sitesetting.yml", """- adx_name: Webapi/app_order/enabled
  adx_value: true
- adx_name: Webapi/app_order/fields
  adx_value: app_name,app_notes,app_amount,app_customer
- adx_name: Webapi/app_orderline/enabled
  adx_description: Off on purpose - staff read every line with Global read in Liquid
  adx_value: false
- adx_name: HTTP/Content-Security-Policy
  adx_value: script-src 'self' 'nonce'; style-src 'unsafe-inline' https:;
- adx_name: HTTP/X-Frame-Options
  adx_value: SAMEORIGIN
""")
    else:
        # Global for anonymous with write; no contact permission; no permission for app_orderline;
        # wildcard fields on one table, missing column on the other; inner errors on.
        _write(base, "table-permissions/Order-All.tablepermission.yml",
               _perm("Order - all", "app_order", "756150000", ["read", "write", "create", "delete"], [ANON]))
        # Global read for a custom role, Web API off only by default
        _write(base, "table-permissions/Note-All.tablepermission.yml",
               _perm("Note - all", "app_note", "756150000", ["read"], [STAFF], pid="22222222-0000-0000-0000-000000000006"))
        # a writable table whose Web API allow-list is the wildcard
        _write(base, "table-permissions/Vendor-Mine.tablepermission.yml",
               _perm("Vendor - mine", "app_vendor", "756150001", ["read", "create"], [AUTH], pid="22222222-0000-0000-0000-000000000005",
                     rel="app_vendor_contact"))
        _write(base, "sitesetting.yml", """- adx_name: Webapi/app_order/enabled
  adx_value: true
- adx_name: Webapi/app_order/fields
  adx_value: app_name,app_stage
- adx_name: Webapi/app_vendor/enabled
  adx_value: true
- adx_name: Webapi/app_vendor/fields
  adx_value: '*'
- adx_name: Webapi/app_region/enabled
  adx_value: true
- adx_name: Webapi/app_region/fields
  adx_value: app_name
- adx_name: Webapi/error/innererror
  adx_value: true
- adx_name: HTTP/Content-Security-Policy
  adx_value: script-src 'self' 'unsafe-inline';
""")


def selftest():
    tmp = tempfile.mkdtemp(prefix="audit-pages-selftest-")
    failures = []
    try:
        bad, good, empty = (os.path.join(tmp, n) for n in ("bad", "good", "empty"))
        _site(bad, False); _site(good, True); os.makedirs(empty)
        _, _, fb, nb = audit(bad)
        codes = {x["code"] for x in fb}
        expect = {"GLOBAL-ANON", "PRIV-MISSING", "PRIV-UNUSED", "NO-PERMISSION", "WEBAPI-WILDCARD", "FIELD-NOT-ALLOWED",
                  "FIELD-SENSITIVE", "WEBAPI-UNUSED", "WEBAPI-NO-PERMISSION", "WEBAPI-INNERERROR", "CSP-UNSAFE-INLINE",
                  "WEBAPI-GLOBAL-READ", "WEBAPI-WILDCARD-WRITE", "GLOBAL-READ-UNGUARDED"}
        for c in sorted(expect - codes):
            failures.append("bad site: expected %s" % c)
        _, _, fg, ng = audit(good)
        serious = [x for x in fg if x["severity"] in ("critical", "warning")]
        for x in serious:
            failures.append("fixed site: unexpected %s %s" % (x["code"], x["message"]))
        # server logic: the /_api/serverlogics endpoint is not a table, and its Dataverse calls need
        # privileges but no Web API setting
        sl = os.path.join(tmp, "sl")
        _site(sl, True)
        _write(sl, "web-templates/lib/Lib.webtemplate.source.html",
               "<script>fetch('/_api/serverlogics/orders', { method: 'POST', body: '{}' });</script>\n")
        _write(sl, "server-logic/orders.js", 'function post() { return Server.Connector.Dataverse.RetrieveMultipleRecords("contacts", "$top=1"); }\n')
        _, _, fs1, _ = audit(sl)
        for x in fs1:
            if x["severity"] in ("critical", "warning"):
                failures.append("server logic site: unexpected %s %s" % (x["code"], x["message"]))
        _write(sl, "server-logic/orders.js", 'function post() { return Server.Connector.Dataverse.CreateRecord("app_orderlines", {}); }\n')
        _, _, fs2, _ = audit(sl)
        c2 = {x["code"] for x in fs2}
        if not any(x["code"] == "PRIV-MISSING" and "create on app_orderline" in x["message"] for x in fs2):
            failures.append("server logic create without the privilege: expected PRIV-MISSING, got %s" % ", ".join(sorted(c2)))
        if "WEBAPI-OFF" in c2:
            failures.append("server logic create: WEBAPI-OFF raised, but server logic needs no Web API setting")
        # server logic binds (object literal and row["...@odata.bind"] = ...) and reads through a helper
        sb = os.path.join(tmp, "sb")
        _site(sb, True)
        _write(sb, "server-logic/lines.js", """function list(set, q) { return JSON.parse(Server.Connector.Dataverse.RetrieveMultipleRecords(set, q)).value; }
function post() {
    var o = list("app_orders", "$top=1")[0];
    var row = { "app_name": "x", "app_Order@odata.bind": "/app_orders(" + o.app_orderid + ")" };
    row["app_Customer@odata.bind"] = "/contacts(" + Server.User.contactid + ")";
    return Server.Connector.Dataverse.CreateRecord("app_orderlines", JSON.stringify(row));
}
""")
        _write(sb, "table-permissions/Line-Create.tablepermission.yml",
               _perm("Line - create", "app_orderline", "756150001", ["read", "create"], [AUTH], pid="22222222-0000-0000-0000-000000000007",
                     rel="app_orderline_contact"))
        _, ub, fb3, _ = audit(sb)
        miss = sorted(x["message"].split(" needs ")[1].split(" on ")[0] for x in fb3 if x["code"] == "PRIV-MISSING" and x["message"].startswith("app_orderline:"))
        if miss != ["append", "appendto"]:
            failures.append("server logic bind without Append/Append To: expected PRIV-MISSING append and appendto on app_orderline, got %s" % miss)
        if "app_orderline" not in ub.get("contact", {}).get("bind_to", set()):
            failures.append("server logic: the row[...@odata.bind] = form was not read as a bind to contact")
        if "GET" not in ub.get("app_order", {}).get("server", set()):
            failures.append("server logic: a read through a helper (list(\"app_orders\", ...)) was not counted")
        _write(sb, "table-permissions/Line-Create.tablepermission.yml",
               _perm("Line - create", "app_orderline", "756150001", ["read", "create", "append", "appendto"], [AUTH],
                     pid="22222222-0000-0000-0000-000000000007", rel="app_orderline_contact"))
        _, _, fb4, _ = audit(sb)
        for x in fb4:
            if x["severity"] in ("critical", "warning") or (x["code"] == "APPEND-UNUSED" and "app_orderline" in x["message"]):
                failures.append("server logic bind with both privileges: unexpected %s %s" % (x["code"], x["message"]))
        # Liquid names that differ only by case, across a page and the template it includes
        lq = os.path.join(tmp, "lq")
        _site(lq, True)
        _write(lq, "web-templates/money/Money.webtemplate.yml", "adx_name: Money\nadx_webtemplateid: 33333333-0000-0000-0000-000000000001\n")
        _write(lq, "web-templates/money/Money.webtemplate.source.html", "{% for aP in periods %}{% assign t = t | plus: aP.value %}{% endfor %}\n")
        _write(lq, "web-pages/money/content-pages/Money.en-US.webpage.copy.html", "{% assign ap = 0 %}{% include 'Money' %}{{ ap }}\n")
        _, _, fl, _ = audit(lq)
        if not any(x["code"] == "LIQUID-CASE-CLASH" and "aP and ap" in x["message"] for x in fl):
            failures.append("Liquid: aP in an included template and ap in the page: expected LIQUID-CASE-CLASH")
        _write(lq, "web-pages/money/content-pages/Money.en-US.webpage.copy.html", "{% assign total_p = 0 %}{% include 'Money' %}{{ total_p }}\n")
        _, _, fl2, _ = audit(lq)
        if any(x["code"] == "LIQUID-CASE-CLASH" for x in fl2):
            failures.append("Liquid: distinct names raised LIQUID-CASE-CLASH")
        _, _, fe, ne = audit(empty)
        if ne != 0:
            failures.append("empty folder: examined %d, expected 0" % ne)
        # yaml reader: folded scalar and quoted value
        _write(tmp, "y.yml", "- adx_description: >-\n    two\n    lines\n  adx_name: A/B\n  adx_value: 'it''s'\n")
        y = read_yaml(os.path.join(tmp, "y.yml"))
        if y != [{"adx_description": "two lines", "adx_name": "A/B", "adx_value": "it's"}]:
            failures.append("yaml reader: %r" % y)
        print("audit-pages-permissions selftest")
        print("  bad site:   %d finding(s): %s" % (len(fb), ", ".join(sorted(codes))))
        print("  fixed site: %d critical/warning" % len(serious))
        print("  server logic: serverlogics endpoint ignored, server calls need privileges, no Web API setting")
        print("  server logic binds: Append and Append To on both tables; reads through a helper counted")
        print("  Liquid: names that differ only by case across a page and its includes")
        print("  empty:      examined %d" % ne)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("selftest: %s" % ("PASSED" if not failures else "FAILED %d: %s" % (len(failures), "; ".join(failures))))
    return 0 if not failures else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("site", nargs="?")
    ap.add_argument("--url")
    ap.add_argument("--entity-sets")
    ap.add_argument("--sensitive", default=DEFAULT_SENSITIVE)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.site or not os.path.isdir(a.site):
        ap.error("give the site folder from `pac pages download --modelVersion 2`")
    set_map = {}
    if a.entity_sets:
        with open(a.entity_sets, encoding="utf-8") as fh:
            set_map = json.load(fh)
    root = find_site_root(a.site)
    site, use, findings, examined = audit(root, set_map, a.sensitive, a.url)
    return report(root, site, use, findings, examined, a.json)


if __name__ == "__main__":
    sys.exit(main())
