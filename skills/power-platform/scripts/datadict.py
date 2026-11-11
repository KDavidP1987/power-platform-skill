#!/usr/bin/env python3
"""datadict.py - a data dictionary for a Dataverse app, built from the unpacked solution in the repo
and, with --env, checked against the live environment. READ-ONLY: every call to Dataverse is a GET.

Usage:
    python datadict.py doc --solution DIR --out PATH_WITHOUT_EXTENSION [--title T] [--notes NOTES.md]
                           [--env https://org.crm.dynamics.com] [--token-cmd CMD] [--sensitive REGEX]
                           [--tables REGEX] [--dataflows DIR ...]
    python datadict.py notes --solution DIR --out NOTES.md [--notes EXISTING.md] [--tables REGEX]
    python datadict.py evaluate --doc PATH[.json] [--solution DIR] [--notes NOTES.md]
                                [--min-coverage 0.8] [--max-age-days 90]
    python datadict.py --selftest

What it reads:
  --solution  an unpacked solution (pac solution unpack / clone): the folder holding Entities/ and
              Other/ (or its parent). Each Entities/<table>/Entity.xml gives the table (name,
              description, ownership, alternate keys, audit) and its columns (type, length, precision,
              required level, description, choices with their labels, column security, audit,
              formula). Other/Relationships gives each lookup's target and cascade behaviour, and the
              tables that point at each table. Global choices are read from Other/OptionSets.
  --notes     curated Markdown. Text before the first table heading is the "About" section (purpose,
              owner, consumers, sensitive data, how to read it). A "## <table logical name>" section
              adds to that table, and a "| Column | Meaning |" table in it gives column meanings
              (logical or display name; "*" matches any run of characters, for repeated columns
              such as Month 1..Month 100). A curated meaning wins over the Dataverse description.
  --env       read the live environment too: the columns each table has there (drift against the
              repo, both ways) and the row count of each table.
  --dataflows a folder of Dataflow Gen2 items (<item>/mashup.pq), repeatable: each table lists the
              dataflows that read it from Dataverse (CommonDataService [Item="table"]), so the
              dictionary names its Fabric consumers. A read-only text scan.
  --sensitive regex on column display names to flag (default: the whole words rate, salary, wage,
              pay, compensation, bonus, ssn, birth date, a column named Cost, names ending Amount).
              Columns with column security are flagged as secured either way.

What it writes (PATH.html, PATH.md, PATH.csv, PATH.json):
  summary; About (curated); a table index; per table: purpose, facts (entity set, ownership, primary
  name, alternate keys, audit, rows), every app column with type, required, meaning and its source,
  allowed values (choices by label, lookups with their target and delete behaviour), flags (key,
  sensitive, secured, formula); what points at the table; the standard columns once; gaps.
  The CSV has one row per column for a spreadsheet.

notes writes a notes skeleton: one section per table with every column and an empty meaning,
keeping what --notes EXISTING.md already says.

evaluate judges an existing document: tables described, column meanings (coverage, FAIL below
--min-coverage), choices labelled, lookups resolved, freshness (a table changed in the solution
since the document was made), age, drift checked and clean, curated notes (purpose, owner),
sensitive columns explained, and how many meanings live in Dataverse itself.

Exit (doc): 0 written; 1 written, with gaps to read; 2 cannot run.
Exit (evaluate): 0 no FAIL; 1 a FAIL; 2 cannot run.
Python 3 standard library only.
"""
import argparse
import csv
import datetime as dt
import fnmatch
import glob
import hashlib
import html
import importlib.util
import io
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
# pay and personal data by whole word; finance figures such as Amount are not flagged by default, and the
# notes can mark any column sensitive or not (a Sensitive column in the meanings table)
DEFAULT_SENSITIVE = r"(?i)\b(rates?|salary|salaries|wages?|pay|payroll|compensation|bonus|ssn|social security|birth\s*date|date of birth|home address|personal (email|phone))\b"
LANG = "1033"
# columns every table carries; listed once, not per table
STANDARD_KEEP = ("primarykey", "state", "status")
REQUIRED = {"none": "", "recommended": "Recommended", "required": "Required", "applicationrequired": "Required",
            "systemrequired": "Required (system)"}
CASCADE = {"Cascade": "deletes the rows", "RemoveLink": "clears the link", "Restrict": "is blocked while rows exist",
           "NoCascade": "leaves the rows"}


# --------------------------------------------------------------------------- reading the solution


def _label(el, path):
    if el is None:
        return ""
    for x in el.findall(path):
        if x.get("languagecode") in (LANG, None):
            return (x.get("description") or "").strip()
    return ""


def text_hash(text):
    norm = "\n".join(l.rstrip() for l in (text or "").replace("\r\n", "\n").strip().split("\n"))
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]


def solution_root(path):
    for cand in (path, os.path.join(path, "src"), os.path.join(path, "solution", "src")):
        if os.path.isdir(os.path.join(cand, "Entities")):
            return cand
    raise ValueError("no Entities folder under %s (pass the unpacked solution folder)" % path)


def options_of(os_el):
    """[(value, label, state or None, hidden)] from an <optionset> element."""
    out = []
    if os_el is None:
        return out
    for o in list(os_el.iter("option")) + list(os_el.iter("status")) + list(os_el.iter("state")):
        if o.get("value") is None:
            continue
        lab = _label(o, "labels/label")
        out.append((o.get("value"), lab, o.get("state"), o.get("IsHidden") == "1"))
    return out


def global_optionsets(root):
    out = {}
    for f in glob.glob(os.path.join(root, "Other", "OptionSets", "*.xml")):
        el = ET.parse(f).getroot()
        name = (el.get("Name") or os.path.splitext(os.path.basename(f))[0]).lower()
        out[name] = {"label": _label(el, "displaynames/displayname"), "options": options_of(el)}
    return out


def friendly_type(a):
    t = a["type"]
    if t == "nvarchar":
        fmt = a.get("format") or "text"
        return ("Text" if fmt in ("text", "") else "Text (%s)" % fmt) + (" %s" % a["maxlength"] if a.get("maxlength") else "")
    if t in ("ntext", "memo"):
        return "Multiline text" + (" %s" % a["maxlength"] if a.get("maxlength") else "")
    if t == "int":
        return "Whole number" + (" (%s)" % a["format"] if a.get("format") and a["format"] != "none" else "")
    if t == "bigint":
        return "Big integer"
    if t in ("decimal", "float", "double"):
        return ("Decimal" if t == "decimal" else "Float") + (" (%s places)" % a["accuracy"] if a.get("accuracy") else "")
    if t == "money":
        return "Currency" + (" (%s places)" % a["accuracy"] if a.get("accuracy") else "")
    if t == "bit":
        return "Yes/No"
    if t == "picklist":
        return "Choice"
    if t == "multiselectpicklist":
        return "Choices (multiple)"
    if t in ("lookup", "customer", "owner"):
        return {"lookup": "Lookup", "customer": "Customer", "owner": "Owner"}[t]
    if t == "datetime":
        if a.get("format") == "date" or a.get("behavior") == "2":
            return "Date only"
        return "Date and time" + (" (time zone independent)" if a.get("behavior") == "3" else "")
    if t == "primarykey":
        return "Unique identifier (key)"
    if t == "uniqueidentifier":
        return "Unique identifier"
    if t == "state":
        return "Status"
    if t == "status":
        return "Status reason"
    if t == "file":
        return "File" + (" (up to %s KB)" % a["maxvalue"] if a.get("maxvalue") else "")
    if t == "image":
        return "Image"
    return t


def read_relationships(root):
    rels = []
    for f in sorted(glob.glob(os.path.join(root, "Other", "Relationships", "*.xml"))) + \
            [p for p in [os.path.join(root, "Other", "Relationships.xml")] if os.path.exists(p)]:
        for r in ET.parse(f).getroot().iter("EntityRelationship"):
            kind = r.findtext("EntityRelationshipType") or ""
            if kind == "OneToMany":
                rels.append({"name": r.get("Name"), "kind": kind,
                             "from": (r.findtext("ReferencingEntityName") or "").lower(),
                             "to": (r.findtext("ReferencedEntityName") or "").lower(),
                             "attr": (r.findtext("ReferencingAttributeName") or "").lower(),
                             "delete": r.findtext("CascadeDelete") or ""})
            elif kind == "ManyToMany":
                rels.append({"name": r.get("Name"), "kind": kind,
                             "from": (r.findtext("FirstEntityName") or "").lower(),
                             "to": (r.findtext("SecondEntityName") or "").lower(),
                             "attr": (r.findtext("IntersectEntityName") or "").lower(), "delete": ""})
    seen, out = set(), []
    for r in rels:
        if r["name"] not in seen:
            seen.add(r["name"])
            out.append(r)
    return out


