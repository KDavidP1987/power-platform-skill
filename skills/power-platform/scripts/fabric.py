#!/usr/bin/env python3
"""fabric.py - deploy and run Microsoft Fabric items from files in the repo, inside ONE workspace
folder, idempotently. The Fabric lane of a build: lakehouses, a Dataverse-to-bronze dataflow,
silver and gold notebooks, a refresh pipeline, a semantic model and a report.

Usage:
    python fabric.py items   --workspace WS [--folder NAME] [--type TYPE]
    python fabric.py deploy  --manifest fabric.json [--only NAME ...] [--apply]
    python fabric.py run     TYPE NAME --workspace WS --folder NAME [--job-type J] [--apply]
    python fabric.py run     --manifest fabric.json TYPE NAME [--apply]
    python fabric.py prove-refresh --manifest fabric.json --checks report-checks.json --check NAME
                             --touch TABLE/KEYCOL=KEY/COLUMN=VALUE [--pipeline NAME] [--apply]
    python fabric.py probe   --manifest fabric.json NAME [--query Q ...] [--mashup FILE]
                             read-only: evaluate each loaded query of a deployed Dataflow and print
                             its M error (a refresh that "failed without detail error" names nothing)
    python fabric.py teardown-plan --workspace WS --folder NAME
                             read-only: the folder's items in the order the owner deletes them
                             (reports and models first, Dataflows BEFORE lakehouses, SQL endpoints
                             with their lakehouse, the folder last)

prove-refresh answers one question: does a refresh run from Fabric ALONE reach Dataverse? A build
that landed Dataverse rows as files from a script on the builder's machine had a pipeline that
"succeeded" on stale files. The command reads the figure (DAX on the published model, and the same
figure counted in Dataverse), changes ONE row under this build's prefix (--touch; refused for any
other table), checks the Dataverse figure moved, runs the pipeline from Fabric, re-reads the DAX
figure, then puts the row back and runs the pipeline again. Exit 0 when the report followed the
change; 1 when it did not (the refresh does not reach Dataverse) or the touch did not move the
figure. Without --apply it only reads both figures and prints the plan.
--touch: "app_loan/app_loannumber=L-0001/app_status=choice:Returned" (choice:<label> is resolved;
digits become numbers, true/false booleans). The checks file is reconcile-report.py's; --check
names one of its checks (a single-value one).

Every write is planned first: without --apply, deploy and run print what they WOULD do and send
nothing but GETs (the client refuses anything else, structurally). Nothing is ever deleted; removing
Fabric items is an owner step in the portal or in the project's owner-cleanup script.

The manifest (assets/templates/fabric-medallion/fabric.example.json):
    {
      "workspace": "<workspace id or display name>",
      "folder": "<folder display name: the lane; created when missing>",
      "vars": { "prefix": "app", "orgHost": "yourorg.crm.dynamics.com" },
      "items": [
        { "type": "Lakehouse",    "name": "APP_Bronze", "description": "<optional, at most 256 characters>" },
        { "type": "Dataflow",     "name": "APP_Bronze_Dataverse", "source": "fabric/dataflow-bronze" },
        { "type": "Environment",  "name": "APP_Spark", "source": "fabric/environment" },
        { "type": "Notebook",     "name": "APP_Silver", "source": "fabric/notebooks/silver.py",
          "lakehouse": "APP_Silver", "environment": "APP_Spark" },
        { "type": "DataPipeline", "name": "APP_Refresh", "source": "fabric/pipeline/pipeline-content.json" },
        { "type": "SemanticModel","name": "APP Model",  "source": "fabric/model" },
        { "type": "Report",       "name": "APP Report", "source": "fabric/report" }
      ]
    }

Items deploy in manifest order, so list what others refer to first. "source" is a folder (every file
under it becomes a definition part at its relative path) or one file (Notebook .py/.ipynb, or the
pipeline's pipeline-content.json). A Notebook .py becomes a one-cell ipynb bound to "lakehouse" as
its default lakehouse, and to "environment" (an Environment item listed earlier) when given.

Placeholders in source files are resolved at deploy time:
    {{workspaceId}}                 the workspace id
    {{id:<Type>:<Name>}}            an item's id in this folder (deployed earlier in the manifest)
    {{sqlEndpoint:<Lakehouse>}}     the lakehouse SQL endpoint host (Direct Lake expressions)
    {{sqlEndpointId:<Lakehouse>}}   the SQL endpoint id
    {{var:<key>}}                   a value from "vars"
A placeholder that cannot be resolved stops an --apply before the item is sent.

Safety: items are matched by type and display name INSIDE the folder. An item with the same type and
name elsewhere in the workspace belongs to someone else: the run refuses (exit 1) instead of taking
it over. Folders are matched by display name at the workspace root.
A SemanticModel whose .tmdl files give a measure the name of a column in the same table (case
ignored) is refused in the plan: the service refuses it too, after a bare 400.
An item "description" over 256 characters is refused in the plan: the create returns a bare 400.
A Dataflow's mashup is refused in the plan when [DataDestinations] names a query the document does
not define (the refresh then "failed without detail error"), or when a query reading a lakehouse
filters rows with each [flag] = true / <> false: on a nullable Yes/No column that fails "We cannot
apply operator < to types Null and Logical"; write List.Contains({true}, [flag]) or
not List.Contains({false}, [flag]).

probe sends POST .../dataflows/{id}/executeQuery for each loaded query (each query with a
<name>_DataDestination partner in the item's mashup.pq, or --query) and prints the error the job API
hides. --mashup FILE sends that document as customMashupDocument instead of the published one, to
bisect a failing query without republishing. It reads; it never changes the dataflow.

Options:
    --workspace ID|NAME   workspace (or "workspace" in the manifest)
    --folder NAME         the folder (or "folder" in the manifest)
    --token-cmd CMD       command printing a token for https://api.fabric.microsoft.com ("{resource}")
    --token-env NAME      variable holding that token (default FABRIC_TOKEN)
    --timeout S           run: give up waiting after S seconds (default 3600; the job keeps running)
    --poll S              run: seconds between status reads (default 15)
    --selftest            offline tests against a simulated Fabric API

Run job types (default per item type): Notebook RunNotebook, DataPipeline Pipeline, Dataflow
Execute. A semantic model refresh is not a Fabric job: the gold notebook reframes the model, or use
the Power BI refresh API.

Exit: 0 done (or planned); 1 a finding (job failed, a name owned outside the folder, an unresolved
placeholder); 2 cannot run (no token, workspace not found, API error).
"""
import argparse
import base64
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ppapi import ApiError, Client, FakeTransport, PlanRefused, RESOURCES, get_token  # noqa: E402

BASE = "https://api.fabric.microsoft.com/v1/"
JOB_TYPES = {"Notebook": "RunNotebook", "DataPipeline": "Pipeline", "Dataflow": "Execute"}
PH = re.compile(r"\{\{\s*([a-zA-Z]+)(?::([^:}]+))?(?::([^}]+))?\s*\}\}")
TEMPLATE_TOKEN = re.compile(r"\{(PREFIX|prefix|table|Table)\}")   # left over from a copied template
TEXT_EXT = (".json", ".pq", ".tmdl", ".pbir", ".pbism", ".py", ".ipynb", ".sql", ".m", ".txt", ".platform", ".yaml", ".yml")


class Finding(Exception):
    pass


