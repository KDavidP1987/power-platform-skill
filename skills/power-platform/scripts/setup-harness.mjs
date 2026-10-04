#!/usr/bin/env node
// setup-harness.mjs - install this skill's development harness into a project: the Claude Code hooks,
// the tools the method runs every cycle, the config files they read, and the continuity documents.
//
// The agent OFFERS this at the start of a project (project-setup.md section 4); the person agrees,
// then the agent runs it. It never overwrites a file that differs from the skill's copy unless
// --force is given, never removes anything, and merges hook wiring into an existing
// .claude/settings.json instead of replacing it.
//
//   node <skill>/scripts/setup-harness.mjs [project dir]            plan: what would be added or updated
//   node <skill>/scripts/setup-harness.mjs [project dir] --apply    do it
//   options: --only hooks,tools,config,docs   --force   --selftest
//
// Exit codes: 0 done or nothing to do, 1 a file differs and was kept (plan shows which), 2 bad usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = (...p) => path.join(SKILL, ...p);

// What the harness is. Each entry: [source in the skill, destination in the project, group, why].
export const MANIFEST = [
  // Hooks: run by Claude Code itself, so the checks happen whether or not anyone remembers them.
  ['scripts/hooks/lib.mjs', '.claude/hooks/lib.mjs', 'hooks', 'shared helpers for the hooks'],
  ['scripts/hooks/preflight.mjs', '.claude/hooks/preflight.mjs', 'hooks', 'session start: git state, pac environment, the state file'],
  ['scripts/hooks/check-pa-yaml.mjs', '.claude/hooks/check-pa-yaml.mjs', 'hooks', 'every .pa.yaml write: compile-killers'],
  ['scripts/hooks/check-standards.mjs', '.claude/hooks/check-standards.mjs', 'hooks', 'every write: emoji and off-palette colours'],
  ['scripts/check-canvas-format.mjs', '.claude/hooks/check-canvas-format.mjs', 'hooks', 'every .pa.yaml write: text fit, theme tokens, accessibility'],
  ['scripts/check-canvas-overlap.mjs', '.claude/hooks/check-canvas-overlap.mjs', 'hooks', 'every .pa.yaml write: controls drawn over controls'],
  ['scripts/hooks/shared-guard.mjs', '.claude/hooks/shared-guard.mjs', 'hooks', 'edits naming a shared table: record it in the shared registry'],
  ['scripts/hooks/audit-stop.mjs', '.claude/hooks/audit-stop.mjs', 'hooks', 'end of turn: whole-repo audit and bookkeeping'],
  // Tools: the ship, verify and data loop.
  ['scripts/canvas-mcp.py', 'scripts/canvas-mcp.py', 'tools', 'compile, push and hold against Studio; sync; checker'],
  ['scripts/ship-canvas.py', 'scripts/ship-canvas.py', 'tools', 'ship a canvas app by solution import, build stamp read back'],
  ['scripts/inspect-artifact.py', 'scripts/inspect-artifact.py', 'tools', 'assert on the packed artifact (used by ship-canvas)'],
  ['scripts/check-published-order.py', 'scripts/check-published-order.py', 'tools', 'published control order against the repo'],
  ['scripts/canvas-browser.mjs', 'scripts/canvas-browser.mjs', 'tools', 'drive Studio and the published app; walk scenarios with Dataverse confirms'],
  ['scripts/contract-to-walk.mjs', 'scripts/contract-to-walk.mjs', 'tools', 'acceptance contract to walk scenarios'],
  ['scripts/deploy-tables.py', 'scripts/deploy-tables.py', 'tools', 'schema manifest to Dataverse, plan first'],
  ['scripts/check-drift.py', 'scripts/check-drift.py', 'tools', 'repo against live drift check'],
  ['scripts/_ppapi.py', 'scripts/_ppapi.py', 'tools', 'shared HTTP and token layer for the Python build tools'],
  ['scripts/seed-data.py', 'scripts/seed-data.py', 'tools', 'sample and fixture rows, idempotent, plan first'],
  ['scripts/deploy-flows.py', 'scripts/deploy-flows.py', 'tools', 'solution flows and own connection references, plan first'],
  ['scripts/fabric.py', 'scripts/fabric.py', 'tools', 'Fabric items into a workspace folder, run jobs, plan first'],
  ['scripts/reconcile-report.py', 'scripts/reconcile-report.py', 'tools', 'report figures against Dataverse (read only)'],
  ['scripts/pbi-theme.py', 'scripts/pbi-theme.py', 'tools', 'Power BI theme from the app tokens'],
  ['scripts/lint-flows.mjs', 'scripts/lint-flows.mjs', 'tools', 'flow definitions: loops, guards, recipients'],
  ['scripts/check-all.mjs', 'scripts/check-all.mjs', 'tools', 'every static check in one call, one compact table'],
  ['scripts/flow-runs.py', 'scripts/flow-runs.py', 'tools', 'why did a flow run fail (read only)'],
  ['scripts/audit-pages-permissions.py', 'scripts/audit-pages-permissions.py', 'tools', 'Power Pages permissions, allow-lists and headers'],
  ['scripts/dv-token.ps1', 'scripts/dv-token.ps1', 'tools', 'one-sign-in Dataverse token'],
  // Config read by the hooks and tools; examples copied once, then the project owns them.
  ['assets/standards.config.example.json', '.claude/hooks/standards.config.json', 'config', 'hook settings (palette rules, shared prefixes, bookkeeping paths)'],
  ['assets/canvas-app.example.json', 'scripts/canvas-app.json', 'config', 'the app identity every tool reads'],
  ['assets/selectors.json', 'scripts/selectors.json', 'config', 'UI anchors for canvas-browser.mjs'],
  // Continuity documents: the agent reads these at session start.
  ['assets/templates/STATE.md', 'docs/STATE.md', 'docs', 'current state, read first every session'],
  ['assets/templates/decisions.md', 'docs/decisions.md', 'docs', 'decision record'],
  ['assets/templates/dependencies.md', 'docs/dependencies.md', 'docs', 'dependency and integration register'],
  ['assets/templates/acceptance-contract.md', 'docs/acceptance-contract.md', 'docs', 'requirements to walk scenarios'],
  ['assets/templates/owner-cleanup.ps1', 'scripts/Remove-TestData.ps1', 'docs', 'owner-run test-data cleanup (list first, -Apply to delete)'],
];
const OWNED_AFTER_COPY = new Set(['config', 'docs']);   // never compared again once the project has them
const GITIGNORE = ['.ship-work/', 'out/', 'scratch/', '.canvas-browser-profile/'];