def read_solution(path, tables_rx=None):
    root = solution_root(path)
    gos = global_optionsets(root)
    sol = {"root": root, "unique_name": "", "version": "", "tables": [], "inputs": {}}
    sx = os.path.join(root, "Other", "Solution.xml")
    if os.path.exists(sx):
        m = ET.parse(sx).getroot().find("SolutionManifest")
        if m is not None:
            sol["unique_name"], sol["version"] = m.findtext("UniqueName") or "", m.findtext("Version") or ""
    for f in sorted(glob.glob(os.path.join(root, "Entities", "*", "Entity.xml"))):
        raw = open(f, encoding="utf-8-sig").read()
        el = ET.fromstring(raw.encode("utf-8"))
        name_el = el.find("Name")
        info = el.find("EntityInfo/entity")
        if info is None:
            continue
        schema = info.get("Name") or (name_el.text if name_el is not None else "")
        logical = schema.lower()
        if tables_rx and not re.search(tables_rx, logical):
            continue
        sol["inputs"]["Entities/%s/Entity.xml" % os.path.basename(os.path.dirname(f))] = text_hash(raw)
        t = {"logical": logical, "schema": schema,
             "display": _label(info, "LocalizedNames/LocalizedName") or (name_el.get("LocalizedName") if name_el is not None else schema),
             "plural": _label(info, "LocalizedCollectionNames/LocalizedCollectionName"),
             "description": _label(info, "Descriptions/Description"),
             "entity_set": info.findtext("EntitySetName") or "",
             "ownership": {"OrgOwned": "Organization", "UserOwned": "User or team"}.get(info.findtext("OwnershipTypeMask") or "", info.findtext("OwnershipTypeMask") or ""),
             "audit": info.findtext("IsAuditEnabled") == "1",
             "change_tracking": info.findtext("ChangeTrackingEnabled") == "1",
             "keys": [], "columns": [], "standard": [], "primary_name": "", "primary_key": ""}
        for k in info.iter("EntityKey"):
            t["keys"].append({"name": _label(k, "displaynames/displayname") or k.findtext("Name") or "",
                              "columns": [x.text.lower() for x in k.iter("AttributeName") if x.text]})
        for a in info.iter("attribute"):
            ln = (a.findtext("LogicalName") or a.findtext("Name") or "").lower()
            typ = a.findtext("Type") or ""
            col = {"logical": ln, "schema": a.get("PhysicalName") or ln, "type": typ,
                   "display": _label(a, "displaynames/displayname") or ln,
                   "description": _label(a, "Descriptions/Description"),
                   "required": REQUIRED.get(a.findtext("RequiredLevel") or "none", a.findtext("RequiredLevel") or ""),
                   "custom": a.findtext("IsCustomField") == "1", "audit": a.findtext("IsAuditEnabled") == "1",
                   "secured": a.findtext("IsSecured") == "1",
                   "maxlength": a.findtext("MaxLength") or "", "format": (a.findtext("Format") or "").lower(),
                   "accuracy": a.findtext("Accuracy") or "", "behavior": a.findtext("Behavior") or "",
                   "minvalue": a.findtext("MinValue") or "", "maxvalue": a.findtext("MaxValue") or "",
                   "calc_of": (a.findtext("CalculationOf") or "").lower(), "source_type": a.findtext("SourceType") or "0",
                   "formula": bool(a.findtext("FormulaDefinitionFileName")), "default": a.findtext("AppDefaultValue") or "",
                   "primary_name": "PrimaryName" in (a.findtext("DisplayMask") or ""),
                   "options": [], "choice_name": "", "global_choice": False, "targets": []}
            os_el = a.find("optionset")
            if os_el is not None:
                col["options"] = options_of(os_el)
                col["choice_name"] = os_el.get("Name") or ""
            gname = (a.findtext("OptionSetName") or "").lower()
            if gname and not col["options"]:
                col["global_choice"] = True
                col["choice_name"] = gname
                col["options"] = gos.get(gname, {}).get("options", [])
            if ln.endswith("_base") and typ == "money":
                continue  # the base-currency copy of a currency column: noted on the column itself
            if col["primary_name"]:
                t["primary_name"] = ln
            if typ == "primarykey":
                t["primary_key"] = ln
            if col["custom"] or typ in STANDARD_KEEP:
                t["columns"].append(col)
            else:
                t["standard"].append(ln)
        sol["tables"].append(t)
    rels = read_relationships(root)
    for f in glob.glob(os.path.join(root, "Other", "Relationships", "*.xml")):
        sol["inputs"]["Other/Relationships/" + os.path.basename(f)] = text_hash(open(f, encoding="utf-8-sig").read())
    by = {t["logical"]: t for t in sol["tables"]}
    for r in rels:
        if r["kind"] != "OneToMany":
            continue
        t = by.get(r["from"])
        if t:
            for c in t["columns"]:
                if c["logical"] == r["attr"]:
                    c["targets"].append({"table": r["to"], "delete": r["delete"], "relationship": r["name"]})
    for t in sol["tables"]:
        t["referenced_by"] = sorted({(r["from"], r["attr"], r["delete"]) for r in rels if r["kind"] == "OneToMany" and r["to"] == t["logical"] and r["from"] != t["logical"]})
        t["many_to_many"] = sorted({r["to"] if r["from"] == t["logical"] else r["from"] for r in rels if r["kind"] == "ManyToMany" and t["logical"] in (r["from"], r["to"])})
        t["self_refs"] = sorted({r["attr"] for r in rels if r["kind"] == "OneToMany" and r["to"] == t["logical"] and r["from"] == t["logical"]})
    sol["relationships"] = rels
    return sol


def dataflow_readers(folders):
    """{table logical name: [dataflow item names]} from CommonDataService navigation in mashup.pq files."""
    out = {}
    for folder in folders or []:
        for f in sorted(glob.glob(os.path.join(folder, "*", "mashup.pq"))):
            item = os.path.basename(os.path.dirname(f))
            text = open(f, encoding="utf-8-sig").read()
            if "CommonDataService" not in text:
                continue
            for m in re.finditer(r'Item\s*=\s*"([A-Za-z0-9_]+)"', text):
                out.setdefault(m.group(1).lower(), [])
                if item not in out[m.group(1).lower()]:
                    out[m.group(1).lower()].append(item)
    return out


# --------------------------------------------------------------------------- curated notes


def _cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def parse_notes(md, tables):
    """(about_md, {table: {"text": md, "meanings": {key: meaning}}}). A section heading names a table by
    logical, schema or display name; a | Column | Meaning | table in it supplies column meanings."""
    names = {}
    for t in tables:
        for n in (t["logical"], t["schema"], t["display"]):
            names[n.lower()] = t["logical"]
    about, out, cur = [], {}, None
    for line in (md or "").replace("\r\n", "\n").split("\n"):
        if re.match(r"^\s*<!--.*-->\s*$", line):
            continue  # skeleton hints, not content
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            key = m.group(1).strip().strip("`").split(" (")[0].split(" - ")[0].strip().strip("`").lower()
            if key in names:
                cur = out.setdefault(names[key], {"lines": [], "meanings": {}, "sensitive": {}})
                continue
            cur = None
        (cur["lines"] if cur is not None else about).append(line)
    for sec in out.values():
        keep, rows, hdr = [], [], None
        for line in sec["lines"] + [""]:
            if line.strip().startswith("|"):
                rows.append(line)
                continue
            if rows:
                h = [c.lower() for c in _cells(rows[0])]
                if "column" in h and "meaning" in h:
                    ci, mi = h.index("column"), h.index("meaning")
                    si = h.index("sensitive") if "sensitive" in h else None
                    for r in rows[1:]:
                        c = _cells(r)
                        if len(c) > max(ci, mi) and not re.match(r"^:?-+:?$", c[ci]):
                            k = c[ci].strip("`").strip()
                            if k and c[mi].strip():
                                sec["meanings"][k.lower()] = c[mi].strip()
                            if k and si is not None and len(c) > si and c[si].strip():
                                sec["sensitive"][k.lower()] = c[si].strip().lower() in ("yes", "y", "true", "sensitive")
                else:
                    keep += rows
                rows = []
            keep.append(line)
        sec["text"] = "\n".join(keep).strip()
        del sec["lines"]
    return "\n".join(about).strip(), out


