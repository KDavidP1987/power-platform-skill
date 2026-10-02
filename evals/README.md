# Evaluation set

The tasks, inputs and harness behind the [evaluation report](https://kdavidp1987.github.io/power-platform-skill/evaluation.html).
Each task runs with the skill and without it, in fresh headless Claude Code sessions, and is graded
against checks fixed before any run.

| File | What it is |
|---|---|
| `evals.json` | 10 tasks and 74 checks: the prompt, the input files, the expected outcome and the checks |
| `inputs/` | the files the tasks hand over: two looping flows, two canvas screens, the column lengths for the long-text test |
| `run_iteration.py` | runs every task N times per configuration in parallel; with the skill, it is installed as a project skill in the run's folder |
| `grade_iteration.py` | runs the bundled checkers on each answer (`lint-flows.mjs`, `check-pa-yaml.mjs`, `check-canvas-format.mjs`, `node --check`), then a grader session that does not know the configuration judges every check and quotes its evidence |
| `analyze.py` | totals, spread between runs, and which checks separate the two configurations |
| `results/` | the 0.5.1 benchmark, with analyst notes, and the per-check analysis |

## Running it

```sh
python evals/run_iteration.py <iteration-dir> --runs 2 --jobs 8
python evals/grade_iteration.py <iteration-dir> --jobs 8
python evals/analyze.py <iteration-dir>
```

Each run costs a full agent session (about USD 0.80 with the skill and 0.47 without on 0.5.1), so 40
runs cost about USD 26, plus the grading sessions. Runs are told to stay offline and never contact a tenant. On Windows keep
`<iteration-dir>` short (for example `%TEMP%/ppe/it3`): a process cannot start in a folder whose path
is longer than 260 characters. The skill-creator `aggregate_benchmark` script reads the same layout.

## Results

| Version | Tasks and runs | With the skill | Without |
|---|---|---|---|
| 0.1.0 | 4 tasks, 32 checks, 1 run each | 32/32 (100%) | 14/32 (44%) |
| 0.5.1 | 10 tasks, 74 checks, 2 runs each | 133/148 (90%) | 98/148 (66%) |

From 0.1.0 to 0.5.1 three checks were tightened (one split into three) and six tasks were added. 47 of
the 74 checks pass in every run of both configurations, so they guard against regression rather than
measure the skill. `results/benchmark-0.5.1.md` lists the checks that still fail with the skill.
