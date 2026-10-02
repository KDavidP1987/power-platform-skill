"""The words half of an app's documentation set: four guides, built on doc_kit.py.

Copy this file into the project (scripts/build-guides.py), replace every <angle-bracket> with what
the app's SOURCE and LIVE environment say, and delete chapters that do not apply. The structure is
the standard (references/documentation-set.md); the sentences here are prompts, not content.

    python build-guides.py            final build: every figure must exist
    python build-guides.py --draft    missing figures become a visible "capture needed" box

Chapters used by more than one guide are written ONCE, as functions taking the document and the
chapter number, so the guides cannot drift apart on how a screen behaves.

Output goes to out/ (git-ignored): screenshots carry people's names, even test ones look real.
Render to PDF through Word (model-driven-and-docs.md, section 4) and read every page.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from doc_kit import Guide, load_theme  # noqa: E402

APP = "<App name>"
ORG = "<Organisation or team>"           # "" for none
VERSION = "Version <1.0>"
ISSUED = "<issue date>"
BUILD = "<build stamp shown in the app>"
THEME = "canvas/theme.json"              # the app's theme, so the guides match the product
SHOTS = os.path.join("out", "shots-trimmed")
OUT = "out"
DRAFT = "--draft" in sys.argv


def out_name(kind):
    """out/<App>-Guide-<Kind>.docx, with anything a file system refuses removed."""
    slug = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in APP.replace(" ", "-")).strip("-") or "App"
    return os.path.join(OUT, "%s-Guide-%s.docx" % (slug, kind))


def doc(kind, audience, blurb):
    return Guide("%s" % APP, "%s guide" % kind, blurb,
                 [("Audience", audience), ("Version", VERSION), ("Issued", ISSUED), ("Build", BUILD)],
                 SHOTS, "%s - %s guide" % (APP, kind), org=ORG, theme=load_theme(THEME))


def fig(d, name, caption):
    """A figure in a final build; a visible gap in a draft."""
    if DRAFT and not os.path.exists(os.path.join(SHOTS, name)):
        d.callout("Capture needed", "%s - %s" % (name, caption), "warn")
    else:
        d.figure(name, caption)


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
    ch_opening(d, 1)
    d.h1("2. <The main task, as a verb: Raise a request>")
    d.steps(["<Press 'New request' (the button's own text)>", "<Fill ...>", "<Press 'Submit'>"])
    fig(d, "new-request-<role>.png", "<Caption>")
    d.callout("What happens next", "<Who is told, what status the record takes, what the reader sees.>")
    d.h1("3. <Second task>")
    d.h1("4. Statuses and what they mean")
    d.table(["Status", "Meaning", "What you do"], [["<label>", "<meaning>", "<action>"]])
    ch_messages(d, 5)
    ch_glossary(d, 6)
    ch_help(d, 7)
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
    return d.save(out_name("Developers"))


if __name__ == "__main__":
    for build in (user_guide, manager_guide, admin_guide, developer_guide):
        print("wrote", build())