def curated_meaning(col, meanings, default=""):
    for k in (col["logical"], col["display"].lower()):
        if k in meanings:
            return meanings[k]
    for pat, v in meanings.items():
        if "*" in pat and (fnmatch.fnmatchcase(col["logical"], pat) or fnmatch.fnmatchcase(col["display"].lower(), pat)):
            return v
    return default


STANDARD_MEANING = {"primarykey": "Unique identifier of the row (set by Dataverse).",
                    "state": "Whether the row is Active or Inactive.",
                    "status": "The reason for the row's status."}


# --------------------------------------------------------------------------- live (read-only)


def load_ppapi():
    spec = importlib.util.spec_from_file_location("_ppapi", os.path.join(HERE, "_ppapi.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def live_read(env, token_cmd, tables, transport=None):
    pp = load_ppapi()
    token = "fixture" if transport else pp.get_token(env.rstrip("/"), token_cmd, "DATAVERSE_TOKEN", env)[0]
    c = pp.dataverse(env, token, read_only=True, transport=transport, sleep=lambda s: None)
    live = {"env": env, "columns": {}, "rows": {}, "errors": []}
    for t in tables:
        try:
            r = c.get("EntityDefinitions(LogicalName='%s')/Attributes?$select=LogicalName,AttributeType,IsCustomAttribute,AttributeOf" % t["logical"])
            live["columns"][t["logical"]] = sorted(x["LogicalName"] for x in r.get("value", [])
                                                   if x.get("IsCustomAttribute") and not x.get("AttributeOf")
                                                   and not x["LogicalName"].endswith("_base"))
        except Exception as e:  # a table missing live is recorded, not fatal
            live["columns"][t["logical"]] = None
            live["errors"].append("%s: %s" % (t["logical"], str(e)[:160]))
    names = [t["logical"] for t in tables]
    for i in range(0, len(names), 50):
        chunk = names[i:i + 50]
        try:
            r = c.get("RetrieveTotalRecordCount(EntityNames=@e)?@e=%s" % json.dumps(chunk, separators=(",", ":")))
            coll = r.get("EntityRecordCountCollection") or {}
            for k, v in zip(coll.get("Keys", []), coll.get("Values", [])):
                live["rows"][k] = v
        except Exception as e:
            live["errors"].append("row counts: %s" % str(e)[:160])
    return live


# --------------------------------------------------------------------------- the document


def values_text(col, by_table):
    if col["options"] and col["type"] not in ("bit",):
        parts = []
        for v, lab, state, hidden in col["options"]:
            s = "%s (%s)" % (lab or "(no label)", v)
            if col["type"] == "status" and state is not None:
                s += " [%s]" % ("Active" if state == "0" else "Inactive")
            parts.append(s + (" hidden" if hidden else ""))
        return parts
    if col["type"] == "bit" and col["options"]:
        labs = {v: lab for v, lab, _, _ in col["options"]}
        if (labs.get("1"), labs.get("0")) != ("Yes", "No"):
            return ["%s = true, %s = false" % (labs.get("1", "?"), labs.get("0", "?"))]
        return []
    return []


def build_doc(a, sol, notes_md, sensitive_rx, live=None, readers=None):
    about, tnotes = parse_notes(notes_md, sol["tables"])
    by = {t["logical"]: t for t in sol["tables"]}
    rx = re.compile(sensitive_rx)
    doc = {"title": a.title or "Data dictionary: %s" % (sol["unique_name"] or "Dataverse solution"),
           "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"), "solution": sol["unique_name"], "version": sol["version"],
           "notes": notes_md or "", "about": about, "inputs": sol["inputs"], "live": live, "tables": [], "gaps": [],
           "standard_columns": sorted({c for t in sol["tables"] for c in t["standard"]})}
    for t in sol["tables"]:
        tn = tnotes.get(t["logical"], {"text": "", "meanings": {}, "sensitive": {}})
        rows = []
        for c in t["columns"]:
            meaning, src = curated_meaning(c, tn["meanings"]), "curated"
            # a standard column's own description is Dataverse boilerplate ("Unique identifier for entity instances")
            if not meaning and c["type"] in STANDARD_MEANING and not c["custom"]:
                meaning, src = STANDARD_MEANING[c["type"]], "standard"
            if not meaning and c["description"]:
                meaning, src = c["description"], "dataverse"
            self_desc = False
            if not meaning and c["targets"]:
                tgt = by.get(c["targets"][0]["table"])
                tdisp = tgt["display"] if tgt else c["targets"][0]["table"]
                self_desc = tdisp.lower() == c["display"].lower()
            if not meaning:
                src = "self-describing lookup" if self_desc else ""
            flags = []
            if c["logical"] in {x for k in t["keys"] for x in k["columns"]}:
                flags.append("alternate key")
            if c["logical"] == t["primary_name"]:
                flags.append("primary name")
            if c["type"] not in STANDARD_MEANING and curated_meaning(c, tn["sensitive"], bool(rx.search(c["display"]))):
                flags.append("sensitive")
            if c["secured"]:
                flags.append("column security")
            if c["formula"] or c["source_type"] in ("1", "2"):
                flags.append({"1": "calculated", "2": "rollup"}.get(c["source_type"], "formula"))
            if c["type"] == "money":
                flags.append("base-currency copy")
            targets = [{"table": x["table"], "display": by[x["table"]]["display"] if x["table"] in by else "",
                        "delete": x["delete"], "in_solution": x["table"] in by} for x in c["targets"]]
            rows.append({"column": c["logical"], "display": c["display"], "type": friendly_type(c), "raw_type": c["type"],
                         "required": c["required"], "meaning": meaning, "meaning_source": src,
                         "dataverse_description": bool(c["description"]), "values": values_text(c, by),
                         "targets": targets, "choice_name": c["choice_name"], "global_choice": c["global_choice"],
                         "default": c["default"], "default_label": next((l for v, l, _, _ in c["options"] if v == c["default"]), "") if c["default"] else "",
                         "flags": flags, "custom": c["custom"]})
            if c["type"] in ("picklist", "multiselectpicklist", "state", "status") and not c["options"]:
                doc["gaps"].append("%s.%s: choice %s has no options in the solution (a global choice outside it?)" % (t["logical"], c["logical"], c["choice_name"] or "?"))
            if any(not lab for _, lab, _, _ in c["options"]):
                doc["gaps"].append("%s.%s: a choice option has no label" % (t["logical"], c["logical"]))
            if c["type"] in ("lookup", "customer") and c["custom"] and not c["targets"]:
                doc["gaps"].append("%s.%s: lookup with no relationship in the solution (target unknown)" % (t["logical"], c["logical"]))
        if not (t["description"] or tn["text"]):
            doc["gaps"].append("%s: no description and no curated section" % t["logical"])
        lc = None
        if live:
            lcols = live["columns"].get(t["logical"])
            if lcols is None:
                lc = {"state": "not found live"}
            else:
                repo = {r["column"] for r in rows if r["custom"]}
                lc = {"state": "same" if set(lcols) == repo else "differs",
                      "only_live": sorted(set(lcols) - repo), "only_repo": sorted(repo - set(lcols))}
            if lc["state"] != "same":
                doc["gaps"].append("%s: live columns %s%s%s" % (t["logical"], lc["state"],
                                   ("; only live: " + ", ".join(lc.get("only_live") or [])) if lc.get("only_live") else "",
                                   ("; only in repo: " + ", ".join(lc.get("only_repo") or [])) if lc.get("only_repo") else ""))
        doc["tables"].append({"logical": t["logical"], "schema": t["schema"], "display": t["display"], "plural": t["plural"],
                              "description": t["description"], "notes": tn["text"], "entity_set": t["entity_set"],
                              "ownership": t["ownership"], "audit": t["audit"], "primary_name": t["primary_name"],
                              "keys": t["keys"], "columns": rows, "referenced_by": [list(x) for x in t["referenced_by"]],
                              "many_to_many": t["many_to_many"], "self_refs": t["self_refs"],
                              "rows": (live or {}).get("rows", {}).get(t["logical"]), "live_columns": lc,
                              "read_by": (readers or {}).get(t["logical"], [])})
    return doc


def stats(doc):
    cols = [c for t in doc["tables"] for c in t["columns"]]
    app = [c for c in cols if c["custom"]]
    covered = [c for c in cols if c["meaning"] or c["meaning_source"] == "self-describing lookup"]
    return {"tables": len(doc["tables"]), "columns": len(cols), "app_columns": len(app),
            "covered": len(covered), "curated": sum(1 for c in cols if c["meaning_source"] == "curated"),
            "dataverse": sum(1 for c in app if c["dataverse_description"]),
            "choices": sum(1 for c in app if c["raw_type"] in ("picklist", "multiselectpicklist")),
            "lookups": sum(1 for c in app if c["targets"]),
            "sensitive": [(t["logical"], c["column"], c["display"]) for t in doc["tables"] for c in t["columns"] if "sensitive" in c["flags"]],
            "secured": sum(1 for c in cols if "column security" in c["flags"]),
            "keys": sum(len(t["keys"]) for t in doc["tables"])}


def summary_text(doc):
    s = stats(doc)
    pct = (100.0 * s["covered"] / s["columns"]) if s["columns"] else 0
    out = ("%d tables and %d columns (%d app columns, %d choices, %d lookups, %d alternate keys) from solution %s %s. "
           "%d of %d columns (%.0f%%) have a meaning: %d curated, %d from Dataverse descriptions, the rest standard columns "
           "or lookups named after their target. " % (
               s["tables"], s["columns"], s["app_columns"], s["choices"], s["lookups"], s["keys"], doc["solution"] or "?", doc["version"],
               s["covered"], s["columns"], pct, s["curated"], s["dataverse"]))
    if s["sensitive"]:
        out += "%d columns are flagged sensitive. " % len(s["sensitive"])
    rb = [t for t in doc["tables"] if t.get("read_by")]
    if rb:
        out += "%d tables are read by Fabric dataflows. " % len(rb)
    if doc["live"]:
        diff = [t["logical"] for t in doc["tables"] if t["live_columns"] and t["live_columns"]["state"] != "same"]
        out += "Checked against %s: %s." % (doc["live"]["env"], ("columns differ on " + ", ".join(diff)) if diff else "every table's columns match the repo")
    else:
        out += "Not checked against a live environment."
    return out


def target_text(c):
    return "; ".join("Lookup to %s (%s); deleting it %s" % (x["display"] or x["table"], x["table"], CASCADE.get(x["delete"], x["delete"] or "?")) for x in c["targets"])


def to_csv(doc):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["Table", "Table display name", "Column", "Display name", "Type", "Required", "Meaning", "Meaning source",
                "Allowed values", "Lookup to", "Flags"])
    for t in doc["tables"]:
        for c in t["columns"]:
            w.writerow([t["logical"], t["display"], c["column"], c["display"], c["type"], c["required"], c["meaning"],
                        c["meaning_source"], "; ".join(c["values"]), ", ".join(x["table"] for x in c["targets"]), ", ".join(c["flags"])])
    return buf.getvalue()


