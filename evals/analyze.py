"""Analyst pass over an iteration: totals, per-eval means and spread, per-assertion discrimination, cost.
Writes <iteration>/analysis.json and <iteration>/eval-data.json (the evaluation page's data). Usage: python analyze.py <iteration-dir>"""
import glob, json, os, statistics as st, sys

root = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
ARMS = ("with_skill", "without_skill")
evals, data = [], {}
for ed in sorted(glob.glob(os.path.join(root, "eval-*")), key=lambda p: int(os.path.basename(p).split("-")[1])):
    meta = json.load(open(os.path.join(ed, "eval_metadata.json"), encoding="utf-8"))
    e = {"id": meta["eval_id"], "name": meta["eval_name"], "assertions": meta["assertions"], "runs": {}}
    for arm in ARMS:
        runs = []
        for rd in sorted(glob.glob(os.path.join(ed, arm, "run-*"))):
            g = json.load(open(os.path.join(rd, "grading.json"), encoding="utf-8"))
            t = json.load(open(os.path.join(rd, "timing.json")))
            runs.append({"passed": [x["passed"] for x in g["expectations"]], "tokens": t["total_tokens"], "output_tokens": t["output_tokens"],
                         "secs": t["total_duration_seconds"], "cost": t["cost_usd"], "skill_used": t["skill_used"]})
        e["runs"][arm] = runs
    evals.append(e)
    data[str(e["id"])] = e

out = {"evals": [], "assertions": [], "totals": {}}
for arm in ARMS:
    p = sum(sum(r["passed"]) for e in evals for r in e["runs"][arm])
    n = sum(len(r["passed"]) for e in evals for r in e["runs"][arm])
    rs = [r for e in evals for r in e["runs"][arm]]
    out["totals"][arm] = {"passed": p, "checks": n, "rate": round(p / n, 3), "runs": len(rs),
                          "mean_tokens": round(st.mean(r["tokens"] for r in rs)), "mean_output_tokens": round(st.mean(r["output_tokens"] for r in rs)),
                          "mean_secs": round(st.mean(r["secs"] for r in rs), 1), "mean_cost": round(st.mean(r["cost"] or 0 for r in rs), 3),
                          "skill_used_runs": sum(r["skill_used"] for r in rs)}
for e in evals:
    row = {"id": e["id"], "name": e["name"], "n": len(e["assertions"])}
    for arm in ARMS:
        rates = [sum(r["passed"]) / len(r["passed"]) for r in e["runs"][arm]]
        row[arm] = {"scores": [sum(r["passed"]) for r in e["runs"][arm]], "mean": round(st.mean(rates), 3), "spread": round(max(rates) - min(rates), 3)}
    row["delta"] = round(row["with_skill"]["mean"] - row["without_skill"]["mean"], 3)
    out["evals"].append(row)
    for i, a in enumerate(e["assertions"]):
        w = sum(r["passed"][i] for r in e["runs"]["with_skill"]); b = sum(r["passed"][i] for r in e["runs"]["without_skill"])
        k = len(e["runs"]["with_skill"])
        kind = ("always-pass" if w == b == k else "always-fail" if w == b == 0 else "favours-skill" if w > b else "favours-baseline" if b > w else "split-equal")
        flaky = (0 < w < k) or (0 < b < len(e["runs"]["without_skill"]))
        out["assertions"].append({"eval": e["id"], "i": i + 1, "text": a, "with": w, "without": b, "kind": kind, "flaky": flaky})
json.dump(out, open(os.path.join(root, "analysis.json"), "w", encoding="utf-8"), indent=2)
json.dump(data, open(os.path.join(root, "eval-data.json"), "w", encoding="utf-8"), indent=1)

print(json.dumps(out["totals"], indent=1))
for r in out["evals"]:
    print(f"{r['id']:>2} {r['name']:40} with {r['with_skill']['scores']} without {r['without_skill']['scores']} /{r['n']}  delta {r['delta']:+.2f}")
from collections import Counter
print(Counter(a["kind"] for a in out["assertions"]))
for a in out["assertions"]:
    if a["kind"] in ("always-fail", "favours-baseline") or a["flaky"]:
        print(f"  e{a['eval']}.{a['i']} {a['kind']:16} flaky={a['flaky']} w{a['with']} b{a['without']} {a['text'][:80]}")
nd = [a for a in out["assertions"] if a["kind"] == "always-pass"]
print("always-pass (non-discriminating):", len(nd))
for a in nd:
    print(f"  e{a['eval']}.{a['i']} {a['text'][:90]}")
