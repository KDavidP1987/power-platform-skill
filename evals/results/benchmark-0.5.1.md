# Skill Benchmark: power-platform

**Model**: claude-opus-5-5
**Date**: 2026-10-02T06:00:20Z
**Evals**: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (2 runs each per configuration)

## Summary

| Metric | With Skill | Without Skill | Delta |
|--------|------------|---------------|-------|
| Pass Rate | 91% ± 15% | 68% ± 25% | +0.23 |
| Time | 141.5s ± 48.7s | 115.8s ± 51.5s | +25.7s |
| Tokens | 506846 ± 156227 | 172798 ± 79886 | +334047 |
## Analyst notes

- Checks passed over 20 runs per configuration: 133/148 (89.9%) with the skill, 98/148 (66.2%) without; +23.7 points. 0.1.0 (iteration 2, one run each, 4 evals): 32/32 vs 14/32.
- The skill loaded in 20 of 20 with-skill runs and in none of the baselines (Skill tool call or a read under skills/power-platform).
- Evals 1-4 (the 0.1.0 set, three assertions tightened): 58/68 with vs 33/68 without. Evals 5-10 (new): 75/80 with vs 65/80 without. The new evals discriminate less: the baseline model already finds an explicit two-flow cycle (eval 5, 6/6 both) and adds list filters when the prompt names the choice columns (eval 8, 11/14 both).
- 47 of 74 assertions pass in every run of both configurations (non-discriminating). They stay as regression guards; the discriminating ones are the 22 that favour the skill.
- Always failed in both configurations: e3.6 (Dataverse confirmation by default: the with-skill scripts make it opt-in and exit 3 'partial' without it), e4.6 (gallery still filters the whole-table collection colSpend), e4.8 (Sum does not delegate), e4.9 (lookup related-column filter not delegable). e4.6 regressed from 0.1.0, whose with-skill run moved the gallery to a delegable query.
- One assertion favours the baseline: e8.7 (notes invite changes to the defaulted filters); both with-skill runs state the defaults but do not invite changes.
- Variance: with the skill, 6 of 10 evals scored identically in both runs; eval 4 differed by 2/9, evals 7, 8 and 9 by 1. Baseline: evals 3 and 8 differed by 1. Flaky assertions: e3.8, e4.3, e4.4, e7.1, e7.2, e7.6, e8.6, e8.7, e9.4.
- Grader fairness fix: check-canvas-format guessed a 100-character length for galRequests.Selected.Category (it resolves ThisItem.X against --schema but not Gallery.Selected.X), a false positive on eval 7. The eval schema now carries Category: 24 (the longest label, stated in the prompt) as a column fallback; eval 7 was regraded. The checker gap is a skill finding.
- Cost per task: mean 506,846 vs 172,798 total tokens including cache reads (2.9x); output tokens 14,303 vs 11,768; 141.5 s vs 115.8 s; USD 0.811 vs 0.472.
