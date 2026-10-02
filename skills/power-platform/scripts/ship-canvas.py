#!/usr/bin/env python3
"""ship-canvas.py - build an importable canvas-app solution on the LIVE manifest, and prove it.

The Path A ship from references/canvas-shipping.md: build the .msapp from the repo's Src/ on top
of the LIVE app's manifest (never the repo's stale .msapr), reconcile the manifest caches the
published player reads (option-set members in both caches, entity set names everywhere, lookup
navigation names), stamp the build, swap it into a solution exported from the ENVIRONMENT, strip
security roles, repair <DatabaseReferences>, then assert on the FINISHED zip - never on an exit code.

It never imports or publishes unless --import is passed.

Usage:
    python ship-canvas.py --dry-run                       # print every step; write nothing
    python ship-canvas.py --markers BtnNewThing           # build and assert; no import
    python ship-canvas.py --markers BtnNewThing --import  # ... then import (rollback export first)

Options:
    --config PATH          identity config (default: scripts/canvas-app.json)
    --repo DIR             repo root for relative config paths (default: the folder above
                           scripts/ when the config lives there, else the current directory)
    --live PATH            live baseline instead of downloading: a solution zip from
                           `pac solution export` (its .msapp is used too) or a .msapp from
                           `pac canvas download`; repeat to give both
    --markers A,B          strings that must be in the half of the app that RUNS
    --absent A,B           strings that must NOT be there
    --offline DUMP         reconcile from a check-drift.py --dump file instead of the Web API
    --org / --token-cmd / --token-env   as check-drift.py (read-only GETs)
    --allow-missing-tables do not refuse when a bound table is not in the solution's entities
    --allow-shared-schema  do not refuse when an externalTables table ships with its subcomponents
    --accept-drift         do not refuse on drift no build step can repair (columns the formulas use
                           that the cache lacks, column types, status/state/yes-no members)
    --no-bump              keep the solution version (default: bump the last segment)
    --dry-run              print every step and its command; write nothing; run no pac command
    --import               import the finished zip (after `pac org who` and a rollback export)
    --publish              with --import, pass --publish-changes
    --selftest             run the built-in tests with a simulated pac, and exit

Config keys (scripts/canvas-app.json; see assets/canvas-app.example.json): environmentUrl,
environmentId, appId, solutionUniqueName, canvasSrc, and optionally appLogicalName,
externalTables (glob patterns for bound tables another solution owns by design),
buildStampVariable (gblBuild), buildStampPlaceholder (unshipped), outDir (out), workDir
(.ship-work), maxScreenFiles (50), bumpVersion (true).

Exit: 0 built (and imported, if asked); 1 refused - a guard fired and nothing importable was
left behind; 2 could not run (config, pac, inputs, or live metadata unavailable).
"""
import argparse
import codecs
import copy
import datetime
import fnmatch
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import zipfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_drift():
    sys.dont_write_bytecode = True           # a dry run writes nothing, not even __pycache__
    spec = importlib.util.spec_from_file_location("check_drift", os.path.join(HERE, "check-drift.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


drift = _load_drift()
norm = drift.norm


class Refuse(Exception):
    """A guard fired: the artifact would be wrong. Exit 1."""


class CannotRun(Exception):
    """An input or a tool is missing. Exit 2."""


DEFAULTS = {"buildStampVariable": "gblBuild", "buildStampPlaceholder": "unshipped", "outDir": "out",
            "workDir": ".ship-work", "maxScreenFiles": 50, "bumpVersion": True}


# --------------------------------------------------------------------------- plumbing

class Pac:
    """Runs pac. In dry-run it only prints. Output is captured as bytes and decoded as UTF-8, so a
    non-Latin-1 label cannot fail the run for a reason that names an encoding."""

    def __init__(self, dry, exe=None):
        self.dry = dry
        self.exe = exe
        self.calls = []

    def __call__(self, *args):
        shown = "pac " + " ".join('"%s"' % a if " " in a else a for a in args)
        if self.dry:
            print("    would run: " + shown)
            return ""
        print("    $ " + shown, flush=True)
        exe = self.exe or shutil.which("pac")
        if not exe:
            raise CannotRun("pac is not on PATH (install the Power Platform CLI)")
        self.calls.append(list(args))
        r = subprocess.run([exe] + list(args), capture_output=True)
        out = r.stdout.decode("utf-8", "replace")
        if r.returncode != 0:
            sys.stdout.write(out[-3000:] + r.stderr.decode("utf-8", "replace")[-2000:])
            raise Refuse("pac %s failed (exit %d) - nothing after this step ran" % (args[0] + " " + args[1], r.returncode))
        return out


def rmtree_strict(path):
    """Remove a tree, clearing read-only bits (cloud-synced folders), and REFUSE if it survives:
    a staging copy that does not start empty ships files deleted from the repo."""
    if not os.path.exists(path):
        return

    def handler(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass

    for _ in range(5):
        try:
            if sys.version_info >= (3, 12):
                shutil.rmtree(path, onexc=handler)
            else:
                shutil.rmtree(path, onerror=handler)
        except OSError:
            pass
        if not os.path.exists(path):
            return
        time.sleep(1)
    raise CannotRun("could not empty %s - close whatever holds it open; refusing to build on a stale copy" % path)


def read_entries(path_or_bytes):
    zf = zipfile.ZipFile(io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else path_or_bytes)
    try:
        return [(i, zf.read(i.filename)) for i in zf.infolist()]
    finally:
        zf.close()


def write_entries(path, items):
    """Rewrite an archive: every entry under its original name and info, replaced data only where
    given. Written to a temp name, then moved, so a failure cannot leave half a zip."""
    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for info, data in items:
            z.writestr(info, data)
    os.replace(tmp, path)


def bom_decode(raw):
    return raw.startswith(codecs.BOM_UTF8), raw.decode("utf-8-sig")


def bom_encode(had_bom, text):
    return (codecs.BOM_UTF8 if had_bom else b"") + text.encode("utf-8")


def compact(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


# --------------------------------------------------------------------------- reconcilers

def _set_label(option, text):
    lab = option.setdefault("Label", {})
    loc = lab.get("LocalizedLabels")
    if isinstance(loc, list) and loc:
        for l in loc:
            if isinstance(l, dict):
                l["Label"] = text
                l["MetadataId"] = None
    else:
        lab["LocalizedLabels"] = [{"Label": text, "LanguageCode": 1033, "IsManaged": False,
                                   "MetadataId": None, "HasChanged": None}]
    ul = lab.get("UserLocalizedLabel")
    if isinstance(ul, dict):
        ul["Label"] = text
        ul["MetadataId"] = None
    else:
        lab["UserLocalizedLabel"] = {"Label": text, "LanguageCode": 1033, "IsManaged": False,
                                     "MetadataId": None, "HasChanged": None}


def reconcile_optionsets(doc, live):
    """Add and relabel Picklist / MultiSelectPicklist members in BOTH caches. Never removes a member
    and never touches a set it could not verify. Returns (changes, unverified)."""
    sources = doc.get("DataSources", []) if isinstance(doc, dict) else doc
    by_name = {e.get("Name"): e.get("LogicalName") for e in sources if e.get("Type") == "NativeCDSDataSourceInfo"}
    changes, unverified = [], []

    def live_choice(table, column):
        t = (live["tables"].get(table) or {})
        ch = (t.get("choices") or {}).get(column) if not t.get("missing") else None
        return ch["options"] if ch and ch.get("options") else None

    for e in sources:                                   # cache 1: OptionSetInfo
        if e.get("Type") != "OptionSetInfo":
            continue
        kind = drift.TYPEKEY_KIND.get(e.get("OptionSetTypeKey"))
        if kind not in drift.RECONCILABLE_CHOICES:
            continue
        want = live_choice(by_name.get(e.get("RelatedEntityName")), e.get("RelatedColumnInvariantName"))
        if not want:
            unverified.append(e.get("Name"))
            continue
        have = e.get("OptionSetInfoNameMapping")
        if not isinstance(have, dict):
            unverified.append(e.get("Name"))
            continue
        for v, lab in sorted(want.items(), key=lambda x: (len(x[0]), x[0])):
            if have.get(v) != lab:
                changes.append('cache 1 %s: %s %s "%s"' % (e.get("Name"), "relabelled" if v in have else "added", v, lab))
                have[v] = lab

    for e in sources:                                   # cache 2: TableDefinition
        if e.get("Type") != "NativeCDSDataSourceInfo":
            continue
        td = drift.jload(e.get("TableDefinition"))
        if not isinstance(td, dict):
            continue
        td_changed = False
        for kind in drift.RECONCILABLE_CHOICES:
            bucket = drift.CHOICE_BUCKETS[kind]
            env = drift.jload(td.get(bucket))
            if not isinstance(env, dict):
                continue
            env_changed = False
            for attr in env.get("value") or []:
                opts = (attr.get("OptionSet") or {}).get("Options")
                if not isinstance(opts, list) or not opts:
                    continue
                want = live_choice(e.get("LogicalName"), attr.get("LogicalName"))
                if not want:
                    continue
                have = {str(o.get("Value")): o for o in opts if isinstance(o, dict)}
                for v, lab in sorted(want.items(), key=lambda x: (len(x[0]), x[0])):
                    if v in have:
                        if drift.label_of(have[v].get("Label")) != lab:
                            _set_label(have[v], lab)
                            env_changed = True
                            changes.append('cache 2 %s.%s: relabelled %s "%s"' % (e.get("LogicalName"), attr.get("LogicalName"), v, lab))
                        continue
                    new = copy.deepcopy(opts[0])        # clone the producer's own shape
                    new["Value"] = int(v)
                    new["MetadataId"] = None
                    _set_label(new, lab)
                    opts.append(new)
                    env_changed = True
                    changes.append('cache 2 %s.%s: added %s "%s"' % (e.get("LogicalName"), attr.get("LogicalName"), v, lab))
            if env_changed:
                td[bucket] = compact(env)
                td_changed = True
        if td_changed:
            e["TableDefinition"] = compact(td)
    return changes, unverified


def reconcile_navprops(doc, live):
    """Rewrite ReferencingEntityNavigationPropertyName and the lookup attribute's SchemaName where
    cached differs from live - matched on the attribute's logical name, which never changes. Not a
    text replace: the same token appears in fields that must stay as they are."""
    sources = doc.get("DataSources", []) if isinstance(doc, dict) else doc
    changes = []
    for e in sources:
        if e.get("Type") != "NativeCDSDataSourceInfo":
            continue
        lt = live["tables"].get(e.get("LogicalName"))
        if not lt or lt.get("missing"):
            continue
        td = drift.jload(e.get("TableDefinition"))
        em = drift.jload(td.get("EntityMetadata")) if isinstance(td, dict) else None
        if not isinstance(em, dict):
            continue
        live_lk = {}
        for r in lt.get("lookups") or []:
            live_lk.setdefault((r["attr"], r.get("target")), r)
        changed = False
        for rel in em.get("ManyToOneRelationships") or []:
            a = rel.get("ReferencingAttribute")
            if not a or a in drift.SYSTEM_ATTRS:
                continue
            lr = live_lk.get((a, rel.get("ReferencedEntity")))
            want = lr and lr.get("nav")
            if want and rel.get("ReferencingEntityNavigationPropertyName") != want:
                changes.append("%s.%s navigation %r -> %r" % (e["LogicalName"], a, rel.get("ReferencingEntityNavigationPropertyName"), want))
                rel["ReferencingEntityNavigationPropertyName"] = want
                changed = True
        live_attrs = lt.get("attributes") or {}
        for at in em.get("Attributes") or []:
            ln = at.get("LogicalName")
            if not ln or ln in drift.SYSTEM_ATTRS or at.get("AttributeType") not in drift.LOOKUP_TYPES:
                continue
            want = (live_attrs.get(ln) or {}).get("schema")
            if want and at.get("SchemaName") != want:
                changes.append("%s.%s schema name %r -> %r" % (e["LogicalName"], ln, at.get("SchemaName"), want))
                at["SchemaName"] = want
                changed = True
        if changed:
            td["EntityMetadata"] = compact(em)
            e["TableDefinition"] = compact(td)
    return changes


def token_pattern(name):
    return re.compile(rb"(?<![A-Za-z0-9_])" + re.escape(name.encode()) + rb"(?![A-Za-z0-9_])")


def stale_entity_sets(pkg, live):
    """{stale name: live name} across DataSources.json, TableDefinition and Properties.json."""
    ldr = pkg.local_db_refs()
    out = {}
    for s in pkg.sources():
        lt = live["tables"].get(s["logical"]) or {}
        want = lt.get("set") or live["entity_sets"].get(s["logical"])
        if not want or lt.get("missing"):
            continue
        for have in (s["set"], s["td_set"], (ldr.get(s["name"]) or {}).get("entitySetName")):
            if have and have != want:
                out[have] = want
    return out


def reconcile_entitysets(items, fixes, live, skip_prefixes=("Src/", "Controls/")):
    """Bounded token replace of each stale set name in EVERY manifest entry (it is cached in at least
    three places). Refuses when the stale name is ambiguous. Returns (items, {name: {entry: n}})."""
    live_sets = set(v for v in live["entity_sets"].values() if v)
    for old in fixes:
        clash = sorted(n for n in live_sets if n != old and n.startswith(old))
        if clash or old in live_sets:
            raise Refuse("stale entity set name %r is %s, so a token replace could corrupt another table's "
                         "name - fix this one by hand (remove and re-add the source in Studio)"
                         % (old, "a live set name of another table" if old in live_sets else
                            "a prefix of live set name(s) " + ", ".join(clash[:3])))
    counts, out = {}, []
    for info, data in items:
        if not any(norm(info.filename).startswith(p) or ("/" + p) in norm(info.filename) for p in skip_prefixes):
            for old, new in fixes.items():
                data, n = token_pattern(old).subn(new.encode(), data)
                if n:
                    counts.setdefault(old, {})[info.filename] = n
        out.append((info, data))
    return out, counts


def reconcile_package(items, live):
    """Run all three reconcilers over an app package's entries. Returns (new items, report)."""
    entries = {i.filename: d for i, d in items}
    pkg = drift.AppPackage("baseline", entries)
    doc = pkg.doc
    report = {}
    report["optionsets"], report["optionsets_unverified"] = reconcile_optionsets(doc, live)
    report["navprops"] = reconcile_navprops(doc, live)
    if report["optionsets"] or report["navprops"]:
        items = [(i, (json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8") if i.filename == pkg.ds_key else d))
                 for i, d in items]
        pkg = drift.AppPackage("baseline", {i.filename: d for i, d in items})
    fixes = stale_entity_sets(pkg, live)
    report["entitysets"] = fixes
    if fixes:
        items, report["entityset_counts"] = reconcile_entitysets(items, fixes, live)
    return items, report


def print_reconcile(report):
    print("    option sets  : %d change(s); %d set(s) could not be verified and were left exactly as they were"
          % (len(report["optionsets"]), len(report["optionsets_unverified"])))
    for c in report["optionsets"][:15]:
        print("      " + c)
    if len(report["optionsets"]) > 15:
        print("      ... and %d more" % (len(report["optionsets"]) - 15))
    print("    lookup names : %d change(s)" % len(report["navprops"]))
    for c in report["navprops"]:
        print("      " + c)
    print("    entity sets  : %d stale name(s)" % len(report["entitysets"]))
    for old, new in report["entitysets"].items():
        where = report.get("entityset_counts", {}).get(old, {})
        print("      %s -> %s  (%s)" % (old, new, ", ".join("%s x%d" % (k, n) for k, n in where.items()) or "planned"))


# --------------------------------------------------------------------------- stamp

def stamp_value(repo, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    sha = "nogit"
    try:
        r = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=repo, capture_output=True)
        if r.returncode == 0 and r.stdout.strip():
            sha = r.stdout.decode().strip()
            d = subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True)
            if d.returncode == 0 and d.stdout.strip():
                sha += "+"
    except OSError:
        pass
    return "%s %s" % (now.strftime("%Y-%m-%d %H:%MZ"), sha)


def stamp_regex(var, placeholder):
    return re.compile(r'(Set\(\s*%s\s*,\s*")%s("\s*\))' % (re.escape(var), re.escape(placeholder)))


def apply_stamp(text, var, placeholder, value):
    new, n = stamp_regex(var, placeholder).subn(lambda m: m.group(1) + value + m.group(2), text)
    if n == 0:
        raise Refuse('App.pa.yaml has no Set(%s, "%s") placeholder - the build stamp would ship unset, '
                     'and then no one can tell which package a browser is running. Restore the line.'
                     % (var, placeholder))
    return new, n


# --------------------------------------------------------------------------- solution surgery

def strip_roles(sol_xml, cus_xml):
    """Drop Role root components and every <Role> definition. Returns (sol, cus, roots, roles)."""
    sol_out, n1 = re.subn(r'[ \t]*<RootComponent\s+type="20"[^>]*/>[ \t]*\r?\n?', "", sol_xml)
    n2 = sum(len(re.findall(r"<Role\b", m.group(0))) for m in re.finditer(r"<Roles>.*?</Roles>", cus_xml, re.S))
    cus_out = re.sub(r"<Roles>.*?</Roles>", "<Roles />", cus_xml, flags=re.S) if n2 else cus_xml
    return sol_out, cus_out, n1, n2


def bump_version(sol_xml):
    m = re.search(r"<Version>(\d+(?:\.\d+)*)</Version>", sol_xml)
    if not m:
        return sol_xml, None, None
    parts = m.group(1).split(".")
    parts[-1] = str(int(parts[-1]) + 1)
    new = ".".join(parts)
    return sol_xml[:m.start(1)] + new + sol_xml[m.end(1):], m.group(1), new


def repair_dbrefs(xml, app_name, bound):
    """Rewrite <DatabaseReferences> dataSources and <CdsDependencies> for one app to match what the
    app binds - by name AND by value. Keeps the existing order, appends new sources.
    Returns (xml, missing, extra, stale)."""
    s, e = drift.canvas_block(xml, app_name)
    block = xml[s:e]
    m = re.search(r"<DatabaseReferences>(.*?)</DatabaseReferences>", block, re.S)
    if not m:
        raise Refuse("no <DatabaseReferences> for %s - cannot make the player list match the app" % app_name)
    body, escaped = drift.xml_json(m.group(1))
    body = body or {}
    cds = body.setdefault("default.cds", {})
    have = dict(cds.get("dataSources") or {})
    missing = sorted(n for n in bound if n not in have)
    extra = sorted(n for n in have if n not in bound)
    stale = sorted(n for n in bound if n in have and have[n] != bound[n])
    if not (missing or extra or stale):
        return xml, missing, extra, stale
    fresh = {}
    for n in have:
        if n in bound:
            fresh[n] = bound[n]
    for n in bound:
        fresh.setdefault(n, bound[n])
    cds["dataSources"] = fresh
    logicals = []
    for v in fresh.values():
        if v.get("logicalName") and v["logicalName"] not in logicals:
            logicals.append(v["logicalName"])
    deps = {"cdsdependencies": [{"componenttype": 1, "logicalname": l} for l in logicals]}

    def enc(obj):
        t = compact(obj)
        return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;") if escaped else t

    block = re.sub(r"<DatabaseReferences>.*?</DatabaseReferences>",
                   lambda _: "<DatabaseReferences>%s</DatabaseReferences>" % enc(body), block, count=1, flags=re.S)
    block = re.sub(r"<CdsDependencies>.*?</CdsDependencies>",
                   lambda _: "<CdsDependencies>%s</CdsDependencies>" % enc(deps), block, count=1, flags=re.S)
    return xml[:s] + block + xml[e:], missing, extra, stale


def bound_sources(msapp_bytes):
    pkg = drift.AppPackage("app", drift.read_zip(msapp_bytes))
    return {s["name"]: {"entitySetName": s["set"], "logicalName": s["logical"]} for s in pkg.sources()}, pkg


def root_entities(sol_xml):
    return [n.lower() for n in re.findall(r'<RootComponent\s+type="1"\s+schemaName="([^"]+)"', sol_xml)]


def pick_app(names, cfg):
    apps = [n for n in names if n.lower().endswith(".msapp") and norm(n).startswith("CanvasApps/")]
    want = cfg.get("appLogicalName")
    if want:
        hit = [n for n in apps if drift.app_name_from_path(n) == want]
        if len(hit) != 1:
            raise Refuse("the solution has no canvas app named %s (has: %s)" % (want, [drift.app_name_from_path(a) for a in apps]))
        return hit[0]
    if len(apps) != 1:
        raise Refuse("the solution holds %d canvas apps; set appLogicalName in the config to say which one "
                     "this ship replaces" % len(apps))
    return apps[0]


def build_solution(export_items, msapp_bytes, cfg, opts, log=print):
    """Swap the app into the exported solution, strip roles, repair the player list, bump the
    version, and gate bound tables. Returns (items, facts) - nothing is written here."""
    names = [i.filename for i, _ in export_items]
    data = {i.filename: d for i, d in export_items}
    if "solution.xml" not in data or "customizations.xml" not in data:
        raise CannotRun("the live solution export has no solution.xml / customizations.xml")
    doc = pick_app(names, cfg)
    app = drift.app_name_from_path(doc)
    sol_bom, sol = bom_decode(data["solution.xml"])
    cus_bom, cus = bom_decode(data["customizations.xml"])
    facts = {"app": app, "doc": doc,
             "entities_before": len(re.findall(r'<RootComponent\s+type="1"', sol)),
             "apps_before": len(re.findall(r'<RootComponent\s+type="300"', sol))}
    sol, cus, n_roots, n_blocks = strip_roles(sol, cus)
    log("    security roles: stripped %d root component(s) and %d role definition(s)" % (n_roots, n_blocks))
    if opts.get("bump", True):
        sol, old, new = bump_version(sol)
        log("    version       : %s -> %s" % (old, new) if old else "    version       : no <Version> found - not bumped")

    bound, _ = bound_sources(msapp_bytes)
    meta = drift.canvas_meta_location(names, app)
    if meta == "customizations.xml":
        cus, missing, extra, stale = repair_dbrefs(cus, app, bound)
    else:
        mb, mx = bom_decode(data[meta])
        mx, missing, extra, stale = repair_dbrefs(mx, app, bound)
        data[meta] = bom_encode(mb, mx)
    log("    player list   : app binds %d Dataverse source(s); <DatabaseReferences> in %s: %s" % (
        len(bound), meta, "already in step" if not (missing or extra or stale) else
        "added %s; removed %s; corrected by value %s" % (missing or "none", extra or "none", stale or "none")))

    ents = set(root_entities(sol))
    outside = sorted(set(v["logicalName"].lower() for v in bound.values()) - ents)
    patterns = [p.lower() for p in cfg.get("externalTables") or []]
    by_design = [t for t in outside if any(fnmatch.fnmatchcase(t, p) for p in patterns)]
    not_in = [t for t in outside if t not in by_design]
    required = set(n.lower() for n in re.findall(r'<Required\s+type="1"\s+schemaName="([^"]+)"', sol))
    facts["tables_not_in_solution"] = not_in
    if by_design:
        undeclared = [t for t in by_design if t not in required]
        log("    tables gate   : %d bound table(s) owned elsewhere by design (externalTables): %s%s" % (
            len(by_design), ", ".join(by_design[:12]),
            "; NOT declared as required dependencies: " + ", ".join(undeclared) if undeclared else
            "; all declared as required dependencies by the export"))
    if not_in:
        declared = [t for t in not_in if t in required]
        msg = ("%d bound table(s) are not entities of the solution: %s - an import can leave those sources "
               "unresolved. Add them to the solution (another solution's tables as references), or, if another "
               "solution in the target environment owns them by design, list them in externalTables%s" % (
                   len(not_in), ", ".join(not_in[:12]),
                   " (the export declares %d of them as required dependencies)" % len(declared) if declared else ""))
        if opts.get("allow_missing_tables"):
            log("    tables gate   : SKIPPED by --allow-missing-tables: " + msg)
        else:
            raise Refuse(msg)
    else:
        log("    tables gate   : every bound table is a solution entity%s"
            % (" or listed in externalTables" if by_design else ""))

    # A table another solution owns may be listed here only as a REFERENCE (behavior 1/2: no
    # subcomponents). With behavior 0 the zip carries that table's full definition, and an import
    # writes this solution's copy over the owner's - silently reverting columns another app added.
    # Creating a lookup to a shared table with the solution header adds it exactly this way.
    full = re.findall(r'<RootComponent\s+type="1"\s+schemaName="([^"]+)"\s+behavior="0"', sol)
    shared_full = sorted(n.lower() for n in full if any(fnmatch.fnmatchcase(n.lower(), p) for p in patterns))
    facts["shared_with_schema"] = shared_full
    if shared_full:
        msg = ("%d table(s) matched by externalTables ship WITH their subcomponents (behavior 0): %s - an "
               "import would overwrite the owning solution's definition. Re-add them as references "
               "(RemoveSolutionComponent, then AddSolutionComponent with DoNotIncludeSubcomponents=true)"
               % (len(shared_full), ", ".join(shared_full[:12])))
        if opts.get("allow_shared_schema"):
            log("    shared schema : ALLOWED by --allow-shared-schema: " + msg)
        else:
            raise Refuse(msg)
    elif patterns:
        log("    shared schema : no externalTables table ships with subcomponents")

    data["solution.xml"] = bom_encode(sol_bom, sol)
    data["customizations.xml"] = bom_encode(cus_bom, cus)
    data[doc] = msapp_bytes
    return [(i, data[i.filename]) for i, _ in export_items], facts


def assert_finished(zip_path, msapp_bytes, facts, live, live_count, opts, log=print):
    """Re-open the zip that would be imported and assert on IT."""
    data = {i.filename: d for i, d in read_entries(zip_path)}
    sol = data["solution.xml"].decode("utf-8-sig")
    cus = data["customizations.xml"].decode("utf-8-sig")
    ents = len(re.findall(r'<RootComponent\s+type="1"', sol))
    roles = len(re.findall(r'<RootComponent\s+type="20"', sol)) + len(re.findall(r"<Role\b", cus))
    apps = len(re.findall(r'<RootComponent\s+type="300"', sol))
    log("    entities %d (export had %d), canvas apps %d, security roles %d" % (ents, facts["entities_before"], apps, roles))
    if ents != facts["entities_before"]:
        raise Refuse("entity root components changed %d -> %d - a canvas ship must never alter schema"
                     % (facts["entities_before"], ents))
    if roles:
        raise Refuse("security roles survive in the finished zip - importing it would reset live access control")
    if apps != facts["apps_before"] or apps < 1:
        raise Refuse("canvas app root components changed %d -> %d" % (facts["apps_before"], apps))
    if data.get(facts["doc"]) != msapp_bytes:
        raise Refuse("the .msapp inside the finished zip is not the one this run packed")
    pkg_entries = drift.read_zip(msapp_bytes)
    pkg = drift.AppPackage(facts["doc"], pkg_entries)
    if pkg.load_from_yaml is not True:
        raise Refuse("packed.json LoadFromYaml is not true - the stale Controls/*.json would run and the change "
                     "would be invisible")
    n = len(pkg.sources())
    log("    data sources %d (live baseline %d), LoadFromYaml true" % (n, live_count))
    if n < live_count:
        raise Refuse("the app binds %d Dataverse sources, the live app %d - packing dropped sources" % (n, live_count))

    player = drift.player_sources(data[drift.canvas_meta_location(list(data), facts["app"])].decode("utf-8-sig"), facts["app"])
    half, files = pkg.formula_files()
    findings, unverified, checked, _ = drift.compare_app(pkg, live, files, player)
    repairable = [f for f in findings if f["severity"] == "drift" and (
        f["check"] in ("entity-set", "dbrefs") or
        (f["check"] == "lookup" and "targets" not in f["what"]) or
        (f["check"] == "choice" and re.search(r"\((Picklist|MultiSelectPicklist)\)", f["what"])))]
    other = [f for f in findings if f["severity"] == "drift" and f not in repairable]
    log("    drift vs live : %d repairable left (must be 0), %d not repairable by a build, %d table(s) unverified"
        % (len(repairable), len(other), len(unverified)))
    for f in repairable + other:
        log("      [%s] %s" % (f["check"], f["what"]))
        if f.get("evidence"):
            log("        used at %s" % f["evidence"])
    if repairable:
        raise Refuse("a reconciled cache did not survive into the finished zip")
    if other and not opts.get("accept_drift"):
        raise Refuse("the finished app still disagrees with live in ways no build step can repair (fix printed by "
                     "check-drift.py); pass --accept-drift only if you have read each one")
    if unverified:
        log("    NOTE: %d table(s) could not be compared - the drift check is incomplete" % len(unverified))


def run_inspect(zip_path, markers, absent, live_count, log=print, runner=subprocess.run):
    cmd = [sys.executable, os.path.join(HERE, "inspect-artifact.py"), zip_path, "--min-datasources", str(live_count)]
    if markers:
        cmd += ["--expect", ",".join(markers)]
    if absent:
        cmd += ["--absent", ",".join(absent)]
    r = runner(cmd, capture_output=True)
    out = r.stdout.decode("utf-8", "replace")
    for line in out.splitlines():
        log("      " + line)
    if r.returncode != 0:
        raise Refuse("inspect-artifact.py reported findings on the finished zip (exit %d)" % r.returncode)


# --------------------------------------------------------------------------- the pipeline

def load_cfg(path):
    if not os.path.isfile(path):
        raise CannotRun("no config at %s - copy assets/canvas-app.example.json to scripts/canvas-app.json" % path)
    cfg = dict(DEFAULTS)
    cfg.update(json.loads(open(path, "rb").read().decode("utf-8-sig")))
    return cfg


def real_id(v):
    return bool(v) and not re.fullmatch(r"[0-]+", v)


SHIPPED = {}


def ship(argv, pac=None, now=None):
    SHIPPED.clear()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=os.path.join("scripts", "canvas-app.json"))
    ap.add_argument("--repo")
    ap.add_argument("--live", action="append", default=[])
    ap.add_argument("--markers", default="")
    ap.add_argument("--absent", default="")
    ap.add_argument("--offline")
    ap.add_argument("--org")
    ap.add_argument("--token-cmd")
    ap.add_argument("--token-env", default="DATAVERSE_TOKEN")
    ap.add_argument("--allow-missing-tables", action="store_true")
    ap.add_argument("--allow-shared-schema", action="store_true")
    ap.add_argument("--accept-drift", action="store_true")
    ap.add_argument("--no-bump", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--import", dest="do_import", action="store_true")
    ap.add_argument("--publish", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    dry = a.dry_run
    pac = pac or Pac(dry)
    pac.dry = dry
    markers = [m for m in a.markers.split(",") if m]
    absent = [m for m in a.absent.split(",") if m]

    cfg_path = os.path.abspath(a.config)
    cfg = load_cfg(cfg_path)
    repo = os.path.abspath(a.repo) if a.repo else (
        os.path.dirname(os.path.dirname(cfg_path)) if os.path.basename(os.path.dirname(cfg_path)) == "scripts" else os.getcwd())
    rp = lambda p: p if os.path.isabs(p) else os.path.join(repo, p)
    src = rp(cfg.get("canvasSrc") or "")
    out_dir, work = rp(cfg["outDir"]), rp(cfg["workDir"])
    env = cfg.get("environmentId") if real_id(cfg.get("environmentId")) else None
    env_args = ["--environment", env] if env else []
    sol_name = cfg.get("solutionUniqueName")
    var, ph = cfg["buildStampVariable"], cfg["buildStampPlaceholder"]
    steps = 9

    def step(n, title, proves):
        print()
        print("[%d/%d] %s%s" % (n, steps, title, "   (dry run)" if dry else ""))
        print("      proves: " + proves)

    print("ship-canvas  repo %s" % repo)
    print("  config %s  -> app %s, solution %s, environment %s" % (
        cfg_path, cfg.get("appId"), sol_name, env or "(pac's active profile - check `pac org who`)"))
    if dry:
        print("  DRY RUN: nothing is written, no pac command is run; live metadata is only read (GET)")

    # 1 ----------------------------------------------------------------- pre-flight on source
    step(1, "Pre-flight: the source that will ship", "Src exists, carries the stamp placeholder, fits the file ceiling")
    app_yaml = os.path.join(src, "App.pa.yaml")
    if not os.path.isfile(app_yaml):
        raise CannotRun("no App.pa.yaml under canvasSrc %s" % src)
    files = [os.path.join(r, f) for r, _, fs in os.walk(src) for f in fs if f.endswith(".pa.yaml")]
    print("    %d .pa.yaml file(s) under %s" % (len(files), src))
    if len(files) > int(cfg["maxScreenFiles"]):
        raise Refuse("%d .pa.yaml files exceeds the %s-file ceiling - the authoring service refuses the compile; "
                     "fold a screen first" % (len(files), cfg["maxScreenFiles"]))
    stamp = stamp_value(repo, now)
    yaml_text = open(app_yaml, encoding="utf-8").read()
    apply_stamp(yaml_text, var, ph, stamp)            # refuses if the placeholder is gone
    print('    stamp placeholder found: Set(%s, "%s") -> "%s" in the PACKED copy only' % (var, ph, stamp))
    if not dry and not (pac.exe or shutil.which("pac")):
        raise CannotRun("pac is not on PATH")

    # 2 ----------------------------------------------------------------- live baseline
    step(2, "Live baseline: the app and solution as they are in the environment",
         "the build starts from the LIVE manifest and the LIVE component list, not the repo's stale copies")
    live_msapp, live_solution = None, None
    for p in a.live:
        if not os.path.isfile(p):
            raise CannotRun("--live %s does not exist" % p)
        names = zipfile.ZipFile(p).namelist()
        if "solution.xml" in names:
            live_solution = p
        else:
            live_msapp = p
    if not dry:
        os.makedirs(work, exist_ok=True)
        os.makedirs(out_dir, exist_ok=True)
    if not live_solution:
        if not sol_name:
            raise CannotRun("no solutionUniqueName in the config and no --live solution zip")
        live_solution = os.path.join(work, "live-export.zip")
        pac("solution", "export", "--name", sol_name, "--path", live_solution, "--managed", "false", "--overwrite", *env_args)
    else:
        print("    solution export: %s (given)" % live_solution)
    if not live_msapp:
        if real_id(cfg.get("appId")):
            live_msapp = os.path.join(work, "live.msapp")
            # `pac canvas download` has no --overwrite and refuses when the file exists, so the
            # previous run's baseline would stop every second ship. Remove it first; a stale
            # baseline must never be reused anyway.
            if not dry and os.path.isfile(live_msapp):
                os.remove(live_msapp)
            pac("canvas", "download", "--name", cfg["appId"], "--file-name", live_msapp, *env_args)
        elif not dry or os.path.isfile(live_solution):
            print("    no appId: the .msapp inside the solution export is the baseline")
    else:
        print("    app download   : %s (given)" % live_msapp)

    have_baseline = os.path.isfile(live_solution) and (live_msapp is None or os.path.isfile(live_msapp))
    if not have_baseline:
        print("    (baseline not on disk in a dry run - later steps print their plan only; pass --live to analyse)")
        export_items = None
        baseline_bytes = None
    else:
        export_items = read_entries(live_solution)
        if live_msapp:
            baseline_bytes = open(live_msapp, "rb").read()
        else:
            baseline_bytes = dict((i.filename, d) for i, d in export_items)[pick_app([i.filename for i, _ in export_items], cfg)]
        base_pkg = drift.AppPackage("live baseline", drift.read_zip(baseline_bytes))
        live_count = len(base_pkg.sources())
        print("    live baseline binds %d Dataverse source(s); LoadFromYaml=%s" % (live_count, base_pkg.load_from_yaml))

    # 3 ----------------------------------------------------------------- unpack the baseline
    step(3, "Unpack the live app (SourceCode layout)", "the pack directory has the shape pac expects, built on live References/")
    unpack, msapr_path = os.path.join(work, "unpack"), None
    if dry:
        pac("canvas", "unpack", "--msapp", live_msapp or "<.msapp from the export>", "--sources", unpack, "--layout", "SourceCode")
        print("    (dry run: the reconcile below runs on the baseline .msapp in memory)")
    else:
        if not live_msapp:
            live_msapp = os.path.join(work, "live-from-export.msapp")
            with open(live_msapp, "wb") as f:
                f.write(baseline_bytes)
        rmtree_strict(unpack)
        pac("canvas", "unpack", "--msapp", live_msapp, "--sources", unpack, "--layout", "SourceCode")
        msaprs = [f for f in os.listdir(unpack) if f.endswith(".msapr")]
        if len(msaprs) != 1:
            raise Refuse("expected one .msapr after unpack, found %s" % msaprs)
        msapr_path = os.path.join(unpack, msaprs[0])

    # 4 ----------------------------------------------------------------- live metadata
    step(4, "Read live metadata (GET only) for every bound table", "the reconcile and the final drift check compare with the environment")
    live = None
    if baseline_bytes is not None:
        logicals = sorted({s["logical"] for s in base_pkg.sources()})
        try:
            if a.offline:
                live = drift.load_dump(a.offline)
                print("    from saved dump %s (captured %s) - it describes the environment as it was then"
                      % (a.offline, live.get("captured_utc")))
            else:
                org, how = drift.resolve_org(a.org, cfg, base_pkg)
                if not org:
                    raise CannotRun("no org URL: set environmentUrl in the config or pass --org")
                token, tok_how = drift.get_token(org, a.token_cmd, a.token_env)
                api = drift.WebApi(org, token)
                live = drift.fetch_live(api, logicals)
                print("    %s: %d table(s) read with %d GET request(s) (org from %s, token from %s)"
                      % (org, len(live["tables"]), api.calls, how, tok_how))
        except (drift.LiveError, OSError, ValueError) as e:
            raise CannotRun("live metadata unavailable: %s - refusing to build without reconciling" % e)
        missing_meta = [l for l in logicals if l not in live["tables"]]
        if missing_meta:
            raise CannotRun("live metadata could not be read for %s - refusing to build on unverified caches" % missing_meta)
    else:
        print("    would read: EntityDefinitions (names, entity sets) and, per bound table, attributes, "
              "lookups and choice metadata")

    # 5 ----------------------------------------------------------------- reconcile
    step(5, "Reconcile the manifest caches from live", "option-set members (both caches), entity set names, "
         "lookup navigation names match the environment before packing")
    reconciled_msapr = None
    if live is not None:
        if dry:
            _, rep = reconcile_package(read_entries(baseline_bytes), live)
            print_reconcile(rep)
        else:
            items, rep = reconcile_package(read_entries(msapr_path), live)
            print_reconcile(rep)
            packdir = os.path.join(work, "packdir")
            rmtree_strict(packdir)
            os.makedirs(packdir)
            reconciled_msapr = os.path.join(packdir, os.path.basename(msapr_path))
            write_entries(reconciled_msapr, items)
            back = drift.AppPackage("readback", drift.read_zip(reconciled_msapr))
            left = stale_entity_sets(back, live)
            if left:
                raise Refuse("entity set names still stale after the rewrite: %s" % left)
            for old in rep["entitysets"]:
                for info, data in read_entries(reconciled_msapr):
                    if token_pattern(old).search(data):
                        raise Refuse("stale entity set %r survived the rewrite in %s" % (old, info.filename))
            if reconcile_package(read_entries(reconciled_msapr), live)[1]["optionsets"]:
                raise Refuse("option-set reconcile is not idempotent - a second pass still finds changes")
            print("    rewrote %s and read it back: corrections present, a second pass is a no-op" % os.path.basename(reconciled_msapr))
    else:
        print("    (plan) add/relabel Picklist members in OptionSetInfo AND TableDefinition; token-replace stale set "
              "names in every manifest entry; rewrite drifted navigation/schema names; never remove, never blank")

    # 6 ----------------------------------------------------------------- stage + stamp + pack
    step(6, "Stage the repo Src on the reconciled manifest, stamp it, pack", "the .msapp holds THIS commit's formulas, stamped")
    app_name = cfg.get("appLogicalName") or (drift.app_name_from_path(pick_app([i.filename for i, _ in export_items], cfg))
                                             if export_items else "canvas-app")
    msapp_out = os.path.join(out_dir, app_name + ".msapp")
    zip_out = os.path.join(out_dir, "%s-import-me.zip" % (sol_name or app_name))
    if dry:
        print("    would copy %s -> <work>/packdir/Src (packdir emptied first; refuse if it cannot be)" % src)
        print('    would stamp packdir/Src/App.pa.yaml: Set(%s, "%s")' % (var, stamp))
        pac("canvas", "pack", "--sources", os.path.join(work, "packdir"), "--msapp", msapp_out, "--layout", "SourceCode")
        msapp_bytes = None
    else:
        dst = os.path.join(os.path.dirname(reconciled_msapr), "Src")
        shutil.copytree(src, dst)
        stamped, _ = apply_stamp(open(os.path.join(dst, "App.pa.yaml"), encoding="utf-8").read(), var, ph, stamp)
        with open(os.path.join(dst, "App.pa.yaml"), "w", encoding="utf-8", newline="") as f:
            f.write(stamped)
        for p in (msapp_out, zip_out):
            if os.path.exists(p):
                os.remove(p)                 # a failed pack must not leave the previous artifact to import
        pac("canvas", "pack", "--sources", os.path.dirname(reconciled_msapr), "--msapp", msapp_out, "--layout", "SourceCode")
        if not os.path.isfile(msapp_out):
            raise Refuse("pac canvas pack reported success and wrote no %s" % msapp_out)
        msapp_bytes = open(msapp_out, "rb").read()
        packed = drift.AppPackage(msapp_out, drift.read_zip(msapp_bytes))
        if packed.load_from_yaml is not True:
            raise Refuse("packed.json LoadFromYaml is not true - the stale Controls/*.json would run")
        if len(packed.sources()) < live_count:
            raise Refuse("packed app binds %d sources, live %d - packing dropped data sources"
                         % (len(packed.sources()), live_count))
        yaml_in = "".join(t for n, t in packed.formula_files()[1] if n.endswith("App.pa.yaml"))
        if stamp not in yaml_in:
            raise Refuse("the packed App.pa.yaml does not carry the stamp %r" % stamp)
        print("    packed %s: %d sources, LoadFromYaml true, stamp present" % (msapp_out, len(packed.sources())))

    # 7 ----------------------------------------------------------------- solution
    step(7, "Swap into the exported solution: strip roles, repair the player list, bump the version",
         "the zip carries the live component list, no security roles, and a player list equal to what the app binds")
    if export_items is None:
        print("    (plan) replace CanvasApps/<app>_DocumentUri.msapp; drop RootComponent type=20 and <Roles>; rewrite "
              "<DatabaseReferences>/<CdsDependencies> from DataSources.json; bump <Version>; refuse if a bound table "
              "is not a solution entity")
    else:
        sol_opts = {"bump": cfg.get("bumpVersion", True) and not a.no_bump,
                    "allow_missing_tables": a.allow_missing_tables,
                    "allow_shared_schema": a.allow_shared_schema}
        new_items, facts = build_solution(export_items, msapp_bytes if msapp_bytes is not None else
                                          _dry_msapp(baseline_bytes, live), cfg, sol_opts)
        if not dry:
            write_entries(zip_out, new_items)
            SHIPPED["zip"] = zip_out
            print("    wrote %s" % zip_out)

    # 8 ----------------------------------------------------------------- assert on the finished zip
    step(8, "Assert on the FINISHED zip", "what will be imported - not what the build intended - is right")
    if dry:
        print("    would check: entity count unchanged, no roles, one app, LoadFromYaml true, source count >= live, "
              "player list in step, no repairable drift left; then run:")
        print("    would run: python inspect-artifact.py %s --min-datasources <live count>%s%s" % (
            zip_out, " --expect " + ",".join(markers) if markers else "", " --absent " + ",".join(absent) if absent else ""))
        if live is not None:
            pkg = drift.AppPackage("baseline after reconcile", drift.read_zip(_dry_msapp(baseline_bytes, live)))
            fs, unv, _, _ = drift.compare_app(pkg, live, pkg.formula_files()[1])
            left = [f for f in fs if f["severity"] == "drift"]
            print("    preview: after reconcile the baseline would carry %d drift finding(s)%s" % (
                len(left), "" if not left else ":"))
            for f in left:
                print("      [%s] %s" % (f["check"], f["what"]))
    else:
        if not markers:
            print("    NOTE: no --markers given - nothing proves YOUR change is in the artifact")
        assert_finished(zip_out, msapp_bytes, facts, live, live_count, {"accept_drift": a.accept_drift})
        run_inspect(zip_out, markers, absent, live_count)
        print("    finished artifact OK: %s" % zip_out)

    # 9 ----------------------------------------------------------------- import (opt-in)
    step(9, "Import", "only that the components landed - read the build stamp in the player afterwards")
    backup = os.path.join(out_dir, "rollback-%s.zip" % (now or datetime.datetime.now(datetime.timezone.utc)).strftime("%Y%m%d-%H%M%S"))
    import_cmd = ["solution", "import", "--path", zip_out] + (["--publish-changes"] if a.publish else []) + env_args
    if not a.do_import or dry:
        print("    NOT imported (%s). To import, close Studio (an import kills a held co-authoring push), then:"
              % ("dry run" if dry else "pass --import to do it here"))
        print("      pac org who")
        print("      pac solution export --name %s --managed false --path %s%s   # rollback point"
              % (sol_name, backup, " --environment " + env if env else ""))
        print("      pac " + " ".join(import_cmd))
        return 0
    print(pac("org", "who").strip())
    pac("solution", "export", "--name", sol_name, "--managed", "false", "--path", backup, *env_args)
    pac(*import_cmd)
    print("    imported. pac's exit code is not the proof: confirm the import job, then read the build stamp %r in the "
          "refreshed player%s." % (stamp, "" if a.publish else ", after publishing (imported WITHOUT --publish-changes)"))
    return 0


def _dry_msapp(baseline_bytes, live):
    """In a dry run the reconciled baseline stands in for the packed app (in memory only)."""
    if live is None:
        return baseline_bytes
    items, _ = reconcile_package(read_entries(baseline_bytes), live)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for info, data in items:
            z.writestr(info, data)
    return buf.getvalue()


def main(argv=None, pac=None, now=None):
    try:
        return ship(sys.argv[1:] if argv is None else argv, pac=pac, now=now)
    except Refuse as e:
        print()
        print("REFUSING: %s" % e)
        if SHIPPED.get("zip") and os.path.isfile(SHIPPED["zip"]):
            dest = SHIPPED["zip"] + ".refused"
            os.replace(SHIPPED["zip"], dest)
            print("  the zip was renamed to %s so it cannot be imported by mistake" % dest)
        return 1
    except CannotRun as e:
        print()
        print("CANNOT RUN: %s - nothing was built; this is NOT a pass" % e)
        return 2


# --------------------------------------------------------------------------- selftest

class FakePac(Pac):
    """Simulates the pac verbs this script uses, against fixtures, and records every call."""

    def __init__(self, export_bytes, msapp_bytes, drop_sources=False, load_from_yaml=True):
        super().__init__(False, exe="fake")
        self.export_bytes, self.msapp_bytes = export_bytes, msapp_bytes
        self.drop_sources, self.lfy = drop_sources, load_from_yaml

    def __call__(self, *args):
        if self.dry:
            return Pac.__call__(self, *args)
        self.calls.append(list(args))
        opt = lambda k: args[args.index(k) + 1]
        verb = args[0] + " " + args[1]
        if verb == "solution export":
            open(opt("--path"), "wb").write(self.export_bytes)
        elif verb == "canvas download":
            if os.path.exists(opt("--file-name")):  # as the real pac: no --overwrite, refuses
                raise CannotRun("pac canvas download failed (exit 1): file already exists")
            open(opt("--file-name"), "wb").write(self.msapp_bytes)
        elif verb == "canvas unpack":
            d = opt("--sources")
            os.makedirs(d)
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as z:
                for info, data in read_entries(open(opt("--msapp"), "rb").read()):
                    if not norm(info.filename).startswith(("Src/", "Controls/")):
                        z.writestr("msapp/" + info.filename, data)
            open(os.path.join(d, "app_fixture.msapr"), "wb").write(buf.getvalue())
        elif verb == "canvas pack":
            d = opt("--sources")
            msapr = [f for f in os.listdir(d) if f.endswith(".msapr")][0]
            with zipfile.ZipFile(opt("--msapp"), "w") as z:
                for info, data in read_entries(os.path.join(d, msapr)):
                    name = info.filename[len("msapp/"):]
                    if name == "packed.json":
                        data = json.dumps({"LoadConfiguration": {"LoadFromYaml": self.lfy}}).encode()
                    if name == "References/DataSources.json" and self.drop_sources:
                        doc = json.loads(data)
                        doc["DataSources"] = [e for e in doc["DataSources"] if e["Type"] != "NativeCDSDataSourceInfo"]
                        data = json.dumps(doc).encode()
                    z.writestr(name, data)
                for r, _, fs in os.walk(os.path.join(d, "Src")):
                    for f in fs:
                        z.write(os.path.join(r, f), "Src/" + norm(os.path.relpath(os.path.join(r, f), os.path.join(d, "Src"))))
        elif verb in ("org who", "solution import"):
            return "fixture environment"
        else:
            raise AssertionError("unexpected pac call %s" % (args,))
        return ""


def selftest():
    import tempfile
    failures = []

    def check(name, cond):
        print("  %s  %s" % ("ok  " if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    def quiet(fn, *a, **k):
        buf, old = io.StringIO(), sys.stdout
        sys.stdout = buf
        try:
            rc = fn(*a, **k)
        finally:
            sys.stdout = old
        return rc, buf.getvalue()

    def tree(d):
        out = {}
        for r, _, fs in os.walk(d):
            for f in fs:
                p = os.path.join(r, f)
                out[os.path.relpath(p, d)] = open(p, "rb").read()
        return out

    print("ship-canvas selftest")
    now = datetime.datetime(2030, 1, 2, 3, 4, tzinfo=datetime.timezone.utc)
    cached = drift.fixture_table(entity_set="app_orderses", nav="app_customer")
    live_t = drift.fixture_table(priority_opts={"1": "Low", "2": "High", "3": "Urgent"}, nav="app_Customer",
                                 customer_schema="app_Customer")
    dump = drift.fixture_dump(live_t)
    stale_msapp = drift.fixture_msapp(cached, drift.FIXTURE_FORMULAS)
    stale_refs = {}                                             # player list missing the source
    export = drift.fixture_solution(stale_msapp, stale_refs, app="app_fixture_1a2b3")

    def make_repo(src_text=None, n_screens=1, extra_cfg=None):
        d = tempfile.mkdtemp(prefix="ship-canvas-selftest-")
        os.makedirs(os.path.join(d, "scripts"))
        os.makedirs(os.path.join(d, "canvas", "app", "Src"))
        cfg = {"environmentUrl": "https://example.invalid", "environmentId": "", "appId": "",
               "solutionUniqueName": "Fixture", "canvasSrc": "canvas/app/Src", "appLogicalName": "app_fixture_1a2b3"}
        cfg.update(extra_cfg or {})
        json.dump(cfg, open(os.path.join(d, "scripts", "canvas-app.json"), "w"))
        open(os.path.join(d, "canvas", "app", "Src", "App.pa.yaml"), "w").write(
            src_text if src_text is not None else "App:\n  Properties:\n    OnStart: |-\n      =Set(gblBuild, \"unshipped\");\n")
        for i in range(n_screens):
            open(os.path.join(d, "canvas", "app", "Src", "Screen%d.pa.yaml" % i), "w").write(
                drift.FIXTURE_FORMULAS + "            Text: =\"NewThingMarker\"\n")
        json.dump(dump, open(os.path.join(d, "live.json"), "w"))
        open(os.path.join(d, "export.zip"), "wb").write(export)
        return d

    def go(d, extra=(), pac=None, export_bytes=None):
        pac = pac or FakePac(export_bytes or export, stale_msapp)
        argv = ["--config", os.path.join(d, "scripts", "canvas-app.json"), "--offline", os.path.join(d, "live.json"),
                "--live", os.path.join(d, "export.zip")] + list(extra)
        rc, out = quiet(main, argv, pac=pac, now=now)
        return rc, out, pac

    tmps = []
    try:
        # --- unit: reconcilers on the fixture manifest
        doc = json.loads(dict((i.filename, x) for i, x in read_entries(stale_msapp))["References/DataSources.json"])
        ch, unv = reconcile_optionsets(doc, dump)
        check("option sets: member added live is added to BOTH caches",
              any(c.startswith("cache 1") and "Urgent" in c for c in ch) and any(c.startswith("cache 2") and "Urgent" in c for c in ch))
        ch2, _ = reconcile_optionsets(doc, dump)
        check("option sets: a second pass is a no-op", ch2 == [])
        gone = drift.fixture_dump(live_t)
        gone["tables"]["app_order"] = dict(live_t, choices={})
        doc2 = json.loads(dict((i.filename, x) for i, x in read_entries(stale_msapp))["References/DataSources.json"])
        before = json.dumps(doc2, sort_keys=True)
        ch3, unv3 = reconcile_optionsets(doc2, gone)
        check("option sets: an unverifiable set is left exactly as it was (never blanked)",
              ch3 == [] and unv3 and json.dumps(doc2, sort_keys=True) == before)
        fewer = drift.fixture_dump(drift.fixture_table(priority_opts={"1": "Low"}))
        doc3 = json.loads(dict((i.filename, x) for i, x in read_entries(stale_msapp))["References/DataSources.json"])
        reconcile_optionsets(doc3, fewer)
        info = [e for e in doc3["DataSources"] if e["Type"] == "OptionSetInfo"][0]
        check("option sets: a member removed live is NOT removed from the cache", "2" in info["OptionSetInfoNameMapping"])

        doc4 = json.loads(dict((i.filename, x) for i, x in read_entries(stale_msapp))["References/DataSources.json"])
        nch = reconcile_navprops(doc4, dump)
        em = json.loads(json.loads([e for e in doc4["DataSources"] if e["Type"] == "NativeCDSDataSourceInfo"][0]["TableDefinition"])["EntityMetadata"])
        rel = [r for r in em["ManyToOneRelationships"] if r["ReferencingAttribute"] == "app_customer"][0]
        att = [x for x in em["Attributes"] if x["LogicalName"] == "app_customer"][0]
        check("lookups: navigation and schema name rewritten, logical name untouched",
              len(nch) == 2 and rel["ReferencingEntityNavigationPropertyName"] == "app_Customer"
              and att["SchemaName"] == "app_Customer" and att["LogicalName"] == "app_customer")

        items, rep = reconcile_package(read_entries(stale_msapp), dump)
        blob = b"".join(x for i, x in items if not i.filename.startswith(("Src/", "Controls/")))
        check("entity sets: stale name replaced in every manifest entry, zero left",
              rep["entitysets"] == {"app_orderses": "app_orders"} and not token_pattern("app_orderses").search(blob)
              and len(rep["entityset_counts"]["app_orderses"]) >= 2)
        clash = drift.fixture_dump(live_t)
        clash["entity_sets"]["core_other"] = "app_orderses_archive"
        try:
            reconcile_package(read_entries(stale_msapp), clash)
            check("entity sets: refuses when the stale name is a prefix of another live set", False)
        except Refuse:
            check("entity sets: refuses when the stale name is a prefix of another live set", True)

        check("stamp: placeholder replaced", apply_stamp('Set(gblBuild, "unshipped");', "gblBuild", "unshipped", "X")[0] == 'Set(gblBuild, "X");')
        try:
            apply_stamp("Set(gblOther, 1);", "gblBuild", "unshipped", "X")
            check("stamp: missing placeholder refuses", False)
        except Refuse:
            check("stamp: missing placeholder refuses", True)

        # --- the whole pipeline, simulated pac
        d = make_repo()
        tmps.append(d)
        before = tree(d)
        rc, out, pac = go(d, ["--dry-run", "--import", "--markers", "NewThingMarker"])
        check("dry run: exit 0, no pac command run, not one file written or changed",
              rc == 0 and pac.calls == [] and tree(d) == before)
        check("dry run: prints every step and the import it would NOT run",
              all("[%d/9]" % n in out for n in range(1, 10)) and "NOT imported" in out and "would run: pac canvas pack" in out)
        check("dry run: previews the reconcile from live", "Urgent" in out and "app_orderses -> app_orders" in out)

        rc, out, pac = go(d, ["--markers", "NewThingMarker"])
        zip_out = os.path.join(d, "out", "Fixture-import-me.zip")
        check("full build: exit 0 and an import zip", rc == 0 and os.path.isfile(zip_out))
        check("full build: NOT imported without --import", not any(c[:2] == ["solution", "import"] for c in pac.calls))
        if os.path.isfile(zip_out):
            z = {i.filename: x for i, x in read_entries(zip_out)}
            sol = z["solution.xml"].decode("utf-8-sig")
            check("full build: roles stripped, version bumped, BOM kept",
                  'type="20"' not in sol and "<Version>1.0.0.5</Version>" in sol
                  and z["customizations.xml"].startswith(codecs.BOM_UTF8) and "<Role " not in z["customizations.xml"].decode("utf-8-sig"))
            rc2, out2 = quiet(drift.run, [zip_out, "--offline", os.path.join(d, "live.json")])
            check("full build: check-drift on the finished zip is clean (reconcile + player list survived)", rc2 == 0)
            app = drift.read_zip(z["CanvasApps/app_fixture_1a2b3_DocumentUri.msapp"])
            check("full build: the shipped App.pa.yaml carries the stamp, the repo copy does not",
                  b"2030-01-02 03:04Z" in app["Src/App.pa.yaml"]
                  and b"unshipped" in open(os.path.join(d, "canvas", "app", "Src", "App.pa.yaml"), "rb").read())

        rc, out, pac = go(d, ["--markers", "NewThingMarker", "--import"])
        verbs = [" ".join(c[:2]) for c in pac.calls]
        check("--import: org who, rollback export, then import - in that order, without --publish-changes",
              rc == 0 and verbs[-3:] == ["org who", "solution export", "solution import"]
              and "--publish-changes" not in pac.calls[-1])

        # Downloading (no --live): pac canvas download has no --overwrite, so the previous run's
        # baseline in the work folder must be cleared, or every second ship refuses.
        dl = make_repo(extra_cfg={"appId": "11111111-2222-3333-4444-555555555555",
                                  "environmentId": "22222222-3333-4444-5555-666666666666"})
        tmps.append(dl)
        dl_argv = ["--config", os.path.join(dl, "scripts", "canvas-app.json"), "--offline",
                   os.path.join(dl, "live.json"), "--markers", "NewThingMarker"]
        rc1, _ = quiet(main, dl_argv, pac=FakePac(export, stale_msapp), now=now)
        rc2, out2 = quiet(main, dl_argv, pac=FakePac(export, stale_msapp), now=now)
        check("downloading baseline: a second run in the same folder rebuilds (old live.msapp replaced)",
              rc1 == 0 and rc2 == 0 and "already exists" not in out2)

        rc, out, _ = go(d, ["--markers", "NotInTheAppAnywhere"])
        check("a marker missing from the running half refuses (exit 1)", rc == 1 and "inspect-artifact" in out)
        check("... and the refused zip is renamed so it cannot be imported by mistake",
              not os.path.exists(zip_out) and os.path.exists(zip_out + ".refused"))

        d2 = make_repo(src_text="App:\n  Properties:\n    OnStart: =Set(gblX, 1)\n")
        tmps.append(d2)
        rc, out, _ = go(d2)
        check("no stamp placeholder refuses before anything is built", rc == 1 and not os.path.exists(os.path.join(d2, "out")))

        d3 = make_repo(n_screens=51)
        tmps.append(d3)
        rc, out, _ = go(d3)
        check("over the screen-file ceiling refuses", rc == 1 and "ceiling" in out)

        rc, out, _ = go(d, pac=FakePac(export, stale_msapp, drop_sources=True))
        check("a pack that drops data sources refuses", rc == 1 and "dropped" in out)
        check("... and leaves no import zip behind", not os.path.exists(zip_out))

        rc, out, _ = go(d, pac=FakePac(export, stale_msapp, load_from_yaml=False))
        check("a pack without LoadFromYaml refuses", rc == 1 and "LoadFromYaml" in out)

        no_tbl = drift.fixture_solution(stale_msapp, stale_refs, app="app_fixture_1a2b3", entities=())
        open(os.path.join(d, "export.zip"), "wb").write(no_tbl)
        rc, out, _ = go(d, export_bytes=no_tbl)
        check("a bound table missing from the solution refuses", rc == 1 and "not entities of the solution" in out)
        rc, out, _ = go(d, ["--allow-missing-tables"], export_bytes=no_tbl)
        check("... and --allow-missing-tables lets it through, saying so", rc == 0 and "SKIPPED" in out)
        d4 = make_repo(extra_cfg={"externalTables": ["app_*"]})
        tmps.append(d4)
        open(os.path.join(d4, "export.zip"), "wb").write(no_tbl)
        rc, out, _ = go(d4, export_bytes=no_tbl)
        check("... and a table matched by externalTables passes as owned elsewhere by design",
              rc == 0 and "by design" in out)
        # The fixture lists app_order as a full root component (behavior 0). Marking it external
        # makes it a shared table shipped with its schema: refuse, unless explicitly allowed.
        d5 = make_repo(extra_cfg={"externalTables": ["app_order"]})
        tmps.append(d5)
        rc, out, _ = go(d5)
        check("an externalTables table shipped WITH subcomponents refuses", rc == 1 and "behavior 0" in out)
        rc, out, _ = go(d5, ["--allow-shared-schema"])
        check("... and --allow-shared-schema lets it through, saying so", rc == 0 and "ALLOWED" in out)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            for info, data in read_entries(export):
                if info.filename == "solution.xml":
                    data = data.replace(b'schemaName="app_order" behavior="0"', b'schemaName="app_order" behavior="1"')
                z.writestr(info.filename, data)
        ref = buf.getvalue()
        open(os.path.join(d5, "export.zip"), "wb").write(ref)
        rc, out, _ = go(d5, export_bytes=ref)
        check("... and the same table as a reference (behavior 1) passes", rc == 0 and "no externalTables table ships" in out)
        open(os.path.join(d, "export.zip"), "wb").write(export)

        used = drift.fixture_dump(drift.fixture_table(priority_opts={"1": "Low", "2": "High", "3": "Urgent"}, nav="app_Customer",
                                                      customer_schema="app_Customer", total_type="String"))
        json.dump(used, open(os.path.join(d, "live.json"), "w"))
        rc, out, _ = go(d)
        check("drift no build can repair (column type) refuses", rc == 1 and "column-type" in out)
        rc, out, _ = go(d, ["--accept-drift"])
        check("... and --accept-drift lets it through, listing it", rc == 0 and "column-type" in out)
        json.dump(dump, open(os.path.join(d, "live.json"), "w"))

        os.remove(os.path.join(d, "live.json"))
        rc, out, _ = go(d)
        check("live metadata unavailable -> exit 2, nothing built", rc == 2 and "NOT a pass" in out)
    finally:
        for t in tmps:
            shutil.rmtree(t, ignore_errors=True)

    print()
    print("selftest: %s" % ("PASSED" if not failures else "FAILED %d: %s" % (len(failures), ", ".join(failures))))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
