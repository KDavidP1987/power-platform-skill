"""Word-document furniture for an app's documentation set, plus the screenshot trim and the
inventory check. The formatting half only: the words live in a separate build script per
project (see build_guides_example.py), so prose can be edited without reading python-docx.

    python doc_kit.py --selftest                      build a sample document and check it
    python doc_kit.py trim <captures-dir> <out-dir>   crop player chrome from screenshots
    python doc_kit.py inventory <shots.json>          every required screen x role has a figure

Colours come from the app's own theme (canvas/theme.json, the file the theme intake writes), so
a page of the guide and the screen it describes look like the same product. Without a theme the
kit uses a neutral slate-and-blue default. Needs python-docx; trim needs Pillow.

The four rules that make python-docx output look professional (references/model-driven-and-docs.md,
section 4) are built in: numbered procedures restart at 1, TOC/PAGE/NUMPAGES are fields Word
evaluates on open, table headers repeat and rows never split, short tables and every figure stay
with their caption.
"""
import glob
import json
import os
import sys

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

CONTENT_WIDTH = Inches(6.7)
KEEP_TOGETHER_ROWS = 8      # a table this short is never split across pages

# Neutral default; replaced by the app's theme when one is given.
DEFAULT_THEME = {
    "primary": "1F4E79", "primaryDark": "16385A", "accent": "0F766E", "text": "1F2933",
    "muted": "52606D", "border": "CBD2D9", "canvas": "F5F7FA", "warning": "B45309", "font": "Segoe UI",
}
# theme.json token -> kit colour
TOKEN_MAP = {"clrPrimary": "primary", "clrAccent": "accent", "clrText": "text", "clrTextMuted": "muted",
             "clrBorder": "border", "clrCanvas": "canvas", "clrWarning": "warning"}


def load_theme(path=None):
    """The kit palette from an app theme.json (colours as rgba [r, g, b, a]); defaults otherwise."""
    t = dict(DEFAULT_THEME)
    if not path or not os.path.exists(path):
        return t
    with open(path, encoding="utf-8-sig") as f:
        j = json.load(f)
    for token, key in TOKEN_MAP.items():
        c = (j.get("colours") or {}).get(token)
        rgba = c.get("rgba") if isinstance(c, dict) else None
        if rgba and len(rgba) >= 3 and any(rgba[:3]):
            t[key] = "%02X%02X%02X" % tuple(int(x) for x in rgba[:3])
    if t["primary"] != DEFAULT_THEME["primary"]:
        r, g, b = (int(t["primary"][i:i + 2], 16) for i in (0, 2, 4))
        t["primaryDark"] = "%02X%02X%02X" % (int(r * .72), int(g * .72), int(b * .72))
    font = ((j.get("typography") or {}).get("fntBody") or "")
    if "'" in font:
        t["font"] = font.split("'")[1]
    return t


def _rgb(hex6):
    return RGBColor.from_string(hex6)


# --------------------------------------------------------------------- low-level XML ----
def _shade(cell, hex_fill):
    el = OxmlElement("w:shd")
    el.set(qn("w:val"), "clear")
    el.set(qn("w:fill"), hex_fill)
    cell._tc.get_or_add_tcPr().append(el)


def _cell_borders(cell, colour, size=4, sides=("top", "left", "bottom", "right")):
    tcPr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for side in sides:
        el = OxmlElement("w:" + side)
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), str(size))
        el.set(qn("w:color"), colour)
        borders.append(el)
    tcPr.append(borders)


def _no_borders(table):
    borders = OxmlElement("w:tblBorders")
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement("w:" + side)
        el.set(qn("w:val"), "none")
        borders.append(el)
    table._tbl.tblPr.append(borders)