def md_cell(s):
    return (s or "").replace("|", "\\|").replace("\n", " ")


def to_markdown(doc):
    L = ["# " + doc["title"], "", "Generated %s from the solution in the repo%s. Derived sections are regenerated, never edited by hand; curated text comes from the notes." % (
        doc["generated"], " and the live environment" if doc["live"] else ""), "", "## Summary", "", summary_text(doc), ""]
    if doc["about"]:
        L += ["## About this data (curated)", "", doc["about"], ""]
    L += ["## Tables", "", "| Table | Logical name | Purpose | Columns | Rows |", "|---|---|---|---|---|"]
    for t in doc["tables"]:
        L.append("| %s | `%s` | %s | %d | %s |" % (t["display"], t["logical"], md_cell(t["description"]), len(t["columns"]),
                                                   "" if t["rows"] is None else t["rows"]))
    L.append("")
    for t in doc["tables"]:
        L += ["## %s (`%s`)" % (t["display"], t["logical"]), ""]
        if t["description"]:
            L += [t["description"], ""]
        if t["notes"]:
            L += [t["notes"], ""]
        L += ["Entity set `%s`; ownership %s; primary name `%s`%s%s%s." % (
            t["entity_set"], t["ownership"], t["primary_name"], "; alternate keys " + ", ".join("%s (%s)" % (k["name"], ", ".join(k["columns"])) for k in t["keys"]) if t["keys"] else "",
            "; audited" if t["audit"] else "", "; about %s rows" % t["rows"] if t["rows"] is not None else ""), ""]
        if t.get("read_by"):
            L += ["Read by: " + ", ".join("`%s`" % x for x in t["read_by"]), ""]
        L += ["| Column | Logical name | Type | Required | Meaning | Values | Flags |", "|---|---|---|---|---|---|---|"]
        for c in t["columns"]:
            vals = "; ".join(c["values"]) or target_text(c)
            L.append("| %s | `%s` | %s | %s | %s | %s | %s |" % (md_cell(c["display"]), c["column"], c["type"], c["required"],
                     md_cell(c["meaning"]) or ("-" if c["meaning_source"] == "self-describing lookup" else "**no meaning recorded**"),
                     md_cell(vals), ", ".join(c["flags"])))
        if t["referenced_by"]:
            L += ["", "Referenced by: " + ", ".join("`%s.%s`" % (f, a) for f, a, _ in t["referenced_by"])]
        L.append("")
    L += ["## Standard columns", "", "Every table also carries: " + ", ".join("`%s`" % c for c in doc["standard_columns"]) + ".", ""]
    L += ["## Gaps and checks", ""] + (["- " + g for g in doc["gaps"]] or ["- None."]) + [""]
    return "\n".join(L)


CSS = """
:root{--bg:#F5F7FA;--panel:#FFFFFF;--text:#1F2933;--muted:#52606D;--line:#CBD2D9;--primary:#0B5394;--accent:#0F766E;--warn:#B45309;--err:#B91C1C;--chip:#EDF0F3}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#11161C;--panel:#1A2129;--text:#E4E7EB;--muted:#9AA5B1;--line:#323F4B;--primary:#5B9BD5;--accent:#3FB8AA;--warn:#E0A458;--err:#F87171;--chip:#262F38}}
:root[data-theme="dark"]{--bg:#11161C;--panel:#1A2129;--text:#E4E7EB;--muted:#9AA5B1;--line:#323F4B;--primary:#5B9BD5;--accent:#3FB8AA;--warn:#E0A458;--err:#F87171;--chip:#262F38}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 "Segoe UI",system-ui,-apple-system,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 4px}
h2{font-size:20px;margin:40px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}h3{font-size:16px;margin:24px 0 6px}
.meta{color:var(--muted);font-size:13px}.summary{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--primary);border-radius:8px;padding:14px 18px;margin:20px 0}
.curated{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:4px 18px 10px}
.tag{display:inline-block;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:10px;padding:0 8px;margin-left:8px;vertical-align:middle;font-weight:400}
nav.toc{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;margin:10px 0 0}a{color:var(--primary);text-decoration:none}a:hover{text-decoration:underline}
.tw{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;vertical-align:top;padding:7px 10px;border-bottom:1px solid var(--line)}
th{background:var(--bg);font-weight:600}tr:last-child td{border-bottom:0}code{font:12px Consolas,"Cascadia Mono",monospace;background:var(--bg);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
table.cols{table-layout:fixed;min-width:900px}td{overflow-wrap:break-word}p,li,.summary{overflow-wrap:anywhere}
.ln{display:block;color:var(--muted);font-size:12px}.flag{display:inline-block;font-size:11px;padding:0 7px;margin:1px 2px 1px 0;border-radius:9px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.flag.sensitive,.flag.column-security{color:var(--warn);border-color:var(--warn);font-weight:600}.flag.alternate-key,.flag.primary-name{color:var(--primary);border-color:var(--primary)}
.src{font-size:11px;color:var(--muted)}.none{color:var(--err)}ul.vals{margin:0;padding-left:16px}ul.vals li{margin:0}
details summary{cursor:pointer;color:var(--primary);font-size:12px}.facts{font-size:13px;color:var(--muted);margin:4px 0 10px}
.filter{display:flex;gap:10px;align-items:center;margin:14px 0}.filter input{flex:1;max-width:420px;font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text)}
.gaps li{margin:4px 0}.ok{color:#15803D}section.tbl{scroll-margin-top:12px}
@media print{body{background:#fff}main{max-width:none;padding:0}.filter{display:none}.tw,.summary,.curated{border-color:#ccc}h2{break-after:avoid}tr{break-inside:avoid}}
"""

