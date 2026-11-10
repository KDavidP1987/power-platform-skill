#!/usr/bin/env python3
"""lineage.py - data-lineage documentation for a Fabric medallion, built from the definitions in the
repo and, with --workspace, checked against what is deployed. READ-ONLY: nothing is ever written to
Fabric (getDefinition is a POST that only reads; every other call is a GET).

Usage:
    python lineage.py doc --dataflows DIR [--pipelines DIR] [--external "NAME=FILE.pq" ...]
                          --focus TABLE [--focus TABLE ...] --out PATH_WITHOUT_EXTENSION
                          [--title T] [--notes NOTES.md] [--lakehouses FILE.json]
                          [--workspace WS] [--token-cmd CMD] [--sensitive REGEX]
    python lineage.py --selftest

What it reads:
  --dataflows   a folder of Dataflow Gen2 items in the Fabric git format (<item>/mashup.pq): every
                loaded query with a data destination is an output table; its inputs are the
                lakehouse tables, Dataverse tables, SQL tables and SharePoint lists it reads,
                through any helper queries. A query that reads another output query of the same
                dataflow is linked to that output's table.
  --pipelines   pipeline JSON (activities, dependsOn): the refresh order. Dataflow references may be
                ids or {{NAME}} placeholders.
  --external    M outside these items that reads them (a Gen1 dataflow query, a report's Power
                Query): "Consumer name=path/to/query.pq". Sql.Database(<endpoint>, <lakehouse>)
                resolves to that lakehouse's table.
  --lakehouses  JSON with {"name": ..., "id": ...} objects anywhere in it (lakehouse ids -> names).
  --workspace   read the live workspace too: lakehouse names, each dataflow's deployed definition
                compared with the repo (drift), schedules and recent runs of the pipelines and
                dataflows, and the producers of input tables made by dataflows outside --dataflows.
  --notes       Markdown written by a person (purpose, owners, decisions, consumers outside Fabric).
                It is included as given and labelled as curated, apart from the derived sections.
  --sensitive   regex on column names to flag (default: the whole words rate, salary, wage,
                pay, compensation, bonus, ssn, birth date; a column named Cost; names ending Amount).

What it writes (PATH.md, PATH.html, PATH.json):
  summary; a lineage diagram (Mermaid in the .md, inline SVG in the .html); refresh order and
  schedule; each table, which item and query make it and what it reads; how each output is built
  (filters, joins with keys, computed columns, with the M comments); column lineage for every
  --focus table: each column's origin (source column, renamed, joined from, computed with its rule)
  and the source columns it ultimately comes from; flagged columns; and the gaps: input tables with
  no known producer, columns the trace could not follow, and drift.

Evaluate an existing document (read-only; the JSON records what it was built from):
  python lineage.py evaluate --doc PATH[.json] [--dataflows DIR] [--notes NOTES.md] [--max-age-days 90]
  Checks: every column traced, no gaps, drift checked and clean, age, freshness (a dataflow in the
  chain changed since generation: regenerate), curated notes cover purpose, owner, consumers,
  refresh and verification, every sensitive column explained in the notes, a consumer and a refresh
  named. Prints PASS / WARN / FAIL per check.

Exit (doc): 0 written; 1 written, with gaps or drift to read; 2 cannot run.
Exit (evaluate): 0 no FAIL; 1 a FAIL; 2 cannot run.
Python 3 standard library only.
"""
import argparse
import base64
import datetime as dt
import hashlib
import html
import importlib.util
import json
import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
# whole words, so "Cost Center" and "Generated" are not flagged; "Cost" alone and "Rate Amount" are
DEFAULT_SENSITIVE = r"(?i)\b(rates?|salary|salaries|wages?|pay|payroll|compensation|bonus|ssn|birth\s*date|date of birth)\b|^cost$|amount$"

# --------------------------------------------------------------------------- M lexer


def tokens(text):
    """[(kind, value, start, end)] kinds: str, qid (#"..."), id, num, p (punctuation), c (comment)."""
    out, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if ch in " \t\r\n":
            i += 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            if re.search(r"\w", text[i + 2:j]):  # a banner such as // ===== is not prose
                out.append(("c", text[i + 2:j].strip(), i, j))
            i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(("c", text[i + 2:j - 2].strip(), i, j))
            i = j
        elif ch == '"' or text.startswith('#"', i):
            q = i + (2 if ch == "#" else 1)
            buf = []
            while q < n:
                if text[q] == '"':
                    if q + 1 < n and text[q + 1] == '"':
                        buf.append('"')
                        q += 2
                        continue
                    break
                buf.append(text[q])
                q += 1
            out.append(("qid" if ch == "#" else "str", "".join(buf), i, q + 1))
            i = q + 1
        elif ch.isalpha() or ch == "_":
            j = i
            while j < n and (text[j].isalnum() or text[j] in "_."):
                j += 1
            out.append(("id", text[i:j].rstrip("."), i, j))
            i = j
        elif ch.isdigit():
            j = i
            while j < n and (text[j].isalnum() or text[j] == "."):
                j += 1
            out.append(("num", text[i:j], i, j))
            i = j
        elif text.startswith("=>", i) or text.startswith("<>", i) or text.startswith(">=", i) or text.startswith("<=", i):
            out.append(("p", text[i:i + 2], i, i + 2))
            i += 2
        else:
            out.append(("p", ch, i, i + 1))
            i += 1
    return out


OPEN, CLOSE = "([{", ")]}"


def split_top(text, sep=","):
    """Split at sep outside brackets, strings and comments."""
    parts, depth, lets, last = [], 0, 0, 0
    for k, v, s, e in tokens(text):
        if k == "p" and v in OPEN:
            depth += 1
        elif k == "p" and v in CLOSE:
            depth -= 1
        elif k == "id" and v == "let" and depth == 0:
            lets += 1
        elif k == "id" and v == "in" and depth == 0 and lets:
            lets -= 1
        elif k == "p" and v == sep and depth == 0 and lets == 0:
            parts.append(text[last:s])
            last = e
    parts.append(text[last:])
    return [p.strip() for p in parts if p.strip()]


def name_of(tok):
    return tok[1]


def section(text):
    """[{name, body, comments, attribute}] for a section document; a bare let... becomes one query."""
    toks = tokens(text)
    if not any(t[0] == "id" and t[1] == "shared" for t in toks):
        return [{"name": None, "body": text.strip().rstrip(";"), "comments": [t[1] for t in toks[:1] if t[0] == "c"], "attribute": ""}]
    out, depth, i, gap_start = [], 0, 0, 0
    while i < len(toks):
        k, v, s, e = toks[i]
        if k == "p" and v in OPEN:
            depth += 1
        elif k == "p" and v in CLOSE:
            depth -= 1
        elif k == "id" and v == "shared" and depth == 0 and i + 2 < len(toks):
            gap = text[gap_start:s]
            name = name_of(toks[i + 1])
            j, d = i + 3, 0
            while j < len(toks):
                kk, vv = toks[j][0], toks[j][1]
                if kk == "p" and vv in OPEN:
                    d += 1
                elif kk == "p" and vv in CLOSE:
                    d -= 1
                elif kk == "p" and vv == ";" and d == 0:
                    break
                j += 1
            body_start = toks[i + 2][3]
            body_end = toks[j][2] if j < len(toks) else len(text)
            gtoks = tokens(gap)
            comments, attribute = [], ""
            for gk, gv, gs, ge in gtoks:
                if gk == "c" and not gv.startswith("----"):
                    comments.append(gv)
            a = re.search(r"\[\s*DataDestinations.*\]\s*$", gap, re.S)
            if a:
                attribute = a.group(0)
            # comments stop at a blank line before the query: keep the block right above it
            out.append({"name": name, "body": text[body_start:body_end].strip(), "comments": comments, "attribute": attribute})
            gap_start = toks[j][3] if j < len(toks) else len(text)
            i = j
        i += 1
    return out


def let_steps(body):
    """([(step, expr, comments)], result_expr). A body that is not a let is one step named None."""
    toks = tokens(body)
    first = next((t for t in toks if t[0] != "c"), None)
    if not first or first[1] != "let":
        return [(None, body, [])], None
    steps, i, n = [], toks.index(first) + 1, len(toks)
    pending = []
    while i < n:
        k, v, s, e = toks[i]
        if k == "c":
            pending.append(v)
            i += 1
            continue
        if k == "id" and v == "in":
            return steps, body[e:].strip()
        name = v
        i += 2                      # name, '='
        start = toks[i][2] if i < n else len(body)
        depth, lets = 0, 0
        while i < n:
            kk, vv = toks[i][0], toks[i][1]
            if kk == "p" and vv in OPEN:
                depth += 1
            elif kk == "p" and vv in CLOSE:
                depth -= 1
            elif kk == "id" and vv == "let" and depth == 0:
                lets += 1
            elif kk == "id" and vv == "in" and depth == 0:
                if lets == 0:
                    break
                lets -= 1
            elif kk == "p" and vv == "," and depth == 0 and lets == 0:
                break
            i += 1
        end = toks[i][2] if i < n else len(body)
        expr = body[start:end].strip()
        steps.append((name, expr, pending))
        pending = []
        if i < n and toks[i][1] == ",":
            i += 1
    return steps, None


def idents(expr):
    return [t[1] for t in tokens(expr) if t[0] in ("id", "qid")]


def strings(expr):
    return [t[1] for t in tokens(expr) if t[0] == "str"]


def calls(expr, fname):
    """Argument texts of each call of fname in expr."""
    out = []
    for m in re.finditer(re.escape(fname) + r"\s*\(", expr):
        depth, j = 1, m.end()
        toks = tokens(expr[m.end():])
        for k, v, s, e in toks:
            if k == "p" and v in OPEN:
                depth += 1
            elif k == "p" and v in CLOSE:
                depth -= 1
                if depth == 0:
                    out.append(split_top(expr[m.end():m.end() + s]))
                    break
    return out


def head_call(expr):
    m = re.match(r"\s*(?:Table\.Buffer\s*\(\s*)?([A-Z][A-Za-z]*\.[A-Za-z]+)\s*\(", expr)
    return m.group(1) if m else None


def str_list(arg):
    return strings(arg) if arg and arg.lstrip().startswith("{") else []


def pairs(arg):
    return [tuple(strings(p)[:2]) for p in re.findall(r"\{\s*(\"(?:[^\"]|\"\")*\"\s*,\s*\"(?:[^\"]|\"\")*\")\s*\}", arg or "")
            if len(strings(p)) >= 2]


def field_refs(expr):
    """(row fields [x] used directly, {row variable or step: fields}) from an expression."""
    toks = tokens(expr)
    direct, owned = [], {}
    for i, t in enumerate(toks):
        if t[0] != "p" or t[1] != "[":
            continue
        # a field access [name]: one quoted identifier, or a generalized identifier (words, spaces,
        # and characters like - & /) up to the closing bracket, with no = , [ or string inside
        j, ok = i + 1, True
        while j < len(toks) and toks[j][1] != "]":
            if toks[j][0] in ("str", "c") or toks[j][1] in ("=", ",", "[", "{", "(", "=>"):
                ok = False
                break
            j += 1
        if not ok or j >= len(toks) or j == i + 1:
            continue
        if toks[i + 1][0] == "qid" and j == i + 2:
            f = toks[i + 1][1]
        elif all(toks[k][0] in ("id", "num", "p") for k in range(i + 1, j)) and toks[i + 1][0] in ("id", "num"):
            f = re.sub(r"\s+", " ", expr[toks[i + 1][2]:toks[j - 1][3]]).strip()
        else:
            continue
        if True:
            prev = toks[i - 1] if i else None
            if prev and prev[0] in ("id", "qid") and prev[1] not in ("each", "then", "else", "and", "or", "not", "if", "in", "let"):
                owned.setdefault(prev[1], []).append(f)
            elif prev and prev[1] in ("}", "]", ")"):
                owned.setdefault("?", []).append(f)
            else:
                direct.append(f)
    for args in calls(expr, "Record.Field"):
        if len(args) == 2 and strings(args[1]):
            owned.setdefault(args[0].strip(), []).append(strings(args[1])[0])
    return direct, owned


def record_fields(expr):
    """{field: expr} of the record a TransformRows lambda builds: (r) => [ A = ..., #"B" = ... ]."""
    m = re.search(r"=>\s*\[", expr)
    if not m:
        return {}
    start, depth = m.end(), 1
    for k, v, s, e in tokens(expr[start:]):
        if k == "p" and v in OPEN:
            depth += 1
        elif k == "p" and v in CLOSE:
            depth -= 1
            if depth == 0:
                inner = expr[start:start + s]
                out = {}
                for part in split_top(inner):
                    pt = tokens(part)
                    if len(pt) >= 2 and pt[0][0] in ("id", "qid") and pt[1][1] == "=":
                        out[pt[0][1]] = part[pt[1][3]:].strip()
                return out
    return {}


