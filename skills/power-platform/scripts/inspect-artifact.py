#!/usr/bin/env python3
"""inspect-artifact.py - report what a Power Platform artifact REALLY contains.

`pac solution pack` exits 0 while dropping components, an import says "success" for whatever
zip it was handed, and a canvas app carries its screens twice. So never trust the build's exit
code: open the finished artifact and assert on it. Python 3 standard library only.

Usage:
    python inspect-artifact.py <solution.zip | app.msapp> [options]

Options:
    --expect A,B,...        markers (control names, strings) that must be in the half of the
                            canvas app that RUNS; exit 1 if any is missing
    --absent A,B,...        markers that must NOT be there
    --min-datasources N     fail if a canvas app binds fewer Dataverse tables than N
                            (pass the LIVE app's count - packing a stale manifest drops sources)
    --stamp REGEX           build-stamp pattern, one capture group (default: Set(gbl*Build*, "..."))
    --allow-roles           do not fail on security roles in the solution
    --json                  machine-readable report
    --selftest              build known-good and known-bad fixtures in a temp folder, check the
                            verdicts, and exit

What it checks:
  solution zip  root components vs elements actually built into customizations.xml; security
                roles (an import carrying roles resets live access control); workflows; every
                canvas app inside (below); <DatabaseReferences> vs the app's DataSources.json
                (what the player initialises vs what the app binds).
  canvas app    LoadFromYaml (which half runs), build stamp, Dataverse table count, option-set
                caches, marker search in the authoritative half, with both halves' counts shown.

Exit: 0 ok, 1 findings, 2 could not read the artifact, or it holds nothing to inspect (NOT a pass).
"""
import argparse
import io
import json
import re
import sys
import zipfile

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT_TYPES = {"1": "Entity", "2": "Attribute", "9": "OptionSet", "20": "Role", "29": "Workflow",
              "60": "SystemForm", "300": "CanvasApp", "371": "Connector", "372": "Connector",
              "380": "EnvironmentVariableDefinition", "10112": "ConnectionReference"}


def norm(name):
    return name.replace("\\", "/")


def find(names, suffix):
    return [n for n in names if norm(n).endswith(suffix)]


def inspect_msapp(zf, label, opts, findings, report):
    names = zf.namelist()
    r = {"name": label}
    packed = find(names, "packed.json")
    load_from_yaml = None
    if packed:
        try:
            load_from_yaml = bool(json.loads(zf.read(packed[0]))
                                  .get("LoadConfiguration", {}).get("LoadFromYaml"))
        except Exception:
            pass
    r["LoadFromYaml"] = load_from_yaml
    src = [n for n in names if norm(n).startswith("Src/") and n.endswith(".pa.yaml")]
    ctl = [n for n in names if norm(n).startswith("Controls/") and n.endswith(".json")]
    r["src_files"], r["controls_files"] = len(src), len(ctl)
    runs = "Src" if load_from_yaml else "Controls"
    r["authoritative_half"] = runs
    if load_from_yaml is None:
        findings.append(f"{label}: no packed.json LoadConfiguration - cannot tell which half runs")

    # Build stamp
    stamp_re = re.compile(opts.stamp)
    stamp = None
    for n in src:
        m = stamp_re.search(zf.read(n).decode("utf-8", "replace"))
        if m:
            stamp = m.group(1) if m.groups() else m.group(0)
            break
    r["build_stamp"] = stamp
    if stamp is None and load_from_yaml:
        findings.append(f"{label}: no build stamp found (pattern {opts.stamp!r}) - you cannot tell "
                        f"which package a browser is running")

    # Data sources
    ds_entries = find(names, "References/DataSources.json")
    tables, optionsets = {}, 0
    if ds_entries:
        d = json.loads(zf.read(ds_entries[0]))
        arr = d.get("DataSources", d) if isinstance(d, dict) else d
        for e in arr:
            if e.get("Type") == "NativeCDSDataSourceInfo":
                tables[e.get("Name")] = {"logical": e.get("LogicalName"), "set": e.get("EntitySetName")}
            elif e.get("Type") == "OptionSetInfo":
                optionsets += 1
    else:
        findings.append(f"{label}: no References/DataSources.json")
    r["dataverse_tables"], r["option_set_caches"] = len(tables), optionsets
    r["_tables"] = tables
    if opts.min_datasources is not None and len(tables) < opts.min_datasources:
        findings.append(f"{label}: binds {len(tables)} Dataverse tables, fewer than the live app's "
                        f"{opts.min_datasources} - a stale manifest was packed and sources were dropped")

    # Markers, searched in both halves; judged in the half that runs.
    def count(files, marker):
        return sum(zf.read(n).decode("utf-8", "replace").count(marker) for n in files)
    marks = []
    for m in opts.expect:
        a, b = count(src, m), count(ctl, m)
        hit = a if runs == "Src" else b
        marks.append({"marker": m, "want": "present", "Src": a, "Controls": b, "ok": hit > 0})
        if hit == 0:
            findings.append(f"{label}: expected marker {m!r} missing from {runs}/ (the half that runs)"
                            + (f" - present in the other half ({a + b - hit}), which does not run" if a + b else ""))
    for m in opts.absent:
        a, b = count(src, m), count(ctl, m)
        hit = a if runs == "Src" else b
        marks.append({"marker": m, "want": "absent", "Src": a, "Controls": b, "ok": hit == 0})
        if hit:
            findings.append(f"{label}: marker {m!r} should be absent but appears {hit}x in {runs}/")
    r["markers"] = marks
    report["canvas_apps"].append(r)
    return r