FILTER_JS = """
(function(){var i=document.getElementById('q');if(!i)return;i.addEventListener('input',function(){var q=i.value.trim().toLowerCase();
document.querySelectorAll('section.tbl').forEach(function(s){var any=false;s.querySelectorAll('tbody tr').forEach(function(r){var m=!q||r.textContent.toLowerCase().indexOf(q)>=0||s.dataset.name.indexOf(q)>=0;r.style.display=m?'':'none';if(m)any=true;});
s.style.display=any?'':'none';});var n=document.getElementById('qn');if(n)n.textContent=q?document.querySelectorAll('section.tbl tbody tr:not([style*="none"])').length+' columns match':'';});})();
"""


def md_inline(text):
    t = html.escape(text)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)
    return t


def notes_html(md):
    out, para, items, rows = [], [], [], []

    def flush():
        if para:
            out.append("<p>%s</p>" % md_inline(" ".join(para)))
            para.clear()
        if items:
            out.append("<ul>%s</ul>" % "".join("<li>%s</li>" % md_inline(t) for t in items))
            items.clear()
        if rows:
            cells = [_cells(r) for r in rows]
            body = [r for r in cells[1:] if not all(re.match(r"^:?-+:?$", c) for c in r)]
            out.append('<div class="tw"><table><thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>' % (
                "".join("<th>%s</th>" % md_inline(c) for c in cells[0]),
                "".join("<tr>%s</tr>" % "".join("<td>%s</td>" % md_inline(c) for c in r) for r in body)))
            rows.clear()
    for line in (md or "").strip().split("\n"):
        if re.match(r"\s*#{1,4} ", line):
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


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def to_html(doc):
    e = html.escape
    by = {t["logical"]: t for t in doc["tables"]}
    sec = []
    toc = [("summary", "Summary")] + ([("about", "About this data")] if doc["about"] else []) + [("tables", "Tables"), ("standard", "Standard columns"), ("gaps", "Gaps and checks")]
    sec.append('<header><h1>%s</h1><div class="meta">Generated %s from the solution in the repo%s (%s %s). Derived sections are regenerated, never edited by hand; '
               'curated text is marked.</div><nav class="toc">%s</nav></header>' % (
                   e(doc["title"]), e(doc["generated"]), " and the live environment" if doc["live"] else "", e(doc["solution"]), e(doc["version"]),
                   "".join('<a href="#%s">%s</a>' % (a, e(b)) for a, b in toc)))
    sec.append('<section id="summary" class="summary">%s</section>' % e(summary_text(doc)))
    if doc["about"]:
        sec.append('<section id="about"><h2>About this data<span class="tag">curated</span></h2><div class="curated">%s</div></section>' % notes_html(doc["about"]))
    tr = []
    for t in doc["tables"]:
        tr.append("<tr><td><a href='#t-%s'><strong>%s</strong></a><span class='ln'>%s</span></td><td>%s</td><td>%d</td><td>%s</td></tr>" % (
            slug(t["logical"]), e(t["display"]), e(t["logical"]), e(t["description"]) or "<span class='none'>no description</span>",
            len(t["columns"]), "" if t["rows"] is None else e(str(t["rows"]))))
    sec.append("<section id='tables'><h2>Tables</h2><div class='tw'><table><colgroup><col style='width:24%%'><col><col style='width:9%%'><col style='width:8%%'></colgroup>"
               "<thead><tr><th>Table</th><th>Purpose</th><th>Columns</th><th>Rows (approx.)</th></tr></thead><tbody>%s</tbody></table></div>"
               "<div class='filter'><input id='q' type='search' placeholder='Filter columns by name, meaning or value' aria-label='Filter columns'><span id='qn' class='meta'></span></div></section>" % "".join(tr))
    for t in doc["tables"]:
        keys = "; ".join("%s (%s)" % (k["name"], ", ".join(k["columns"])) for k in t["keys"])
        facts = ["Entity set <code>%s</code>" % e(t["entity_set"]), "ownership: %s" % e(t["ownership"]),
                 "primary name <code>%s</code>" % e(t["primary_name"] or "-")]
        if keys:
            facts.append("alternate keys: %s" % e(keys))
        if t["audit"]:
            facts.append("audited")
        if t["rows"] is not None:
            facts.append("about %s rows (Dataverse snapshot count)" % e(str(t["rows"])))
        if t.get("read_by"):
            facts.append("read by the dataflow%s %s" % ("s" if len(t["read_by"]) > 1 else "", ", ".join("<code>%s</code>" % e(x) for x in t["read_by"])))
        if t["live_columns"]:
            facts.append("live columns: %s" % e(t["live_columns"]["state"]))
        rows = []
        for c in t["columns"]:
            if c["values"]:
                vals = "<ul class='vals'>%s</ul>" % "".join("<li>%s</li>" % e(v) for v in c["values"])
                if len(c["values"]) > 8:
                    vals = "<details><summary>%d values</summary>%s</details>" % (len(c["values"]), vals)
                if c["global_choice"]:
                    vals += "<div class='src'>global choice %s</div>" % e(c["choice_name"])
            elif c["targets"]:
                vals = "<br>".join("Lookup to %s <span class='ln'>%s; deleting it %s</span>" % (
                    ("<a href='#t-%s'>%s</a>" % (slug(x["table"]), e(x["display"])) if x["in_solution"] else "<code>%s</code>" % e(x["table"])),
                    e(x["table"]), e(CASCADE.get(x["delete"], x["delete"] or "?"))) for x in c["targets"])
            else:
                vals = ""
            if c.get("default_label"):
                vals += "<div class='src'>Default: %s</div>" % e(c["default_label"])
            if c["meaning"]:
                mean = md_inline(c["meaning"]) + ("<div class='src'>from %s</div>" % e(c["meaning_source"]) if c["meaning_source"] != "curated" else "")
            elif c["meaning_source"] == "self-describing lookup":
                mean = "<span class='src'>The related %s.</span>" % e(c["display"].lower())
            else:
                mean = "<span class='none'>no meaning recorded</span>"
            flags = "".join("<span class='flag %s'>%s</span>" % (slug(f), e(f)) for f in c["flags"])
            rows.append("<tr><td><strong>%s</strong><span class='ln'>%s</span></td><td>%s%s</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
                e(c["display"]), e(c["column"]), e(c["type"]), ("<span class='ln'>%s</span>" % e(c["required"])) if c["required"] else "",
                mean, vals or "-", flags))
        refs = ""
        if t["referenced_by"]:
            refs = "<p class='facts'>Referenced by: %s</p>" % ", ".join(
                ("<a href='#t-%s'>%s</a>" % (slug(f), e(by[f]["display"])) if f in by else "<code>%s</code>" % e(f)) + " <span class='ln' style='display:inline'>(%s)</span>" % e(a)
                for f, a, _ in t["referenced_by"])
        sec.append("<section class='tbl' id='t-%s' data-name='%s'><h2>%s <span class='tag'>%s</span></h2>%s%s<p class='facts'>%s.</p>%s"
                   "<div class='tw'><table class='cols'><colgroup><col style='width:19%%'><col style='width:13%%'><col style='width:34%%'><col style='width:22%%'><col style='width:12%%'></colgroup>"
                   "<thead><tr><th>Column</th><th>Type</th><th>Meaning</th><th>Values</th><th>Flags</th></tr></thead><tbody>%s</tbody></table></div></section>" % (
                       slug(t["logical"]), e((t["logical"] + " " + t["display"]).lower()), e(t["display"]), e(t["logical"]),
                       ("<p>%s</p>" % e(t["description"])) if t["description"] else "",
                       ("<div class='curated'>%s</div>" % notes_html(t["notes"])) if t["notes"] else "",
                       "; ".join(facts), refs, "".join(rows)))
    sec.append("<section id='standard'><h2>Standard columns</h2><p>Every table also carries these Dataverse columns, not listed per table: %s.</p></section>" %
               ", ".join("<code>%s</code>" % e(c) for c in doc["standard_columns"]))
    g = "".join("<li>%s</li>" % e(x) for x in doc["gaps"]) or "<li class='ok'>None: every table is described, every choice has labels, every lookup has a target.</li>"
    sec.append("<section id='gaps'><h2>Gaps and checks</h2><ul class='gaps'>%s</ul></section>" % g)
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            "<title>%s</title><style>%s</style></head><body><main>%s</main><script>%s</script></body></html>" % (
                e(doc["title"][:80]), CSS, "\n".join(sec), FILTER_JS))


# --------------------------------------------------------------------------- notes skeleton