def record_field_exprs(expr, field):
    """Every `field = <expr>` inside record literals of expr, and the let bindings before the final in."""
    toks, found = tokens(expr), []
    for i, t in enumerate(toks):
        if t[1] == "[" and i + 2 < len(toks) and toks[i + 1][0] in ("id", "qid") and toks[i + 2][1] == "=":
            depth = 1
            for k in range(i + 1, len(toks)):
                if toks[k][0] == "p" and toks[k][1] in OPEN:
                    depth += 1
                elif toks[k][0] == "p" and toks[k][1] in CLOSE:
                    depth -= 1
                    if depth == 0:
                        for part in split_top(expr[toks[i][3]:toks[k][2]]):
                            pt = tokens(part)
                            if len(pt) >= 2 and pt[0][0] in ("id", "qid") and pt[0][1] == field and pt[1][1] == "=":
                                found.append(part[pt[1][3]:].strip())
                        break
    lets = ""
    m = re.search(r"\blet\b(.*)\bin\b", expr, re.S)
    if m and found:
        lets = m.group(1)
    return found, lets


def short(expr, n=170):
    s = re.sub(r"\s+", " ", re.sub(r"//[^\n]*", "", expr)).strip()
    return s if len(s) <= n else s[:n - 3].rstrip() + "..."


# --------------------------------------------------------------------------- reading items

LH_ID = re.compile(r'lakehouseId\s*=\s*"([0-9a-fA-F-]{36})"')
NAV = re.compile(r'(#"(?:[^"]|"")*"|[A-Za-z_][\w]*)\s*\{\s*\[\s*Id\s*=\s*"([^"]+)"\s*,\s*ItemKind\s*=\s*"Table"\s*\]\s*\}')
DV = re.compile(r'(?:CommonDataService\.Database|Dataverse\.Contents|Dataverse\.Database)\s*\(\s*"([^"]+)"')
SQLDB = re.compile(r'Sql\.Database\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"')
ITEM = re.compile(r'\{\s*\[\s*Schema\s*=\s*"([^"]+)"\s*,\s*Item\s*=\s*"([^"]+)"\s*\]\s*\}')
SP = re.compile(r'SharePoint\.(Tables|Files|Contents)\s*\(\s*"([^"]+)"')
GUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
FUNC_DEF = re.compile(r"^\s*\([^()]*\)\s*(as\s+[\w.]+\s*)?=>")
SP_LIST = re.compile(r'\{\s*\[\s*(?:Title|Id)\s*=\s*"([^"]+)"\s*\]\s*\}')


class Dataflow:
    def __init__(self, name, text, kind="Dataflow", path=None):
        self.name, self.kind, self.path, self.text = name, kind, path, text
        self.queries = {}
        for q in section(text):
            qn = q["name"] or name
            steps, result = let_steps(q["body"])
            q.update(steps=steps, result=result, lakehouse=None)
            self.queries[qn] = q
        for qn, q in self.queries.items():
            ids = LH_ID.findall(q["body"])
            if ids and "Lakehouse.Contents" in q["body"] and not NAV.search(q["body"]):
                q["lakehouse"] = ids[-1]          # a handle query: Bronze = Lakehouse.Contents(...){...}
        self.outputs = {}                         # query -> (lakehouse id, table)
        for qn, q in self.queries.items():
            m = re.search(r'QueryName\s*=\s*"([^"]+)"', q["attribute"] or "")
            if m and m.group(1) in self.queries:
                d = self.queries[m.group(1)]["body"]
                ids, nav = LH_ID.findall(d), NAV.findall(d)
                if ids and nav:
                    self.outputs[qn] = (ids[-1], nav[-1][1])

    def is_destination(self, qn):
        return any(re.search(r'QueryName\s*=\s*"%s"' % re.escape(qn), q["attribute"] or "") for q in self.queries.values())

    def query_refs(self, qn):
        names = set(idents(self.queries[qn]["body"]))
        return [o for o in self.queries if o != qn and o in names and not self.is_destination(o)]

    def reads(self, qn):
        """Sources read directly by query qn: [(kind, a, b)] lakehouse (lh id, table), dv (org, table),
        sql (host, db, table), sp (site, list)."""
        q = self.queries[qn]
        body = q["body"]
        out = []
        step_lh = {s: LH_ID.findall(e)[-1] for s, e, _ in q["steps"] if s and LH_ID.findall(e) and "Lakehouse.Contents" not in e}
        step_lh.update({s: LH_ID.findall(e)[-1] for s, e, _ in q["steps"] if s and LH_ID.findall(e)})
        for handle, table in NAV.findall(body):
            h = handle[2:-1] if handle.startswith('#"') else handle
            lh = step_lh.get(h) or (self.queries.get(h) or {}).get("lakehouse")
            if lh:
                out.append(("lh", lh, table))
        dv = DV.search(body)
        if dv:
            for schema, item in ITEM.findall(body):
                out.append(("dv", dv.group(1), item))
        for host, db in SQLDB.findall(body):
            for schema, item in ITEM.findall(body):
                out.append(("sql", host, db, item))
        for kind, site in SP.findall(body):
            lists = SP_LIST.findall(body)
            for lst in lists or ["(site)"]:
                out.append(("sp", site, lst, qn))
        return out


def read_dataflows(folder):
    out = []
    for item in sorted(os.listdir(folder)):
        p = os.path.join(folder, item, "mashup.pq")
        if os.path.isfile(p):
            with open(p, encoding="utf-8-sig") as f:
                out.append(Dataflow(item, f.read(), path=p))
    return out


def read_pipelines(folder):
    out = []
    for fn in sorted(os.listdir(folder or ".")) if folder else []:
        if not fn.endswith(".json"):
            continue
        with open(os.path.join(folder, fn), encoding="utf-8-sig") as f:
            d = json.load(f)
        p = d.get("properties", d)
        acts = []
        for a in p.get("activities", []):
            tp = a.get("typeProperties", {})
            ref = tp.get("dataflowId") or (tp.get("notebookId")) or (tp.get("pipelineId")) or ""
            acts.append({"name": a.get("name"), "type": a.get("type"), "ref": re.sub(r"^\{\{\s*|\s*\}\}$", "", ref),
                         "dependsOn": [x.get("activity") for x in a.get("dependsOn", [])]})
        out.append({"name": os.path.splitext(fn)[0], "activities": acts})
    return out


def lakehouse_names(path):
    names = {}

    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("id"), str) and isinstance(o.get("name"), str):
                names[o["id"].lower()] = o["name"]
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    if path:
        with open(path, encoding="utf-8-sig") as f:
            walk(json.load(f))
    return names


# --------------------------------------------------------------------------- the graph


class Graph:
    def __init__(self, dataflows, externals, lh_names):
        self.dfs = {d.name: d for d in dataflows}
        self.ext = externals
        self.lh = dict(lh_names)
        self.nodes, self.edges = {}, []          # edges: (src, dst, item, query)
        self.producer = {}                       # table node -> (dataflow, query)
        for d in list(dataflows) + list(externals):
            for qn, (lh, table) in d.outputs.items():
                self.producer[self.lh_node(lh, table)] = (d.name, qn)
        for d in list(dataflows) + list(externals):
            outs = d.outputs if d.outputs else ({qn: None for qn in d.queries} if d.kind == "External" else {})
            for qn in outs:
                dst = self.lh_node(*d.outputs[qn]) if d.outputs.get(qn) else "ext:" + d.name
                if dst.startswith("ext:"):
                    self.add_node(dst, "consumer", d.name, d.name)
                for src in self.inputs(d, qn):
                    self.edges.append((src, dst, d.name, qn))

    def lh_name(self, lh):
        return self.lh.get(lh.lower(), lh[:8])

    def lh_node(self, lh, table):
        n = "lh:%s/%s" % (self.lh_name(lh), table)
        self.add_node(n, "lakehouse", table, self.lh_name(lh))
        return n

    def add_node(self, nid, kind, label, group):
        self.nodes.setdefault(nid, {"id": nid, "kind": kind, "label": label, "group": group})

    def source_node(self, r):
        if r[0] == "lh":
            return self.lh_node(r[1], r[2])
        if r[0] == "dv":
            n = "dv:%s/%s" % (r[1], r[2])
            self.add_node(n, "dataverse", r[2], "Dataverse")
            return n
        if r[0] == "sql":
            lh_by_name = {v.lower(): k for k, v in self.lh.items()}
            if r[2].lower() in lh_by_name:
                return self.lh_node(lh_by_name[r[2].lower()], r[3])
            n = "sql:%s/%s/%s" % r[1:]
            self.add_node(n, "sql", r[3], "SQL " + r[2])
            return n
        n = "sp:%s/%s" % (r[1], r[2])
        name = r[2]
        if GUID.match(name) and len(r) > 3 and r[3]:
            name = "%s (list %s)" % (r[3], name[:8])
        self.add_node(n, "sharepoint", name, "SharePoint")
        return n

    def inputs(self, d, qn, seen=None):
        seen = seen if seen is not None else set()
        if qn in seen:
            return []
        seen.add(qn)
        out = [self.source_node(r) for r in d.reads(qn)]
        for ref in d.query_refs(qn):
            if ref in d.outputs and ref != qn:
                out.append(self.lh_node(*d.outputs[ref]))
            else:
                out.extend(self.inputs(d, ref, seen))
        return list(dict.fromkeys(out))

    def upstream(self, nid, acc=None):
        acc = acc if acc is not None else set()
        for s, t, _, _ in self.edges:
            if t == nid and s not in acc:
                acc.add(s)
                self.upstream(s, acc)
        return acc

    def downstream(self, nid, acc=None):
        acc = acc if acc is not None else set()
        for s, t, _, _ in self.edges:
            if s == nid and t not in acc:
                acc.add(t)
                self.downstream(t, acc)
        return acc

    def focus_nodes(self, table):
        hits = [n for n, v in self.nodes.items() if v["kind"] == "lakehouse" and v["label"].lower() == table.lower()]
        return hits

    def scope(self, focus_ids):
        keep = set(focus_ids)
        for f in focus_ids:
            keep |= self.upstream(f) | self.downstream(f)
        return keep


# --------------------------------------------------------------------------- column trace

INTRO_FNS = ("Table.AddColumn", "Table.ExpandTableColumn", "Table.ExpandRecordColumn", "Table.RenameColumns",
             "Table.Group", "Table.FromRecords", "Table.TransformRows")