def _field(paragraph, code, placeholder="", dirty=True):
    """A Word field (TOC, PAGE, NUMPAGES) that the reader's Word evaluates."""
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    if dirty:
        begin.set(qn("w:dirty"), "true")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = code
    sep = OxmlElement("w:fldChar")
    sep.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = placeholder
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for el in (begin, instr, sep, text, end):
        run._r.append(el)
    return run


def _rule(paragraph, colour, size=12, space=1):
    pPr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    for k, v in (("w:val", "single"), ("w:sz", str(size)), ("w:space", str(space)), ("w:color", colour)):
        bottom.set(qn(k), v)
    borders.append(bottom)
    pPr.append(borders)


def _keep_with_next(paragraph):
    paragraph._p.get_or_add_pPr().append(OxmlElement("w:keepNext"))


# ------------------------------------------------------------------------- the builder --
class Guide(object):
    """One document of the set: a user SOP, a manager or administrator guide, or the developer guide.

    meta is a list of (label, value) rows for the cover: audience, version, issued, app, owner.
    Put the version and issue date there - a guide without them cannot be matched to a build.
    """

    def __init__(self, title, subtitle, blurb, meta, shots_dir, running_head, org="", theme=None):
        self.t = theme or dict(DEFAULT_THEME)
        self.doc = Document()
        self.shots = shots_dir
        self.figure_no = 0
        self.table_no = 0
        self.figures = []
        self._styles()
        self._page()
        self._running_head(running_head)
        self._cover(title, subtitle, blurb, meta, org)
        self._contents()

    def _run(self, p, text, size, colour, bold=False, italic=False):
        r = p.add_run(text)
        r.font.size = Pt(size)
        r.font.color.rgb = _rgb(colour)
        r.font.name = self.t["font"]
        r.font.bold = bold
        r.italic = italic
        return r

    def _styles(self):
        st = self.doc.styles
        normal = st["Normal"]
        normal.font.name = self.t["font"]
        normal.font.size = Pt(10.5)
        normal.font.color.rgb = _rgb(self.t["text"])
        normal.paragraph_format.space_after = Pt(8)
        normal.paragraph_format.line_spacing = 1.16
        for name, size, colour, before, after in (("Heading 1", 18, "primary", 22, 8),
                                                  ("Heading 2", 13.5, "primaryDark", 16, 6),
                                                  ("Heading 3", 11.5, "text", 12, 4)):
            s = st[name]
            s.font.name = self.t["font"]
            s.font.size = Pt(size)
            s.font.color.rgb = _rgb(self.t[colour])
            s.font.bold = True
            s.paragraph_format.space_before = Pt(before)
            s.paragraph_format.space_after = Pt(after)
            s.paragraph_format.keep_with_next = True
        for name in ("List Bullet", "List Number"):
            s = st[name]
            s.font.name = self.t["font"]
            s.font.size = Pt(10.5)
            s.font.color.rgb = _rgb(self.t["text"])
            s.paragraph_format.space_after = Pt(4)
            s.paragraph_format.line_spacing = 1.14

    def _page(self):
        for section in self.doc.sections:
            for side in ("top_margin", "bottom_margin", "left_margin", "right_margin"):
                setattr(section, side, Inches(0.9))
            section.different_first_page_header_footer = True

    def _running_head(self, text):
        section = self.doc.sections[0]
        head = section.header.paragraphs[0]
        head.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        self._run(head, text, 8, self.t["muted"])
        _rule(head, self.t["border"], size=6, space=4)
        foot = section.footer.paragraphs[0]
        foot.alignment = WD_ALIGN_PARAGRAPH.CENTER
        self._run(foot, "Page ", 8, self.t["muted"])
        _field(foot, "PAGE", "1")
        self._run(foot, " of ", 8, self.t["muted"])
        _field(foot, "NUMPAGES", "1")

    def _cover(self, title, subtitle, blurb, meta, org):
        doc = self.doc
        doc.add_paragraph().paragraph_format.space_after = Pt(90)
        if org:
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(2)
            self._run(p, org.upper(), 10, self.t["muted"], bold=True)
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(14)
        self._run(p, title.upper(), 30, self.t["primary"], bold=True)
        _rule(p, self.t["accent"], size=18, space=6)
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(16)
        self._run(p, subtitle, 17, self.t["text"])
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(48)
        self._run(p, blurb, 11.5, self.t["muted"])
        table = doc.add_table(rows=0, cols=2)
        table.alignment = WD_TABLE_ALIGNMENT.LEFT
        _no_borders(table)
        for label, value in meta:
            row = table.add_row()
            row.cells[0].width = Inches(1.5)
            row.cells[1].width = Inches(5.2)
            self._run(row.cells[0].paragraphs[0], label.upper(), 8, self.t["muted"], bold=True)
            self._run(row.cells[1].paragraphs[0], value, 10, self.t["text"])
            for cell in row.cells:
                cell.paragraphs[0].paragraph_format.space_after = Pt(3)
        doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    def _contents(self):
        p = self.doc.add_paragraph()
        self._run(p, "Contents", 18, self.t["primary"], bold=True)
        _rule(p, self.t["border"], size=8, space=4)
        toc = self.doc.add_paragraph()
        toc.paragraph_format.space_before = Pt(8)
        _field(toc, 'TOC \\o "1-2" \\h \\z \\u', "The contents build when this document is opened in Word.")
        self.doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    # -- body ----------------------------------------------------------------------------
    def h1(self, text):
        self.doc.add_heading(text, level=1)

    def h2(self, text):
        self.doc.add_heading(text, level=2)

    def h3(self, text):
        self.doc.add_heading(text, level=3)

    def page_break(self):
        self.doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    def para(self, text, bold_lead=None):
        p = self.doc.add_paragraph()
        if bold_lead:
            p.add_run(bold_lead).bold = True
        p.add_run(text)
        return p

    def _item(self, p, item):
        if isinstance(item, tuple):
            p.add_run(item[0]).bold = True
            p.add_run(item[1])
        else:
            p.add_run(item)

    def bullets(self, items):
        for item in items:
            self._item(self.doc.add_paragraph(style="List Bullet"), item)

    def _fresh_numbering(self):
        """A new list instance restarting at 1 - otherwise every procedure continues the last one."""
        numbering = self.doc.part.numbering_part.numbering_definitions._numbering
        style_num = self.doc.styles["List Number"].element.pPr.numPr.numId.val
        abstract = numbering.num_having_numId(style_num).abstractNumId.val
        num = numbering.add_num(abstract)
        num.add_lvlOverride(ilvl=0).add_startOverride(1)
        return num.numId

    def steps(self, items):
        """A numbered procedure, from 1. Each item: a string, or (bold lead, remainder)."""
        num_id = self._fresh_numbering()
        for item in items:
            p = self.doc.add_paragraph(style="List Number")
            numPr = p._p.get_or_add_pPr().get_or_add_numPr()
            numPr.get_or_add_ilvl().val = 0
            numPr.get_or_add_numId().val = num_id
            self._item(p, item)

    def callout(self, heading, text, tone="info"):
        colour = {"info": self.t["primary"], "warn": self.t["warning"], "good": self.t["accent"]}[tone]
        table = self.doc.add_table(rows=1, cols=1)
        table.autofit = False
        cell = table.rows[0].cells[0]
        cell.width = CONTENT_WIDTH
        _shade(cell, self.t["canvas"])
        _cell_borders(cell, colour, size=18, sides=("left",))
        _cell_borders(cell, self.t["border"], size=4, sides=("top", "bottom", "right"))
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(2)
        self._run(p, heading, 10, colour, bold=True)
        body = cell.add_paragraph()
        body.paragraph_format.space_after = Pt(0)
        self._run(body, text, 10, self.t["text"])
        self.doc.add_paragraph().paragraph_format.space_after = Pt(2)

    def table(self, headers, rows, caption=None, widths=None):
        self.table_no += 1
        table = self.doc.add_table(rows=1, cols=len(headers))
        table.autofit = False
        hdr = table.rows[0]
        for i, text in enumerate(headers):
            cell = hdr.cells[i]
            _shade(cell, self.t["primary"])
            _cell_borders(cell, self.t["primary"])
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.space_before = Pt(2)
            self._run(p, text, 9, "FFFFFF", bold=True)
        for r, values in enumerate(rows):
            row = table.add_row()
            for i, text in enumerate(values):
                cell = row.cells[i]
                _cell_borders(cell, self.t["border"])
                if r % 2 == 1:
                    _shade(cell, self.t["canvas"])
                p = cell.paragraphs[0]
                p.paragraph_format.space_after = Pt(2)
                p.paragraph_format.space_before = Pt(2)
                self._run(p, str(text), 9.5, self.t["text"])
        if widths:
            for row in table.rows:
                for i, w in enumerate(widths):
                    row.cells[i].width = Inches(w)
        # Header repeats on every page; no row splits; a short table stays on one page.
        hdr._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
        for row in table.rows:
            row._tr.get_or_add_trPr().append(OxmlElement("w:cantSplit"))
        if len(table.rows) <= KEEP_TOGETHER_ROWS:
            for row in table.rows[:-1]:
                for cell in row.cells:
                    for p in cell.paragraphs:
                        p.paragraph_format.keep_with_next = True
        p = self.doc.add_paragraph()
        if caption:
            p.paragraph_format.space_before = Pt(3)
            self._run(p, "Table %d. %s" % (self.table_no, caption), 8.5, self.t["muted"], italic=True)
        return table

    def figure(self, filename, caption, width=None):
        """A screenshot from shots_dir with a numbered caption kept on its page. A missing file
        stops the build: a guide with a hole in it is not finished."""
        path = os.path.join(self.shots, filename)
        if not os.path.exists(path):
            raise SystemExit("missing screenshot: %s" % path)
        self.figure_no += 1
        self.figures.append(filename)
        holder = self.doc.add_paragraph()
        holder.alignment = WD_ALIGN_PARAGRAPH.CENTER
        holder.paragraph_format.space_before = Pt(6)
        holder.paragraph_format.space_after = Pt(3)
        _keep_with_next(holder)
        holder.add_run().add_picture(path, width=width or Inches(6.4))
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p.paragraph_format.space_after = Pt(12)
        self._run(p, "Figure %d. %s" % (self.figure_no, caption), 8.5, self.t["muted"], italic=True)

    def save(self, path):
        d = os.path.dirname(path)
        if d and not os.path.isdir(d):
            os.makedirs(d)
        self.doc.save(path)
        return path