class Fabric:
    def __init__(self, client, workspace, folder_name):
        self.c = client
        self.ws = self.resolve_workspace(workspace)
        self.folder_name = folder_name
        self.folder_id = self.find_folder(folder_name) if folder_name else None
        self._items = None

    def resolve_workspace(self, ws):
        if re.match(r"^[0-9a-fA-F-]{36}$", ws or ""):
            return ws
        for w in self.c.get_all("workspaces"):
            if w.get("displayName") == ws:
                return w["id"]
        raise ApiError("workspace not found or not visible to this account: %s" % ws)

    def find_folder(self, name):
        for f in self.c.get_all("workspaces/%s/folders" % self.ws):
            if f.get("displayName") == name and not f.get("parentFolderId"):
                return f["id"]
        return None

    def ensure_folder(self, apply):
        if self.folder_id or not self.folder_name:
            return self.folder_id
        if not apply:
            print("would create folder %r" % self.folder_name)
            return None
        _, _, body = self.c.call("POST", "workspaces/%s/folders" % self.ws, {"displayName": self.folder_name})
        self.folder_id = body["id"]
        print("created folder %r %s" % (self.folder_name, self.folder_id))
        return self.folder_id

    def items(self, refresh=False):
        if self._items is None or refresh:
            self._items = self.c.get_all("workspaces/%s/items" % self.ws)
        return self._items

    def find(self, kind, name):
        """(item in the folder or None, the same name elsewhere or None)."""
        mine = other = None
        for it in self.items():
            if it.get("type") == kind and it.get("displayName") == name:
                if self.folder_id and it.get("folderId") == self.folder_id:
                    mine = it
                elif not self.folder_name and not it.get("folderId"):
                    mine = it
                else:
                    other = it
        return mine, other

    def lakehouse_sql(self, item_id):
        lh = self.c.get("workspaces/%s/lakehouses/%s" % (self.ws, item_id)) or {}
        sql = (lh.get("properties") or {}).get("sqlEndpointProperties") or {}
        return sql.get("connectionString"), sql.get("id")


def b64(data):
    return base64.b64encode(data if isinstance(data, bytes) else data.encode("utf-8")).decode("ascii")


def notebook_ipynb(src, lakehouse_id, lakehouse_name, ws, environment_id=None):
    meta = {"language_info": {"name": "python"}, "kernel_info": {"name": "synapse_pyspark"},
            "kernelspec": {"name": "synapse_pyspark", "display_name": "Synapse PySpark"}}
    if lakehouse_id:
        meta["dependencies"] = {"lakehouse": {"default_lakehouse": lakehouse_id,
                                              "default_lakehouse_name": lakehouse_name,
                                              "default_lakehouse_workspace_id": ws}}
    if environment_id:
        # The workspace's default Spark runtime can be retired (measured: 1.1), and workspace settings
        # are the owner's. A notebook bound to this folder's own Environment item runs on its runtime.
        meta.setdefault("dependencies", {})["environment"] = {"environmentId": environment_id, "workspaceId": ws}
    return json.dumps({"nbformat": 4, "nbformat_minor": 5, "metadata": meta,
                       "cells": [{"cell_type": "code", "metadata": {}, "execution_count": None,
                                  "outputs": [], "source": src.splitlines(keepends=True)}]}, indent=1)


def read_parts(root, source):
    path = os.path.join(root, source)
    if os.path.isdir(path):
        out = {}
        for d, _, files in os.walk(path):
            for f in sorted(files):
                full = os.path.join(d, f)
                rel = os.path.relpath(full, path).replace(os.sep, "/")
                with open(full, "rb") as fh:
                    out[rel] = fh.read()
        return out
    with open(path, "rb") as fh:
        return {os.path.basename(path): fh.read()}


def resolve(text, fab, vars_, pending, apply):
    """Replace {{...}} placeholders. Unknown references stay visible in a plan, stop an apply."""
    missing = []

    def sub(m):
        kind, a, b = m.group(1), m.group(2), m.group(3)
        if kind == "workspaceId":
            return fab.ws
        if kind == "var":
            if a in vars_:
                return str(vars_[a])
        elif kind == "id" and a and b:
            it, _ = fab.find(a, b)
            if it:
                return it["id"]
            if (a, b) in pending:
                missing.append(m.group(0))
                return "<id of %s %s, created earlier in this run>" % (a, b)
        elif kind in ("sqlEndpoint", "sqlEndpointId") and a:
            it, _ = fab.find("Lakehouse", a)
            if it:
                host, sid = fab.lakehouse_sql(it["id"])
                val = host if kind == "sqlEndpoint" else sid
                if val:
                    return val
            if ("Lakehouse", a) in pending:
                missing.append(m.group(0))
                return "<%s of %s, created earlier in this run>" % (kind, a)
        missing.append(m.group(0))
        return m.group(0)

    left = sorted(set(TEMPLATE_TOKEN.findall(text)))
    if left:
        raise Finding("template token(s) not filled in: %s (replace them when copying the template)"
                      % ", ".join("{%s}" % t for t in left))
    out = PH.sub(sub, text)
    if missing and apply:
        raise Finding("unresolved placeholder(s): %s" % ", ".join(sorted(set(missing))))
    return out, missing


TMDL_OBJ = re.compile(r"^\s*(table|column|measure)\s+('(?:[^']|'')+'|[^\s=]+)")


def tmdl_name_clashes(parts):
    """A model refuses a measure named like a column of the same table, ignoring case (measure Budget,
    column budget): 'a column with the same name already exists', after a bare 400 on create. Found
    here from the .tmdl files, before anything is sent."""
    found = []
    for rel, text in sorted(parts.items()):
        if not rel.lower().endswith(".tmdl") or not isinstance(text, str):
            continue
        table, cols, measures = None, {}, []

        def flush():
            for m in measures:
                if m.lower() in cols:
                    found.append("table %s: measure %r has the name of column %r (names are not case-sensitive); "
                                 "rename the column, for example %s_amount" % (table, m, cols[m.lower()], cols[m.lower()]))
        for line in text.splitlines():
            m = TMDL_OBJ.match(line)
            if not m:
                continue
            kind, name = m.group(1), m.group(2)
            if name.startswith("'"):
                name = name[1:-1].replace("''", "'")
            if kind == "table":
                flush()
                table, cols, measures = name, {}, []
            elif kind == "column":
                cols[name.lower()] = name
            else:
                measures.append(name)
        flush()
    return found


DEST_REF = re.compile(r'QueryName\s*=\s*"([^"]+)"')
SHARED = re.compile(r'(?m)^\s*shared\s+(#"(?:[^"]|"")+"|[A-Za-z_][\w.]*)\s*=')
FLAG_CMP = re.compile(r'each\s+\[([^\]]+)\]\s*(=|<>)\s*(true|false)\b', re.I)
FLAG_FIX = {("=", "true"): "List.Contains({true}, [%s])", ("<>", "false"): "not List.Contains({false}, [%s])",
            ("=", "false"): "List.Contains({false}, [%s])", ("<>", "true"): "not List.Contains({true}, [%s])"}


def shared_queries(text):
    """{name: body} for every `shared <name> = ...;` query of a section document."""
    out, marks = {}, list(SHARED.finditer(text))
    for i, m in enumerate(marks):
        name = m.group(1)
        if name.startswith('#"'):
            name = name[2:-1].replace('""', '"')
        out[name] = text[m.end():marks[i + 1].start() if i + 1 < len(marks) else len(text)]
    return out