class Tracer:
    def __init__(self, graph):
        self.g = graph
        self.memo = {}
        self.untraced = []

    def item(self, name):
        return self.g.dfs.get(name) or next((e for e in self.g.ext if e.name == name), None)

    def trace(self, item, qn, col, upto=None, depth=0):
        key = (item, qn, col, upto)
        if key in self.memo:
            return self.memo[key]
        node = {"col": col, "where": "%s / %s" % (item, qn), "how": None, "rule": None, "notes": [], "inputs": []}
        self.memo[key] = node
        if depth > 60:
            node["how"] = "untraced"
            return node
        d = self.item(item)
        q = d.queries[qn]
        steps = q["steps"]
        names = [s for s, _, _ in steps]
        if upto is None:
            res = [nm for nm in idents(q.get("result") or "") if nm in names]
            i = names.index(res[-1]) if res else len(steps) - 1
        else:
            i = upto
        while i is not None and i >= 0:
            step, expr, comments = steps[i]
            hc = head_call(expr) or ""
            if self.intro(d, qn, steps, i, col, hc, expr, comments, node, depth):
                return node
            self.modifies(hc, expr, col, step, node)
            fdefs = {s for s, e, _ in steps[:i] if FUNC_DEF.match(e)}
            used = [nm for nm in idents(expr) if nm in fdefs]
            if used and not FUNC_DEF.match(expr):
                note = "%s: generic function %s, column matched by name" % (step, used[0])
                if note not in node["notes"]:
                    node["notes"].append(note)
            if (NAV.search(expr) or ITEM.search(expr) or (SP_LIST.search(expr) and SP.search(d.queries[qn]["body"]))) and hc != "Table.Join":
                # this step reads a table (lakehouse, Dataverse, SQL): the rows come from there
                return self.from_base(d, qn, expr, col, node, depth)
            nxt = self.next_step(steps, i, col, hc, expr)
            if nxt is None:
                # no earlier step: the rows come from a table, a source or another query
                return self.from_base(d, qn, expr, col, node, depth)
            i = nxt
        return self.from_base(d, qn, steps[0][1] if steps else q["body"], col, node, depth)

    @staticmethod
    def explicit_cols(expr):
        """The column list a SelectColumns in expr names, or None."""
        a = calls(expr, "Table.SelectColumns")[:1]
        return str_list(a[0][1]) if a and len(a[0]) > 1 and str_list(a[0][1]) else None

    def next_step(self, steps, i, col, hc, expr):
        """The earlier step this step reads its rows from (the side of a join that has col)."""
        # a step that defines a local function is not where rows come from
        names = [s for s, e, _ in steps[:i] if not FUNC_DEF.match(e)]
        idx = {s: k for k, (s, _, _) in enumerate(steps[:i])}
        if hc == "Table.Join":
            a = calls(expr, hc)[:1]
            if a and len(a[0]) >= 4:
                left, right = a[0][0], a[0][2]

                def side_has(arg):
                    cols = self.explicit_cols(arg)
                    if cols is None:
                        ref = [nm for nm in idents(arg) if nm in names]
                        cols = self.explicit_cols(steps[idx[ref[0]]][1]) if ref else None
                    return None if cols is None else col in cols
                r_has, l_has = side_has(right), side_has(left)
                pick = right if (r_has or (r_has is None and l_has is False)) else left
                ref = [nm for nm in idents(pick) if nm in names]
                if ref:
                    return idx[ref[0]]
        ref = [nm for nm in idents(expr) if nm in names]
        return idx[ref[0]] if ref else None

    def from_base(self, d, qn, expr, col, node, depth):
        q = d.queries[qn]
        # direct navigation in this expression
        srcs = self.sources_in(d, qn, expr)
        for nm in idents(expr):
            if nm in d.queries and nm != qn and not d.is_destination(nm) and not d.queries[nm].get("lakehouse"):
                if nm in d.outputs and nm != qn:
                    src = self.g.lh_node(*d.outputs[nm])
                    return self.cross(src, col, node, depth)
                child = self.trace(d.name, nm, col, None, depth + 1)
                node["how"], node["inputs"] = "passthrough", [child]
                return node
        if srcs:
            return self.cross(srcs[0], col, node, depth)
        node["how"] = "untraced"
        self.untraced.append((d.name, qn, col))
        return node

    def sources_in(self, d, qn, expr):
        fake = Dataflow.__new__(Dataflow)
        fake.queries = {qn: dict(d.queries[qn], body=expr)}
        out = []
        q = d.queries[qn]
        step_lh = {s: LH_ID.findall(e)[-1] for s, e, _ in q["steps"] if s and LH_ID.findall(e)}
        for handle, table in NAV.findall(expr):
            h = handle[2:-1] if handle.startswith('#"') else handle
            lh = step_lh.get(h) or (d.queries.get(h) or {}).get("lakehouse")
            if lh:
                out.append(self.g.lh_node(lh, table))
        if ITEM.search(expr):
            # Source{[Schema, Item]}: the Source step says which kind
            for s, e, _ in q["steps"]:
                if DV.search(e):
                    out += [self.g.source_node(("dv", DV.search(e).group(1), it)) for _, it in ITEM.findall(expr)]
                elif SQLDB.search(e):
                    host, db = SQLDB.search(e).groups()
                    out += [self.g.source_node(("sql", host, db, it)) for _, it in ITEM.findall(expr)]
        for kind, site in SP.findall(expr):
            out.append(self.g.source_node(("sp", site, (SP_LIST.findall(expr) or ["(site)"])[0], qn)))
        if SP_LIST.search(expr) and not SP.search(expr):
            for s_, e_, _ in q["steps"]:
                m = SP.search(e_)
                if m:
                    out += [self.g.source_node(("sp", m.group(2), lst, qn)) for lst in SP_LIST.findall(expr)]
                    break
        return out

    def cross(self, src, col, node, depth):
        """Follow a column into the table it was read from: its producer, or a source leaf."""
        prod = self.g.producer.get(src)
        if prod:
            child = self.trace(prod[0], prod[1], col, None, depth + 1)
            node["how"], node["inputs"] = "passthrough", [child]
            node["via"] = src
            return node
        node["how"], node["source"] = "source", src
        return node

    def intro(self, d, qn, steps, i, col, hc, expr, comments, node, depth):
        names_before = [s for s, _, _ in steps[:i]]
        prev = lambda: i - 1 if i > 0 else None

        def base_trace(c):
            # trace c from the table this step reads (a previous step, another query, a source)
            for nm in idents(expr):
                if nm in names_before:
                    return self.trace(d.name, qn, c, names_before.index(nm), depth + 1)
            for nm in idents(expr):
                if nm in d.queries and nm != qn and not d.is_destination(nm) and not d.queries[nm].get("lakehouse"):
                    if nm in d.outputs:
                        sub = {"col": c, "where": "", "how": None, "rule": None, "notes": [], "inputs": []}
                        return self.cross(self.g.lh_node(*d.outputs[nm]), c, sub, depth + 1)
                    return self.trace(d.name, nm, c, None, depth + 1)
            sub = {"col": c, "where": "%s / %s" % (d.name, qn), "how": None, "rule": None, "notes": [], "inputs": []}
            srcs = self.sources_in(d, qn, expr)
            if srcs:
                return self.cross(srcs[0], c, sub, depth + 1)
            sub["how"] = "untraced"
            return sub

        def lookups(text, same_name=None):
            """Inputs read from other queries inside an expression (lookups like m{0}[Rate]); same_name
            also looks for a field of that name in the referenced queries (pick("Role", ...))."""
            out = []
            _, owned = field_refs(text)
            if same_name:
                owned.setdefault("?", []).append(same_name)
            qrefs = [nm for nm in idents(text) if nm in d.queries and nm != qn and not d.queries[nm].get("lakehouse")
                     and not d.is_destination(nm) and nm not in ("fnText", "fnKey")]
            qrefs = list(dict.fromkeys(qrefs))
            for owner, fields in owned.items():
                for f in dict.fromkeys(fields):
                    for qr in qrefs:
                        if self.introduces(d, qr, f):
                            out.append(self.trace(d.name, qr, f, None, depth + 1))
                            break
            return out, qrefs

        def computed(rule_expr, how="computed", row_fields=None):
            direct, _ = field_refs(rule_expr)
            fields = row_fields if row_fields is not None else direct
            node["how"], node["rule"] = how, short(rule_expr)
            node["where"] = "%s / %s / %s" % (d.name, qn, steps[i][0])
            node["comment"] = " ".join(comments)
            ins = [base_trace(f) for f in dict.fromkeys(fields) if f != col]
            lk, qrefs = lookups(rule_expr, same_name=col)
            node["inputs"] = ins + lk
            if qrefs:
                node["lookups"] = qrefs
            return True

        if hc == "Table.AddColumn":
            for args in calls(expr, "Table.AddColumn")[:1]:
                if len(args) >= 3 and strings(args[1])[:1] == [col]:
                    return computed(args[2])
        if hc in ("Table.ExpandTableColumn", "Table.ExpandRecordColumn"):
            for args in calls(expr, hc)[:1]:
                if len(args) >= 3:
                    src_cols, new_cols = str_list(args[2]), str_list(args[3]) if len(args) > 3 else str_list(args[2])
                    if col in new_cols and len(src_cols) == len(new_cols):
                        src_col, nested = src_cols[new_cols.index(col)], strings(args[1])[0] if strings(args[1]) else None
                        node["how"], node["where"] = "joined", "%s / %s / %s" % (d.name, qn, steps[i][0])
                        node["comment"] = " ".join(comments)
                        if src_col != col:
                            node["rule"] = "from %s" % src_col
                        child = self.nested_source(d, qn, steps, i, nested, src_col, depth)
                        node["inputs"] = [child] if child else []
                        return True
        if hc == "Table.RenameColumns":
            for args in calls(expr, "Table.RenameColumns")[:1]:
                for a, b in pairs(args[1] if len(args) > 1 else ""):
                    if b == col:
                        node["how"], node["rule"] = "renamed", "renamed from %s" % a
                        node["where"] = "%s / %s / %s" % (d.name, qn, steps[i][0])
                        node["inputs"] = [base_trace(a)]
                        return True
        if hc == "Table.Group":
            for args in calls(expr, "Table.Group")[:1]:
                if len(args) >= 3:
                    for agg in split_top(args[2].strip()[1:-1]) if args[2].strip().startswith("{") else []:
                        inner = agg.strip()[1:-1] if agg.strip().startswith("{") else agg
                        parts = split_top(inner)
                        if parts and strings(parts[0])[:1] == [col]:
                            return computed(parts[1] if len(parts) > 1 else inner, "aggregated")
        if "Table.TransformRows" in expr:
            rec = record_fields(expr)
            if col in rec:
                direct, owned = field_refs(rec[col])
                rowvar = re.search(r"\(\s*([A-Za-z_]\w*)\s*\)\s*=>", expr)
                rv = rowvar.group(1) if rowvar else "r"
                row_fields = owned.get(rv, []) + direct
                plain = re.fullmatch(r"\s*%s\s*\[\s*(?:#\"%s\"|%s)\s*\]\s*" % (re.escape(rv), re.escape(col), re.escape(col)), rec[col])
                if plain:
                    node["how"], node["where"] = "passthrough", "%s / %s / %s" % (d.name, qn, steps[i][0])
                    node["inputs"] = [base_trace(col)]
                    return True
                return computed(rec[col], row_fields=row_fields)
        return False

    def introduces(self, d, qn, col):
        q = d.queries.get(qn)
        if not q:
            return False
        for step, expr, _ in q["steps"]:
            hc = head_call(expr) or ""
            if hc == "Table.AddColumn" and any(strings(a[1])[:1] == [col] for a in calls(expr, hc)[:1] if len(a) > 1):
                return True
            if hc in ("Table.ExpandTableColumn", "Table.ExpandRecordColumn"):
                for a in calls(expr, hc)[:1]:
                    if col in (str_list(a[3]) if len(a) > 3 else str_list(a[2]) if len(a) > 2 else []):
                        return True
            if "Table.TransformRows" in expr and col in record_fields(expr):
                return True
            if hc == "Table.RenameColumns" and any(b == col for a in calls(expr, hc)[:1] for _, b in pairs(a[1] if len(a) > 1 else "")):
                return True
            if hc == "Table.Group" and col in strings(expr):
                return True
            if hc == "Table.SelectColumns" and col in strings(expr):
                return True
        return any(col in strings(e) for _, e, _ in q["steps"])

    def nested_source(self, d, qn, steps, i, nested, src_col, depth):
        """The table behind a nested column: a NestedJoin's right side, or a record column made earlier."""
        for j in range(i - 1, -1, -1):
            step, expr, _ = steps[j]
            for args in calls(expr, "Table.NestedJoin"):
                if len(args) >= 5 and strings(args[4])[:1] == [nested]:
                    right = idents(args[2])
                    for nm in right:
                        if nm in d.queries:
                            if nm in d.outputs and nm != qn:
                                sub = {"col": src_col, "where": "", "how": None, "rule": None, "notes": [], "inputs": []}
                                return self.cross(self.g.lh_node(*d.outputs[nm]), src_col, sub, depth + 1)
                            return self.trace(d.name, nm, src_col, None, depth + 1)
                        if nm in [s for s, _, _ in steps[:j]]:
                            return self.trace(d.name, qn, src_col, [s for s, _, _ in steps].index(nm), depth + 1)
            for args in calls(expr, "Table.AddColumn")[:1]:
                if len(args) >= 3 and strings(args[1])[:1] == [nested]:
                    # a record column: this field's own expressions plus the let bindings they use
                    fexprs, lets = record_field_exprs(args[2], src_col)
                    rule = (lets + " " + " ".join(fexprs)) if fexprs else args[2]
                    sub = {"col": src_col, "where": "%s / %s / %s" % (d.name, qn, step), "how": "computed",
                           "rule": short(" | ".join(dict.fromkeys(fexprs)) if fexprs else rule), "notes": [], "inputs": []}
                    direct, owned = [], {}
                    for piece in ([lets] + fexprs) if fexprs else [rule]:
                        dr, ow = field_refs(piece)
                        direct += dr
                        for k2, v2 in ow.items():
                            owned.setdefault(k2, []).extend(v2)
                    sub["inputs"] = [self.trace(d.name, qn, f, j - 1 if j else None, depth + 1) for f in dict.fromkeys(direct) if f != src_col]
                    owned.setdefault("?", []).append(src_col)          # a field of the same name in a looked-up query
                    qrefs = [nm for nm in idents(rule) if nm in d.queries and nm != qn and not d.queries[nm].get("lakehouse") and nm not in ("fnText", "fnKey")]
                    for owner, fields in owned.items():
                        for f in dict.fromkeys(fields):
                            for qr in dict.fromkeys(qrefs):
                                if self.introduces(d, qr, f):
                                    sub["inputs"].append(self.trace(d.name, qr, f, None, depth + 1))
                                    break
                    if qrefs:
                        sub["lookups"] = list(dict.fromkeys(qrefs))
                    return sub
            for args in calls(expr, "Table.Group")[:1]:
                # a grouped row column ({"Row", each Table.First(_)}): its fields are the group's input rows
                if len(args) >= 3 and nested in strings(args[2]):
                    nxt = self.next_step(steps, j, src_col, "Table.Group", expr)
                    if nxt is not None:
                        return self.trace(d.name, qn, src_col, nxt, depth + 1)
                    sub = {"col": src_col, "where": "%s / %s / %s" % (d.name, qn, step), "how": None, "rule": None, "notes": [], "inputs": []}
                    return self.from_base(d, qn, expr, src_col, sub, depth + 1)
        return None

    def modifies(self, hc, expr, col, step, node):
        if hc == "Table.ReplaceValue":
            args = calls(expr, hc)[:1]
            if args and len(args[0]) >= 5 and col in str_list(args[0][4]):
                node["notes"].append("%s: replaces %s with %s" % (step, args[0][1], args[0][2]))
        elif hc == "Table.TransformColumns" and col in strings(expr):
            node["notes"].append("%s: transformed (%s)" % (step, short(expr, 90)))


