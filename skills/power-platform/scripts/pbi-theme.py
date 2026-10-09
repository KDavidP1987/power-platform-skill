#!/usr/bin/env python3
"""pbi-theme.py - turn the app's design tokens (theme.json, the same file the canvas app's tokens
come from) into a Power BI report theme, check it, and install it into a PBIR report folder.

One palette for the app and the report: a report left on the default theme ships the default
purple-led data colours and does not look like the app it sits beside.

Usage:
    python pbi-theme.py --tokens theme.json                          print the theme JSON
    python pbi-theme.py --tokens theme.json --out fabric/pbi-theme.json
    python pbi-theme.py --tokens theme.json --report fabric/report    plan: what it would change
    python pbi-theme.py --tokens theme.json --report fabric/report --apply

--report is a PBIR report definition folder (definition.pbir, definition/report.json). --apply
writes StaticResources/RegisteredResources/<name>.json and registers it in report.json as the
custom theme (baseTheme kept). Deploy the report afterwards (fabric.py deploy) and screenshot it:
the theme is proven when the published report shows it.

Tokens (assets/templates/theme.json): "colours" maps clrPrimary, clrAccent, clrText, clrTextMuted,
clrBorder, clrCanvas, clrSurface, clrSuccess, clrWarning, clrError, clrOnPrimary to {"rgba": [r, g,
b, a]} or "#rrggbb". Optional "dataColors": a list of hex colours for series, in order; without it
the series colours start from clrPrimary and clrAccent and continue with a fixed professional set
(blue, teal, slate, amber, green). Optional "typography.fntBody" picks the font family. Callout,
title and header use the family's Semibold face only where Power BI has one (Segoe UI); any other
family keeps its plain face, because a made-up face such as "Arial Semibold" falls back silently.

Checks (any failure stops the run with exit 1 and writes nothing):
  - no purple, violet, indigo or magenta in any colour (hue 255-335 degrees with visible saturation)
  - body text on canvas and on surface, and clrOnPrimary on clrPrimary, at least 4.5:1
  - unset tokens (the template's zeros) are refused

Options:
    --name NAME     theme name (default "AppTheme")
    --selftest      offline tests

Exit: 0 written/printed; 1 a check failed; 2 cannot run (missing file, bad JSON, not a PBIR folder).
"""
import argparse
import colorsys
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REQUIRED = ["clrPrimary", "clrAccent", "clrText", "clrTextMuted", "clrBorder", "clrCanvas", "clrSurface",
            "clrSuccess", "clrWarning", "clrError", "clrOnPrimary"]
# Series colours after the brand pair: blue, teal, slate, amber, green, steel, rust, sea.
FALLBACK_SERIES = ["#2563EB", "#0F766E", "#475569", "#B45309", "#15803D", "#0369A1", "#B91C1C", "#0E7490"]
# Heavier faces Power BI really has, by family. A face that is not on the service's list (for
# example "Arial Semibold") is not refused: text silently falls back to the default font. So a
# family missing here keeps its plain face in every class, and weight comes from size instead.
SEMIBOLD_FACE = {"Segoe UI": "Segoe UI Semibold"}
REPORT_VERSION = {"visual": "1.8.95", "report": "2.0.95", "page": "1.3.95"}


class CheckFailed(Exception):
    pass


def hexof(v):
    if isinstance(v, dict):
        v = v.get("rgba") or v.get("hex")
    if isinstance(v, str):
        v = v.strip()
        if len(v) == 7 and v.startswith("#"):
            return v.upper()
        raise ValueError("not a #rrggbb colour: %r" % v)
    if isinstance(v, (list, tuple)) and len(v) >= 3:
        return "#%02X%02X%02X" % tuple(int(round(float(x))) for x in v[:3])
    raise ValueError("not a colour: %r" % (v,))


def rgb(h):
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (1, 3, 5))