# ------------------------------------------------------------------ screenshot trim ----
# A Power Apps capture arrives wrapped in the player's black command bar, a dark grey letterbox,
# and empty app background. Trimming it makes a screenshot look like a figure, not a monitor.
def _is_surround(px):
    r, g, b = px[:3]
    return abs(r - g) < 12 and abs(g - b) < 12 and r < 90


def _is_blank_row(im, y, w):
    px = im.load()
    row = [px[x, y] for x in range(w)]
    first = row[0]
    if min(first) < 200:
        return False
    return all(max(abs(px[i] - first[i]) for i in range(3)) <= 6 for px in row[::4])


def trim(path, out_path, foot_margin=12):
    """Crop one capture to the application itself. Returns (before, after) sizes. Falls back to
    the whole frame when detection leaves less than 200 px."""
    from PIL import Image
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    col = 8                                    # a column clear of any centred dialog
    top = 0
    while top < h and _is_surround(px[col, top]):
        top += 1
    bottom = h - 1
    while bottom > top and _is_surround(px[col, bottom]):
        bottom -= 1
    if bottom - top < 200:
        top, bottom = 0, h - 1
    while bottom > top + 200 and _is_blank_row(im, bottom, w):
        bottom -= 1
    bottom = min(h - 1, bottom + foot_margin)
    out = im.crop((0, top, w, bottom + 1))
    out.save(out_path)
    return (w, h), out.size