def leaves(node, acc=None, seen=None):
    acc = acc if acc is not None else []
    seen = seen if seen is not None else set()
    if id(node) in seen:
        return acc
    seen.add(id(node))
    if node.get("how") == "source":
        acc.append((node["source"], node["col"]))
    for c in node.get("inputs", []):
        leaves(c, acc, seen)
    return acc


def first_rule(node, seen=None):
    """The nearest computing step on the way back: (how, rule, where, comment, notes)."""
    seen = seen if seen is not None else set()
    notes = []
    n = node
    while n and id(n) not in seen:
        seen.add(id(n))
        notes += n.get("notes", [])
        if n.get("how") in ("computed", "aggregated", "renamed", "joined") and n.get("rule"):
            if n["how"] in ("renamed", "joined") and n.get("inputs"):
                inner = first_rule(n["inputs"][0], seen)
                return (n["how"], n["rule"] + ("; " + inner[1] if inner[1] else ""), n["where"], n.get("comment"), notes + inner[4])
            return (n["how"], n["rule"], n["where"], n.get("comment"), notes)
        if n.get("how") == "joined":
            inner = first_rule(n["inputs"][0], seen) if n.get("inputs") else (None, None, None, None, [])
            return ("joined", inner[1] or "joined", n["where"], n.get("comment"), notes + inner[4])
        n = n["inputs"][0] if len(n.get("inputs", [])) == 1 and n.get("how") == "passthrough" else None
    return ("passthrough", None, None, None, notes)


def hops(node):
    out, n, seen = [], node, set()
    while n and id(n) not in seen:
        seen.add(id(n))
        w = n.get("where")
        if w:
            item = w.split(" / ")[0]
            if not out or out[-1] != item:
                out.append(item)
        n = n["inputs"][0] if n.get("inputs") else None
    return out


def output_columns(d, qn):
    steps = d.queries[qn]["steps"]
    for step, expr, _ in reversed(steps):
        hc = head_call(expr) or ""
        if hc in ("Table.SelectColumns", "Table.ReorderColumns"):
            a = calls(expr, hc)[:1]
            if a and len(a[0]) > 1 and str_list(a[0][1]):
                return str_list(a[0][1])
        if hc == "Table.TransformColumnTypes":
            a = calls(expr, hc)[:1]
            if a and len(a[0]) > 1:
                cols = [p[0] for p in pairs(a[0][1])]
                if cols:
                    return cols
    return []


def build_steps(d, qn):
    """Plain-language steps of a query: filters, joins, computed columns, renames, groups."""
    out = []
    for step, expr, comments in d.queries[qn]["steps"]:
        hc = head_call(expr) or ""
        line = None
        if hc == "Table.SelectRows" or (expr.startswith("Table.SelectRows")):
            a = calls(expr, "Table.SelectRows")[:1]
            line = "Filter: %s" % short(a[0][1] if a and len(a[0]) > 1 else expr, 140)
        elif hc in ("Table.NestedJoin", "Table.Join"):
            a = calls(expr, hc)[:1]
            if a and len(a[0]) >= 4:
                kind = re.search(r"JoinKind\.(\w+)", expr)
                right = a[0][2]
                line = "Join %s on %s = %s (%s)" % (short(right, 60), ", ".join(strings(a[0][1])) or a[0][1],
                                                     ", ".join(strings(a[0][3])) or a[0][3], kind.group(1) if kind else "")
        elif hc == "Table.AddColumn":
            a = calls(expr, hc)[:1]
            if a and len(a[0]) >= 3:
                line = "Add column %s = %s" % (", ".join(strings(a[0][1])[:1]), short(a[0][2], 120))
        elif hc == "Table.Group":
            a = calls(expr, hc)[:1]
            if a and len(a[0]) >= 2:
                line = "Group by %s" % (", ".join(strings(a[0][1])) or a[0][1])
        elif hc == "Table.RenameColumns":
            a = calls(expr, hc)[:1]
            ps = pairs(a[0][1]) if a and len(a[0]) > 1 else []
            line = "Rename %d column(s)" % len(ps)
        elif hc in ("Table.ExpandTableColumn", "Table.ExpandRecordColumn"):
            a = calls(expr, hc)[:1]
            line = "Expand %s: %s" % ((strings(a[0][1]) or ["?"])[0], ", ".join(str_list(a[0][3] if len(a[0]) > 3 else a[0][2])[:8])) if a and len(a[0]) >= 3 else None
        elif "Table.TransformRows" in expr:
            line = "Shape each row: %s" % ", ".join(list(record_fields(expr))[:14])
        elif hc == "Table.SelectColumns":
            a = calls(expr, hc)[:1]
            line = "Keep %d column(s)" % len(str_list(a[0][1])) if a and len(a[0]) > 1 else None
        elif hc == "Table.ReplaceValue":
            a = calls(expr, hc)[:1]
            line = "Replace %s with %s in %s" % (a[0][1], a[0][2], ", ".join(str_list(a[0][4]))) if a and len(a[0]) >= 5 else None
        elif hc == "Table.Distinct":
            line = "Remove duplicates"
        elif NAV.search(expr) or ITEM.search(expr) or SQLDB.search(expr) or DV.search(expr):
            line = None
        if line or comments:
            out.append({"step": step, "what": line, "comment": " ".join(comments)})
    return out


# --------------------------------------------------------------------------- live (read-only)


