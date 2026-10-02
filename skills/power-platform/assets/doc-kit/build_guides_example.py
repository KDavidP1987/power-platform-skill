"""The words half of an app's documentation set: four guides, built on doc_kit.py.

Copy this file into the project (scripts/build-guides.py, beside doc_kit.py and shots.json),
replace every <angle-bracket> with what the app's SOURCE and LIVE environment say, and delete
chapters that do not apply. The structure is the standard (references/documentation-set.md); the
sentences here are prompts, not content.

    python build-guides.py            final build: every figure must exist
    python build-guides.py --draft    missing figures become a visible "capture needed" box

then, from the same folder:

    python doc_kit.py inventory shots.json --build "<stamp>" --figures "../out/*.figures.json"
    python doc_kit.py finish ../out              fields, contents, PDF, page counts (Word)
    python doc_kit.py render ../out ../out/pages  every page as an image: read them all

Chapters used by more than one guide are written ONCE, as functions taking the document and the
chapter number, so the guides cannot drift apart on how a screen behaves.

Every path is relative to this file, never to the current directory. The captures folder is
shots.json's shotsDir, resolved against shots.json, so the build and the inventory read the same
files. Output goes to out/ (git-ignored): screenshots carry people's names, even test ones look real.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from doc_kit import Guide, load_shots, load_theme, shots_dir  # noqa: E402

ROOT = os.path.normpath(os.path.join(HERE, ".."))
APP = "<App name>"
ORG = "<Organisation or team>"           # "" for none
VERSION = "Version <1.0>"
ISSUED = "<issue date>"
SHOTS_JSON = os.path.join(HERE, "shots.json")
if not os.path.exists(SHOTS_JSON):                     # run in place, from the kit
    SHOTS_JSON = os.path.join(HERE, "shots.example.json")
BUILD = load_shots(SHOTS_JSON).get("build", "<build stamp shown in the app>")   # one stamp, one place
THEME = os.path.join(ROOT, "canvas", "theme.json")      # the app's theme, so the guides match the product
SHOTS = shots_dir(SHOTS_JSON)
OUT = os.path.join(ROOT, "out")
MANIFEST = os.path.join(ROOT, "<scripts/dataverse/tables.json>")     # the build manifest, for column tables
LIVE_COLUMNS = os.path.join(OUT, "<live-columns.json>")              # attributes read on the stated date
LINT = os.path.join(OUT, "<lint-flows.json>")                        # node lint-flows.mjs <flows> --json > this
DRAFT = "--draft" in sys.argv


def out_name(kind):
    """out/<App>-Guide-<Kind>.docx, with anything a file system refuses removed."""
    slug = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in APP.replace(" ", "-")).strip("-") or "App"
    return os.path.join(OUT, "%s-Guide-%s.docx" % (slug, kind))


def doc(kind, audience, blurb):
    return Guide("%s" % APP, "%s guide" % kind, blurb,
                 [("Audience", audience), ("Version", VERSION), ("Issued", ISSUED),
                  ("Build", BUILD + " (the build every screenshot was taken on)")],
                 SHOTS, "%s - %s guide" % (APP, kind), org=ORG, theme=load_theme(THEME),
                 build=BUILD, draft=DRAFT)


def fig(d, name, caption, width=None):
    """A figure; in a draft a missing capture becomes a visible box. width: "full" (default),
    "wide", "half", "narrow", or "email" for a reading-pane capture of a message."""
    d.figure(name, caption, width)


def efig(d, name, caption):
    fig(d, name, caption, "email")


# ================================================ shared chapters (written once) ==========
def ch_opening(d, n):
    d.h1("%d. Opening the app" % n)
    d.para("<Where the app lives (link, Teams tab), which browsers, the supported screen size.>")
    d.steps(["<Open ...>", "<Sign in with ...>", "<What the first screen shows and why>"])
    fig(d, "home-<role>.png", "Home, as <role>")


def ch_who_sees_what(d, n):
    d.h1("%d. What each role can see and do" % n)
    d.para("<Read from each control's Visible/DisplayMode and the live security roles - never from what an admin account shows.>")
    d.table(["Role", "Sees", "Can change"], [["<role>", "<screens>", "<actions>"]], caption="Roles and what they unlock")


def ch_messages(d, n):
    d.h1("%d. Messages the app sends" % n)
    d.para("<Every email/Teams message: when it is sent, to whom, what it contains, how to resend it, where its history is.>")
    d.table(["Message", "Sent when", "To", "Resend"], [["<kind>", "<trigger>", "<recipient>", "<button / not possible>"]])


def ch_glossary(d, n):
    d.h1("%d. Glossary" % n)
    d.table(["Term", "Meaning"], [["<term as the app labels it>", "<meaning>"]])


def ch_help(d, n):
    d.h1("%d. Getting help" % n)
    d.para("<Who to contact, what to include (screenshot, record name, build stamp).>")


# ======================================================================= the guides ======
def user_guide():
    d = doc("User", "<Everyone who uses the app day to day>", "<One sentence: what the app is for, for this reader.>")
    d.h1("1. About this guide")
    d.para("<Who it is for, which role's screens it shows, the build on the cover, and that a role sees only "
           "its own buttons. Name the role the captures were taken as if it is not the reader's.>")
    d.h1("2. Before you begin")
    d.bullets(["<What the reader needs: a licence, a security role, the app shared with them, a roster row>",
               "<The supported browsers and screen size>"])
    d.h2("2.1 If the app does not recognise you")
    d.para("<What the reader sees when they are not set up (the app's own message, quoted), and who to ask.>")
    ch_opening(d, 3)
    d.h1("4. <The main task, as a verb: Raise a request>")
    d.para("<One line on when to do this.>")
    d.steps(["<Press 'New request' (the button's own text)>", "<Fill ...>", "<Press 'Submit'>"])
    fig(d, "new-request-<role>.png", "<Caption>")
    d.callout("What happens next", "<Who is told, what status the record takes, what the reader sees.>")
    d.h1("5. <Second task>")
    d.h1("6. Statuses and what they mean")
    d.table(["Status", "Meaning", "What you do"], [["<label>", "<meaning>", "<action>"]], caption="Statuses")
    ch_messages(d, 7)
    d.h1("8. Quick reference")
    d.table(["To", "Go to", "Press"], [["<task, as a verb>", "<screen>", "<button's own text>"]],
            caption="Every task on one page")
    d.h1("9. Common questions")
    d.para("<The question as a reader asks it?>", bold_lead="Q. ")
    d.para("<The answer, with the button or screen named exactly.>", bold_lead="A. ")
    ch_glossary(d, 10)
    ch_help(d, 11)
    return d.save(out_name("Users"))


def manager_guide():
    d = doc("Manager", "<People who approve, assign or oversee others' records>", "<For managers: ...>")
    ch_opening(d, 1)
    d.h1("2. Your team's work at a glance")
    d.h1("3. Approving, rejecting and reassigning")
    d.h1("4. Following up: overdue, blocked, history")
    ch_messages(d, 5)
    ch_who_sees_what(d, 6)
    ch_glossary(d, 7)
    ch_help(d, 8)
    return d.save(out_name("Managers"))


def admin_guide():
    d = doc("Administrator", "<People who configure the app from inside it>", "<For administrators: ...>")
    d.h1("1. How the app decides who is an administrator")
    ch_who_sees_what(d, 2)
    d.h1("3. The administration screens, tab by tab")
    d.h1("4. Reference data: lists, templates, settings")
    d.h1("5. Writing message and document templates")
    d.para("<Placeholders, their meaning and value when blank, syntax rules, allowed formatting, a worked example; the in-app preview.>")
    d.h1("6. Communications: history and resend")
    d.h1("7. Routine tasks")
    d.h1("8. Known limitations")
    ch_glossary(d, 9)
    return d.save(out_name("Administrators"))


def developer_guide():
    d = doc("Developer and platform", "<The next developer and the platform administrator>",
            "<Everything needed to run, change, release and hand over the app.>")
    chapters = [
        ("About this guide", "<Scope, sources (repo commit, live environment read on <date>), how to regenerate it.>"),
        ("The environment and the solution", "<Environment name/type/URL, solution, publisher and prefix, what else shares the environment.>"),
        ("Architecture", "<Canvas app, tables, flows, connectors, external systems; a diagram.>"),
        ("Dataverse tables", "<Every table: purpose, key columns, choices with their values, relationships, delete behaviour, row growth.>"),
        ("Security roles and data access", "<Each role's privilege matrix, how it is applied (script, outside the solution), how to prove it by impersonation.>"),
        ("Giving someone access", "<Licence, security role, app sharing, team membership - in order.>"),
        ("Sharing and licensing", "<Which licences each role needs, premium connectors, capacity.>"),
        ("Connections and connection references", "<Each reference, its connector, whose connection, the deployment settings file.>"),
        ("Cloud flows", "<Each flow: trigger (table, message, filtering attributes, condition), what it writes, what it sends, the loop analysis (lint-flows edges), the safety switches.>"),
        ("Theme and design elements", "<theme.json tokens, fonts, icons and imagery, layout grid, the text-fit rule, accessibility.>"),
        ("What happens when the app opens", "<App.OnStart / Named Formulas, collections, role resolution, settings read.>"),
        ("The main screens in detail", "<Per screen: data sources, filters, galleries, write handlers, gates.>"),
        ("A record from start to finish", "<The lifecycle: each status, who moves it, which flow fires, what is sent.>"),
        ("Changing and releasing the app", "<Branching, build, the artifact checks, import, publish, verifying the build stamp, rollback.>"),
        ("Running it day to day", "<Monitoring flow runs, failed sends, resend, data growth, scheduled jobs and their switches.>"),
        ("Rules and traps", "<The project's hard-won rules, each with the incident behind it.>"),
        ("The repository", "<Folder map, scripts and what each proves, audits, hooks.>"),
        ("Known gaps for the next developer", "<Open items, decisions pending, technical debt.>"),
    ]
    for i, (title, prompt) in enumerate(chapters, 1):
        d.h1("%d. %s" % (i, title))
        d.para(prompt)
        if title == "Dataverse tables" and os.path.exists(MANIFEST):
            # One table per Dataverse table: manifest columns checked against live metadata.
            import json
            with open(MANIFEST, encoding="utf-8-sig") as f:
                manifest = json.load(f)
            live = None
            if os.path.exists(LIVE_COLUMNS):
                with open(LIVE_COLUMNS, encoding="utf-8-sig") as f:
                    live = json.load(f)
            for t in manifest.get("tables", []):
                d.h2(t.get("displayName") or t["logicalName"])
                d.column_table(t.get("columns", []), live=(live or {}).get(t["logicalName"]) if live else None,
                               caption="%s columns" % (t.get("displayName") or t["logicalName"]))
        if title == "Cloud flows" and os.path.exists(LINT):
            d.para("Which flow's writes can start which flow, from lint-flows.mjs on this build:")
            d.lint_edges_table(LINT, caption="Flow write and trigger edges")
    return d.save(out_name("Developers"))


if __name__ == "__main__":
    for build in (user_guide, manager_guide, admin_guide, developer_guide):
        print("wrote", build())