function read(p) { try { return fs.readFileSync(p); } catch { return null; } }

function mergeSettings(existing, snippet) {
  const out = existing ? JSON.parse(JSON.stringify(existing)) : {};
  let added = 0;
  out.permissions = out.permissions || {};
  out.permissions.allow = out.permissions.allow || [];
  for (const rule of (snippet.permissions?.allow || [])) {
    if (!out.permissions.allow.includes(rule)) { out.permissions.allow.push(rule); added++; }
  }
  // Environment for the session (e.g. compact at 40% of the window). Never overwrite a value the
  // project already chose.
  for (const [k, v] of Object.entries(snippet.env || {})) {
    out.env = out.env || {};
    if (!(k in out.env)) { out.env[k] = v; added++; }
  }
  out.hooks = out.hooks || {};
  for (const [event, groups] of Object.entries(snippet.hooks || {})) {
    out.hooks[event] = out.hooks[event] || [];
    const have = new Set(out.hooks[event].flatMap((g) => (g.hooks || []).map((h) => h.command)));
    for (const g of groups) {
      const fresh = (g.hooks || []).filter((h) => !have.has(h.command));
      if (!fresh.length) continue;
      const same = out.hooks[event].find((x) => (x.matcher || '') === (g.matcher || ''));
      if (same) same.hooks.push(...fresh); else out.hooks[event].push({ ...g, hooks: fresh });
      added += fresh.length;
    }
  }
  return { out, added };
}