def load_ppapi():
    spec = importlib.util.spec_from_file_location("_ppapi", os.path.join(HERE, "_ppapi.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def live_read(ws, token_cmd, dataflows, pipelines, transport=None):
    pp = load_ppapi()
    token = "fixture" if transport else pp.get_token(pp.RESOURCES["fabric"], token_cmd, "FABRIC_TOKEN")[0]
    c = pp.Client("https://api.fabric.microsoft.com/v1/", token, read_only=True, transport=transport, sleep=lambda s: None)
    if not re.match(r"^[0-9a-fA-F-]{36}$", ws):
        ws = next(w["id"] for w in c.get_all("workspaces") if w.get("displayName") == ws)
    items = c.get_all("workspaces/%s/items" % ws)
    out = {"workspace": ws, "lakehouses": {}, "drift": {}, "runs": {}, "schedules": {}, "others": [], "ids": {}}
    for it in items:
        out["ids"][(it["type"], it["displayName"])] = it["id"]
        if it["type"] == "Lakehouse":
            out["lakehouses"][it["id"].lower()] = it["displayName"]

    def definition(item_id):
        st, hdrs, body = c.call("POST", "workspaces/%s/items/%s/getDefinition" % (ws, item_id), read=True)
        if st == 202:
            body = c.wait_operation(hdrs)
        for p in ((body or {}).get("definition") or {}).get("parts", []):
            if p.get("path") == "mashup.pq":
                return base64.b64decode(p["payload"]).decode("utf-8-sig")
        return None

    norm = lambda s: "\n".join(l.rstrip() for l in (s or "").replace("\r\n", "\n").strip().split("\n"))
    for d in dataflows:
        iid = out["ids"].get(("Dataflow", d.name))
        if not iid:
            out["drift"][d.name] = "not deployed"
            continue
        live = definition(iid)
        if live is None:
            out["drift"][d.name] = "definition not readable"
        elif norm(live) == norm(d.text):
            out["drift"][d.name] = "same"
        else:
            a, b = norm(d.text).split("\n"), norm(live).split("\n")
            k = next((i for i in range(min(len(a), len(b))) if a[i] != b[i]), min(len(a), len(b)))
            out["drift"][d.name] = "differs from line %d" % (k + 1)
        out["runs"][d.name] = runs(c, ws, iid)
    for p in pipelines:
        iid = out["ids"].get(("DataPipeline", p["name"]))
        if iid:
            out["runs"][p["name"]] = runs(c, ws, iid)
            sch = c.get("workspaces/%s/items/%s/jobs/Pipeline/schedules" % (ws, iid), ok404=True) or {}
            out["schedules"][p["name"]] = [{"enabled": s.get("enabled"), "configuration": s.get("configuration")} for s in sch.get("value", [])]
    known = {d.name for d in dataflows}
    for it in items:
        if it["type"] == "Dataflow" and it["displayName"] not in known:
            try:
                text = definition(it["id"])
            except pp.ApiError:
                text = None
            if text:
                out["others"].append(Dataflow(it["displayName"], text))
    return out


def runs(c, ws, iid):
    try:
        rows = c.get_all("workspaces/%s/items/%s/jobs/instances" % (ws, iid))
    except Exception:  # noqa: BLE001 - a run list we cannot read is reported as such, not fatal
        return None
    rows.sort(key=lambda r: r.get("startTimeUtc") or "", reverse=True)
    return [{"status": r.get("status"), "start": r.get("startTimeUtc"), "end": r.get("endTimeUtc")} for r in rows[:5]]


# --------------------------------------------------------------------------- rendering

LAYER_ORDER = ["dataverse", "sharepoint", "sql", "lakehouse", "consumer"]


def columns_for(graph, keep):
    """Ordered diagram columns: [(title, kind, [node ids])] by depth from the sources."""
    rank = {}

    def r(n, stack=()):
        if n in rank:
            return rank[n]
        if n in stack:
            return 0
        ins = [s for s, t, _, _ in graph.edges if t == n and s in keep]
        rank[n] = 0 if not ins else 1 + max(r(s, stack + (n,)) for s in ins)
        return rank[n]
    for n in keep:
        r(n)
    groups = {}
    for n in keep:
        v = graph.nodes[n]
        key = v["group"] if v["kind"] in ("lakehouse", "consumer") else v["kind"]
        groups.setdefault(key, []).append(n)
    title = {"dataverse": "Dataverse", "sharepoint": "SharePoint", "sql": "SQL"}
    cols = []
    for key, ns in groups.items():
        kind = graph.nodes[ns[0]]["kind"]
        cols.append((min(rank[n] for n in ns), title.get(key, key), kind, sorted(ns, key=lambda n: (rank[n], graph.nodes[n]["label"].lower()))))
    cols.sort(key=lambda c: (c[0], LAYER_ORDER.index(c[2]) if c[2] in LAYER_ORDER else 9, c[1]))
    return [(t, k, ns) for _, t, k, ns in cols]


def zone(title, kind):
    t = title.upper()
    if kind in ("dataverse", "sharepoint", "sql"):
        return "src"
    if kind == "consumer":
        return "use"
    for z in ("BRONZE", "SILVER", "GOLD"):
        if z in t:
            return z.lower()
    return "lh"


def svg(graph, keep, focus):
    cols = columns_for(graph, keep)
    W, H, GAP, PAD, HEAD = 220, 26, 8, 18, 44
    colw = W + 70
    pos = {}
    height = 0
    for ci, (title, kind, ns) in enumerate(cols):
        for k, n in enumerate(ns):
            pos[n] = (PAD + ci * colw, HEAD + k * (H + GAP))
        height = max(height, HEAD + len(ns) * (H + GAP))
    width = PAD * 2 + len(cols) * colw - 70
    parts = ['<svg class="lineage" width="%d" height="%d" viewBox="0 0 %d %d" role="img" aria-label="Lineage diagram" xmlns="http://www.w3.org/2000/svg">'
             % (width, height + PAD, width, height + PAD)]
    for ci, (title, kind, ns) in enumerate(cols):
        x = PAD + ci * colw
        parts.append('<text class="col-title" x="%d" y="18">%s</text>' % (x, html.escape(title)))
        parts.append('<text class="col-sub" x="%d" y="33">%d table%s</text>' % (x, len(ns), "" if len(ns) == 1 else "s"))
    for s, t, item, qn in sorted(set(graph.edges)):
        if s in pos and t in pos:
            (x1, y1), (x2, y2) = pos[s], pos[t]
            x1, y1, y2 = x1 + W, y1 + H / 2, y2 + H / 2
            if x2 > x1:
                c = (x2 - x1) / 2
                d = "M%.0f %.0f C%.0f %.0f %.0f %.0f %.0f %.0f" % (x1, y1, x1 + c, y1, x2 - c, y2, x2, y2)
            else:
                d = "M%.0f %.0f C%.0f %.0f %.0f %.0f %.0f %.0f" % (x1, y1, x1 + 40, y1, x1 + 40, y2, x1, y2)
            parts.append('<path class="edge" d="%s"><title>%s</title></path>' % (d, html.escape("%s / %s" % (item, qn))))
    for ci, (title, kind, ns) in enumerate(cols):
        z = zone(title, kind)
        for n in ns:
            x, y = pos[n]
            v = graph.nodes[n]
            cls = "node z-%s%s" % (z, " focus" if n in focus else "")
            label = re.sub(r" \(list [0-9a-f]{8}\)$", "", v["label"])
            label = label if len(label) <= 32 else label[:30] + "..."
            parts.append('<g class="%s"><rect x="%d" y="%d" width="%d" height="%d" rx="5"/><text x="%d" y="%d">%s</text><title>%s</title></g>'
                         % (cls, x, y, W, H, x + 10, y + 17, html.escape(label), html.escape(n)))
    parts.append("</svg>")
    return "\n".join(parts)


def mermaid(graph, keep, focus):
    cols = columns_for(graph, keep)
    ids = {n: "n%d" % i for i, n in enumerate(sorted(keep))}
    lines = ["flowchart LR"]
    for ci, (title, kind, ns) in enumerate(cols):
        lines.append('  subgraph c%d["%s"]' % (ci, title.replace('"', "'")))
        for n in ns:
            lines.append('    %s["%s"]' % (ids[n], graph.nodes[n]["label"].replace('"', "'")))
        lines.append("  end")
    for s, t in sorted({(s, t) for s, t, _, _ in graph.edges if s in keep and t in keep}):
        lines.append("  %s --> %s" % (ids[s], ids[t]))
    for f in focus:
        lines.append("  style %s stroke-width:3px" % ids[f])
    return "\n".join(lines)


def schedule_text(sch):
    if not sch:
        return "no schedule found"
    out = []
    for s in sch:
        cfg = s.get("configuration") or {}
        times = ", ".join(cfg.get("times") or []) or cfg.get("interval") and "every %s min" % cfg["interval"] or ""
        out.append("%s %s %s (%s)" % ("on" if s.get("enabled") else "OFF", cfg.get("type", ""), times, cfg.get("localTimeZoneId", "")))
    return "; ".join(out)


def build_doc(args, graph, tracer, live, notes_md, sensitive):
    focus_ids = []
    for f in args.focus:
        hits = graph.focus_nodes(f)
        if not hits:
            raise SystemExit("focus table %r is not an output of any dataflow read (outputs: %s)"
                             % (f, ", ".join(sorted({v["label"] for v in graph.nodes.values() if v["kind"] == "lakehouse"}))[:600]))
        focus_ids += hits
    keep = graph.scope(focus_ids)
    in_scope_items = sorted({item for s, t, item, _ in graph.edges if s in keep and t in keep})
    pipes = [p for p in graph.pipelines if any(a["ref"] in in_scope_items for a in p["activities"])]
    gaps = []
    for n in sorted(keep):
        v = graph.nodes[n]
        if v["kind"] == "lakehouse" and n not in graph.producer and any(s == n for s, _, _, _ in graph.edges):
            gaps.append("Input table %s has no producer in the definitions read%s." % (n[3:], "" if live else " (add --workspace to look in the live workspace)"))
    doc = {"title": args.title or "Data lineage: " + ", ".join(args.focus), "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
           "focus": focus_ids, "items": in_scope_items, "pipelines": pipes, "gaps": gaps, "tables": [], "columns": {}, "steps": {}}
    for n in sorted(keep, key=lambda n: (graph.nodes[n]["kind"], graph.nodes[n]["group"], graph.nodes[n]["label"].lower())):
        v = graph.nodes[n]
        prod = graph.producer.get(n)
        reads = sorted({s for s, t, _, _ in graph.edges if t == n})
        used = sorted({t for s, t, _, _ in graph.edges if s == n and t in keep})
        q = graph.dfs[prod[0]].queries[prod[1]] if prod and prod[0] in graph.dfs else None
        doc["tables"].append({"id": n, "label": v["label"], "group": v["group"], "kind": v["kind"], "producer": prod,
                              "reads": reads, "used_by": used, "about": " ".join(q["comments"]) if q else ""})
        if prod and prod[0] in graph.dfs:
            doc["steps"][n] = build_steps(graph.dfs[prod[0]], prod[1])
    for c in graph.ext:
        doc["steps"]["ext:" + c.name] = build_steps(c, next(iter(c.queries)))
    for f in focus_ids:
        item, qn = graph.producer[f]
        rows = []
        for col in output_columns(graph.dfs[item], qn):
            node = tracer.trace(item, qn, col)
            how, rule, where, comment, notes = first_rule(node)
            pairs = sorted({(graph.nodes[s]["label"], c) for s, c in leaves(node) if s in graph.nodes})
            srcs = ["%s.%s" % pc for pc in pairs]
            by_table = {}
            for t, c in pairs:
                by_table.setdefault(t, []).append(c)
            rows.append({"column": col, "how": how, "rule": rule, "where": where, "comment": comment, "notes": notes,
                         "sources": srcs, "by_table": by_table, "path": hops(node), "sensitive": bool(re.search(sensitive, col))})
        doc["columns"][f] = rows
    untraced = sorted({"%s.%s" % (q, c) for _, q, c in tracer.untraced})
    if untraced:
        doc["gaps"].append("Columns the trace could not follow to a source: %s." % ", ".join(untraced[:30]))
    doc["live"] = None
    if live:
        doc["live"] = {"drift": {k: v for k, v in live["drift"].items() if k in in_scope_items},
                       "runs": {k: v for k, v in live["runs"].items() if k in in_scope_items or k in [p["name"] for p in pipes]},
                       "schedules": {k: v for k, v in live["schedules"].items() if k in [p["name"] for p in pipes]}}
        for k, v in doc["live"]["drift"].items():
            if v != "same":
                doc["gaps"].append("%s: the deployed definition %s the repo." % (k, v if v.startswith("not") else v.replace("differs", "differs from")))
    doc["notes"] = notes_md
    doc["mermaid"] = mermaid(graph, keep, focus_ids)
    doc["svg"] = svg(graph, keep, focus_ids)
    doc["counts"] = {k: sum(1 for n in keep if graph.nodes[n]["kind"] == k) for k in ("dataverse", "sharepoint", "sql", "lakehouse", "consumer")}
    doc["consumers"] = sorted(graph.nodes[n]["label"] for n in keep if graph.nodes[n]["kind"] == "consumer")
    return doc


def label(n, graph):
    v = graph.nodes.get(n)
    return "%s (%s)" % (v["label"], v["group"]) if v else n


def summary_text(doc, graph):
    c = doc["counts"]
    srcs = []
    if c["dataverse"]:
        srcs.append("%d Dataverse table%s" % (c["dataverse"], "s" * (c["dataverse"] != 1)))
    if c["sharepoint"]:
        srcs.append("%d SharePoint list%s" % (c["sharepoint"], "s" * (c["sharepoint"] != 1)))
    if c["sql"]:
        srcs.append("%d SQL table%s" % (c["sql"], "s" * (c["sql"] != 1)))
    focus = ", ".join(graph.nodes[f]["label"] for f in doc["focus"])
    named = " (%s)" % ", ".join(doc["items"]) if len(doc["items"]) <= 4 else ""
    s = "%s is built by %d item%s%s through %d lakehouse table%s" % (
        focus, len(doc["items"]), "s" * (len(doc["items"]) != 1), named, c["lakehouse"], "s" * (c["lakehouse"] != 1))
    if srcs:
        s += ", starting from " + " and ".join(srcs)
    s += "."
    if doc["pipelines"]:
        s += " Refreshed by the pipeline%s %s (see Refresh)." % ("s" * (len(doc["pipelines"]) != 1), ", ".join(p["name"] for p in doc["pipelines"]))
    if doc["consumers"]:
        s += " Read downstream by %s." % ", ".join(doc["consumers"])
    return s


def grouped(r, sep="; "):
    """Source columns grouped by table: 'table: a, b; other: c'."""
    return sep.join("%s: %s" % (t, ", ".join(cs)) for t, cs in (r.get("by_table") or {}).items())


def to_markdown(doc, graph):
    L = ["# %s" % doc["title"], "", "Generated %s by `lineage.py` from the definitions in the repo%s. Sections marked "
         "*curated* are written by people; everything else is derived and is regenerated, never edited by hand." %
         (doc["generated"], " and the live workspace" if doc["live"] else ""), "", "## Summary", "", summary_text(doc, graph), ""]
    if doc["notes"]:
        L += ["## About this data (curated)", "", doc["notes"].strip(), ""]
    L += ["## Lineage", "", "```mermaid", doc["mermaid"], "```", ""]
    if doc["pipelines"] or doc["live"]:
        L += ["## Refresh", ""]
        for p in doc["pipelines"]:
            L.append("**%s**" % p["name"])
            if doc["live"]:
                L.append("- Schedule: %s" % schedule_text(doc["live"]["schedules"].get(p["name"])))
            for a in p["activities"]:
                L.append("- %s (%s: %s)%s" % (a["name"], a["type"], a["ref"], ", after " + ", ".join(a["dependsOn"]) if a["dependsOn"] else ""))
            L.append("")
        if doc["live"]:
            L += ["| Item | Deployed definition | Last runs (newest first) |", "|---|---|---|"]
            for k in doc["items"] + [p["name"] for p in doc["pipelines"]]:
                rs = doc["live"]["runs"].get(k)
                runs_s = ", ".join("%s %s" % (r["status"], (r["start"] or "")[:16].replace("T", " ")) for r in rs[:3]) if rs else "none read"
                L.append("| %s | %s | %s |" % (k, doc["live"]["drift"].get(k, "pipeline"), runs_s))
            L.append("")
    L += ["## Tables", "", "| Table | Where | Made by | Reads | Read by |", "|---|---|---|---|---|"]
    for t in doc["tables"]:
        L.append("| %s | %s | %s | %s | %s |" % (t["label"], t["group"], " / ".join(t["producer"]) if t["producer"] else ("source" if t["kind"] != "lakehouse" else "**not found**"),
                                                  ", ".join(graph.nodes[r]["label"] for r in t["reads"]) or "-",
                                                  ", ".join(graph.nodes[u]["label"] for u in t["used_by"]) or "-"))
    L.append("")
    L += ["## How each output is built", ""]
    for t in doc["tables"]:
        st = doc["steps"].get(t["id"])
        if not st or not t["producer"]:
            continue
        L += ["### %s" % t["label"], "", "%s, query `%s`.%s" % (t["producer"][0], t["producer"][1], (" " + t["about"]) if t["about"] else ""), ""]
        for s in st:
            L.append("- `%s`%s%s" % (s["step"], ": " + s["what"] if s["what"] else "", (" *" + s["comment"] + "*") if s["comment"] else ""))
        L.append("")
    for c in graph.ext:
        st = doc["steps"].get("ext:" + c.name)
        if st:
            L += ["### %s (outside the medallion)" % c.name, ""] + ["- `%s`%s%s" % (s["step"], ": " + s["what"] if s["what"] else "", (" *" + s["comment"] + "*") if s["comment"] else "") for s in st] + [""]
    for f, rows in doc["columns"].items():
        L += ["## Column lineage: %s" % graph.nodes[f]["label"], "",
              "Each column of the output, how it is made, and the source columns it comes from. "
              "A flag marks a column matching the sensitive-data pattern.", "",
              "| Column | How | Rule | Comes from | Path |", "|---|---|---|---|---|"]
        for r in rows:
            rule = (r["rule"] or "").replace("|", "\\|")
            if r["notes"]:
                rule += (" " if rule else "") + "Then: " + "; ".join(r["notes"]).replace("|", "\\|")
            L.append("| %s%s | %s | %s | %s | %s |" % (r["column"], " (sensitive)" if r["sensitive"] else "", r["how"], rule or "-",
                                                         grouped(r) or "-", " < ".join(r["path"])))
        L.append("")
        sens = [r for r in rows if r["sensitive"]]
        if sens:
            L += ["**Sensitive columns:** " + "; ".join("%s (from %s)" % (r["column"], grouped(r) or "derived") for r in sens), ""]
    L += ["## Gaps and checks", ""] + (["- " + g for g in doc["gaps"]] or ["- None: every input table has a producer and every column was traced."]) + [""]
    return "\n".join(L)


CSS = """
:root{--bg:#F5F7FA;--panel:#FFFFFF;--text:#1F2933;--muted:#52606D;--line:#CBD2D9;--primary:#0B5394;--accent:#0F766E;
--warn:#B45309;--err:#B91C1C;--src:#E6F2F1;--src-b:#0F766E;--bronze:#F6EBDD;--bronze-b:#9A5B1E;--silver:#EDF0F3;--silver-b:#52606D;
--gold:#FBF3D9;--gold-b:#A16207;--use:#E3EDF8;--use-b:#0B5394;--edge:#9AA5B1}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#11161C;--panel:#1A2129;--text:#E4E7EB;--muted:#9AA5B1;--line:#323F4B;
--primary:#5B9BD5;--accent:#3FB8AA;--src:#12302D;--src-b:#3FB8AA;--bronze:#3A2A18;--bronze-b:#D49A5E;--silver:#262F38;--silver-b:#9AA5B1;
--gold:#3A3115;--gold-b:#E0B341;--use:#15293F;--use-b:#5B9BD5;--edge:#52606D}}
:root[data-theme="dark"]{--bg:#11161C;--panel:#1A2129;--text:#E4E7EB;--muted:#9AA5B1;--line:#323F4B;--primary:#5B9BD5;--accent:#3FB8AA;
--src:#12302D;--src-b:#3FB8AA;--bronze:#3A2A18;--bronze-b:#D49A5E;--silver:#262F38;--silver-b:#9AA5B1;--gold:#3A3115;--gold-b:#E0B341;--use:#15293F;--use-b:#5B9BD5;--edge:#52606D}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 "Segoe UI",system-ui,-apple-system,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 4px;color:var(--text)}
h2{font-size:20px;margin:40px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}h3{font-size:16px;margin:24px 0 6px}
.meta{color:var(--muted);font-size:13px}.summary{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--primary);
border-radius:8px;padding:14px 18px;margin:20px 0}.curated{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:4px 18px 10px}
.tag{display:inline-block;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:10px;padding:0 8px;margin-left:8px;vertical-align:middle}
nav.toc{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;margin:10px 0 0}nav.toc a{color:var(--primary);text-decoration:none}
.figure{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto}
svg.lineage{display:block;max-width:none}svg .col-title{font:600 13px "Segoe UI",sans-serif;fill:var(--text)}
svg .col-sub{font:12px "Segoe UI",sans-serif;fill:var(--muted)}svg .edge{fill:none;stroke:var(--edge);stroke-width:1.2;opacity:.75}
svg .node rect{stroke-width:1.2}svg .node text{font:12px "Segoe UI",sans-serif;fill:var(--text)}
svg .z-src rect{fill:var(--src);stroke:var(--src-b)}svg .z-bronze rect{fill:var(--bronze);stroke:var(--bronze-b)}
svg .z-silver rect,svg .z-lh rect{fill:var(--silver);stroke:var(--silver-b)}svg .z-gold rect{fill:var(--gold);stroke:var(--gold-b)}
svg .z-use rect{fill:var(--use);stroke:var(--use-b)}svg .focus rect{stroke-width:3}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);margin-top:8px}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-1px;border:1px solid}
.tw{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;vertical-align:top;padding:7px 10px;border-bottom:1px solid var(--line)}
th{background:var(--bg);font-weight:600;position:sticky;top:0}tr:last-child td{border-bottom:0}code{font:12px Consolas,"Cascadia Mono",monospace;background:var(--bg);padding:1px 4px;border-radius:4px}
.how{font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:1px 7px;border-radius:9px;border:1px solid var(--line);white-space:nowrap}
.how.computed,.how.aggregated{color:var(--accent);border-color:var(--accent)}.how.joined{color:var(--primary);border-color:var(--primary)}
.how.untraced{color:var(--err);border-color:var(--err)}.sens{color:var(--warn);font-weight:600;font-size:11px;margin-left:6px}
p,li,.summary{overflow-wrap:anywhere}td{overflow-wrap:break-word}code.rule{display:block;white-space:pre-wrap;word-break:break-word;background:none;padding:0;color:var(--text)}
.src{margin:0 0 4px}.src .st{display:block;font-weight:600;font-size:12px;color:var(--muted)}table.cols{table-layout:fixed;min-width:860px}ol.path{margin:0;padding-left:16px;font-size:12px;color:var(--muted)}ol.path li{margin:0}
ul.steps{margin:6px 0 0;padding-left:20px}ul.steps li{margin:3px 0}.c{color:var(--muted);font-style:italic}
.gaps li{margin:4px 0}.ok{color:#15803D}.bad{color:var(--err)}
@media print{svg.lineage{width:100%;height:auto}body{background:#fff}main{max-width:none;padding:0}.figure,.tw,.summary,.curated{border-color:#ccc}h2{break-after:avoid}tr{break-inside:avoid}}
"""


def md_inline(text):
    t = html.escape(text)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)
    return t


def notes_html(md):
    """A small Markdown subset for curated notes: headings, paragraphs, lists, pipe tables."""
    out, para, items, rows = [], [], [], []

    def flush():
        if para:
            out.append("<p>%s</p>" % md_inline(" ".join(para)))
            para.clear()
        if items:
            out.append("<ul>%s</ul>" % "".join("<li>%s</li>" % md_inline(t) for t in items))
            items.clear()
        if rows:
            cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
            body = [r for r in cells[1:] if not all(re.match(r"^:?-+:?$", c) for c in r)]
            out.append('<div class="tw"><table><thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>' % (
                "".join("<th>%s</th>" % md_inline(c) for c in cells[0]),
                "".join("<tr>%s</tr>" % "".join("<td>%s</td>" % md_inline(c) for c in r) for r in body)))
            rows.clear()
    for line in md.strip().split("\n"):
        if re.match(r"\s*#{2,4} ", line):
            flush()
            out.append("<h3>%s</h3>" % md_inline(line.strip().lstrip("#").strip()))
        elif line.strip().startswith("|"):
            if para or items:
                flush()
            rows.append(line)
        elif re.match(r"\s*[-*] ", line):
            if para or rows:
                flush()
            items.append(re.sub(r"^\s*[-*] ", "", line))
        elif not line.strip():
            flush()
        elif items and line.startswith(" "):
            items[-1] += " " + line.strip()
        else:
            if items or rows:
                flush()
            para.append(line.strip())
    flush()
    return "\n".join(out)


def to_html(doc, graph):
    e = html.escape
    sec = []
    toc = [("summary", "Summary")] + ([("about", "About this data")] if doc["notes"] else []) + [("lineage", "Lineage")]
    if doc["pipelines"]:
        toc.append(("refresh", "Refresh"))
    toc += [("tables", "Tables"), ("build", "How outputs are built")] + [("col-%d" % i, "Columns: " + graph.nodes[f]["label"]) for i, f in enumerate(doc["columns"])] + [("gaps", "Gaps and checks")]
    sec.append('<header><h1>%s</h1><div class="meta">Generated %s from the definitions in the repo%s. Derived sections are regenerated, never edited by hand; '
               'curated sections are marked.</div><nav class="toc">%s</nav></header>' % (e(doc["title"]), e(doc["generated"]),
               " and the live workspace" if doc["live"] else "", "".join('<a href="#%s">%s</a>' % (a, e(b)) for a, b in toc)))
    sec.append('<section id="summary" class="summary">%s</section>' % e(summary_text(doc, graph)))
    if doc["notes"]:
        sec.append('<section id="about"><h2>About this data<span class="tag">curated</span></h2><div class="curated">%s</div></section>' % notes_html(doc["notes"]))
    legend = "".join('<span><i style="background:var(--%s);border-color:var(--%s-b)"></i>%s</span>' % (k, k, t)
                     for k, t in (("src", "Source system"), ("bronze", "Bronze"), ("silver", "Silver"), ("gold", "Gold"), ("use", "Consumer")))
    sec.append('<section id="lineage"><h2>Lineage</h2><div class="figure">%s<div class="legend">%s<span>Thick border: the documented output. Hover a box or line for its full name.</span></div></div></section>' % (doc["svg"], legend))
    if doc["pipelines"]:
        rows = []
        for p in doc["pipelines"]:
            sched = schedule_text(doc["live"]["schedules"].get(p["name"])) if doc["live"] else "not read (run with --workspace)"
            acts = "".join("<li><strong>%s</strong> refreshes <code>%s</code>%s</li>" % (e(a["name"]), e(a["ref"]), " after " + e(", ".join(a["dependsOn"])) if a["dependsOn"] else "") for a in p["activities"])
            rows.append("<h3>%s</h3><p class='meta'>Schedule: %s</p><ul class='steps'>%s</ul>" % (e(p["name"]), e(sched), acts))
        if doc["live"]:
            tr = []
            for k in doc["items"] + [p["name"] for p in doc["pipelines"]]:
                rs = doc["live"]["runs"].get(k)
                d = doc["live"]["drift"].get(k, "pipeline")
                runs_s = ", ".join("%s %s" % (r["status"], (r["start"] or "")[:16].replace("T", " ")) for r in rs[:3]) if rs else "none read"
                tr.append("<tr><td>%s</td><td class='%s'>%s</td><td>%s</td></tr>" % (e(k), "ok" if d in ("same", "pipeline") else "bad", e(d), e(runs_s)))
            rows.append("<div class='tw'><table><tr><th>Item</th><th>Deployed definition vs repo</th><th>Last runs, newest first (UTC)</th></tr>%s</table></div>" % "".join(tr))
        sec.append('<section id="refresh"><h2>Refresh</h2>%s</section>' % "".join(rows))
    tr = []
    for t in doc["tables"]:
        made = e(" / ".join(t["producer"])) if t["producer"] else ("source" if t["kind"] != "lakehouse" else "<span class='bad'>not found</span>")
        tr.append("<tr><td><strong>%s</strong></td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
            e(t["label"]), e(t["group"]), made, e(", ".join(graph.nodes[r]["label"] for r in t["reads"])) or "-",
            e(", ".join(graph.nodes[u]["label"] for u in t["used_by"])) or "-"))
    sec.append("<section id='tables'><h2>Tables</h2><div class='tw'><table><tr><th>Table</th><th>Where</th><th>Made by (item / query)</th><th>Reads</th><th>Read by</th></tr>%s</table></div></section>" % "".join(tr))
    blocks = []
    for t in doc["tables"]:
        st = doc["steps"].get(t["id"])
        if st and t["producer"]:
            lis = "".join("<li><code>%s</code>%s%s</li>" % (e(s["step"] or ""), (" " + e(s["what"])) if s["what"] else "", (" <span class='c'>%s</span>" % e(s["comment"])) if s["comment"] else "") for s in st)
            blocks.append("<h3>%s</h3><p class='meta'>%s, query <code>%s</code></p>%s<ul class='steps'>%s</ul>" % (
                e(t["label"]), e(t["producer"][0]), e(t["producer"][1]), ("<p>%s</p>" % e(t["about"])) if t["about"] else "", lis))
    for c in graph.ext:
        st = doc["steps"].get("ext:" + c.name)
        if st:
            lis = "".join("<li><code>%s</code>%s%s</li>" % (e(s["step"] or ""), (" " + e(s["what"])) if s["what"] else "", (" <span class='c'>%s</span>" % e(s["comment"])) if s["comment"] else "") for s in st)
            blocks.append("<h3>%s <span class='tag'>outside the medallion</span></h3><ul class='steps'>%s</ul>" % (e(c.name), lis))
    sec.append("<section id='build'><h2>How each output is built</h2>%s</section>" % "".join(blocks))
    for i, (f, rows) in enumerate(doc["columns"].items()):
        tr = []
        for r in rows:
            rule = ("<code class='rule'>%s</code>" % e(r["rule"])) if r["rule"] else ""
            if r["comment"]:
                rule += "<div class='c'>%s</div>" % e(r["comment"])
            if r["notes"]:
                rule += "<div class='c'>Then: %s</div>" % e("; ".join(r["notes"]))
            tr.append("<tr><td><strong>%s</strong>%s</td><td><span class='how %s'>%s</span></td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
                e(r["column"]), "<span class='sens'>SENSITIVE</span>" if r["sensitive"] else "", e(r["how"]), e(r["how"]), rule or "-",
                "".join("<div class='src'><span class='st'>%s</span> %s</div>" % (e(t), e(", ".join(cs))) for t, cs in r["by_table"].items()) or "-",
                "<ol class='path'>%s</ol>" % "".join("<li>%s</li>" % e(h) for h in r["path"])))
        sens = [r for r in rows if r["sensitive"]]
        note = ("<p><strong>Sensitive columns:</strong> %s.</p>" % e("; ".join("%s (from %s)" % (r["column"], grouped(r) or "derived") for r in sens))) if sens else ""
        sec.append("<section id='col-%d'><h2>Column lineage: %s</h2><p>Each column of the output, how it is made, and the source columns it ultimately comes from. "
                   "<em>Path</em> lists the items that carry it, from the output back to the first one.</p>%s<div class='tw'><table class='cols'><colgroup><col style='width:15%%'><col style='width:10%%'><col style='width:35%%'><col style='width:22%%'><col style='width:18%%'></colgroup><tr><th>Column</th><th>How</th><th>Rule</th>"
                   "<th>Comes from</th><th>Path</th></tr>%s</table></div></section>" % (i, e(graph.nodes[f]["label"]), note, "".join(tr)))
    g = "".join("<li>%s</li>" % e(x) for x in doc["gaps"]) or "<li class='ok'>None: every input table has a producer and every column was traced.</li>"
    sec.append("<section id='gaps'><h2>Gaps and checks</h2><ul class='gaps'>%s</ul></section>" % g)
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            "<title>%s</title><style>%s</style></head><body><main>%s</main></body></html>" % (e(doc["title"][:80]), CSS, "\n".join(sec)))