def mashup_findings(parts):
    """Faults in a Dataflow's Power Query document that the service reports only as a refresh that
    'failed without detail error'."""
    found = []
    for rel, text in sorted(parts.items()):
        if not rel.lower().endswith((".pq", ".m")) or not isinstance(text, str):
            continue
        queries = shared_queries(text)
        for line in text.splitlines():
            if "[DataDestinations" not in line:
                continue
            for ref in DEST_REF.findall(line):
                if ref not in queries:
                    found.append("%s: [DataDestinations] names query %r, which the document does not define (the refresh "
                                 "fails without detail); add `shared %s = ...` or fix the name" % (rel, ref, ref))
        for name, body in queries.items():
            if "Lakehouse.Contents" not in body or name.endswith("_DataDestination"):
                continue
            for m in FLAG_CMP.finditer(body):
                if "SelectRows" not in body[max(0, m.start() - 200):m.start()]:
                    continue
                fix = FLAG_FIX[(m.group(2), m.group(3).lower())] % m.group(1)
                found.append("%s: query %s filters a lakehouse table with `each [%s] %s %s`; on a nullable Yes/No column "
                             "the refresh fails \"We cannot apply operator < to types Null and Logical\". Write `each %s`"
                             % (rel, name, m.group(1), m.group(2), m.group(3), fix))
    return found


def build_definition(item, root, fab, vars_, pending, apply):
    kind, src = item["type"], item.get("source")
    if not src:
        return None, []
    raw = read_parts(root, src)
    parts, missing = {}, []
    for rel, data in raw.items():
        if rel.lower().endswith(TEXT_EXT):
            text, miss = resolve(data.decode("utf-8-sig"), fab, vars_, pending, apply)
            missing += miss
            parts[rel] = text
        else:
            parts[rel] = data
    if kind == "SemanticModel":
        clashes = tmdl_name_clashes(parts)
        if clashes:
            raise Finding("; ".join(clashes))
    if kind == "Dataflow":
        faults = mashup_findings(parts)
        if faults:
            raise Finding("; ".join(faults))
    fmt = None
    if kind == "Notebook":
        (name, body), = parts.items() if len(parts) == 1 else (None, None)
        if name is None:
            raise Finding("Notebook %s: source must be one .py or .ipynb file" % item["name"])
        if name.endswith(".py"):
            lh_id = None
            if item.get("lakehouse"):
                lh, _ = fab.find("Lakehouse", item["lakehouse"])
                lh_id = lh["id"] if lh else ("<pending>" if not apply else None)
                if apply and not lh_id:
                    raise Finding("Notebook %s: lakehouse %r not found in the folder" % (item["name"], item["lakehouse"]))
            env_id = None
            if item.get("environment"):
                env, _ = fab.find("Environment", item["environment"])
                env_id = env["id"] if env else ("<pending>" if not apply else None)
                if apply and not env_id:
                    raise Finding("Notebook %s: environment %r not found in the folder (list it earlier in the manifest)"
                                  % (item["name"], item["environment"]))
            body = notebook_ipynb(body, lh_id, item.get("lakehouse"), fab.ws, env_id)
        parts = {"notebook-content.ipynb": body}
        fmt = "ipynb"
    definition = {"parts": [{"path": p, "payload": b64(c), "payloadType": "InlineBase64"} for p, c in parts.items()]}
    if fmt:
        definition["format"] = fmt
    return definition, missing


def cmd_deploy(fab, man, root, only, apply):
    fab.ensure_folder(apply)
    pending, bad = set(), 0
    for item in man.get("items") or []:
        kind, name = item["type"], item["name"]
        if only and name not in only:
            continue
        if TEMPLATE_TOKEN.search(name):
            print("REFUSED %s %r: template token not filled in" % (kind, name))
            bad += 1
            continue
        desc = item.get("description")
        if desc is not None and len(str(desc)) > 256:
            print("REFUSED %s %r: description is %d characters; Fabric allows 256 and answers a longer one with a "
                  "bare 400" % (kind, name, len(str(desc))))
            bad += 1
            continue
        mine, other = fab.find(kind, name)
        if other and not mine:
            print("REFUSED %s %r: an item with this name exists outside folder %r (id %s) - it is not this "
                  "lane's; rename yours" % (kind, name, fab.folder_name, other["id"]))
            bad += 1
            continue
        try:
            definition, missing = build_definition(item, root, fab, man.get("vars") or {}, pending, apply)
        except Finding as e:
            print("REFUSED %s %r: %s" % (kind, name, e))
            bad += 1
            continue
        nparts = len(definition["parts"]) if definition else 0
        note = (" (placeholders pending: %s)" % ", ".join(sorted(set(missing)))) if missing else ""
        if not apply:
            print("would %s %s %r%s%s" % ("update" if mine else "create", kind, name,
                                          " with %d definition part(s)" % nparts if nparts else "", note))
            if not mine:
                pending.add((kind, name))
            continue
        if mine:
            if definition:
                st, h, _ = fab.c.call("POST", "workspaces/%s/items/%s/updateDefinition" % (fab.ws, mine["id"]),
                                      {"definition": definition})
                if st == 202:
                    fab.c.wait_operation(h)
                print("updated %s %r %s" % (kind, name, mine["id"]))
            else:
                print("ok %s %r %s" % (kind, name, mine["id"]))
            continue
        body = {"displayName": name, "type": kind}
        if item.get("description"):
            body["description"] = str(item["description"])
        if fab.folder_id:
            body["folderId"] = fab.folder_id
        if definition:
            body["definition"] = definition
        st, h, out = fab.c.call("POST", "workspaces/%s/items" % fab.ws, body)
        if st == 202:
            fab.c.wait_operation(h)
        fab.items(refresh=True)
        mine, _ = fab.find(kind, name)
        print("created %s %r %s" % (kind, name, mine["id"] if mine else (out or {}).get("id", "?")))
        if kind == "Lakehouse":
            wait_sql_endpoint(fab, mine)
    return 1 if bad else 0


def wait_sql_endpoint(fab, item, tries=20):
    """A new lakehouse's SQL endpoint provisions after the item; Direct Lake models need it."""
    if not item:
        return
    for _ in range(tries):
        host, _ = fab.lakehouse_sql(item["id"])
        if host:
            return
        fab.c.sleep(15)
    print("  note: SQL endpoint of %s not ready yet; {{sqlEndpoint:...}} will resolve on a re-run" % item["displayName"])


def cmd_run(fab, kind, name, job_type, apply, timeout, poll):
    mine, other = fab.find(kind, name)
    if not mine:
        print("%s %r not found in folder %r%s" % (kind, name, fab.folder_name,
                                                 " (one exists outside it; not this lane's)" if other else ""))
        return 2
    job = job_type or JOB_TYPES.get(kind)
    if not job:
        print("no default job type for %s; pass --job-type" % kind)
        return 2
    if not apply:
        print("would run %s %r (%s), job type %s, and wait up to %d s" % (kind, name, mine["id"], job, timeout))
        return 0
    st, h, _ = fab.c.call("POST", "workspaces/%s/items/%s/jobs/instances?jobType=%s" % (fab.ws, mine["id"], job), {})
    loc = h.get("location")
    if not loc:
        print("job accepted without a Location header; check the item's run history")
        return 2
    t0 = time.time()
    while True:
        fab.c.sleep(poll)
        s = fab.c.get(loc) or {}
        status = s.get("status")
        if status not in ("NotStarted", "InProgress", None):
            took = time.time() - t0
            reason = s.get("failureReason")
            print("%s %r %s after %.0f s%s" % (kind, name, status, took,
                                               (": " + json.dumps(reason)[:2000]) if reason else ""))
            return 0 if status in ("Completed", "Deduped") else 1
        if time.time() - t0 > timeout:
            print("%s %r still %s after %d s; the job keeps running (%s)" % (kind, name, status, timeout, loc))
            return 1


