"""Grade every run of an iteration: scripted checks first, then a blinded headless grader.

For each run: outputs/final-response.md is written from the transcript's result event (the chat
answer), script_checks.json holds the bundled linters' verdicts, and grading.json holds one
{text, passed, evidence} per assertion. The grader sees a neutral copy of outputs (no with/without
in its path or prompt). Usage: python grade_iteration.py <iteration-dir> [--jobs 8] [--only 5,6] [--force]
"""
import argparse, glob, hashlib, json, os, re, shutil, subprocess, tempfile
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
S = os.path.normpath(os.path.join(HERE, "..", "skills", "power-platform", "scripts"))
# On Windows prefer the native binary over the npm .cmd shim, which re-parses arguments through cmd.exe.
_EXE = os.path.join(os.environ.get("APPDATA", ""), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
CLAUDE = _EXE if os.path.exists(_EXE) else shutil.which("claude") or "claude"
GROOT = os.path.join(tempfile.gettempdir(), "ppe", "g")
PA_HOOK = os.path.join(S, "hooks", "check-pa-yaml.mjs")


def node(args, cwd=None):
    p = subprocess.run(["node", *args], capture_output=True, text=True, encoding="utf-8", cwd=cwd)
    return p.returncode, p.stdout, p.stderr


def lint(paths):
    if not paths:
        return {"ran": False, "why": "no flow files"}
    rc, out, err = node([os.path.join(S, "lint-flows.mjs"), *paths, "--json"])
    try:
        d = json.loads(out)
    except Exception:
        return {"ran": True, "parse_error": (out + err)[:800]}
    errs = [i.get("msg") or i.get("message") or json.dumps(i)[:300] for r in d["results"] for i in r["items"] if i["level"] == "error"]
    errs += d.get("cycles", [])
    return {"ran": True, "files": [os.path.basename(p) for p in paths], "errors": len(errs), "error_messages": [e[:400] for e in errs]}


def pa_yaml(files):
    """check-pa-yaml.mjs in hook mode (stdin JSON); exit 2 with findings on stderr, 0 when clean."""
    if not files:
        return {"ran": False, "why": "no .pa.yaml produced"}
    res = {}
    for f in files:
        p = subprocess.run(["node", PA_HOOK], input=json.dumps({"tool_input": {"file_path": f}}),
                           capture_output=True, text=True, encoding="utf-8")
        res[os.path.basename(f)] = {"clean": p.returncode == 0, "exit": p.returncode, "findings": p.stderr.strip()[:1500]}
    return {"ran": True, "files": res}


def canvas_format(files, schema=None):
    if not files:
        return {"ran": False, "why": "no .pa.yaml produced"}
    args = [os.path.join(S, "check-canvas-format.mjs"), *files, "--no-theme", "--json"]
    if schema:
        args += ["--schema", schema]
    rc, out, err = node(args)
    try:
        d = json.loads(out)
    except Exception:
        return {"ran": True, "error": (out + err)[:800]}
    f = d.get("findings", [])
    return {"ran": True, "text_overflow_errors": [x["msg"][:300] for x in f if x["code"] == "text-overflow" and x["level"] == "error"],
            "list_without_filter": [x["msg"][:300] for x in f if x["code"] == "list-without-filter"],
            "other": [f'{x["level"]} {x["code"]}: {x["msg"][:200]}' for x in f if x["code"] not in ("text-overflow", "list-without-filter")][:10]}


def parse_json(path):
    try:
        d = json.load(open(path, encoding="utf-8-sig"))
        return {"file": os.path.basename(path), "parses": True, "has_definition": bool(d.get("properties", {}).get("definition"))}
    except Exception as e:
        return {"file": os.path.basename(path), "parses": False, "error": str(e)[:200]}


def script_checks(eid, out):
    yamls = [f for f in glob.glob(os.path.join(out, "**", "*.pa.yaml"), recursive=True)]
    c = {}
    if eid == 2 or eid == 6:
        f = os.path.join(out, "flow.json")
        c["flow_json"] = parse_json(f) if os.path.exists(f) else {"parses": False, "error": "flow.json missing"}
        c["lint_flows"] = lint([f] if os.path.exists(f) else [])
        if eid == 6 and os.path.exists(f):
            # informational only: the assertion is plain lint; this shows how strict-recipient lint sees it
            c["lint_flows_require_safe_recipients_info_only"] = node([os.path.join(S, "lint-flows.mjs"), f, "--require-safe-recipients"])[1][-1500:]
    if eid == 3:
        f = os.path.join(out, "verify-approve.mjs")
        if os.path.exists(f):
            rc, o, e = node(["--check", f])
            c["node_check"] = {"ok": rc == 0, "stderr": e[:400]}
        else:
            c["node_check"] = {"ok": False, "stderr": "verify-approve.mjs missing"}
    if eid in (4, 7, 8):
        c["check_pa_yaml"] = pa_yaml(yamls)
    if eid == 5:
        fx = sorted(glob.glob(os.path.join(out, "fixed", "*.json")))
        c["fixed_parse"] = [parse_json(f) for f in fx]
        c["lint_flows_fixed_together"] = lint(fx)
    if eid == 7:
        c["check_canvas_format_with_schema"] = canvas_format(yamls, os.path.join(HERE, "inputs", "text-fit-schema-requests.json"))
    if eid == 8:
        c["check_canvas_format"] = canvas_format(yamls)
    return c


def final_response(run_dir):
    res = ""
    for line in open(os.path.join(run_dir, "transcript.jsonl"), encoding="utf-8", errors="replace"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("type") == "result":
            res = d.get("result") or ""
    return res


GRADER = """You are grading one AI assistant run against a list of assertions. The run's files are in ./outputs
(outputs/final-response.md is the assistant's final chat answer; other files are what it wrote).
./script_checks.json holds verdicts from deterministic checkers; where an assertion names a checker
(lint-flows, check-pa-yaml, check-canvas-format, node --check, parses as JSON), that verdict decides it.

Grade strictly: an assertion passes only if the outputs clearly satisfy all of it. Surface mentions
without substance fail. Quote or cite the file and the specific text as evidence (one or two sentences).
Do not modify any file. Do not run anything that contacts a network.

Assertions:
{assertions}

Reply with ONLY a JSON object, no prose, no code fence:
{{"results": [[true_or_false, "evidence"], ... one per assertion in order ...], "notes": "one or two sentences on anything the assertions miss or that seems unfair"}}"""


def grade_one(job):
    run_dir, meta, force = job
    if os.path.exists(os.path.join(run_dir, "grading.json")) and not force:
        return f"skip {run_dir}"
    out = os.path.join(run_dir, "outputs")
    os.makedirs(out, exist_ok=True)
    open(os.path.join(out, "final-response.md"), "w", encoding="utf-8").write(final_response(run_dir))
    checks = script_checks(meta["eval_id"], out)
    json.dump(checks, open(os.path.join(run_dir, "script_checks.json"), "w", encoding="utf-8"), indent=2)
    # blinded copy
    g = os.path.join(GROOT, hashlib.sha1(run_dir.encode()).hexdigest()[:10])
    shutil.rmtree(g, ignore_errors=True)
    shutil.copytree(out, os.path.join(g, "outputs"))
    json.dump(checks, open(os.path.join(g, "script_checks.json"), "w", encoding="utf-8"), indent=2)
    A = meta["assertions"]
    prompt = GRADER.format(assertions="\n".join(f"{i+1}. {a}" for i, a in enumerate(A)))
    last = ""
    for attempt in range(3):
        p = subprocess.run([CLAUDE, "-p", "--output-format", "json", "--dangerously-skip-permissions"], input=prompt,
                           cwd=g, capture_output=True, text=True, encoding="utf-8", timeout=1200)
        try:
            txt = json.loads(p.stdout)["result"]
            m = re.search(r"\{.*\}", txt, re.S)
            r = json.loads(m.group(0))
            if len(r["results"]) == len(A):
                break
            last = f"count {len(r['results'])} != {len(A)}"
        except Exception as e:
            last = f"{e}: {p.stdout[-300:]} {p.stderr[-300:]}"
        r = None
    if r is None:
        return f"FAILED {run_dir}: {last}"
    exp = [{"text": t, "passed": bool(x[0]), "evidence": str(x[1])} for t, x in zip(A, r["results"])]
    n = sum(e["passed"] for e in exp)
    json.dump({"expectations": exp, "summary": {"passed": n, "failed": len(A) - n, "total": len(A), "pass_rate": round(n / len(A), 3)},
               "notes": r.get("notes", ""), "script_checks": checks},
              open(os.path.join(run_dir, "grading.json"), "w", encoding="utf-8"), indent=2)
    return f"graded {run_dir} {n}/{len(A)}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root"); ap.add_argument("--jobs", type=int, default=8); ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    only = {int(x) for x in a.only.split(",") if x}
    jobs = []
    for ed in sorted(glob.glob(os.path.join(a.root, "eval-*"))):
        meta = json.load(open(os.path.join(ed, "eval_metadata.json"), encoding="utf-8"))
        if only and meta["eval_id"] not in only:
            continue
        for rd in sorted(glob.glob(os.path.join(ed, "*", "run-*"))):
            if os.path.exists(os.path.join(rd, "timing.json")):
                jobs.append((rd, meta, a.force))
    with ThreadPoolExecutor(a.jobs) as ex:
        for msg in ex.map(grade_one, jobs):
            print(msg, flush=True)


if __name__ == "__main__":
    main()