# --------------------------------------------------------------------------- command


def cmd_doc(a, transport=None):
    dataflows = read_dataflows(a.dataflows)
    externals = []
    for spec in a.external or []:
        name, _, path = spec.partition("=")
        with open(path, encoding="utf-8-sig") as f:
            ext = Dataflow(name.strip(), f.read(), kind="External", path=path)
        ext.outputs = {}
        externals.append(ext)
    lh = lakehouse_names(a.lakehouses)
    pipelines = read_pipelines(a.pipelines)
    live = None
    if a.workspace:
        live = live_read(a.workspace, a.token_cmd, dataflows, pipelines, transport)
        lh.update(live["lakehouses"])
        dataflows += live["others"]
    graph = Graph(dataflows, externals, lh)
    graph.pipelines = pipelines
    if live:
        own = {d.name for d in read_dataflows(a.dataflows)}
        # an outside dataflow only matters when it produces a table this set reads
        used = {s for s, _, _, _ in graph.edges}
        keep_other = {d.name for d in live["others"] if any(graph.lh_node(*o) in used for o in d.outputs.values())}
        graph = Graph([d for d in dataflows if d.name in own or d.name in keep_other], externals, lh)
        graph.pipelines = pipelines
    tracer = Tracer(graph)
    notes = open(a.notes, encoding="utf-8-sig").read() if a.notes else ""
    doc = build_doc(a, graph, tracer, live, notes, a.sensitive or DEFAULT_SENSITIVE)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
    with open(a.out + ".md", "w", encoding="utf-8", newline="\n") as f:
        f.write(to_markdown(doc, graph))
    with open(a.out + ".html", "w", encoding="utf-8", newline="\n") as f:
        f.write(to_html(doc, graph))
    with open(a.out + ".json", "w", encoding="utf-8", newline="\n") as f:
        json.dump({"nodes": [graph.nodes[n] for n in sorted(graph.nodes)], "edges": [{"from": s, "to": t, "item": i, "query": q} for s, t, i, q in sorted(set(graph.edges))],
                   "focus": doc["focus"], "columns": doc["columns"], "gaps": doc["gaps"], "live": doc["live"],
                   "title": doc["title"], "generated": doc["generated"], "items": doc["items"], "notes": doc["notes"],
                   "consumers": doc["consumers"], "pipelines": [p["name"] for p in doc["pipelines"]],
                   "inputs": {d.name: text_hash(d.text) for d in list(graph.dfs.values()) + list(graph.ext) if d.name in doc["items"] and getattr(d, "path", None) and d.kind != "External"}},
                  f, indent=1, default=str)
    traced = sum(1 for rows in doc["columns"].values() for r in rows if r["sources"])
    total = sum(len(rows) for rows in doc["columns"].values())
    print("wrote %s.md, .html, .json: %d tables in scope, %d of %d focus columns traced to a source, %d gap(s)"
          % (a.out, len(doc["tables"]), traced, total, len(doc["gaps"])))
    for g in doc["gaps"]:
        print("  gap: " + g)
    return 1 if doc["gaps"] else 0


