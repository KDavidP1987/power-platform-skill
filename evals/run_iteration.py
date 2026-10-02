"""Run every eval with the skill and without it, N runs each, as headless Claude Code processes.

Each run gets its own working folder. A with-skill run has the skill at .claude/skills/power-platform
inside that folder (project skill discovery, as a real user would have it); a baseline run does not.
Both get the same offline instruction. The stream-json transcript is kept, and timing.json is written
from the final result event. Usage: python run_iteration.py <iteration-dir> [--runs 2] [--jobs 8] [--only 5,6]
On Windows keep <iteration-dir> short (for example %TEMP%/ppe/it3): a run's working folder nests four levels
below it, and a process cannot start in a folder whose path exceeds 260 characters.
"""
import argparse, json, os, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.join(HERE, "..", "skills", "power-platform")
# On Windows prefer the native binary over the npm .cmd shim, which re-parses arguments through cmd.exe.
_EXE = os.path.join(os.environ.get("APPDATA", ""), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
CLAUDE = _EXE if os.path.exists(_EXE) else shutil.which("claude") or "claude"
OFFLINE = ("This is an offline exercise. Do not run pac, az, or any command that contacts Microsoft Power Platform, "
           "Azure, a tenant or another network service, and do not open a browser. Work only inside the current directory.")
SUFFIX = ("\n\nInput files, if any, are in ./inputs. Save every file you produce in the current directory "
          "(create sub-folders where asked). Do not ask questions; make reasonable assumptions and state them.")


def run_one(job):
    ev, cfg, k, root = job
    run_dir = os.path.join(root, f"eval-{ev['id']}-{ev['name']}", cfg, f"run-{k}")
    work = os.path.join(run_dir, "work")
    if os.path.exists(os.path.join(run_dir, "timing.json")):
        return f"skip {run_dir}"
    shutil.rmtree(run_dir, ignore_errors=True)
    os.makedirs(work)
    for f in ev.get("files", []):
        dst = os.path.join(work, f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy(os.path.join(HERE, f), dst)
    if cfg == "with_skill":
        shutil.copytree(SKILL, os.path.join(work, ".claude", "skills", "power-platform"),
                        ignore=shutil.ignore_patterns("__pycache__", "node_modules", "scratchpad"))
    t0 = time.time()
    with open(os.path.join(run_dir, "transcript.jsonl"), "w", encoding="utf-8") as out:
        p = subprocess.run([CLAUDE, "-p", "--output-format", "stream-json", "--verbose",
                            "--dangerously-skip-permissions", "--append-system-prompt", OFFLINE],
                           input=ev["prompt"] + SUFFIX, cwd=work, stdout=out, stderr=subprocess.STDOUT,
                           text=True, encoding="utf-8", timeout=1800)
    wall = time.time() - t0
    result, skill_used = {}, False
    for line in open(os.path.join(run_dir, "transcript.jsonl"), encoding="utf-8", errors="replace"):
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("type") == "result":
            result = d
        if d.get("type") == "assistant":
            for c in d.get("message", {}).get("content", []):
                if c.get("type") == "tool_use" and (c.get("name") == "Skill" or "skills/power-platform" in json.dumps(c.get("input", {})).replace("\\\\", "/").replace("\\", "/")):
                    skill_used = True
    u = result.get("usage", {})
    tokens = sum(u.get(x, 0) or 0 for x in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    timing = {"total_tokens": tokens, "output_tokens": u.get("output_tokens", 0), "duration_ms": result.get("duration_ms", int(wall * 1000)),
              "total_duration_seconds": round(result.get("duration_ms", wall * 1000) / 1000, 1), "cost_usd": result.get("total_cost_usd"),
              "num_turns": result.get("num_turns"), "skill_used": skill_used, "exit_code": p.returncode, "is_error": result.get("is_error")}
    json.dump(timing, open(os.path.join(run_dir, "timing.json"), "w"), indent=2)
    # outputs/ = what the run produced (inputs and the installed skill excluded)
    outd = os.path.join(run_dir, "outputs")
    shutil.copytree(work, outd, ignore=shutil.ignore_patterns(".claude", "inputs"))
    return f"done {run_dir} {timing['total_duration_seconds']}s tokens={tokens} skill_used={skill_used} err={timing['is_error']}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root"); ap.add_argument("--runs", type=int, default=2); ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    E = json.load(open(os.path.join(HERE, "evals.json"), encoding="utf-8"))
    only = {int(x) for x in a.only.split(",") if x}
    jobs = []
    for ev in E["evals"]:
        if only and ev["id"] not in only:
            continue
        d = os.path.join(a.root, f"eval-{ev['id']}-{ev['name']}")
        os.makedirs(d, exist_ok=True)
        json.dump({"eval_id": ev["id"], "eval_name": ev["name"], "prompt": ev["prompt"], "assertions": ev["assertions"]},
                  open(os.path.join(d, "eval_metadata.json"), "w", encoding="utf-8"), indent=2)
        for k in range(1, a.runs + 1):
            for cfg in ("with_skill", "without_skill"):
                jobs.append((ev, cfg, k, a.root))
    with ThreadPoolExecutor(a.jobs) as ex:
        for msg in ex.map(run_one, jobs):
            print(msg, flush=True)


if __name__ == "__main__":
    main()
