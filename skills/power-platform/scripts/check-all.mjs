#!/usr/bin/env node
// check-all.mjs - every static check the project has, in one call, as one compact table.
//
// A measured build's lead agent made 190 small shell calls, most of them one check at a time, and
// each call re-sent the whole conversation. This runs them together and prints only what a lead
// needs to decide: per check, what it examined, how many findings, the verdict, and the first few
// findings of a check that failed. Full outputs stay out of the context; re-run one check by hand
// for its detail.
//
// Runs what the project has (each is skipped, and says so, when its input is absent):
//   pa-yaml       hooks/check-pa-yaml.mjs           over the canvas Src (compile-killers)
//   format        check-canvas-format.mjs           over the canvas Src (text fit, tokens, contrast,
//                                                   build-stamp-visible, accessible names)
//   overlap       check-canvas-overlap.mjs          over the canvas Src
//   flows         lint-flows.mjs                    over flows/ (or solution/src/Workflows)
//   drift         check-drift.py --offline          cache drift and picker size, when an artifact and a metadata dump are given
//                                                   (--drift <msapp|zip> --drift-dump <json>, or
//                                                   "driftArtifact"/"driftDump" in canvas-app.json)
//   seed          seed-data.py check                when a seed file exists AND a token source does
//                                                   (DATAVERSE_TOKEN, or dataverseTokenCommand)
//
// Usage:
//   node check-all.mjs [--repo .] [--max 5] [--only format,overlap] [--json]
//   node check-all.mjs --selftest
//
// Canvas Src: "canvasSrc" in scripts/canvas-app.json, else every canvas/*/Src folder.
// Exit: 0 every check that ran passed; 1 a check failed; 2 nothing failed but a check examined
// nothing, or no check could run (a check that read nothing is not a pass).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const FINDING = /^\s*(ERROR|FAIL|FIND|DRIFT|BAD)\b/;
const WARNING = /^\s*WARN\b/;

function arg(argv, name, dflt = null) { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; }