def text_hash(text):
    norm = "\n".join(l.rstrip() for l in (text or "").replace("\r\n", "\n").strip().split("\n"))
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]


NOTE_TOPICS = [("purpose", r"(?i)\bpurpose\b"), ("owner", r"(?i)\bowner"), ("consumers", r"(?i)\bconsumer"),
               ("refresh", r"(?i)\brefresh|schedule"), ("verification", r"(?i)\bverif|reconcil|acceptance")]


def evaluate(doc, dataflows_dir=None, max_age_days=90, today=None):
    """[(level, check, detail)] for a lineage document's JSON. level: PASS, WARN, FAIL."""
    out = []
    rows = [r for rs in (doc.get("columns") or {}).values() for r in rs]
    if not rows:
        return [("FAIL", "coverage", "the document traces no column (no --focus output or an empty one)")]
    untraced = [r["column"] for r in rows if not r.get("sources")]
    out.append(("FAIL" if untraced else "PASS", "coverage", "%d of %d columns traced to a source%s" % (
        len(rows) - len(untraced), len(rows), (": missing " + ", ".join(untraced[:10])) if untraced else "")))
    gaps = doc.get("gaps") or []
    out.append(("FAIL" if gaps else "PASS", "gaps", "; ".join(gaps)[:400] if gaps else "every input table has a producer"))
    live = doc.get("live")
    if not live:
        out.append(("WARN", "drift", "not checked: generated without --workspace, so the deployed definitions were never compared"))
    else:
        bad = {k: v for k, v in (live.get("drift") or {}).items() if v != "same"}
        out.append(("FAIL" if bad else "PASS", "drift", ", ".join("%s %s" % kv for kv in bad.items()) if bad else "repo matches the deployed definitions"))
    gen = doc.get("generated")
    if gen:
        age = ((today or dt.date.today()) - dt.date.fromisoformat(gen[:10])).days
        out.append(("WARN" if age > max_age_days else "PASS", "age", "generated %s (%d days ago)" % (gen[:10], age)))
    inputs = doc.get("inputs") or {}
    if dataflows_dir:
        now = {d.name: text_hash(d.text) for d in read_dataflows(dataflows_dir)}
        changed = sorted(n for n, h in inputs.items() if n in now and now[n] != h)
        gone = sorted(n for n in inputs if n not in now and not n.startswith("ext:"))
        if not inputs:
            out.append(("WARN", "freshness", "the document records no input hashes (made by an older lineage.py): regenerate it"))
        else:
            out.append(("FAIL" if changed else "PASS", "freshness", ("changed since generated: " + ", ".join(changed)) if changed else
                        "no dataflow in the chain changed since generated%s" % ("; not in the folder: " + ", ".join(gone) if gone else "")))
    notes = doc.get("notes") or ""
    if not notes.strip():
        out.append(("FAIL", "curated notes", "none: purpose, owner, consumers, refresh and verification are not recorded"))
    else:
        missing = [t for t, rx in NOTE_TOPICS if not re.search(rx, notes)]
        out.append(("FAIL" if missing else "PASS", "curated notes", ("missing: " + ", ".join(missing)) if missing else "purpose, owner, consumers, refresh, verification"))
    sens = [r["column"] for r in rows if r.get("sensitive")]
    if sens:
        unexplained = [c for c in sens if c.lower() not in notes.lower()]
        out.append(("FAIL" if unexplained else "PASS", "sensitive columns", ("not explained in the notes: " + ", ".join(unexplained)) if unexplained else
                    "%d flagged, each explained in the notes" % len(sens)))
    if not doc.get("consumers") and not re.search(r"(?i)consumer", notes):
        out.append(("WARN", "consumers", "no reader outside the chain is named; add --external or say who reads it in the notes"))
    if not doc.get("pipelines") and not re.search(r"(?i)schedule|refresh", notes):
        out.append(("WARN", "refresh", "no pipeline or schedule recorded"))
    return out


def cmd_evaluate(a):
    with open(a.doc if a.doc.endswith(".json") else a.doc + ".json", encoding="utf-8") as f:
        doc = json.load(f)
    if a.notes:
        doc["notes"] = open(a.notes, encoding="utf-8-sig").read()
    res = evaluate(doc, a.dataflows, a.max_age_days)
    for level, check, detail in res:
        print("%-4s  %-17s %s" % (level, check, detail))
    fails = sum(1 for r in res if r[0] == "FAIL")
    print("%s: %d check(s), %d failing, %d warning" % (doc.get("title") or a.doc, len(res), fails, sum(1 for r in res if r[0] == "WARN")))
    return 1 if fails else 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="lineage.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("command", nargs="?", choices=["doc", "evaluate"])
    ap.add_argument("--doc")
    ap.add_argument("--max-age-days", type=int, default=90)
    ap.add_argument("--dataflows")
    ap.add_argument("--pipelines")
    ap.add_argument("--external", action="append")
    ap.add_argument("--lakehouses")
    ap.add_argument("--workspace")
    ap.add_argument("--token-cmd")
    ap.add_argument("--focus", action="append")
    ap.add_argument("--title")
    ap.add_argument("--notes")
    ap.add_argument("--sensitive")
    ap.add_argument("--out")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if a.command == "evaluate":
        if not a.doc:
            ap.print_help()
            return 2
        try:
            return cmd_evaluate(a)
        except (OSError, ValueError, KeyError) as e:
            print("cannot run: %s" % e)
            return 2
    if a.command != "doc" or not a.dataflows or not a.focus or not a.out:
        ap.print_help()
        return 2
    try:
        return cmd_doc(a)
    except (OSError, ValueError, StopIteration) as e:
        print("cannot run: %s" % e)
        return 2


# --------------------------------------------------------------------------- selftest

FIX_LH = {"b": "11111111-1111-1111-1111-111111111111", "s": "22222222-2222-2222-2222-222222222222", "g": "33333333-3333-3333-3333-333333333333"}


def _dest(q, lh, table):
    return ('shared %s_DataDestination = let\n    Pattern = Lakehouse.Contents([]),\n    N1 = Pattern{[workspaceId = "w"]}[Data],\n'
            '    N2 = N1{[lakehouseId = "%s"]}[Data],\n    T = N2{[Id = "%s", ItemKind = "Table"]}?[Data]?\nin\n    T;\n' % (q, lh, table))


def _attr(q):
    return '[DataDestinations = {[Definition = [Kind = "Reference", QueryName = "%s_DataDestination", IsNewTarget = true]]}]\n' % q


