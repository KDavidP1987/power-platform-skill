"""
check-new-galleries.py - name every Gallery in the repo's canvas source that the LIVE app does not have.

Why: in October 2026 (Studio 3.26094.x) a gallery CREATED from .pa.yaml source broke a published app
while every gate was green - compile, audits, the package markers, the column cache. The player stopped
part-way through App.OnStart, and pushing the same source into Studio tore the editor down ("An error
occured while selecting the store state: Cannot read properties of undefined (reading 'get')"). A
minimal invisible gallery with one label reproduced it. UPDATING a gallery the app already has worked,
and so did a gallery inserted through Studio's Insert menu and then filled from source. Two projects hit
the teardown the same week; new galleries had shipped from source a month earlier, so it reads as a
platform regression. Until it is shown fixed, run this before any ship that adds a gallery.

The workaround, measured twice with no teardown (against eight crashing cycles before it), in this order:
  1. Push the change WITHOUT the new gallery, and save.
  2. Studio: Insert > Blank vertical gallery on the target screen, rename it to the source's name, save.
  3. Push the full source (the gallery and its children); the Tree view must stay up. Save and Publish.
  4. Re-ship from git, then open the published app and check that its first screen renders signed-in data.
A driver command for the Studio steps is on the roadmap; today they are done by hand in Studio.

What it compares: gallery names in the repo's Src against the galleries the live app already knows -
the named controls in the live package's compiled half (msapp/Controls/*.json; a Studio publish writes a
new gallery there) and its Src half. `pac canvas download` + `pac canvas unpack --layout SourceCode`
writes the live Src BESIDE the .msapr, not inside it, and Controls/*.json only holds controls as of the
last Studio publish - so pass that unpacked folder with --live-src, or every gallery created from source
since the last Studio publish reads as new.

Usage:
    python check-new-galleries.py <live .msapr or .msapp> <repo Src dir> [--live-src <unpacked Src dir>]
    python check-new-galleries.py --selftest

Exit: 0 no new gallery; 1 a new gallery (stop the ship and use the workaround); 2 cannot run, or no
.pa.yaml in the repo Src (nothing was compared - not a pass). Python 3 standard library only.
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import zipfile

GALLERY_RX = re.compile(r"^\s*- ([\w]+):\s*\r?\n\s*Control: Gallery\b", re.M)


def src_galleries(text):
    return set(GALLERY_RX.findall(text))


def live_galleries(package):
    names = set()
    with zipfile.ZipFile(package) as z:
        for n in z.namelist():
            low = n.replace("\\", "/")
            if "/Controls/" in "/" + low and low.endswith(".json"):
                try:
                    doc = json.loads(z.read(n).decode("utf-8-sig"))
                except ValueError:
                    continue

                def walk(c):
                    if "gallery" in ((c.get("Template") or {}).get("Name") or "").lower() and c.get("Name"):
                        names.add(c["Name"])
                    for ch in c.get("Children") or []:
                        walk(ch)
                walk(doc.get("TopParent") or {})
            elif low.endswith(".pa.yaml"):
                names |= src_galleries(z.read(n).decode("utf-8-sig"))
    return names


def folder_galleries(folder):
    found = {}
    for root, _, files in os.walk(folder):
        for f in sorted(files):
            if f.endswith(".pa.yaml"):
                with open(os.path.join(root, f), encoding="utf-8-sig") as fh:
                    for g in src_galleries(fh.read()):
                        found.setdefault(g, f)
    return found


def run(argv):
    ap = argparse.ArgumentParser(prog="check-new-galleries.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("package", nargs="?")
    ap.add_argument("src", nargs="?")
    ap.add_argument("--live-src")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.package or not a.src:
        ap.print_help()
        return 2
    try:
        live = live_galleries(a.package)
    except (OSError, zipfile.BadZipFile) as e:
        print("cannot read the live package %s: %s" % (a.package, e))
        return 2
    if a.live_src:
        live |= set(folder_galleries(a.live_src))
    if not any(f.endswith(".pa.yaml") for _, _, fs in os.walk(a.src) for f in fs):
        print("no .pa.yaml under %s - nothing was compared (not a pass)" % a.src)
        return 2
    repo = folder_galleries(a.src)
    new = sorted(g for g in repo if g not in live)
    print("galleries in source: %d   known to the live app: %d%s" % (
        len(repo), len(live), "" if a.live_src else "   (no --live-src: galleries shipped from source since the last Studio publish may read as new)"))
    if not new:
        print("  no new gallery")
        return 0
    for g in new:
        print("NEW %s (%s) does not exist in the live app" % (g, repo[g]))
    print("\nA gallery created from source broke a published app (Studio 3.26094.x, October 2026).\n"
          "Insert it in Studio first: Insert > Vertical gallery, rename it to the name above, push the source,\n"
          "Save and Publish from Studio, then ship from git again (references/canvas-shipping.md).")
    return 1


def selftest():
    tmp = tempfile.mkdtemp(prefix="new-galleries-")
    fails = []
    try:
        pkg = os.path.join(tmp, "live.msapp")
        with zipfile.ZipFile(pkg, "w") as z:
            z.writestr("Controls/1.json", json.dumps({"TopParent": {"Name": "scrOrders", "Template": {"Name": "screen"},
                       "Children": [{"Name": "galOrders", "Template": {"Name": "gallery"}, "Children": []}]}}))
        src = os.path.join(tmp, "Src")
        os.makedirs(src)
        screen = "Screens:\n  scrOrders:\n    Children:\n      - galOrders:\n          Control: Gallery@2.15.0\n"
        with open(os.path.join(src, "scrOrders.pa.yaml"), "w", encoding="utf-8") as f:
            f.write(screen)
        if run([pkg, src]) != 0:
            fails.append("a gallery the live app has passes")
        with open(os.path.join(src, "scrOrders.pa.yaml"), "w", encoding="utf-8") as f:
            f.write(screen + "      - galVendors:\n          Control: Gallery@2.15.0\n")
        if run([pkg, src]) != 1:
            fails.append("a new gallery fails")
        live_src = os.path.join(tmp, "LiveSrc")
        os.makedirs(live_src)
        with open(os.path.join(live_src, "scrOrders.pa.yaml"), "w", encoding="utf-8") as f:
            f.write("Screens:\n  scrOrders:\n    Children:\n      - galVendors:\n          Control: Gallery\n")
        if run([pkg, src, "--live-src", live_src]) != 0:
            fails.append("a gallery in the unpacked live Src (beside the .msapr) is not new")
        empty = os.path.join(tmp, "Empty")
        os.makedirs(empty)
        if run([pkg, empty]) != 2:
            fails.append("an empty Src is exit 2, not a pass")
        if run([os.path.join(tmp, "missing.msapp"), src]) != 2:
            fails.append("a missing package is exit 2")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("selftest: %s" % ("PASSED (5 cases)" if not fails else "FAILED: " + "; ".join(fails)))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