def database_references(cx):
    """Every <DatabaseReferences> JSON blob in customizations.xml / a meta.xml."""
    out = []
    for m in re.finditer(r"<DatabaseReferences>(.*?)</DatabaseReferences>", cx, re.S):
        raw = m.group(1).strip()
        raw = raw.replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        try:
            out.append(json.loads(raw))
        except Exception:
            out.append(None)
    return out


def inspect_solution(zf, opts, findings, report):
    names = zf.namelist()
    if "solution.xml" not in names or "customizations.xml" not in names:
        raise ValueError("not a solution zip (no solution.xml / customizations.xml)")
    sx = zf.read("solution.xml").decode("utf-8", "replace")
    cx = zf.read("customizations.xml").decode("utf-8", "replace")
    m = re.search(r"<UniqueName>([^<]+)</UniqueName>", sx)
    v = re.search(r"<Version>([^<]+)</Version>", sx)
    managed = re.search(r"<Managed>(\d)</Managed>", sx)
    report["solution"] = {"unique_name": m and m.group(1), "version": v and v.group(1),
                          "managed": managed and managed.group(1) == "1"}

    roots = re.findall(r'<RootComponent\s+type="(\d+)"\s+(?:schemaName|id)="([^"]+)"', sx)
    by_type = {}
    for t, name in roots:
        by_type.setdefault(ROOT_TYPES.get(t, "type " + t), []).append(name)
    report["root_components"] = {k: len(v) for k, v in by_type.items()}

    # Metadata actually built: each declared entity must have an <Entity> element.
    built_entities = set(n.lower() for n in re.findall(r"<Entity>\s*<Name[^>]*>([^<]+)</Name>", cx))
    report["built_entities"] = len(built_entities)
    if by_type.get("Entity") and not built_entities:
        findings.append("SELF-CHECK: solution declares entities but none could be read from customizations.xml - "
                        "this inspector cannot read this artifact's layout; the entity check did not run")
    missing = [e for e in by_type.get("Entity", []) if e.lower() not in built_entities]
    if missing:
        findings.append(f"declared Entity root components with no built <Entity> element: {', '.join(missing[:10])}"
                        " - pac skipped them (look for 'unexpected children' in the pack log)")

    roles = re.findall(r"<Role\s[^>]*name=\"([^\"]+)\"", cx) + by_type.get("Role", [])
    report["security_roles"] = sorted(set(roles))
    if roles and not opts.allow_roles:
        findings.append(f"solution carries {len(set(roles))} security role(s) - importing it RESETS live access "
                        f"control. Strip Role components (or pass --allow-roles if this is deliberate)")

    wf_built = re.findall(r"<Workflow\s+WorkflowId=\"\{?([0-9a-fA-F-]+)\}?\"", cx)
    wf_files = [n for n in names if norm(n).startswith("Workflows/") and n.lower().endswith(".json")]
    report["workflows"] = {"declared": len(by_type.get("Workflow", [])), "built": len(wf_built), "files": len(wf_files)}
    for wid in wf_built:
        if not any(wid.lower() in n.lower() for n in wf_files):
            findings.append(f"workflow {wid} is in customizations.xml but no Workflows/*{wid}*.json is in the zip")

    refs = database_references(cx)
    apps = [n for n in names if n.lower().endswith(".msapp")]
    for i, n in enumerate(apps):
        app = inspect_msapp(zipfile.ZipFile(io.BytesIO(zf.read(n))), norm(n), opts, findings, report)
        ref = refs[i] if i < len(refs) else None
        if ref is None:
            findings.append(f"{norm(n)}: no readable <DatabaseReferences> - cannot confirm what the player initialises")
            continue
        player = {}
        for db in ref.values():
            for disp, v in (db.get("dataSources") or {}).items():
                player[disp] = v
        bound = app["_tables"]
        dead = sorted(set(bound) - set(player))
        if dead:
            findings.append(f"{norm(n)}: {len(dead)} data source(s) the app BINDS but the player will NOT initialise "
                            f"(dead in the published app): {', '.join(dead[:12])}")
        for disp, b in bound.items():
            p = player.get(disp)
            if p and b.get("set") and p.get("entitySetName") and p["entitySetName"] != b["set"]:
                findings.append(f"{norm(n)}: '{disp}' entity set differs - app {b['set']!r} vs player {p['entitySetName']!r}")
        app["player_initialises"] = len(player)
    if not roots and not apps:
        raise ValueError("the solution declares no root components and carries no canvas app - nothing to inspect")