def luminance(h):
    def ch(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def is_purple(h):
    r, g, b = rgb(h)
    hue, light, sat = colorsys.rgb_to_hls(r, g, b)
    return 255 <= hue * 360 <= 335 and sat >= 0.2 and 0.12 <= light <= 0.92


def build(tokens, name):
    cols = tokens.get("colours") or tokens.get("colors") or {}
    problems, c = [], {}
    for k in REQUIRED:
        if k not in cols:
            problems.append("%s missing" % k)
            continue
        try:
            c[k] = hexof(cols[k])
        except ValueError as e:
            problems.append("%s: %s" % (k, e))
    if problems:
        raise CheckFailed("; ".join(problems))
    if len(set(c.values())) <= 2:
        raise CheckFailed("the tokens are not set yet (template values); agree the palette first")
    series = [hexof(x) for x in tokens.get("dataColors") or []] or \
        [c["clrPrimary"], c["clrAccent"]] + [x for x in FALLBACK_SERIES if x not in (c["clrPrimary"], c["clrAccent"])]
    purple = sorted({"%s %s" % (k, v) for k, v in list(c.items()) + [("dataColors", s) for s in series] if is_purple(v)})
    if purple:
        problems.append("purple/violet/magenta colour(s): %s" % ", ".join(purple))
    for text, on in (("clrText", "clrCanvas"), ("clrText", "clrSurface"), ("clrOnPrimary", "clrPrimary")):
        r = contrast(c[text], c[on])
        if r < 4.5:
            problems.append("%s on %s is %.2f:1 (needs 4.5:1)" % (text, on, r))
    if problems:
        raise CheckFailed("; ".join(problems))
    font = str(((tokens.get("typography") or {}).get("fntBody") or "Segoe UI"))
    font = font.replace("Font.", "").strip("'\" ") or "Segoe UI"
    strong = SEMIBOLD_FACE.get(font, font)
    solid = lambda h: {"solid": {"color": h}}  # noqa: E731
    return {
        "name": name,
        "dataColors": series[:12],
        "background": c["clrSurface"], "foreground": c["clrText"], "tableAccent": c["clrPrimary"],
        "good": c["clrSuccess"], "neutral": c["clrWarning"], "bad": c["clrError"],
        "maximum": c["clrPrimary"], "center": c["clrBorder"], "minimum": c["clrSurface"],
        "textClasses": {
            "callout": {"fontSize": 28, "fontFace": strong, "color": c["clrText"]},
            "title": {"fontSize": 13, "fontFace": strong, "color": c["clrText"]},
            "header": {"fontSize": 12, "fontFace": strong, "color": c["clrText"]},
            "label": {"fontSize": 10, "fontFace": font, "color": c["clrTextMuted"]},
        },
        "visualStyles": {
            "*": {"*": {
                "title": [{"show": True, "fontFamily": font, "fontSize": 12, "fontColor": solid(c["clrText"])}],
                "background": [{"show": True, "color": solid(c["clrSurface"]), "transparency": 0}],
                "border": [{"show": True, "color": solid(c["clrBorder"]), "radius": 6}],
                "dropShadow": [{"show": False}],
                "visualHeader": [{"foreground": solid(c["clrTextMuted"]), "background": solid(c["clrSurface"])}],
            }},
            "page": {"*": {"background": [{"color": solid(c["clrCanvas"]), "transparency": 0}],
                           "outspace": [{"color": solid(c["clrCanvas"])}]}},
            "tableEx": {"*": {"columnHeaders": [{"fontColor": solid(c["clrText"]), "backColor": solid(c["clrCanvas"]),
                                                 "fontFamily": strong}],
                              "values": [{"fontColor": solid(c["clrText"]), "backColor": solid(c["clrSurface"]),
                                          "backColorSecondary": solid(c["clrCanvas"])}]}},
        },
    }


def install(report_dir, theme, apply):
    rj = os.path.join(report_dir, "definition", "report.json")
    if not os.path.isfile(rj):
        raise FileNotFoundError("%s is not a PBIR report folder (definition/report.json missing)" % report_dir)
    with open(rj, encoding="utf-8-sig") as f:
        report = json.load(f)
    fname = theme["name"] + ".json"
    res_path = os.path.join(report_dir, "StaticResources", "RegisteredResources", fname)
    tc = report.setdefault("themeCollection", {})
    tc["customTheme"] = {"name": fname, "reportVersionAtImport": (tc.get("baseTheme") or {}).get(
        "reportVersionAtImport", REPORT_VERSION), "type": "RegisteredResources"}
    pkgs = report.setdefault("resourcePackages", [])
    reg = next((p for p in pkgs if p.get("type") == "RegisteredResources"), None)
    if not reg:
        reg = {"name": "RegisteredResources", "type": "RegisteredResources", "items": []}
        pkgs.append(reg)
    reg["items"] = [i for i in reg.get("items") or [] if i.get("type") != "CustomTheme"] + \
        [{"name": fname, "path": fname, "type": "CustomTheme"}]
    if not apply:
        print("would write %s" % os.path.relpath(res_path, report_dir))
        print("would register %s as the custom theme in definition/report.json" % fname)
        print("plan only: nothing was written. Re-run with --apply.")
        return
    os.makedirs(os.path.dirname(res_path), exist_ok=True)
    with open(res_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(theme, f, indent=2)
    with open(rj, "w", encoding="utf-8", newline="\n") as f:
        json.dump(report, f, indent=2)
    print("wrote %s and registered it in definition/report.json" % os.path.relpath(res_path, report_dir))


def run(argv):
    ap = argparse.ArgumentParser(prog="pbi-theme.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("--tokens")
    ap.add_argument("--name", default="AppTheme")
    ap.add_argument("--out")
    ap.add_argument("--report")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.tokens:
        ap.print_help()
        return 2
    try:
        with open(a.tokens, encoding="utf-8-sig") as f:
            tokens = json.load(f)
        theme = build(tokens, a.name)
    except (OSError, ValueError) as e:
        print("cannot run: %s" % e)
        return 2
    except CheckFailed as e:
        print("REFUSED: %s" % e)
        return 1
    if a.report:
        try:
            install(a.report, theme, a.apply)
        except (OSError, ValueError) as e:
            print("cannot run: %s" % e)
            return 2
    if a.out:
        with open(a.out, "w", encoding="utf-8", newline="\n") as f:
            json.dump(theme, f, indent=2)
        print("wrote %s" % a.out)
    if not a.report and not a.out:
        print(json.dumps(theme, indent=2))
    return 0


def selftest():
    import io
    import shutil
    import tempfile
    failures = []

    def check(name, cond):
        print("  %s  %s" % ("ok  " if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    good = {"colours": {"clrPrimary": {"rgba": [0, 84, 147, 1]}, "clrAccent": "#0F766E", "clrText": "#1F2933",
                        "clrTextMuted": "#52606D", "clrBorder": "#CBD2D9", "clrCanvas": "#F5F7FA",
                        "clrSurface": "#FFFFFF", "clrSuccess": "#15803D", "clrWarning": "#B45309",
                        "clrError": "#B91C1C", "clrOnPrimary": "#FFFFFF"},
            "typography": {"fntBody": "Font.'Segoe UI'"}}
    tmp = tempfile.mkdtemp(prefix="pbi-theme-selftest-")

    def go(*args):
        buf, old = io.StringIO(), sys.stdout
        sys.stdout = buf
        try:
            rc = run(list(args))
        finally:
            sys.stdout = old
        return rc, buf.getvalue()

    def tok(t):
        p = os.path.join(tmp, "theme.json")
        with open(p, "w") as f:
            json.dump(t, f)
        return p

    try:
        rc, out = go("--tokens", tok(good))
        th = json.loads(out)
        check("a good palette builds a theme", rc == 0 and th["dataColors"][0] == "#005493")
        check("no default purple in the series", not any(is_purple(x) for x in th["dataColors"]))
        check("font taken from the tokens", th["textClasses"]["label"]["fontFace"] == "Segoe UI")
        check("Segoe UI headings use the real Semibold face",
              th["textClasses"]["title"]["fontFace"] == "Segoe UI Semibold")
        arial = json.loads(json.dumps(good))
        arial["typography"]["fntBody"] = "Font.Arial"
        rc, out = go("--tokens", tok(arial))
        faces = [v["fontFace"] for v in json.loads(out)["textClasses"].values()] +             [json.loads(out)["visualStyles"]["tableEx"]["*"]["columnHeaders"][0]["fontFamily"]]
        check("Arial is never given a made-up 'Arial Semibold' face",
              rc == 0 and set(faces) == {"Arial"} and "Semibold" not in out)
        check("the fallback series has no purple", not any(is_purple(x) for x in FALLBACK_SERIES))
        check("the default Power BI purple is detected", is_purple("#744EC2") and is_purple("#B845A7")
              and not is_purple("#118DFF") and not is_purple("#0F766E"))
        bad = json.loads(json.dumps(good))
        bad["colours"]["clrAccent"] = "#7C3AED"
        rc, out = go("--tokens", tok(bad))
        check("a violet accent is refused", rc == 1 and "clrAccent #7C3AED" in out)
        low = json.loads(json.dumps(good))
        low["colours"]["clrText"] = "#B0B0B0"
        rc, out = go("--tokens", tok(low))
        check("low-contrast text is refused", rc == 1 and "clrText on clrCanvas" in out)
        rc, out = go("--tokens", tok({"colours": {k: {"rgba": [0, 0, 0, 1]} for k in REQUIRED}}))
        check("template zeros are refused", rc == 1 and "not set yet" in out)

        rep = os.path.join(tmp, "report")
        os.makedirs(os.path.join(rep, "definition"))
        with open(os.path.join(rep, "definition", "report.json"), "w") as f:
            json.dump({"themeCollection": {"baseTheme": {"name": "CY24SU10", "type": "SharedResources",
                                                         "reportVersionAtImport": REPORT_VERSION}}}, f)
        rc, out = go("--tokens", tok(good), "--report", rep)
        check("--report without --apply writes nothing", rc == 0 and "would write" in out
              and not os.path.exists(os.path.join(rep, "StaticResources")))
        rc, out = go("--tokens", tok(good), "--report", rep, "--apply")
        with open(os.path.join(rep, "definition", "report.json")) as f:
            r = json.load(f)
        check("--apply writes the resource and registers it", rc == 0
              and os.path.isfile(os.path.join(rep, "StaticResources", "RegisteredResources", "AppTheme.json"))
              and r["themeCollection"]["customTheme"]["name"] == "AppTheme.json"
              and r["themeCollection"]["baseTheme"]["name"] == "CY24SU10")
        rc, out = go("--tokens", tok(good), "--report", rep, "--apply")
        with open(os.path.join(rep, "definition", "report.json")) as f:
            r = json.load(f)
        items = [i for p in r["resourcePackages"] for i in p["items"]]
        check("re-applying does not duplicate the registration", len(items) == 1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print()
    print("selftest: %s" % ("PASSED" if not failures else "FAILED %d: %s" % (len(failures), ", ".join(failures))))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