def notes_skeleton(sol, existing_md=""):
    about, tnotes = parse_notes(existing_md, sol["tables"])
    L = [about or "**Purpose.** <what the app is for, one sentence>.\n\n**Owner.** <owning team> (<repo>).\n\n"
         "**Consumers.** <reports, dataflows, other apps that read these tables>.\n\n"
         "**Sensitive data.** <the tables and columns that hold sensitive data, and the access decision for each>.", ""]
    for t in sol["tables"]:
        tn = tnotes.get(t["logical"], {"text": "", "meanings": {}})
        L += ["## %s" % t["logical"], ""]
        if tn["text"]:
            L += [tn["text"], ""]
        if t["description"]:
            L += ["<!-- Dataverse description: %s -->" % t["description"].replace("--", "-"), ""]
        L += ["| Column | Display name | Type | Meaning |", "|---|---|---|---|"]
        for c in t["columns"]:
            if c["type"] in STANDARD_MEANING:
                continue
            L.append("| %s | %s | %s | %s |" % (c["logical"], md_cell(c["display"]), friendly_type(c) + (
                " to " + ", ".join(x["table"] for x in c["targets"]) if c["targets"] else ""), md_cell(curated_meaning(c, tn["meanings"]) or "")))
        for k, v in tn["meanings"].items():
            if "*" in k:
                L.append("| %s | | | %s |" % (k, md_cell(v)))
        L.append("")
    return "\n".join(L)


# --------------------------------------------------------------------------- evaluate

NOTE_TOPICS = [("purpose", r"(?i)\bpurpose\b"), ("owner", r"(?i)\bowner")]


def evaluate(doc, solution_dir=None, min_coverage=0.8, max_age_days=90, today=None):
    """[(level, check, detail)] for a data dictionary's JSON. level: PASS, WARN, FAIL."""
    out = []
    tables = doc.get("tables") or []
    if not tables:
        return [("FAIL", "tables", "the document lists no table")]
    undesc = [t["logical"] for t in tables if not (t.get("description") or t.get("notes"))]
    out.append(("FAIL" if undesc else "PASS", "tables described", ("no purpose: " + ", ".join(undesc[:10])) if undesc else "%d of %d tables have a purpose" % (len(tables), len(tables))))
    cols = [(t["logical"], c) for t in tables for c in t["columns"]]
    covered = [x for x in cols if x[1]["meaning"] or x[1]["meaning_source"] == "self-describing lookup"]
    ratio = len(covered) / float(len(cols)) if cols else 1.0
    missing = ["%s.%s" % (t, c["column"]) for t, c in cols if not (c["meaning"] or c["meaning_source"] == "self-describing lookup")]
    lvl = "FAIL" if ratio < min_coverage else ("WARN" if missing else "PASS")
    out.append((lvl, "column meanings", "%d of %d columns (%.0f%%) have a meaning%s%s" % (
        len(covered), len(cols), 100 * ratio, "; below the %.0f%% floor" % (100 * min_coverage) if lvl == "FAIL" else "",
        ("; first missing: " + ", ".join(missing[:8])) if missing else "")))
    gaps = doc.get("gaps") or []
    choice_gaps = [g for g in gaps if "choice" in g]
    out.append(("FAIL" if choice_gaps else "PASS", "choices labelled", "; ".join(choice_gaps)[:300] if choice_gaps else "every choice has its options and labels"))
    lk = [g for g in gaps if "lookup" in g]
    out.append(("FAIL" if lk else "PASS", "lookups resolved", "; ".join(lk)[:300] if lk else "every lookup names its target table"))
    if solution_dir:
        inputs = doc.get("inputs") or {}
        now = read_solution(solution_dir)["inputs"]
        changed = sorted(k for k, h in inputs.items() if k in now and now[k] != h)
        added = sorted(k for k in now if k not in inputs and k.startswith("Entities/"))
        gone = sorted(k for k in inputs if k not in now)
        bad = changed + ["new: " + k for k in added] + ["removed: " + k for k in gone]
        out.append(("FAIL" if bad else "PASS", "freshness", ("changed since generated: " + ", ".join(b.split("/")[1] if b.startswith("Entities/") else b for b in bad[:12])) if bad else
                    "no table or relationship changed in the solution since generated"))
    gen = doc.get("generated")
    if gen:
        age = ((today or dt.date.today()) - dt.date.fromisoformat(gen[:10])).days
        out.append(("WARN" if age > max_age_days else "PASS", "age", "generated %s (%d days ago)" % (gen[:10], age)))
    live = doc.get("live")
    if not live:
        out.append(("WARN", "drift", "not checked: generated without --env, so the live columns were never compared"))
    else:
        diff = [t["logical"] for t in tables if t.get("live_columns") and t["live_columns"]["state"] != "same"]
        out.append(("FAIL" if diff else "PASS", "drift", ("columns differ live: " + ", ".join(diff)) if diff else "every table matches the live environment"))
    notes = doc.get("notes") or ""
    about = doc.get("about") or ""
    if not notes.strip():
        out.append(("FAIL", "curated notes", "none: purpose and owner are not recorded"))
    else:
        miss = [t for t, rx in NOTE_TOPICS if not re.search(rx, about)]
        out.append(("FAIL" if miss else "PASS", "curated notes", ("missing in the About section: " + ", ".join(miss)) if miss else "purpose and owner recorded"))
    sens = [(t["logical"], t["display"], c["column"], c["display"]) for t in tables for c in t["columns"] if "sensitive" in c["flags"] or "column security" in c["flags"]]
    if sens:
        sp = sensitive_part(about)
        un = ["%s.%s" % (tl, cl) for tl, td, cl, cd in sens
              if not any(x.lower() in sp for x in (tl, td, cl, cd))]
        out.append(("FAIL" if un else "PASS", "sensitive columns", ("not covered by the notes' sensitive-data part: " + ", ".join(un[:10])) if un else
                    "%d flagged, each covered by the notes' sensitive-data part (by column or table)" % len(sens)))
    app = [c for _, c in cols if c.get("custom")]
    dv = sum(1 for c in app if c.get("dataverse_description"))
    if app and dv < len(app) / 2.0:
        out.append(("WARN", "meanings in Dataverse", "%d of %d app columns carry a Dataverse description; the meanings live only in this document, so the maker portal, "
                    "Power BI and Copilot cannot see them" % (dv, len(app))))
    return out


def sensitive_part(about):
    """The lower-cased text of the About section's sensitive-data paragraph or section."""
    parts, on = [], False
    for line in (about or "").split("\n"):
        if re.match(r"^\s*(#+\s*|\*\*)sensitive", line, re.I):
            on = True
        elif on and (re.match(r"^\s*#+\s", line) or re.match(r"^\s*\*\*[A-Z][^*]*\.\*\*", line)):
            on = False
        if on:
            parts.append(line)
    return "\n".join(parts).lower()


# --------------------------------------------------------------------------- commands


def write_outputs(doc, out):
    d = os.path.dirname(os.path.abspath(out))
    os.makedirs(d, exist_ok=True)
    for ext, text in ((".html", to_html(doc)), (".md", to_markdown(doc)), (".csv", to_csv(doc)),
                      (".json", json.dumps(doc, indent=1, ensure_ascii=False))):
        with open(out + ext, "w", encoding="utf-8-sig" if ext == ".csv" else "utf-8", newline="\n") as f:
            f.write(text)


def cmd_doc(a, transport=None):
    sol = read_solution(a.solution, a.tables)
    if not sol["tables"]:
        raise ValueError("no tables found in %s" % a.solution)
    notes = open(a.notes, encoding="utf-8-sig").read() if a.notes else ""
    live = live_read(a.env, a.token_cmd, sol["tables"], transport) if a.env else None
    doc = build_doc(a, sol, notes, a.sensitive or DEFAULT_SENSITIVE, live, dataflow_readers(a.dataflows))
    write_outputs(doc, a.out)
    print(summary_text(doc))
    print("wrote %s.html, .md, .csv, .json" % a.out)
    for g in doc["gaps"]:
        print("gap: " + g)
    return 1 if doc["gaps"] else 0