# --------------------------------------------------------------------------- selftest
def _zip_bytes(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def _fixture_msapp(stamp=True, marker_half="Src", tables=("Assets", "Loans")):
    screen = 'Screens:\n  List:\n    Children:\n      - btnSave:\n          Control: Button\n'
    if stamp:
        screen += '# OnStart: =Set(gblBuildStamp, "2026-10-05.1")\n'
    ds = {"DataSources": [{"Type": "NativeCDSDataSourceInfo", "Name": t, "LogicalName": "pfx_" + t.lower()[:-1],
                           "EntitySetName": "pfx_" + t.lower()} for t in tables]
          + [{"Type": "OptionSetInfo", "Name": "Status"}]}
    files = {"References/DataSources.json": json.dumps(ds),
             "Header.json": "{}",
             "Controls/1.json": json.dumps({"TopParent": {"Name": "List"}})}
    files["packed.json"] = json.dumps({"LoadConfiguration": {"LoadFromYaml": True}})
    if marker_half == "Src":
        files["Src/List.pa.yaml"] = screen
    else:
        files["Src/List.pa.yaml"] = screen.replace("btnSave", "btnOther")
        files["Controls/2.json"] = json.dumps({"Name": "btnSave"})
    return _zip_bytes(files)


def _fixture_solution(entity_built=True, role=False, workflow_json=True, refs=("Assets", "Loans"), app=None):
    roots = '<RootComponent type="1" schemaName="pfx_asset" />'
    if role:
        roots += '<RootComponent type="20" id="{11111111-1111-1111-1111-111111111111}" />'
    roots += '<RootComponent type="29" id="{22222222-2222-2222-2222-222222222222}" />'
    sx = ('<ImportExportXml><SolutionManifest><UniqueName>PfxSolution</UniqueName><Version>1.0.0.1</Version>'
          '<Managed>0</Managed><RootComponents>' + roots + '</RootComponents></SolutionManifest></ImportExportXml>')
    dbref = json.dumps({"default.cds": {"dataSources": {t: {"entitySetName": "pfx_" + t.lower()} for t in refs}}})
    dbref = dbref.replace("&", "&amp;").replace('"', "&quot;")
    cx = ('<ImportExportXml><Entities>'
          + ('<Entity><Name LocalizedName="Asset">pfx_asset</Name></Entity>' if entity_built else '')
          + '</Entities>'
          + ('<Roles><Role id="{11111111-1111-1111-1111-111111111111}" name="Pfx Lender"/></Roles>' if role else '')
          + '<Workflows><Workflow WorkflowId="{22222222-2222-2222-2222-222222222222}" Name="Notify"/></Workflows>'
          + '<CanvasApps><CanvasApp><Name>pfx_app</Name><DatabaseReferences>' + dbref + '</DatabaseReferences></CanvasApp></CanvasApps>'
          + '</ImportExportXml>')
    files = {"solution.xml": sx, "customizations.xml": cx, "[Content_Types].xml": "<Types/>",
             "CanvasApps/pfx_app_DocumentUri.msapp": app if app is not None else _fixture_msapp()}
    if workflow_json:
        files["Workflows/Notify-22222222-2222-2222-2222-222222222222.json"] = "{}"
    return _zip_bytes(files)


def selftest():
    import contextlib
    import os
    import shutil
    import tempfile
    failures, ran = [], 0
    tmp = tempfile.mkdtemp(prefix="inspect-artifact-selftest-")

    def case(name, files_or_bytes, argv, want_rc, want_text=()):
        nonlocal ran
        ext = ".msapp" if name.startswith("msapp") else ".zip"
        p = os.path.join(tmp, name.replace(" ", "_") + ext)
        with open(p, "wb") as f:
            f.write(files_or_bytes)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = main([p] + argv)
        out = buf.getvalue()
        ran += 1
        missing = [t for t in want_text if t not in out]
        ok = rc == want_rc and not missing
        print("  %s  %s (exit %s%s)" % ("ok  " if ok else "FAIL", name, rc, "; missing " + repr(missing) if missing else ""))
        if not ok:
            failures.append(name)

    try:
        print("inspect-artifact selftest")
        case("msapp good", _fixture_msapp(), ["--expect", "btnSave", "--min-datasources", "2"], 0,
             ["LoadFromYaml=True", "build stamp: 2026-10-05.1", "Dataverse tables bound: 2", "no findings"])
        case("msapp marker only in the half that does not run", _fixture_msapp(marker_half="Controls"), ["--expect", "btnSave"], 1,
             ["missing from Src/", "present in the other half"])
        case("msapp no stamp and a dropped source", _fixture_msapp(stamp=False, tables=("Assets",)), ["--min-datasources", "2"], 1,
             ["no build stamp", "fewer than the live app's 2"])
        case("msapp absent marker present", _fixture_msapp(), ["--absent", "btnSave"], 1, ["should be absent"])
        case("solution good", _fixture_solution(), [], 0,
             ["solution  PfxSolution 1.0.0.1 (unmanaged)", "player initialises: 2", "no findings"])
        case("solution entity not built", _fixture_solution(entity_built=False), [], 1,
             ["SELF-CHECK"])
        case("solution carries a role", _fixture_solution(role=True), [], 1, ["RESETS live access"])
        case("solution role allowed", _fixture_solution(role=True), ["--allow-roles"], 0, ["no findings"])
        case("solution workflow without its json", _fixture_solution(workflow_json=False), [], 1, ["no Workflows/*"])
        case("solution app binds a source the player skips", _fixture_solution(refs=("Assets",)), [], 1,
             ["BINDS but the player will NOT initialise", "Loans"])
        case("not a zip", b"this is not a zip file", [], 2, ["NOT a pass"])
        case("zip that is not a solution", _zip_bytes({"readme.txt": "x"}), [], 2, ["not a solution zip"])
        empty = _zip_bytes({"solution.xml": "<ImportExportXml><SolutionManifest><UniqueName>E</UniqueName></SolutionManifest></ImportExportXml>",
                            "customizations.xml": "<ImportExportXml/>"})
        case("empty solution examined nothing", empty, [], 2, ["nothing to inspect"])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not ran:
        print("selftest examined nothing - NOT a pass")
        return 2
    print("selftest: %s" % ("PASSED (%d cases)" % ran if not failures else "FAILED %d: %s" % (len(failures), ", ".join(failures))))
    return 1 if failures else 0


def main(argv=None):
    if argv is None and "--selftest" in sys.argv[1:]:
        return selftest()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("artifact")
    ap.add_argument("--expect", default="")
    ap.add_argument("--absent", default="")
    ap.add_argument("--min-datasources", type=int)
    ap.add_argument("--stamp", default=r'Set\(\s*gbl\w*Build\w*\s*,\s*"([^"]+)"')
    ap.add_argument("--allow-roles", action="store_true")
    ap.add_argument("--json", action="store_true")
    opts = ap.parse_args(argv)
    opts.expect = [x for x in opts.expect.split(",") if x]
    opts.absent = [x for x in opts.absent.split(",") if x]

    findings, report = [], {"artifact": opts.artifact, "canvas_apps": []}
    try:
        zf = zipfile.ZipFile(opts.artifact)
        if opts.artifact.lower().endswith(".msapp"):
            inspect_msapp(zf, opts.artifact, opts, findings, report)
        else:
            inspect_solution(zf, opts, findings, report)
    except Exception as e:
        print(f"could not read {opts.artifact}: {e} - this is NOT a pass")
        return 2

    for a in report["canvas_apps"]:
        a.pop("_tables", None)
    report["findings"] = findings
    if opts.json:
        print(json.dumps(report, indent=2))
    else:
        s = report.get("solution")
        if s:
            print(f"solution  {s['unique_name']} {s['version']} ({'managed' if s['managed'] else 'unmanaged'})")
            print(f"  root components: {report['root_components']}")
            print(f"  security roles:  {len(report['security_roles'])}  workflows: {report['workflows']}")
        for a in report["canvas_apps"]:
            print(f"canvas    {a['name']}")
            print(f"  LoadFromYaml={a['LoadFromYaml']}  -> {a['authoritative_half']}/ runs   "
                  f"(Src {a['src_files']} files, Controls {a['controls_files']} files)")
            print(f"  build stamp: {a['build_stamp'] or '(none)'}")
            print(f"  Dataverse tables bound: {a['dataverse_tables']}"
                  + (f"   player initialises: {a['player_initialises']}" if 'player_initialises' in a else "")
                  + f"   option-set caches: {a['option_set_caches']}")
            for mk in a["markers"]:
                print(f"  {'ok ' if mk['ok'] else 'BAD'} {mk['want']:7} {mk['marker']!r}: Src {mk['Src']}  Controls {mk['Controls']}")
        print()
        if findings:
            print(f"{len(findings)} finding(s):")
            for f in findings:
                print("  - " + f)
        else:
            print("no findings. This proves what the artifact contains - not that the feature works.")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