def selftest():
    import tempfile
    ok, fails = 0, []

    def check(name, cond):
        nonlocal ok
        if cond:
            ok += 1
        else:
            fails.append(name)
    bronze = ("section Section1;\n" + _attr("app_sheet") + 'shared app_sheet = let\n    Source = CommonDataService.Database("org.example.invalid"),\n'
              '    Data = Source{[Schema = "dbo", Item = "app_sheet"]}[Data],\n    Stamped = Table.AddColumn(Data, "loaded", each 1)\nin\n    Stamped;\n'
              + _dest("app_sheet", FIX_LH["b"], "app_sheet") + _attr("app_rate") +
              'shared app_rate = let\n    Source = CommonDataService.Database("org.example.invalid"),\n    Data = Source{[Schema = "dbo", Item = "app_rate"]}[Data]\nin\n    Data;\n'
              + _dest("app_rate", FIX_LH["b"], "app_rate"))
    silver = ("section Section1;\nshared B = let\n    Source = Lakehouse.Contents([]),\n    W = Source{[workspaceId = \"w\"]}[Data],\n"
              '    L = W{[lakehouseId = "%s"]}[Data]\nin\n    L;\n' % FIX_LH["b"] +
              "// rates by person\nshared Rates = let\n    Source = B{[Id = \"app_rate\", ItemKind = \"Table\"]}[Data],\n"
              "    Shaped = Table.FromRecords(Table.TransformRows(Source, (r) => [Key = r[app_person], Amount = r[app_amount]]))\nin\n    Shaped;\n"
              "// approved sheets only\n" + _attr("OUT") +
              "shared OUT = let\n    Sheets = Table.SelectRows(B{[Id = \"app_sheet\", ItemKind = \"Table\"]}[Data], each [app_status] = \"Approved\"),\n"
              "    // hours times rate\n    WithCost = Table.AddColumn(Sheets, \"Cost\", each [app_hours] * 2, type number),\n"
              "    Merged = Table.NestedJoin(WithCost, {\"app_person\"}, Rates, {\"Key\"}, \"R\", JoinKind.LeftOuter),\n"
              "    Expanded = Table.ExpandTableColumn(Merged, \"R\", {\"Amount\"}, {\"Rate\"}),\n"
              "    Renamed = Table.RenameColumns(Expanded, {{\"app_hours\", \"Hours\"}}),\n"
              "    Final = Table.SelectColumns(Renamed, {\"Hours\", \"Cost\", \"Rate\", \"app_person\"})\nin\n    Final;\n" + _dest("OUT", FIX_LH["s"], "OUT"))
    gold = ("section Section1;\n" + _attr("FINAL") + "shared FINAL = let\n    Source = Lakehouse.Contents([]),\n    W = Source{[workspaceId = \"w\"]}[Data],\n"
            '    S = W{[lakehouseId = "%s"]}[Data],\n    T = S{[Id = "OUT", ItemKind = "Table"]}[Data],\n' % FIX_LH["s"] +
            '    Blanked = Table.ReplaceValue(T, "N/A", null, Replacer.ReplaceValue, {"Rate"}),\n'
            '    Final = Table.SelectColumns(Blanked, {"Hours", "Cost", "Rate", "app_person"})\nin\n    Final;\n' + _dest("FINAL", FIX_LH["g"], "FINAL"))
    ext = ('let\n    Source = Sql.Database("host.example.invalid", "APP_GOLD"),\n    T = Source{[Schema = "dbo", Item = "FINAL"]}[Data],\n'
           '    Recent = Table.SelectRows(T, each [Hours] > 0)\nin\n    Recent')
    pipe = {"properties": {"activities": [
        {"name": "Bronze", "type": "RefreshDataflow", "typeProperties": {"dataflowId": "{{DF_BRONZE}}"}},
        {"name": "Silver", "type": "RefreshDataflow", "typeProperties": {"dataflowId": "{{DF_SILVER}}"}, "dependsOn": [{"activity": "Bronze"}]},
        {"name": "Gold", "type": "RefreshDataflow", "typeProperties": {"dataflowId": "{{DF_GOLD}}"}, "dependsOn": [{"activity": "Silver"}]}]}}
    with tempfile.TemporaryDirectory() as tmp:
        for name, text in (("DF_BRONZE", bronze), ("DF_SILVER", silver), ("DF_GOLD", gold)):
            os.makedirs(os.path.join(tmp, "df", name))
            with open(os.path.join(tmp, "df", name, "mashup.pq"), "w", encoding="utf-8") as f:
                f.write(text)
        os.makedirs(os.path.join(tmp, "pl"))
        with open(os.path.join(tmp, "pl", "PL_REFRESH.json"), "w") as f:
            json.dump(pipe, f)
        with open(os.path.join(tmp, "ext.pq"), "w") as f:
            f.write(ext)
        with open(os.path.join(tmp, "lh.json"), "w") as f:
            json.dump({"bronze": {"name": "APP_BRONZE", "id": FIX_LH["b"]}, "silver": {"name": "APP_SILVER", "id": FIX_LH["s"]},
                       "gold": {"name": "APP_GOLD", "id": FIX_LH["g"]}}, f)
        with open(os.path.join(tmp, "notes.md"), "w") as f:
            f.write("## Purpose\n\n- Owner: a team\n")
        out = os.path.join(tmp, "doc", "lineage")
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = main(["doc", "--dataflows", os.path.join(tmp, "df"), "--pipelines", os.path.join(tmp, "pl"), "--lakehouses", os.path.join(tmp, "lh.json"),
                       "--external", "Finance query=" + os.path.join(tmp, "ext.pq"), "--focus", "FINAL", "--notes", os.path.join(tmp, "notes.md"), "--out", out])
        data = json.load(open(out + ".json"))
        md = open(out + ".md", encoding="utf-8").read()
        page = open(out + ".html", encoding="utf-8").read()
        edges = {(e["from"], e["to"]) for e in data["edges"]}
        check("bronze edge from Dataverse", ("dv:org.example.invalid/app_sheet", "lh:APP_BRONZE/app_sheet") in edges)
        check("silver edge via helper query", ("lh:APP_BRONZE/app_rate", "lh:APP_SILVER/OUT") in edges)
        check("gold edge", ("lh:APP_SILVER/OUT", "lh:APP_GOLD/FINAL") in edges)
        check("external consumer via SQL endpoint", ("lh:APP_GOLD/FINAL", "ext:Finance query") in edges)
        cols = {r["column"]: r for r in data["columns"]["lh:APP_GOLD/FINAL"]}
        check("renamed column traced", cols["Hours"]["how"] == "renamed" and cols["Hours"]["sources"] == ["app_sheet.app_hours"])
        check("computed column with rule", cols["Cost"]["how"] == "computed" and "app_hours" in (cols["Cost"]["rule"] or "") and cols["Cost"]["sources"] == ["app_sheet.app_hours"])
        check("joined column through a record shape", cols["Rate"]["how"] == "joined" and cols["Rate"]["sources"] == ["app_rate.app_amount"])
        check("modification noted", any("N/A" in n for n in cols["Rate"]["notes"]))
        check("passthrough to source", cols["app_person"]["sources"] == ["app_sheet.app_person"])
        check("sensitive flag", cols["Rate"]["sensitive"] and cols["Cost"]["sensitive"] and not cols["Hours"]["sensitive"])
        check("no gaps", rc == 0 and not data["gaps"])
        check("markdown has mermaid and curated notes", "```mermaid" in md and "About this data (curated)" in md and "PL_REFRESH" in md)
        check("html has svg, tokens, dark mode", "<svg" in page and ":root{" in page and "prefers-color-scheme:dark" in page)
        check("comments carried into steps", "hours times rate" in md and "approved sheets only" in md)
        # evaluate: the fixture document (notes lack topics; Rate and Cost unexplained), then fresh notes, then a changed dataflow
        ev = {c: lv for lv, c, _ in evaluate(data, os.path.join(tmp, "df"), today=dt.date.today())}
        check("evaluate: coverage, gaps and freshness pass; thin notes fail", ev.get("coverage") == "PASS" and ev.get("gaps") == "PASS"
              and ev.get("freshness") == "PASS" and ev.get("curated notes") == "FAIL" and ev.get("sensitive columns") == "FAIL" and ev.get("drift") == "WARN")
        data["notes"] = "Purpose: x. Owner: a team. Consumers: Finance query. Refresh: PL_REFRESH daily. Verification: reconciled. Rate and Cost are pay data."
        ev = {c: lv for lv, c, _ in evaluate(data, os.path.join(tmp, "df"))}
        check("evaluate: complete notes pass", ev.get("curated notes") == "PASS" and ev.get("sensitive columns") == "PASS")
        with open(os.path.join(tmp, "df", "DF_GOLD", "mashup.pq"), "a", encoding="utf-8") as f:
            f.write("\n// changed\n")
        ev = {c: lv for lv, c, _ in evaluate(data, os.path.join(tmp, "df"))}
        check("evaluate: a changed dataflow makes the document stale", ev.get("freshness") == "FAIL")
        # an input with no producer is a gap
        os.remove(os.path.join(tmp, "df", "DF_BRONZE", "mashup.pq"))
        with contextlib.redirect_stdout(buf):
            rc2 = main(["doc", "--dataflows", os.path.join(tmp, "df"), "--lakehouses", os.path.join(tmp, "lh.json"), "--focus", "FINAL", "--out", out])
        data2 = json.load(open(out + ".json"))
        check("missing producer is a gap (exit 1)", rc2 == 1 and any("no producer" in g for g in data2["gaps"]))
        # a SharePoint list read by GUID through a generic helper function
        sp = ("section Section1;\n" + _attr("Staff List") + 'shared #"Staff List" = let\n'
              '    Source = SharePoint.Tables("https://example.invalid/sites/x", [Implementation = "2.0"]),\n'
              '    #"Navigation 1" = Source{[Id = "aaaaaaaa-0000-4000-8000-000000000000"]}[Items],\n'
              '    Norm = (tbl as table) as table => Table.TransformColumnNames(tbl, each _),\n'
              '    Normed = Norm(#"Navigation 1"),\n'
              '    Kept = Table.SelectColumns(Normed, {"Vendor"})\nin\n    Kept;\n' + _dest("Staff List", FIX_LH["b"], "SP_STAFF").replace("shared Staff List_DataDestination", 'shared #"Staff List_DataDestination"'))
        sv = ("section Section1;\n" + _attr("STAFF") + "shared STAFF = let\n    Source = Lakehouse.Contents([]),\n    W = Source{[workspaceId = \"w\"]}[Data],\n"
              '    L = W{[lakehouseId = "%s"]}[Data],\n    T = L{[Id = "SP_STAFF", ItemKind = "Table"]}[Data],\n' % FIX_LH["b"] +
              '    Renamed = Table.RenameColumns(T, {{"Vendor", "Vendor Name"}}),\n    Kept = Table.SelectColumns(Renamed, {"Vendor Name"})\nin\n    Kept;\n' + _dest("STAFF", FIX_LH["s"], "STAFF"))
        for name, text in (("DF_SP", sp), ("DF_SV", sv)):
            os.makedirs(os.path.join(tmp, "df2", name))
            with open(os.path.join(tmp, "df2", name, "mashup.pq"), "w", encoding="utf-8") as f:
                f.write(text)
        with contextlib.redirect_stdout(buf):
            rc3 = main(["doc", "--dataflows", os.path.join(tmp, "df2"), "--lakehouses", os.path.join(tmp, "lh.json"), "--focus", "STAFF", "--out", out])
        d3 = json.load(open(out + ".json"))
        c3 = {r["column"]: r for r in d3["columns"].get("lh:APP_SILVER/STAFF", [])}
        check("SharePoint list by GUID, named after its query", rc3 == 0 and c3["Vendor Name"]["sources"] == ["Staff List (list aaaaaaaa).Vendor"])
        check("generic helper function passed by name, noted", any("generic function Norm" in n for n in c3["Vendor Name"]["notes"]))
    # lexer cases
    check("quoted identifiers and doubled quotes", [t[1] for t in tokens('#"a ""b""" = "x""y"') if t[0] in ("qid", "str")] == ['a "b"', 'x"y'])
    flag = lambda c: bool(re.search(DEFAULT_SENSITIVE, c))
    check("sensitive pattern: whole words", all(map(flag, ["Timesheet Rate", "Cost", "Rate Amount", "Pay Grade"])) and not any(map(flag, ["Cost Center", "Generated", "Separate"])))
    check("let steps with nested let", [s for s, _, _ in let_steps('let a = let x = 1 in x, b = (y) => let z = y in z in b')[0]] == ["a", "b"])
    if fails:
        print("selftest FAILED (%d ok): %s" % (ok, "; ".join(fails)))
        return 1
    print("selftest ok: %d checks (graph edges through helper queries and an outside SQL consumer, column lineage: renamed, computed, joined "
          "through a record shape, passthrough, a later modification, a SharePoint list through a generic function, sensitive flags; gaps; md/html/json output; evaluate; lexer)" % ok)
    return 0


if __name__ == "__main__":
    sys.exit(main())