def trim_all(src_dir, dst_dir, pattern="*.png"):
    """Trim every capture into dst_dir. Never edits in place, so it can be re-run."""
    if not os.path.isdir(dst_dir):
        os.makedirs(dst_dir)
    done = 0
    for p in sorted(glob.glob(os.path.join(src_dir, pattern))):
        before, after = trim(p, os.path.join(dst_dir, os.path.basename(p)))
        print("  %-34s %sx%s -> %sx%s" % (os.path.basename(p), before[0], before[1], after[0], after[1]))
        done += 1
    print("trimmed %d into %s" % (done, dst_dir))
    return done


def cut_band(path, y_from, y_to, fill=(245, 247, 250)):
    """Remove a horizontal strip and close the gap - for a banner only one role can see."""
    from PIL import Image
    im = Image.open(path).convert("RGB")
    w, h = im.size
    head, tail = im.crop((0, 0, w, y_from)), im.crop((0, y_to, w, h))
    out = Image.new("RGB", (w, head.size[1] + tail.size[1]), fill)
    out.paste(head, (0, 0))
    out.paste(tail, (0, head.size[1]))
    out.save(path)
    return out.size


# ------------------------------------------------------------------ inventory check ----
def inventory(spec_path):
    """Check a shot list against what each guide needs. shots.json:
        {"shotsDir": "out/shots-trimmed",
         "shots": [{"file": "home-manager.png", "screen": "Home", "role": "Manager"}, ...],
         "required": {"user": {"roles": ["Employee"], "screens": ["Home", "My requests"]},
                      "manager": {...}, "admin": {...}}}
    Fails on a shot whose file is missing, and on any required (screen, role) with no shot.
    Returns the list of problems; an empty shot list is a failure, not a pass."""
    with open(spec_path, encoding="utf-8-sig") as f:
        spec = json.load(f)
    base = os.path.join(os.path.dirname(os.path.abspath(spec_path)), spec.get("shotsDir", "."))
    shots = spec.get("shots") or []
    problems = []
    if not shots:
        problems.append("no shots listed - an empty inventory is not a pass")
    have = set()
    for s in shots:
        if not os.path.exists(os.path.join(base, s["file"])):
            problems.append("missing file %s (%s as %s)" % (s["file"], s.get("screen"), s.get("role")))
        have.add((s.get("screen"), s.get("role")))
    for guide, need in (spec.get("required") or {}).items():
        for role in need.get("roles", []):
            for screen in need.get("screens", []):
                if (screen, role) not in have:
                    problems.append("%s guide: no shot of '%s' as %s" % (guide, screen, role))
    return problems