// The check scripts live next to this one in the skill; installed by setup-harness they live in
// the project's scripts/ and .claude/hooks/. Take the first that exists.
function locate(repo, name) {
  for (const p of [join(HERE, name), join(HERE, 'hooks', name), join(repo, '.claude', 'hooks', name), join(repo, 'scripts', name), join(repo, 'scripts', 'hooks', name)]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }

export function discover(repo, argv = []) {
  const cfg = readJson(join(repo, 'scripts', 'canvas-app.json')) || {};
  let src = [];
  if (cfg.canvasSrc && existsSync(join(repo, cfg.canvasSrc))) src = [join(repo, cfg.canvasSrc)];
  else if (existsSync(join(repo, 'canvas'))) {
    for (const d of readdirSync(join(repo, 'canvas'))) {
      const s = join(repo, 'canvas', d, 'Src');
      if (existsSync(s) && statSync(s).isDirectory()) src.push(s);
    }
  }
  const flows = ['flows', join('solution', 'src', 'Workflows')].map((f) => join(repo, f)).find((f) => existsSync(f)) || null;
  const driftArtifact = arg(argv, 'drift') || (cfg.driftArtifact && join(repo, cfg.driftArtifact));
  const driftDump = arg(argv, 'drift-dump') || (cfg.driftDump && join(repo, cfg.driftDump));
  const seed = [join(repo, 'seed', 'seed.json'), join(repo, 'seed.json')].find((p) => existsSync(p)) || null;
  const tokenCmd = cfg.dataverseTokenCommand || process.env.DATAVERSE_TOKEN_COMMAND || null;
  const token = !!process.env.DATAVERSE_TOKEN || !!tokenCmd;
  return { cfg, src, flows, driftArtifact, driftDump, seed, tokenCmd, token };
}

export function plan(repo, d) {
  const node = process.execPath, py = process.platform === 'win32' ? 'python' : 'python3';
  const C = [];
  const add = (name, script, mk, why) => {
    const s = script && locate(repo, script);
    C.push(s && !why ? { name, run: mk(s) } : { name, skip: why || `${script} not found` });
  };
  const noSrc = d.src.length ? null : 'no canvas Src folder';
  add('pa-yaml', 'check-pa-yaml.mjs', (s) => [node, s, ...d.src], noSrc);
  add('format', 'check-canvas-format.mjs', (s) => [node, s, ...d.src], noSrc);
  add('overlap', 'check-canvas-overlap.mjs', (s) => [node, s, ...d.src], noSrc);
  add('flows', 'lint-flows.mjs', (s) => [node, s, d.flows], d.flows ? null : 'no flows/ folder');
  add('drift', 'check-drift.py', (s) => [py, s, d.driftArtifact, '--offline', d.driftDump],
    d.driftArtifact && d.driftDump ? null : 'no artifact and metadata dump (--drift, --drift-dump)');
  add('seed', 'seed-data.py', (s) => [py, s, 'check', '--seed', d.seed, ...(d.tokenCmd ? ['--token-cmd', d.tokenCmd] : [])],
    !d.seed ? 'no seed file' : !d.token ? 'no token source (DATAVERSE_TOKEN or dataverseTokenCommand)' : null);
  return C;
}

// Reduce one check's output to a row: the summary line, the counts, and the first findings.
export function summarise(name, code, out, max) {
  const lines = out.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const findings = lines.filter((l) => FINDING.test(l));
  const warnings = lines.filter((l) => WARNING.test(l)).length;
  const pick = (rx) => [...lines].reverse().find((l) => rx.test(l) && !FINDING.test(l) && !WARNING.test(l));
  const summary = pick(/^\s*\d+ (\.pa\.yaml file\(s\) checked|screen file\(s\);|flow|row\(s\) compared)|seed check:|compared/i)
    || pick(/(error\(s\)|drift|NOT a pass)/i) || lines[lines.length - 1] || '';
  // An error printed is a failure even when the check also says it examined too little (exit 2).
  const verdict = code === 0 ? 'pass' : code === 1 || findings.length ? 'FAIL' : 'NOT EXAMINED';
  return { name, code, verdict, findings: findings.length, warnings, examined: summary.trim().slice(0, 110),
    first: verdict === 'FAIL' ? findings.slice(0, max).map((l) => l.trim().slice(0, 200)) : [] };
}

export function render(rows, skipped) {
  const out = [];
  const w = (s, n) => String(s).padEnd(n).slice(0, n);
  out.push(`${w('check', 9)} ${w('verdict', 13)} ${w('findings', 9)} ${w('warn', 5)} examined`);
  for (const r of rows) out.push(`${w(r.name, 9)} ${w(r.verdict, 13)} ${w(r.findings, 9)} ${w(r.warnings, 5)} ${r.examined}`);
  for (const s of skipped) out.push(`${w(s.name, 9)} ${w('skipped', 13)} ${w('-', 9)} ${w('-', 5)} ${s.skip}`);
  for (const r of rows) if (r.first.length) {
    out.push('');
    out.push(`${r.name}: first ${r.first.length} of ${r.findings} finding(s) - run it alone for the rest`);
    for (const f of r.first) out.push('  ' + f);
  }
  return out.join('\n');
}

export function overall(rows) {
  if (rows.some((r) => r.verdict === 'FAIL')) return 1;
  if (!rows.length || rows.some((r) => r.verdict === 'NOT EXAMINED')) return 2;
  return 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const repo = resolve(arg(argv, 'repo', '.'));
  const max = Number(arg(argv, 'max', 5));
  const only = arg(argv, 'only') ? new Set(arg(argv, 'only').split(',')) : null;
  const d = discover(repo, argv);
  const checks = plan(repo, d).filter((c) => !only || only.has(c.name));
  const rows = [], skipped = [];
  for (const c of checks) {
    if (c.skip) { skipped.push(c); continue; }
    const r = spawnSync(c.run[0], c.run.slice(1), { cwd: repo, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
    const code = r.status ?? 2;
    rows.push(summarise(c.name, code, (r.stdout || '') + '\n' + (r.stderr || ''), max));
  }
  const rc = overall(rows);
  if (argv.includes('--json')) console.log(JSON.stringify({ exit: rc, rows, skipped: skipped.map((s) => ({ name: s.name, why: s.skip })) }));
  else {
    console.log(render(rows, skipped));
    console.log(`\n${rows.filter((r) => r.verdict === 'pass').length} passed, ${rows.filter((r) => r.verdict === 'FAIL').length} failed, ${rows.filter((r) => r.verdict === 'NOT EXAMINED').length} examined nothing, ${skipped.length} skipped.`);
  }
  return rc;
}

function selftest() {
  const fails = [];
  // Summaries from real output shapes.
  const fmt = summarise('format', 1, 'WARN  literal-colour  S.pa.yaml:4  x\nERROR build-stamp-visible  S.pa.yaml:9  y\nERROR text-overflow  S.pa.yaml:14  z\n\n1 screen file(s); 2 text control(s)\nRoom is an estimate', 1);
  if (fmt.verdict !== 'FAIL' || fmt.findings !== 2 || fmt.warnings !== 1) fails.push('format counts: ' + JSON.stringify(fmt));
  if (fmt.first.length !== 1 || !fmt.first[0].includes('build-stamp-visible')) fails.push('only --max findings are shown');
  if (!/screen file/.test(fmt.examined)) fails.push('examined line picked: ' + fmt.examined);
  const ok = summarise('pa-yaml', 0, '3 .pa.yaml file(s) checked, 0 with faults that break a compile.', 5);
  if (ok.verdict !== 'pass' || ok.first.length) fails.push('a pass shows no findings');
  const none = summarise('overlap', 2, 'No control geometry was resolved - this is NOT a pass.', 5);
  if (none.verdict !== 'NOT EXAMINED') fails.push('exit 2 is not a pass');
  if (overall([ok]) !== 0 || overall([ok, fmt]) !== 1 || overall([ok, none]) !== 2 || overall([]) !== 2) fails.push('overall exit codes');
  const table = render([ok, fmt], [{ name: 'seed', skip: 'no seed file' }]);
  if (!table.includes('skipped') || table.includes('text-overflow')) fails.push('render: skipped listed, findings capped');

  // A throwaway project: discovery, the plan, and one real run end to end.
  const repo = join(tmpdir(), 'check-all-selftest-' + process.pid);
  try {
    mkdirSync(join(repo, 'canvas', 'app', 'Src'), { recursive: true });
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'canvas', 'app', 'Src', 'S.pa.yaml'),
      'Screens:\n  S:\n    Children:\n      - lblBuild:\n          Control: Label\n          Properties:\n            Text: =gblBuild\n            X: =0\n            Y: =0\n            Width: =200\n            Height: =40\n');
    const d = discover(repo);
    if (d.src.length !== 1 || d.flows || d.seed) fails.push('discover: ' + JSON.stringify({ src: d.src.length, flows: d.flows, seed: d.seed }));
    const p = plan(repo, d);
    const by = Object.fromEntries(p.map((c) => [c.name, c]));
    if (!by['pa-yaml'].run || !by.format.run || !by.overlap.run) fails.push('canvas checks planned');
    if (!by.flows.skip || !by.seed.skip || !by.drift.skip) fails.push('absent inputs are skipped with a reason');
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--repo', repo, '--only', 'format', '--json'], { encoding: 'utf8' });
    const j = JSON.parse(r.stdout || '{}');
    const f = (j.rows || [])[0] || {};
    if (r.status !== 1 || f.verdict !== 'FAIL' || !f.first.some((x) => x.includes('build-stamp-visible'))) fails.push('end to end: visible build stamp fails the run (' + r.status + ' ' + JSON.stringify(f) + ')');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  console.log(fails.length ? 'selftest FAILED:\n  ' + fails.join('\n  ')
    : 'selftest ok: counts, the findings cap, exit codes (fail 1, nothing examined 2), skipped inputs, and an end-to-end run that fails on a visible build stamp');
  return fails.length ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