export function setup(project, { apply = false, force = false, only = null, log = console.log } = {}) {
  const groups = only ? new Set(only) : null;
  let kept = 0, changes = 0;
  for (const [src, dst, group, why] of MANIFEST) {
    if (groups && !groups.has(group)) continue;
    const from = S(src), to = path.join(project, dst);
    const body = read(from);
    if (!body) { log(`  skip     ${dst}  (not in this skill version)`); continue; }
    const cur = read(to);
    let state;
    if (!cur) state = 'add';
    else if (cur.equals(body)) state = 'same';
    else if (OWNED_AFTER_COPY.has(group)) state = 'owned';
    else state = force ? 'update' : 'differs';
    if (state === 'same' || state === 'owned') continue;
    if (state === 'differs') { kept++; log(`  differs  ${dst}  (kept; --force replaces it with the skill's copy)`); continue; }
    changes++;
    log(`  ${state.padEnd(8)} ${dst}  - ${why}`);
    if (apply) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, body); }
  }
  if (!groups || groups.has('hooks')) {
    const sp = path.join(project, '.claude', 'settings.json');
    const raw = read(sp);
    let existing = null;
    if (raw) { try { existing = JSON.parse(raw.toString('utf8').replace(/^﻿/, '')); } catch { log('  differs  .claude/settings.json  (not valid JSON; fix it, then re-run)'); kept++; } }
    if (!raw || existing) {
      const { out, added } = mergeSettings(existing, JSON.parse(read(S('assets', 'settings.snippet.json')).toString('utf8')));
      if (added) {
        changes++;
        log(`  merge    .claude/settings.json  - ${added} hook, permission or env entr${added === 1 ? 'y' : 'ies'} added, existing ones kept`);
        if (apply) { fs.mkdirSync(path.dirname(sp), { recursive: true }); fs.writeFileSync(sp, JSON.stringify(out, null, 2) + '\n'); }
      }
    }
    const gi = path.join(project, '.gitignore');
    const lines = (read(gi)?.toString('utf8') || '').split(/\r?\n/);
    const missing = GITIGNORE.filter((l) => !lines.includes(l));
    if (missing.length) {
      changes++;
      log(`  append   .gitignore  - ${missing.join(' ')}`);
      if (apply) fs.appendFileSync(gi, (lines.at(-1) === '' || !lines.join('') ? '' : '\n') + missing.join('\n') + '\n');
    }
  }
  if (apply && (changes || !fs.existsSync(path.join(project, '.claude', 'hooks', 'harness.json')))) {
    // Which skill version this harness came from; the pre-flight compares it with the latest release.
    const m = (read(S('SKILL.md'))?.toString('utf8') || '').match(/version:\s*"([^"]+)"/);
    fs.mkdirSync(path.join(project, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(project, '.claude', 'hooks', 'harness.json'), JSON.stringify({
      skill: 'power-platform', version: m ? m[1] : 'unknown', installed: new Date().toISOString().slice(0, 10),
      releases: 'https://api.github.com/repos/KDavidP1987/power-platform-skill/releases/latest' }, null, 2) + '\n');
  }
  log(changes ? `${changes} change(s) ${apply ? 'made' : 'to make (run with --apply)'}` : 'harness up to date');
  if (apply && changes) log('Next: fill scripts/canvas-app.json, set "shared" prefixes in .claude/hooks/standards.config.json, run each hook once by hand (project-setup.md section 4), and restart the session so Claude Code loads the hooks.');
  return { kept, changes };
}

function selftest() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
  const quiet = () => {};
  let ok = true;
  const check = (name, cond) => { ok &&= cond; console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`); };
  try {
    fs.mkdirSync(path.join(t, '.claude'), { recursive: true });
    const mine = { permissions: { allow: ['Bash(npm test*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node mine.mjs' }] }] } };
    fs.writeFileSync(path.join(t, '.claude', 'settings.json'), JSON.stringify(mine));
    const plan = setup(t, { log: quiet });
    check('plan writes nothing', !fs.existsSync(path.join(t, '.claude', 'hooks', 'lib.mjs')) && plan.changes > 0);
    setup(t, { apply: true, log: quiet });
    const s = JSON.parse(fs.readFileSync(path.join(t, '.claude', 'settings.json'), 'utf8'));
    check('existing permission kept', s.permissions.allow.includes('Bash(npm test*)'));
    check('existing Stop hook kept', JSON.stringify(s.hooks.Stop).includes('node mine.mjs'));
    check('skill hooks wired', JSON.stringify(s.hooks).includes('check-pa-yaml.mjs'));
    check('hooks copied', fs.existsSync(path.join(t, '.claude', 'hooks', 'preflight.mjs')));
    const again = setup(t, { apply: true, log: quiet });
    check('second run is a no-op', again.changes === 0 && again.kept === 0);
    fs.appendFileSync(path.join(t, '.claude', 'hooks', 'preflight.mjs'), '\n// local edit\n');
    fs.writeFileSync(path.join(t, 'docs', 'STATE.md'), '# my state\n');
    const edited = setup(t, { apply: true, log: quiet });
    check('locally edited hook kept, reported', edited.kept === 1 && fs.readFileSync(path.join(t, '.claude', 'hooks', 'preflight.mjs'), 'utf8').includes('local edit'));
    check('project-owned doc never compared', fs.readFileSync(path.join(t, 'docs', 'STATE.md'), 'utf8') === '# my state\n');
    const gi = fs.readFileSync(path.join(t, '.gitignore'), 'utf8');
    check('gitignore entries once', gi.split('.ship-work/').length === 2);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
  console.log(`selftest ${ok ? 'passed' : 'FAILED'}`);
  return ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) process.exit(selftest());
  if (args.includes('-h') || args.includes('--help')) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).join('\n').replace(/^\/\/ ?/gm, '')); process.exit(0); }
  const oi = args.indexOf('--only');
  const only = oi >= 0 ? (args[oi + 1] || '').split(',').filter(Boolean) : null;
  const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') || process.cwd();
  if (!fs.existsSync(dir)) { console.error(`no such folder: ${dir}`); process.exit(2); }
  const apply = args.includes('--apply');
  console.log(`${apply ? 'Installing' : 'Plan for'} the power-platform harness in ${path.resolve(dir)}`);
  const r = setup(path.resolve(dir), { apply, force: args.includes('--force'), only });
  process.exit(r.kept ? 1 : 0);
}