# ------------------------------------------------------------------------ self-test ----
def selftest():
    import tempfile
    import zipfile
    from PIL import Image, ImageDraw
    tmp = tempfile.mkdtemp(prefix="doc-kit-")
    fails = []
    # A fake capture: black bar, grey letterbox, a pale app with a block, then blank rows.
    raw = os.path.join(tmp, "raw")
    os.makedirs(raw)
    im = Image.new("RGB", (900, 700), (245, 247, 250))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 899, 39), fill=(20, 20, 20))
    d.rectangle((0, 40, 899, 79), fill=(60, 60, 60))
    d.rectangle((0, 660, 899, 699), fill=(60, 60, 60))
    d.rectangle((40, 120, 600, 400), fill=(31, 78, 121))
    im.save(os.path.join(raw, "home-user.png"))
    trimmed = os.path.join(tmp, "shots")
    trim_all(raw, trimmed)
    w, h = Image.open(os.path.join(trimmed, "home-user.png")).size
    if not (h < 700 and h > 300):
        fails.append("trim: expected the chrome and blank tail removed, got height %d" % h)
    theme = os.path.join(tmp, "theme.json")
    with open(theme, "w") as f:
        json.dump({"colours": {"clrPrimary": {"rgba": [11, 83, 148, 1]}}, "typography": {"fntBody": "Font.'Segoe UI'"}}, f)
    t = load_theme(theme)
    if t["primary"] != "0B5394":
        fails.append("theme: primary not read from theme.json (%s)" % t["primary"])
    g = Guide("Sample app", "User guide", "How to use the sample app.", [("Audience", "Users"), ("Version", "1.0"), ("Issued", "1 January 2030")],
              trimmed, "Sample app - User guide", org="Example organisation", theme=t)
    g.h1("1. Getting started")
    g.steps(["Open the app.", ("Choose ", "New request.")])
    g.h2("1.1 A second procedure")
    g.steps(["This list must start at 1 again.", "Second step."])
    g.callout("Note", "Callouts carry a tone.", "warn")
    g.table(["Column", "Meaning"], [["A", "first"], ["B", "second"]], caption="A short table")
    g.figure("home-user.png", "Home, as a user")
    out = g.save(os.path.join(tmp, "out", "sample.docx"))
    with zipfile.ZipFile(out) as z:
        xml = z.read("word/document.xml").decode("utf-8")
        numbering = z.read("word/numbering.xml").decode("utf-8")
    checks = [("TOC field", 'TOC \\o' in xml), ("repeating table header", "w:tblHeader" in xml),
              ("rows kept whole", "w:cantSplit" in xml), ("figure caption", "Figure 1. Home, as a user" in xml),
              ("table caption", "Table 1. A short table" in xml), ("restart at 1", numbering.count("w:startOverride") >= 2),
              ("image embedded", "graphicData" in xml)]
    fails += ["docx: %s" % name for name, ok in checks if not ok]
    try:
        g.figure("absent.png", "x")
        fails.append("figure: a missing screenshot must stop the build")
    except SystemExit:
        pass
    spec = os.path.join(tmp, "shots.json")
    with open(spec, "w") as f:
        json.dump({"shotsDir": "shots", "shots": [{"file": "home-user.png", "screen": "Home", "role": "User"}],
                   "required": {"user": {"roles": ["User"], "screens": ["Home"]}}}, f)
    if inventory(spec):
        fails.append("inventory: a complete list should pass, got %s" % inventory(spec))
    with open(spec, "w") as f:
        json.dump({"shotsDir": "shots", "shots": [{"file": "home-user.png", "screen": "Home", "role": "User"},
                                                  {"file": "gone.png", "screen": "Admin", "role": "Administrator"}],
                   "required": {"manager": {"roles": ["Manager"], "screens": ["Home"]}}}, f)
    if len(inventory(spec)) != 2:
        fails.append("inventory: expected a missing file and a missing (screen, role), got %s" % inventory(spec))
    with open(spec, "w") as f:
        json.dump({"shots": []}, f)
    if not inventory(spec):
        fails.append("inventory: an empty shot list must fail")
    if fails:
        print("selftest FAILED:\n  " + "\n  ".join(fails))
        return 1
    print("selftest ok: theme read, trim, cover/contents/steps restart/callout/table/figure built and found in the docx, "
          "missing figure stops the build, inventory passes complete / fails 2 gaps / fails empty")
    return 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["--selftest"]:
        sys.exit(selftest())
    if len(a) >= 3 and a[0] == "trim":
        trim_all(a[1], a[2])
    elif len(a) >= 2 and a[0] == "inventory":
        probs = inventory(a[1])
        for p in probs:
            print("MISSING  " + p)
        print("inventory: %s" % ("ok" if not probs else "%d problem(s)" % len(probs)))
        sys.exit(1 if probs else 0)
    else:
        raise SystemExit(__doc__.strip())