def _reconcile():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "reconcile_report", os.path.join(os.path.dirname(os.path.abspath(__file__)), "reconcile-report.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def parse_touch(t):
    """'table/keycol=key/col=value' -> (table, keycol, key, col, raw value)."""
    parts = (t or "").split("/", 2)
    if len(parts) != 3 or "=" not in parts[1] or "=" not in parts[2]:
        raise Finding("--touch is TABLE/KEYCOL=KEY/COLUMN=VALUE, got %r" % t)
    kc, kv = parts[1].split("=", 1)
    col, val = parts[2].split("=", 1)
    return parts[0].strip(), kc.strip(), kv.strip(), col.strip(), val.strip()


def touch_value(raw, meta, table, col):
    if raw.startswith("choice:"):
        return meta.choice_value(table, col, raw[len("choice:"):])
    if re.match(r"^-?\d+$", raw):
        return int(raw)
    if raw in ("true", "false"):
        return raw == "true"
    return raw


def cmd_prove_refresh(fab, man, a, transport, sleep):
    from _ppapi import dataverse
    rr = _reconcile()
    if not (a.checks and a.check and a.touch):
        print("prove-refresh needs --checks, --check and --touch")
        return 2
    with open(a.checks, encoding="utf-8-sig") as f:
        spec = json.load(f)
    chk = next((c for c in spec.get("checks") or [] if c.get("name") == a.check), None)
    if not chk or not chk.get("dataverse") or chk["dataverse"].get("groupBy"):
        print("--check must name a single-value check with a \"dataverse\" side in %s" % a.checks)
        return 2
    table, keycol, key, col, raw = parse_touch(a.touch)
    prefix = a.prefix or (man.get("vars") or {}).get("prefix")
    if not prefix:
        print("pass --prefix (or vars.prefix in the manifest): only this build's rows may be touched")
        return 2
    if not table.lower().startswith(prefix.lower() + "_"):
        print("REFUSED: %s is not under this build's prefix %s_; prove-refresh changes only its own rows" % (table, prefix))
        return 1
    pipeline = a.pipeline or next((i["name"] for i in man.get("items") or [] if i.get("type") == "DataPipeline"), None)
    if not pipeline:
        print("no pipeline: pass --pipeline or list a DataPipeline in the manifest")
        return 2
    org, ws, ds = spec.get("org"), spec.get("workspace"), spec.get("dataset")
    if transport:
        dvt = pbit = "fixture"
    else:
        dvt, _ = get_token(org, a.dv_token_cmd, "DATAVERSE_TOKEN", org)
        pbit, _ = get_token(RESOURCES["powerbi"], a.pbi_token_cmd, "POWERBI_TOKEN")
    dv = dataverse(org, dvt, read_only=not a.apply, transport=transport, sleep=sleep)
    pbi = Client(rr.PBI, pbit, read_only=True, transport=transport, sleep=sleep)
    meta = rr.Meta(dv)
    today = rr.today_in(spec.get("timezone"))
    ds = rr.resolve_dataset(pbi, ws, ds)
    figure = lambda: (rr.dataverse_value(dv, meta, chk["dataverse"], today), rr.dax_value(pbi, ws, ds, chk["dax"], False))
    dv0, dax0 = figure()
    print("before: Dataverse %s, report %s (%s)" % (dv0, dax0, a.check))
    t = meta.table(table)
    from _ppapi import odata_literal
    rows = (dv.get("%s?$select=%s,%s&$filter=%s eq %s" % (t["set"], col, keycol, keycol, odata_literal(key))) or {}).get("value") or []
    if len(rows) != 1:
        print("--touch matched %d rows in %s where %s = %r; it must match exactly one" % (len(rows), table, keycol, key))
        return 2
    row = rows[0]
    pk = next((k for k in row if k.endswith("id") and k.startswith(table)), None) or (table + "id")
    ident = row.get(pk)
    original = row.get(col)
    new = touch_value(raw, meta, table, col)
    if not a.apply:
        print("would set %s %s=%s: %s %r -> %r, run pipeline %r, re-read the figure, then restore %r and run it again"
              % (table, keycol, key, col, original, new, pipeline, original))
        print("plan only: nothing was written. Re-run with --apply.")
        return 0
    if original == new:
        print("--touch value equals the current value; choose a change that moves %r" % a.check)
        return 2
    rc = 1
    try:
        dv.call("PATCH", "%s(%s)" % (t["set"], ident), {col: new})
        dv1, _ = figure()
        if rr.same(dv0, dv1, 0.0001):
            print("the touch did not move the Dataverse figure (%s); choose a change that %r counts" % (dv1, a.check))
            return 1
        if cmd_run(fab, "DataPipeline", pipeline, None, True, a.timeout, a.poll) != 0:
            print("the pipeline did not complete; the refresh is not proved")
            return 1
        _, dax1 = figure()
        moved = not rr.same(dax0, dax1, 0.0001) and rr.same(dv1, dax1, 0.0001)
        print("after:  Dataverse %s, report %s" % (dv1, dax1))
        if moved:
            print("PROVED: a refresh run from Fabric alone carried a Dataverse change into the report")
            rc = 0
        else:
            print("NOT PROVED: the report did not follow the change - the refresh does not reach Dataverse from Fabric "
                  "(a landing step outside Fabric, a stale frame, or a filter that hides the row)")
    finally:
        dv.call("PATCH", "%s(%s)" % (t["set"], ident), {col: original})
        print("restored %s %s=%s: %s %r" % (table, keycol, key, col, original))
        if cmd_run(fab, "DataPipeline", pipeline, None, True, a.timeout, a.poll) != 0:
            print("note: the restoring refresh did not complete; run the pipeline again")
    return rc


def query_error(out):
    """The M error in an executeQuery answer, or None. The answer is an Arrow stream; an evaluation
    error is embedded in it as {"Error":"..."} (the transport extracts it as _error)."""
    if isinstance(out, dict):
        if out.get("_error"):
            return out["_error"]
        if isinstance(out.get("Error"), str):
            return out["Error"]
        m = re.search(r'\{"Error":"((?:[^"\\]|\\.)*)"', out.get("_text") or "")
        return m.group(1) if m else None
    return None


def cmd_probe(fab, man, root, name, queries, mashup):
    mine, other = fab.find("Dataflow", name)
    if not mine:
        print("Dataflow %r not found in folder %r%s" % (name, fab.folder_name, " (one exists outside it)" if other else ""))
        return 2
    if not queries:
        item = next((i for i in man.get("items") or [] if i.get("type") == "Dataflow" and i.get("name") == name), None)
        if not item or not item.get("source"):
            print("pass --query, or list Dataflow %r with a \"source\" in the manifest" % name)
            return 2
        text = "".join(v.decode("utf-8-sig") for k, v in read_parts(root, item["source"]).items() if k.lower().endswith(".pq"))
        queries = [q[:-len("_DataDestination")] for q in shared_queries(text) if q.endswith("_DataDestination")]
        if not queries:
            print("no loaded query (one with a <name>_DataDestination partner) in %s; pass --query" % item["source"])
            return 2
    custom = None
    if mashup:
        with open(mashup, encoding="utf-8-sig") as f:
            custom = f.read()
    bad = 0
    for q in queries:
        body = {"queryName": q}
        if custom is not None:
            body["customMashupDocument"] = custom
        try:
            _, _, out = fab.c.call("POST", "workspaces/%s/dataflows/%s/executeQuery" % (fab.ws, mine["id"]), body, read=True)
            err = query_error(out)
        except ApiError as e:
            err = str(e)
        if err:
            bad += 1
            print("  FAIL  %-32s %s" % (q, err[:600]))
        else:
            print("  ok    %s" % q)
    print("%d of %d quer%s failed%s" % (bad, len(queries), "y" if len(queries) == 1 else "ies",
                                       " (custom mashup document)" if custom is not None else ""))
    return 1 if bad else 0


def cmd_items(fab, kind):
    rows = [i for i in fab.items() if (not kind or i.get("type") == kind)]
    if fab.folder_name:
        rows = [i for i in rows if fab.folder_id and i.get("folderId") == fab.folder_id]
        print("folder %r: %s" % (fab.folder_name, fab.folder_id or "not created yet"))
    for i in sorted(rows, key=lambda r: (r.get("type", ""), r.get("displayName", ""))):
        print("%-16s %-40s %s" % (i.get("type"), i.get("displayName"), i.get("id")))
    print("%d item(s)" % len(rows))
    return 0


# Teardown order, consumers first. A Dataflow Gen2 whose destination lakehouse is already gone could
# not be deleted at all in a measured close-out (UnknownError, 400, on both the dataflows and items
# endpoints); deleted before its lakehouse it goes cleanly. A lakehouse's SQL endpoint is deleted WITH
# the lakehouse: deleting it on its own returns 404, which is expected, not a failure.
TEARDOWN_ORDER = ["Report", "Dashboard", "PaginatedReport", "SemanticModel", "DataPipeline", "Dataflow",
                  "Notebook", "SparkJobDefinition", "Environment"]
TEARDOWN_LAST = ["Warehouse", "Lakehouse"]
TEARDOWN_WITH_PARENT = {"SQLEndpoint": "Lakehouse"}


def teardown_order(items):
    """(ordered, skipped): the items in the order to delete them, and the ones that go with a parent.
    Types not named above sit after the known consumers and before warehouses and lakehouses."""
    def rank(t):
        if t in TEARDOWN_ORDER:
            return TEARDOWN_ORDER.index(t)
        if t in TEARDOWN_LAST:
            return 100 + TEARDOWN_LAST.index(t)
        return 50
    keep = [i for i in items if i.get("type") not in TEARDOWN_WITH_PARENT]
    skipped = [i for i in items if i.get("type") in TEARDOWN_WITH_PARENT]
    keep.sort(key=lambda i: (rank(i.get("type", "")), i.get("displayName", "")))
    return keep, skipped


def cmd_teardown_plan(fab):
    """Read-only: the order in which the owner's cleanup (a script or the portal) deletes this folder."""
    if not fab.folder_name:
        print("teardown-plan needs --folder (it never plans a whole workspace)")
        return 2
    if not fab.folder_id:
        print("folder %r does not exist: nothing to remove" % fab.folder_name)
        return 0
    rows = [i for i in fab.items() if i.get("folderId") == fab.folder_id]
    order, skipped = teardown_order(rows)
    print("folder %r: %d item(s). Delete in this order (consumers first, Dataflows before lakehouses):" % (fab.folder_name, len(rows)))
    for n, i in enumerate(order, 1):
        print("  %2d. %-16s %-40s %s" % (n, i.get("type"), i.get("displayName"), i.get("id")))
    for i in skipped:
        print("      %-16s %-40s goes with its %s (a separate delete returns 404; expected)" % (i.get("type"), i.get("displayName"), TEARDOWN_WITH_PARENT[i["type"]]))
    print("  %2d. the folder itself, once it is empty" % (len(order) + 1))
    print("If the API refuses a Dataflow (UnknownError) after its lakehouse is gone, delete it in the Fabric portal.")
    print("This command deletes nothing: removing Fabric items is an owner step.")
    return 0


def run(argv, transport=None, sleep=None):
    ap = argparse.ArgumentParser(prog="fabric.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("command", nargs="?", choices=["items", "deploy", "run", "prove-refresh", "teardown-plan", "probe"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--manifest")
    ap.add_argument("--workspace")
    ap.add_argument("--folder")
    ap.add_argument("--type")
    ap.add_argument("--only", action="append")
    ap.add_argument("--query", action="append")
    ap.add_argument("--mashup")
    ap.add_argument("--job-type")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--timeout", type=int, default=3600)
    ap.add_argument("--poll", type=float, default=15)
    ap.add_argument("--token-cmd")
    ap.add_argument("--token-env", default="FABRIC_TOKEN")
    ap.add_argument("--checks")
    ap.add_argument("--check")
    ap.add_argument("--touch")
    ap.add_argument("--pipeline")
    ap.add_argument("--prefix")
    ap.add_argument("--dv-token-cmd")
    ap.add_argument("--pbi-token-cmd")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.command:
        ap.print_help()
        return 2
    man, root = {}, os.getcwd()
    if a.manifest:
        try:
            with open(a.manifest, encoding="utf-8-sig") as f:
                man = json.load(f)
        except (OSError, ValueError) as e:
            print("cannot read manifest: %s" % e)
            return 2
        root = os.path.dirname(os.path.abspath(a.manifest))
        root = os.path.join(root, man.get("root", "."))
    ws = a.workspace or man.get("workspace")
    folder = a.folder or man.get("folder")
    if not ws:
        print("pass --workspace or a manifest with \"workspace\"")
        return 2
    if a.command == "deploy" and not man:
        print("deploy needs --manifest")
        return 2
    try:
        if transport:
            token = "fixture"
        else:
            token, _ = get_token(RESOURCES["fabric"], a.token_cmd, a.token_env)
        writes = a.apply and a.command in ("deploy", "run", "prove-refresh")
        fab = Fabric(Client(BASE, token, read_only=not writes, transport=transport, sleep=sleep), ws, folder)
        if a.command == "items":
            return cmd_items(fab, a.type)
        if a.command == "teardown-plan":
            return cmd_teardown_plan(fab)
        if a.command == "probe":
            if len(a.args) != 1:
                print("probe takes NAME (the Dataflow)")
                return 2
            return cmd_probe(fab, man, root, a.args[0], a.query or [], a.mashup)
        if a.command == "prove-refresh":
            return cmd_prove_refresh(fab, man, a, transport, sleep)
        if a.command == "deploy":
            rc = cmd_deploy(fab, man, root, set(a.only or []), a.apply)
            if not a.apply:
                print("plan only: nothing was written. Re-run with --apply.")
            return rc
        if len(a.args) != 2:
            print("run takes TYPE NAME")
            return 2
        return cmd_run(fab, a.args[0], a.args[1], a.job_type, a.apply, a.timeout, a.poll)
    except PlanRefused as e:
        print("BUG: %s" % e)
        return 2
    except ApiError as e:
        print("cannot run: %s" % e)
        return 2


# --------------------------------------------------------------------------- selftest

def _fake_fabric():
    import uuid
    state = {"folders": [{"id": "f-other", "displayName": "Someone Else"}],
             "items": [{"id": "x-1", "type": "Notebook", "displayName": "APP_Taken", "folderId": "f-other"},
                       {"id": "x-2", "type": "Report", "displayName": "Loose report"}],
             "jobs": {}, "defs": {}}
    t = FakeTransport()
    t.on("GET", "/v1/workspaces", lambda u, b: {"value": [{"id": "11111111-2222-3333-4444-555555555555",
                                                           "displayName": "Team Workspace"}]})
    t.on("GET", "/folders", lambda u, b: {"value": state["folders"]})

    def new_folder(u, b):
        f = {"id": "f-" + uuid.uuid4().hex[:6], "displayName": b["displayName"]}
        state["folders"].append(f)
        return 201, {}, f
    t.on("POST", "/folders", new_folder)
    t.on("GET", "/items", lambda u, b: {"value": state["items"]})

    def new_item(u, b):
        it = {"id": "i-" + uuid.uuid4().hex[:6], "type": b["type"], "displayName": b["displayName"],
              "folderId": b.get("folderId")}
        state["items"].append(it)
        state["defs"][it["id"]] = b.get("definition")
        if b["type"] == "Report":           # one long-running create, to exercise the LRO path
            return 202, {"location": "https://api.fabric.microsoft.com/v1/operations/op1", "retry-after": "0"}, None
        return 201, {}, it
    t.on("POST", "/items", new_item)
    t.on("GET", "/operations/op1", lambda u, b: {"status": "Succeeded"})
    t.on("GET", "/operations/op1/result", lambda u, b: (404, {}, None))

    def upd(u, b):
        iid = u.split("/items/")[1].split("/")[0]
        state["defs"][iid] = b["definition"]
        return 200, {}, None
    t.on("POST", "/updateDefinition", upd)
    t.on("GET", "/lakehouses/", lambda u, b: {"properties": {"sqlEndpointProperties": {
        "connectionString": "abc.datawarehouse.fabric.microsoft.com", "id": "sql-1"}}})

    def job(u, b):
        iid = u.split("/items/")[1].split("/")[0]
        return 202, {"location": "https://api.fabric.microsoft.com/v1/jobs/" + iid}, None
    t.on("POST", "/jobs/instances", job)
    t.on("GET", "/v1/jobs/", lambda u, b: {"status": state["jobs"].get(u.rsplit("/", 1)[1], "Completed"),
                                           "failureReason": {"message": "boom"} if state["jobs"].get(u.rsplit("/", 1)[1]) == "Failed" else None})
    return t, state


def selftest():
    import io
    import shutil
    import tempfile
    failures = []

    def check(name, cond):
        print("  %s  %s" % ("ok  " if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    tmp = tempfile.mkdtemp(prefix="fabric-selftest-")
    try:
        os.makedirs(os.path.join(tmp, "fabric", "notebooks"))
        os.makedirs(os.path.join(tmp, "fabric", "model", "definition"))
        with open(os.path.join(tmp, "fabric", "notebooks", "silver.py"), "w") as f:
            f.write("WS = '{{workspaceId}}'\nBRONZE = '{{id:Lakehouse:APP_Bronze}}'\nP = '{{var:prefix}}'\n")
        with open(os.path.join(tmp, "fabric", "model", "definition", "expressions.tmdl"), "w") as f:
            f.write('Sql.Database("{{sqlEndpoint:APP_Gold}}", "{{sqlEndpointId:APP_Gold}}")\n')
        with open(os.path.join(tmp, "fabric", "model", "definition.pbism"), "w") as f:
            f.write('{"version": "4.0"}')
        man = {"workspace": "Team Workspace", "folder": "Equipment Lane", "vars": {"prefix": "app"},
               "items": [{"type": "Lakehouse", "name": "APP_Bronze"},
                         {"type": "Lakehouse", "name": "APP_Gold"},
                         {"type": "Notebook", "name": "APP_Silver", "source": "fabric/notebooks/silver.py",
                          "lakehouse": "APP_Bronze"},
                         {"type": "SemanticModel", "name": "APP Model", "source": "fabric/model"},
                         {"type": "Report", "name": "APP Report"}]}
        mpath = os.path.join(tmp, "fabric.json")
        with open(mpath, "w") as f:
            json.dump(man, f)

        def go(t, *args):
            buf, old = io.StringIO(), sys.stdout
            sys.stdout = buf
            try:
                rc = run(list(args), transport=t, sleep=lambda s: None)
            finally:
                sys.stdout = old
            return rc, buf.getvalue()

        t, state = _fake_fabric()
        rc, out = go(t, "deploy", "--manifest", mpath)
        check("plan exits 0", rc == 0)
        check("plan sends only GETs", t.writes() == [])
        check("plan names the folder it would create", "would create folder 'Equipment Lane'" in out)
        check("plan lists every item as a create", out.count("would create ") == 6)
        check("plan names placeholders that wait for an earlier item", "placeholders pending: {{id:Lakehouse:APP_Bronze}}" in out)

        rc, out = go(t, "deploy", "--manifest", mpath, "--apply")
        check("apply exits 0", rc == 0, )
        lane = [f for f in state["folders"] if f["displayName"] == "Equipment Lane"]
        check("apply creates the folder once", len(lane) == 1)
        mine = [i for i in state["items"] if lane and i.get("folderId") == lane[0]["id"]]
        check("apply creates five items in the folder", len(mine) == 5)
        nb = next(i for i in mine if i["type"] == "Notebook")
        part = state["defs"][nb["id"]]["parts"][0]
        nbjson = json.loads(base64.b64decode(part["payload"]).decode())
        src = "".join(nbjson["cells"][0]["source"])
        bronze = next(i for i in mine if i["displayName"] == "APP_Bronze")
        check("notebook placeholders resolved", "11111111-2222-3333-4444-555555555555" in src
              and bronze["id"] in src and "P = 'app'" in src)
        check("notebook bound to its default lakehouse",
              nbjson["metadata"]["dependencies"]["lakehouse"]["default_lakehouse"] == bronze["id"])
        model = next(i for i in mine if i["type"] == "SemanticModel")
        parts = {p["path"]: base64.b64decode(p["payload"]).decode() for p in state["defs"][model["id"]]["parts"]}
        check("model keeps folder-relative part paths", set(parts) == {"definition.pbism", "definition/expressions.tmdl"})
        check("SQL endpoint placeholders resolved", "abc.datawarehouse.fabric.microsoft.com" in parts["definition/expressions.tmdl"]
              and "sql-1" in parts["definition/expressions.tmdl"])

        # A measure named like a column of its table (any case) is refused by the service: stop it here.
        tables = os.path.join(tmp, "fabric", "clash", "definition", "tables")
        os.makedirs(tables)
        fact = ("table fact_amount\n\tmeasure Budget = SUM(fact_amount[%s])\n\t\tformatString: 0\n\n"
                "\tcolumn %s\n\t\tdataType: double\n\t\tsourceColumn: budget\n")
        with open(os.path.join(tables, "fact_amount.tmdl"), "w") as f:
            f.write(fact % ("budget", "budget"))
        clash_item = {"type": "SemanticModel", "name": "APP Clash", "source": "fabric/clash"}
        try:
            build_definition(clash_item, tmp, None, {}, set(), False)
            check("a measure named like a column (any case) is refused offline", False)
        except Finding as e:
            check("a measure named like a column (any case) is refused offline", "'Budget'" in str(e) and "'budget'" in str(e))
        with open(os.path.join(tables, "fact_amount.tmdl"), "w") as f:
            f.write(fact % ("budget_amount", "budget_amount"))
        d, _ = build_definition(clash_item, tmp, None, {}, set(), False)
        check("a suffixed column beside the plain measure passes", len(d["parts"]) == 1)
        check("the same name in another table is not a clash",
              tmdl_name_clashes({"a.tmdl": "table t1\n\tcolumn 'Open Records'\n",
                                 "b.tmdl": "table t2\n\tmeasure 'Open Records' = 1\n"}) == [])
        check("quoted names are compared unquoted", len(tmdl_name_clashes(
            {"a.tmdl": "table t1\n\tcolumn 'open records'\n\tmeasure 'Open Records' = 1\n"})) == 1)

        # Report images (a masthead, a logo) are sent as their bytes, never decoded as text.
        img = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE, 0x80])
        res = os.path.join(tmp, "fabric", "imgreport", "StaticResources", "RegisteredResources")
        os.makedirs(res)
        with open(os.path.join(res, "masthead.png"), "wb") as f:
            f.write(img)
        d, _ = build_definition({"type": "Report", "name": "APP Img", "source": "fabric/imgreport"}, tmp, None, {}, set(), False)
        check("a report image is sent byte for byte", base64.b64decode(d["parts"][0]["payload"]) == img)

        n_before = len(state["items"])
        rc, out = go(t, "deploy", "--manifest", mpath, "--apply")
        check("re-run is idempotent (no new items)", rc == 0 and len(state["items"]) == n_before)
        check("re-run updates definitions in place", "updated Notebook 'APP_Silver'" in out)

        man2 = dict(man, items=[{"type": "Notebook", "name": "APP_Taken", "source": "fabric/notebooks/silver.py"}])
        with open(mpath, "w") as f:
            json.dump(man2, f)
        w0 = len(t.writes())
        rc, out = go(t, "deploy", "--manifest", mpath, "--apply")
        check("a name owned outside the folder is refused with exit 1", rc == 1 and "REFUSED" in out)
        check("a refusal writes nothing", len(t.writes()) == w0)

        man3 = dict(man, items=[{"type": "Notebook", "name": "APP_New", "source": "fabric/notebooks/silver.py"}],
                    vars={})
        with open(mpath, "w") as f:
            json.dump(man3, f)
        rc, out = go(t, "deploy", "--manifest", mpath, "--apply")
        check("an unresolved placeholder stops the apply", rc == 1 and "unresolved placeholder" in out
              and "{{var:prefix}}" in out)

        with open(os.path.join(tmp, "fabric", "notebooks", "raw.py"), "w") as f:
            f.write("LH = '{{id:Lakehouse:{PREFIX}_Bronze}}'\n")
        man4 = dict(man, items=[{"type": "Notebook", "name": "APP_Raw", "source": "fabric/notebooks/raw.py"},
                                {"type": "Notebook", "name": "{PREFIX}_Gold"}])
        with open(mpath, "w") as f:
            json.dump(man4, f)
        rc, out = go(t, "deploy", "--manifest", mpath)
        check("unfilled template tokens are refused, in names and in files", rc == 1
              and out.count("template token") == 2)

        rc, out = go(t, "run", "Notebook", "APP_Silver", "--workspace", "Team Workspace", "--folder", "Equipment Lane")
        check("run without --apply only plans", rc == 0 and "would run" in out and not any("jobs/instances" in u for _, u in t.writes()))
        rc, out = go(t, "run", "Notebook", "APP_Silver", "--workspace", "Team Workspace", "--folder", "Equipment Lane", "--apply")
        check("run waits for Completed and exits 0", rc == 0 and "Completed" in out)
        state["jobs"][nb["id"]] = "Failed"
        rc, out = go(t, "run", "Notebook", "APP_Silver", "--workspace", "Team Workspace", "--folder", "Equipment Lane", "--apply")
        check("a failed job exits 1 with its reason", rc == 1 and "boom" in out)
        rc, out = go(t, "items", "--workspace", "Team Workspace", "--folder", "Equipment Lane")
        check("items lists the folder only", rc == 0 and "APP_Silver" in out and "Loose report" not in out)
        rc, out = go(t, "items", "--workspace", "No Such Workspace")
        check("unknown workspace exits 2", rc == 2)

        # Dataflow mashups: a destination query that is not defined, and a Yes/No filter on a lakehouse.
        good_pq = ('section Section1;\n'
                   '[DataDestinations = {[Definition = [Kind = "Reference", QueryName = "orders_DataDestination", IsNewTarget = true]]}]\n'
                   'shared orders = let\n  Source = Lakehouse.Contents([EnableFolding = false]),\n'
                   '  Rows = Table.SelectRows(Source, each not List.Contains({false}, [is_current]))\nin\n  Rows;\n'
                   'shared orders_DataDestination = let\n  Pattern = Lakehouse.Contents([]),\n'
                   '  T = Table.SelectRows(Pattern, each [flag] = true)\nin\n  T;\n')
        check("a mashup with its destination defined and List.Contains filters passes", mashup_findings({"mashup.pq": good_pq}) == [])
        no_dest = good_pq.replace("shared orders_DataDestination", "shared orders_Destination")
        f1 = mashup_findings({"mashup.pq": no_dest})
        check("a [DataDestinations] query the document never defines is refused",
              any("names query 'orders_DataDestination'" in x for x in f1))
        cmp_pq = good_pq.replace("each not List.Contains({false}, [is_current])", "each [is_current] <> false")
        f2 = mashup_findings({"mashup.pq": cmp_pq})
        check("each [flag] <> false over a lakehouse is refused with the List.Contains form",
              len(f2) == 1 and "not List.Contains({false}, [is_current])" in f2[0])
        check("each [flag] = true over a Dataverse source is left alone", mashup_findings(
            {"mashup.pq": cmp_pq.replace("Lakehouse.Contents([EnableFolding = false])", 'CommonDataService.Database("x")')}) == [])
        check("the shipped bronze templates pass the mashup lint", all(
            mashup_findings({"mashup.pq": open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "templates",
                                                            "fabric-medallion", d, "mashup.pq"), encoding="utf-8").read()
                                         .replace("{table}", "orders")}) == []
            for d in ("dataflow-bronze", "dataflow-bronze-webapi")))
        os.makedirs(os.path.join(tmp, "fabric", "df"))
        with open(os.path.join(tmp, "fabric", "df", "mashup.pq"), "w") as f:
            f.write(cmp_pq)
        try:
            build_definition({"type": "Dataflow", "name": "APP_DF", "source": "fabric/df"}, tmp, None, {}, set(), False)
            check("deploy refuses a Dataflow whose mashup fails the lint", False)
        except Finding as e:
            check("deploy refuses a Dataflow whose mashup fails the lint", "List.Contains" in str(e))

        # A description over 256 characters: refused in the plan; one within it is sent on create.
        with open(mpath, "w") as f:
            json.dump(dict(man, items=[{"type": "Lakehouse", "name": "APP_Long", "description": "x" * 257},
                                       {"type": "Lakehouse", "name": "APP_Short", "description": "Bronze landing"}]), f)
        w0 = len(t.writes())
        rc, out = go(t, "deploy", "--manifest", mpath, "--apply")
        short = next((i for i in state["items"] if i["displayName"] == "APP_Short"), None)
        sent = [b for m, u, b in t.calls if m == "POST" and u.endswith("/items") and (b or {}).get("displayName") == "APP_Short"]
        check("a description over 256 characters is refused, the item not sent", rc == 1 and "257 characters" in out
              and not any(i["displayName"] == "APP_Long" for i in state["items"]))
        check("a description within 256 characters is sent on create", short and sent and sent[0].get("description") == "Bronze landing")

        # probe: every loaded query is evaluated; the embedded M error is printed; reads only.
        with open(os.path.join(tmp, "fabric", "df", "mashup.pq"), "w") as f:
            f.write(good_pq + good_pq.split("section Section1;\n", 1)[1].replace("orders", "lines"))
        state["items"].append({"id": "df-1", "type": "Dataflow", "displayName": "APP_DF", "folderId": lane[0]["id"]})
        with open(mpath, "w") as f:
            json.dump(dict(man, items=[{"type": "Dataflow", "name": "APP_DF", "source": "fabric/df"}]), f)
        asked = []

        def execute(u, b):
            asked.append(b)
            if b["queryName"] == "lines":
                return 200, {}, {"_text": "ARROW1 ...", "_error": "Expression.Error: The column 'is_current' of the table wasn't found."}
            return 200, {}, {"_text": "ARROW1 rows"}
        t.on("POST", "/dataflows/df-1/executeQuery", execute)
        rc, out = go(t, "probe", "--manifest", mpath, "APP_DF")
        check("probe evaluates every loaded query and prints the M error (exit 1)", rc == 1
              and sorted(b["queryName"] for b in asked) == ["lines", "orders"] and "wasn't found" in out and "ok    orders" in out)
        mfile = os.path.join(tmp, "custom.pq")
        with open(mfile, "w") as f:
            f.write("section Section1;\nshared orders = 1;\n")
        asked.clear()
        rc, out = go(t, "probe", "--manifest", mpath, "APP_DF", "--query", "orders", "--mashup", mfile)
        check("probe --query --mashup sends one query with the custom document", rc == 0 and len(asked) == 1
              and asked[0].get("customMashupDocument", "").startswith("section Section1;"))
        check("the transport lifts an Error embedded past the first 2,000 characters of a binary answer",
              query_error({"_text": "x" * 2000, "_error": "boom"}) == "boom"
              and query_error({"_text": 'abc{"Error":"Expression.Error: bad"}'}) == "Expression.Error: bad"
              and query_error({"_text": "ARROW rows"}) is None)

        # teardown-plan: consumers first, Dataflows before lakehouses, SQL endpoints with their lakehouse.
        order, skipped = teardown_order([{"type": "Lakehouse", "displayName": "B"}, {"type": "SQLEndpoint", "displayName": "B"},
                                         {"type": "Dataflow", "displayName": "DF"}, {"type": "Report", "displayName": "R"},
                                         {"type": "Notebook", "displayName": "N"}, {"type": "Mystery", "displayName": "M"},
                                         {"type": "SemanticModel", "displayName": "S"}])
        types = [i["type"] for i in order]
        check("teardown: Dataflow before Lakehouse", types.index("Dataflow") < types.index("Lakehouse"))
        check("teardown: report and model first, lakehouse last", types[:2] == ["Report", "SemanticModel"] and types[-1] == "Lakehouse")
        check("teardown: an unknown type sits before the lakehouse", types.index("Mystery") < types.index("Lakehouse"))
        check("teardown: SQL endpoint goes with its lakehouse", [i["type"] for i in skipped] == ["SQLEndpoint"] and "SQLEndpoint" not in types)
        w0 = len(t.writes())
        rc, out = go(t, "teardown-plan", "--workspace", "Team Workspace", "--folder", "Equipment Lane")
        check("teardown-plan lists the folder in order, reads only", rc == 0 and "APP_Silver" in out and "Loose report" not in out
              and out.index("APP Report") < out.index("APP_Bronze") and len(t.writes()) == w0 and "deletes nothing" in out)
        rc, out = go(t, "teardown-plan", "--workspace", "Team Workspace")
        check("teardown-plan refuses without a folder", rc == 2 and "never plans a whole workspace" in out)

        # prove-refresh: a refresh that reaches Dataverse, one that does not, and the prefix guard.
        with open(mpath, "w") as f:
            json.dump(dict(man, items=[{"type": "DataPipeline", "name": "APP_Refresh"}]), f)
        state["items"].append({"id": "pl-1", "type": "DataPipeline", "displayName": "APP_Refresh", "folderId": lane[0]["id"]})
        state["jobs"].pop(nb["id"], None)
        cpath = os.path.join(tmp, "checks.json")
        with open(cpath, "w") as f:
            json.dump({"org": "https://example.crm.dynamics.com", "workspace": "ws-1", "dataset": "11111111-aaaa-bbbb-cccc-222222222222",
                       "checks": [{"name": "open", "dax": "EVALUATE ROW(\"v\", [Open])",
                                   "dataverse": {"table": "app_loan", "filter": "app_status eq {choice:app_loan.app_status:Open}"}}]}, f)
        dvrows = [{"app_loanid": "r1", "app_number": "L-1", "app_status": 1}, {"app_loanid": "r2", "app_number": "L-2", "app_status": 1}]
        model = {"open": 2, "reaches": True}
        t.on("GET", "EntityDefinitions(", lambda u, b: {"value": [{"LogicalName": "app_status", "OptionSet": {"Options": [
            {"Value": 1, "Label": {"UserLocalizedLabel": {"Label": "Open"}}},
            {"Value": 2, "Label": {"UserLocalizedLabel": {"Label": "Returned"}}}]}}]} if "Picklist" in u
            else {"EntitySetName": "app_loans", "PrimaryIdAttribute": "app_loanid"})
        t.on("GET", "/app_loans?$apply", lambda u, b: {"value": [{"n": sum(1 for r in dvrows if r["app_status"] == 1)}]})
        t.on("GET", "/app_loans?$select", lambda u, b: {"value": [r for r in dvrows if r["app_number"] in u]})

        def patch_row(u, b):
            ident = u.split("(")[1].split(")")[0]
            next(r for r in dvrows if r["app_loanid"] == ident).update(b)
            return 204, {}, None
        t.on("PATCH", "/app_loans(", patch_row)

        def run_pipeline(u, b):
            if model["reaches"]:
                model["open"] = sum(1 for r in dvrows if r["app_status"] == 1)
            return 202, {"location": "https://api.fabric.microsoft.com/v1/jobs/pl-1"}, None
        t.on("POST", "/items/pl-1/jobs/instances", run_pipeline)
        t.on("POST", "executeQueries", lambda u, b: {"results": [{"tables": [{"rows": [{"[v]": model["open"]}]}]}]})
        args = ["prove-refresh", "--manifest", mpath, "--checks", cpath, "--check", "open", "--prefix", "app",
                "--touch", "app_loan/app_number=L-1/app_status=choice:Returned"]
        w0 = len(t.writes())
        rc, out = go(t, *args)
        check("prove-refresh plan reads both figures and writes nothing", rc == 0 and "before: Dataverse 2, report 2" in out
              and "would set" in out and all("executeQueries" in u for _, u in t.writes()[w0:]))
        rc, out = go(t, *args, "--apply")
        check("prove-refresh passes when the report follows the change", rc == 0 and "PROVED" in out and "NOT PROVED" not in out)
        check("prove-refresh restores the row", dvrows[0]["app_status"] == 1 and "restored" in out)
        model["reaches"] = False
        model["open"] = 2
        rc, out = go(t, *args, "--apply")
        check("prove-refresh fails (exit 1) when the refresh does not reach Dataverse", rc == 1 and "NOT PROVED" in out
              and dvrows[0]["app_status"] == 1)
        bad = list(args)
        bad[bad.index("--touch") + 1] = "core_person/core_name=X/core_flag=true"
        w0 = len(t.writes())
        rc, out = go(t, *bad, "--apply")
        check("prove-refresh refuses a table outside the build's prefix", rc == 1 and "REFUSED" in out and len(t.writes()) == w0)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print()
    print("selftest: %s" % ("PASSED" if not failures else "FAILED %d: %s" % (len(failures), ", ".join(failures))))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