def cmd_notes(a):
    sol = read_solution(a.solution, a.tables)
    existing = open(a.notes, encoding="utf-8-sig").read() if a.notes and os.path.exists(a.notes) else ""
    text = notes_skeleton(sol, existing)
    with open(a.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print("wrote %s: %d tables" % (a.out, len(sol["tables"])))
    return 0


def cmd_evaluate(a):
    with open(a.doc if a.doc.endswith(".json") else a.doc + ".json", encoding="utf-8") as f:
        doc = json.load(f)
    if a.notes:
        doc["notes"] = open(a.notes, encoding="utf-8-sig").read()
        doc["about"] = parse_notes(doc["notes"], doc["tables"])[0]
    res = evaluate(doc, a.solution, a.min_coverage, a.max_age_days)
    for level, check, detail in res:
        print("%-4s  %-21s %s" % (level, check, detail))
    fails = sum(1 for r in res if r[0] == "FAIL")
    print("%s: %d check(s), %d failing, %d warning" % (doc.get("title") or a.doc, len(res), fails, sum(1 for r in res if r[0] == "WARN")))
    return 1 if fails else 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="datadict.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("command", nargs="?", choices=["doc", "notes", "evaluate"])
    ap.add_argument("--solution")
    ap.add_argument("--out")
    ap.add_argument("--title")
    ap.add_argument("--notes")
    ap.add_argument("--env")
    ap.add_argument("--token-cmd")
    ap.add_argument("--sensitive")
    ap.add_argument("--tables")
    ap.add_argument("--dataflows", action="append")
    ap.add_argument("--doc")
    ap.add_argument("--min-coverage", type=float, default=0.8)
    ap.add_argument("--max-age-days", type=int, default=90)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    try:
        if a.command == "doc" and a.solution and a.out:
            return cmd_doc(a)
        if a.command == "notes" and a.solution and a.out:
            return cmd_notes(a)
        if a.command == "evaluate" and a.doc:
            return cmd_evaluate(a)
    except (OSError, ValueError, ET.ParseError) as e:
        print("cannot run: %s" % e)
        return 2
    ap.print_help()
    return 2


# --------------------------------------------------------------------------- selftest

FIX_ENTITY = """<?xml version="1.0" encoding="utf-8"?>
<Entity><Name LocalizedName="Widget" OriginalName="Widget">tst_Widget</Name><EntityInfo><entity Name="tst_Widget">
<LocalizedNames><LocalizedName description="Widget" languagecode="1033" /></LocalizedNames>
<LocalizedCollectionNames><LocalizedCollectionName description="Widgets" languagecode="1033" /></LocalizedCollectionNames>
<Descriptions><Description description="%s" languagecode="1033" /></Descriptions>
<attributes>
<attribute PhysicalName="tst_WidgetId"><Type>primarykey</Type><LogicalName>tst_widgetid</LogicalName><RequiredLevel>systemrequired</RequiredLevel><IsCustomField>0</IsCustomField><displaynames><displayname description="Widget" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="tst_Name"><Type>nvarchar</Type><LogicalName>tst_name</LogicalName><RequiredLevel>required</RequiredLevel><DisplayMask>PrimaryName|ValidForGrid</DisplayMask><IsCustomField>1</IsCustomField><Format>text</Format><MaxLength>100</MaxLength><displaynames><displayname description="Name" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="tst_Kind"><Type>picklist</Type><LogicalName>tst_kind</LogicalName><RequiredLevel>none</RequiredLevel><IsCustomField>1</IsCustomField><AppDefaultValue>2</AppDefaultValue>
<optionset Name="tst_widget_tst_kind"><OptionSetType>picklist</OptionSetType><options>
<option value="1"><labels><label description="Small" languagecode="1033" /></labels></option>
<option value="2"><labels><label description="Large" languagecode="1033" /></labels></option></options></optionset>
<displaynames><displayname description="Kind" languagecode="1033" /></displaynames><Descriptions><Description description="Size class of the widget." languagecode="1033" /></Descriptions></attribute>
<attribute PhysicalName="tst_HourlyRate"><Type>money</Type><LogicalName>tst_hourlyrate</LogicalName><IsCustomField>1</IsCustomField><Accuracy>2</Accuracy><displaynames><displayname description="Hourly Rate" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="tst_HourlyRate_Base"><Type>money</Type><LogicalName>tst_hourlyrate_base</LogicalName><IsCustomField>1</IsCustomField><CalculationOf>tst_hourlyrate</CalculationOf><displaynames><displayname description="Hourly Rate (Base)" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="tst_CostCenter"><Type>nvarchar</Type><LogicalName>tst_costcenter</LogicalName><IsCustomField>1</IsCustomField><displaynames><displayname description="Cost Center" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="tst_Month1"><Type>money</Type><LogicalName>tst_month1</LogicalName><IsCustomField>1</IsCustomField><displaynames><displayname description="Month 1" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="tst_Month2"><Type>money</Type><LogicalName>tst_month2</LogicalName><IsCustomField>1</IsCustomField><displaynames><displayname description="Month 2" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="tst_Parent"><Type>lookup</Type><LogicalName>tst_parent</LogicalName><IsCustomField>1</IsCustomField><displaynames><displayname description="Gadget" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="tst_Owner2"><Type>lookup</Type><LogicalName>tst_owner2</LogicalName><IsCustomField>1</IsCustomField><displaynames><displayname description="Backup" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="tst_Code"><Type>nvarchar</Type><LogicalName>tst_code</LogicalName><IsCustomField>1</IsCustomField><MaxLength>20</MaxLength><displaynames><displayname description="Code" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="CreatedOn"><Type>datetime</Type><LogicalName>createdon</LogicalName><IsCustomField>0</IsCustomField><displaynames><displayname description="Created On" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="statecode"><Type>state</Type><LogicalName>statecode</LogicalName><IsCustomField>0</IsCustomField><optionset Name="s"><states>
<state value="0"><labels><label description="Active" languagecode="1033" /></labels></state><state value="1"><labels><label description="Inactive" languagecode="1033" /></labels></state></states></optionset>
<displaynames><displayname description="Status" languagecode="1033" /></displaynames></attribute>
</attributes>
<EntityKeys><EntityKey><Name>tst_Widget_Code</Name><EntityKeyAttributes><AttributeName>tst_code</AttributeName></EntityKeyAttributes><displaynames><displayname description="Code" languagecode="1033" /></displaynames></EntityKey></EntityKeys>
<EntitySetName>tst_widgets</EntitySetName><OwnershipTypeMask>OrgOwned</OwnershipTypeMask><IsAuditEnabled>1</IsAuditEnabled>
</entity></EntityInfo></Entity>"""

FIX_GADGET = """<?xml version="1.0" encoding="utf-8"?>
<Entity><Name LocalizedName="Gadget">tst_Gadget</Name><EntityInfo><entity Name="tst_Gadget">
<LocalizedNames><LocalizedName description="Gadget" languagecode="1033" /></LocalizedNames><Descriptions><Description description="" languagecode="1033" /></Descriptions>
<attributes><attribute PhysicalName="tst_GadgetId"><Type>primarykey</Type><LogicalName>tst_gadgetid</LogicalName><IsCustomField>0</IsCustomField><displaynames><displayname description="Gadget" languagecode="1033" /></displaynames></attribute>
<attribute PhysicalName="tst_Label"><Type>nvarchar</Type><LogicalName>tst_label</LogicalName><DisplayMask>PrimaryName</DisplayMask><IsCustomField>1</IsCustomField><displaynames><displayname description="Label" languagecode="1033" /></displaynames></attribute>
</attributes><EntitySetName>tst_gadgets</EntitySetName><OwnershipTypeMask>UserOwned</OwnershipTypeMask></entity></EntityInfo></Entity>"""

FIX_REL = """<?xml version="1.0" encoding="utf-8"?>
<EntityRelationships><EntityRelationship Name="tst_widget_parent"><EntityRelationshipType>OneToMany</EntityRelationshipType>
<ReferencingEntityName>tst_Widget</ReferencingEntityName><ReferencedEntityName>tst_Gadget</ReferencedEntityName><CascadeDelete>Restrict</CascadeDelete>
<ReferencingAttributeName>tst_Parent</ReferencingAttributeName></EntityRelationship></EntityRelationships>"""

FIX_NOTES = """**Purpose.** Test widgets. **Owner.** The test team.

**Sensitive data.** `Hourly Rate` is a pay rate (decision T1).

**Consumers.** None.

## tst_widget

Widgets are counted weekly.

| Column | Meaning |
|---|---|
| tst_name | The widget's name. |
| Cost Center | The cost centre charged. |
| tst_month* | Spend in that month of the plan. |

| Column | Meaning | Sensitive |
|---|---|---|
| tst_code | The widget's code. | yes |
"""


def selftest():
    import shutil
    import tempfile
    ok = fails = 0

    def check(name, cond, detail=""):
        nonlocal ok, fails
        if cond:
            ok += 1
        else:
            fails += 1
            print("FAIL %s %s" % (name, detail))

    tmp = tempfile.mkdtemp()
    try:
        src = os.path.join(tmp, "src")
        os.makedirs(os.path.join(src, "Entities", "tst_Widget"))
        os.makedirs(os.path.join(src, "Entities", "tst_Gadget"))
        os.makedirs(os.path.join(src, "Other", "Relationships"))
        open(os.path.join(src, "Entities", "tst_Widget", "Entity.xml"), "w", encoding="utf-8").write(FIX_ENTITY % "Things we make.")
        open(os.path.join(src, "Entities", "tst_Gadget", "Entity.xml"), "w", encoding="utf-8").write(FIX_GADGET)
        open(os.path.join(src, "Other", "Relationships", "tst_Widget.xml"), "w", encoding="utf-8").write(FIX_REL)
        open(os.path.join(src, "Other", "Solution.xml"), "w", encoding="utf-8").write(
            "<ImportExportXml><SolutionManifest><UniqueName>TestSol</UniqueName><Version>1.2.0.0</Version></SolutionManifest></ImportExportXml>")
        sol = read_solution(tmp)
        check("root found from the parent", sol["root"] == src)
        check("solution name and version", (sol["unique_name"], sol["version"]) == ("TestSol", "1.2.0.0"))
        w = next(t for t in sol["tables"] if t["logical"] == "tst_widget")
        names = [c["logical"] for c in w["columns"]]
        check("base-currency copy dropped", "tst_hourlyrate_base" not in names, names)
        check("standard columns listed once, not per table", "createdon" in w["standard"] and "createdon" not in names)
        check("primary key and status kept", "tst_widgetid" in names and "statecode" in names)
        check("primary name found", w["primary_name"] == "tst_name")
        check("alternate key", w["keys"] == [{"name": "Code", "columns": ["tst_code"]}], w["keys"])
        parent = next(c for c in w["columns"] if c["logical"] == "tst_parent")
        check("lookup target from relationships", parent["targets"] and parent["targets"][0]["table"] == "tst_gadget" and parent["targets"][0]["delete"] == "Restrict")
        a = argparse.Namespace(title=None)
        doc = build_doc(a, sol, FIX_NOTES, DEFAULT_SENSITIVE)
        dw = next(t for t in doc["tables"] if t["logical"] == "tst_widget")
        col = {c["column"]: c for c in dw["columns"]}
        check("curated meaning by logical name", col["tst_name"]["meaning"] == "The widget's name." and col["tst_name"]["meaning_source"] == "curated")
        check("curated meaning by display name", col["tst_costcenter"]["meaning"] == "The cost centre charged.")
        check("wildcard meaning for repeated columns", col["tst_month1"]["meaning"] == col["tst_month2"]["meaning"] == "Spend in that month of the plan.")
        check("Dataverse description used when not curated", col["tst_kind"]["meaning_source"] == "dataverse")
        check("standard meaning for the primary key", col["tst_widgetid"]["meaning_source"] == "standard")
        check("choice labels with values and default", col["tst_kind"]["values"] == ["Small (1)", "Large (2)"] and col["tst_kind"]["default"] == "2")
        check("lookup named after its target is self-describing", col["tst_parent"]["meaning_source"] == "self-describing lookup")
        check("sensitive by whole word: Hourly Rate yes, Cost Center no",
              "sensitive" in col["tst_hourlyrate"]["flags"] and "sensitive" not in col["tst_costcenter"]["flags"])
        check("notes mark a column sensitive", "sensitive" in col["tst_code"]["flags"] and col["tst_code"]["meaning"] == "The widget's code.")
        check("table notes kept without the meanings table", dw["notes"] == "Widgets are counted weekly.", dw["notes"])
        check("about excludes table sections", "Widgets are counted" not in doc["about"] and "Purpose" in doc["about"])
        check("gap: lookup with no relationship", any("tst_owner2" in g for g in doc["gaps"]), doc["gaps"])
        check("gap: table with no description", any(g.startswith("tst_gadget:") for g in doc["gaps"]))
        h = to_html(doc)
        check("html has filter, table anchors and no unescaped notes", "id='q'" in h and "id='t-tst-widget'" in h and "<script>" in h)
        check("csv one row per column plus header", to_csv(doc).count("\n") == sum(len(t["columns"]) for t in doc["tables"]) + 1)
        res = {c: (l, d) for l, c, d in evaluate(doc, tmp, 0.8, 90, dt.date.today())}
        check("evaluate: undescribed table fails", res["tables described"][0] == "FAIL")
        check("evaluate: lookup gap fails", res["lookups resolved"][0] == "FAIL")
        check("evaluate: sensitive column covered by notes", res["sensitive columns"][0] == "FAIL" and "tst_code" in res["sensitive columns"][1] and "tst_hourlyrate" not in res["sensitive columns"][1], res["sensitive columns"])
        check("evaluate: fresh", res["freshness"][0] == "PASS", res["freshness"])
        check("evaluate: drift not checked warns", res["drift"][0] == "WARN")
        open(os.path.join(src, "Entities", "tst_Widget", "Entity.xml"), "w", encoding="utf-8").write(FIX_ENTITY % "Things we make, changed.")
        res2 = {c: (l, d) for l, c, d in evaluate(doc, tmp, 0.8, 90, dt.date.today())}
        check("evaluate: changed table fails freshness", res2["freshness"][0] == "FAIL" and "tst_Widget" in res2["freshness"][1], res2["freshness"])
        doc2 = build_doc(a, sol, FIX_NOTES.replace("`Hourly Rate` is a pay rate", "Nothing"), DEFAULT_SENSITIVE)
        res3 = {c: (l, d) for l, c, d in evaluate(doc2, None, 0.99, 90, dt.date.today())}
        check("evaluate: unexplained sensitive column fails", res3["sensitive columns"][0] == "FAIL")
        check("evaluate: coverage below the floor fails", res3["column meanings"][0] == "FAIL", res3["column meanings"])
        os.makedirs(os.path.join(tmp, "df", "DF_BRONZE_X"))
        open(os.path.join(tmp, "df", "DF_BRONZE_X", "mashup.pq"), "w", encoding="utf-8").write(
            'section Section1;\nshared W = let Source = CommonDataService.Database("org"), T = Source{[Schema = "dbo", Item = "tst_widget"]}[Data] in T;')
        rd = dataflow_readers([os.path.join(tmp, "df")])
        dr = build_doc(a, sol, FIX_NOTES, DEFAULT_SENSITIVE, None, rd)
        check("dataflow readers named per table", next(t for t in dr["tables"] if t["logical"] == "tst_widget")["read_by"] == ["DF_BRONZE_X"], rd)
        sk = notes_skeleton(sol, FIX_NOTES)
        check("skeleton keeps curated meanings and wildcards", "| tst_name | Name | Text 100 | The widget's name. |" in sk and "| tst_month* |" in sk and "## tst_gadget" in sk)
        about, tn = parse_notes(sk, sol["tables"])
        check("skeleton hint comments are dropped", "<!--" not in tn["tst_widget"]["text"] and "<!--" not in about)
        check("skeleton parses back", tn["tst_widget"]["meanings"].get("tst_name") == "The widget's name.")

        pp = load_ppapi()
        ft = pp.FakeTransport()
        ft.on("GET", "EntityDefinitions(LogicalName='tst_widget')", lambda *x: {"value": [
            {"LogicalName": n, "IsCustomAttribute": True} for n in ["tst_name", "tst_kind", "tst_hourlyrate", "tst_costcenter", "tst_month1", "tst_month2", "tst_parent", "tst_owner2", "tst_code", "tst_extra"]]})
        ft.on("GET", "EntityDefinitions(LogicalName='tst_gadget')", lambda *x: {"value": [{"LogicalName": "tst_label", "IsCustomAttribute": True}]})
        ft.on("GET", "RetrieveTotalRecordCount", lambda *x: {"EntityRecordCountCollection": {"Keys": ["tst_gadget", "tst_widget"], "Values": [3, 12]}})
        live = live_read("https://example.crm.dynamics.com", None, sol["tables"], ft)
        check("live is read-only", not ft.writes())
        doc3 = build_doc(a, sol, FIX_NOTES, DEFAULT_SENSITIVE, live)
        t3 = {t["logical"]: t for t in doc3["tables"]}
        check("live drift: a column only live", t3["tst_widget"]["live_columns"]["only_live"] == ["tst_extra"], t3["tst_widget"]["live_columns"])
        check("live row counts", t3["tst_widget"]["rows"] == 12 and t3["tst_gadget"]["live_columns"]["state"] == "same")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("datadict.py selftest: %d passed, %d failed" % (ok, fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
