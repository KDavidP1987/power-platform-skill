// Stop hook shipped with the PLUGIN (hooks/hooks.json at the plugin root), so it runs whenever the
// plugin is enabled - no project harness needed.
//
// Why: in a measured build the agent never ran the design-first and planning steps the skill calls
// required (not one mention in 72 minutes), and the project-level design gate never ran because the
// harness is installed only "when the person agrees" and nobody was present. Guidance an agent can
// skip is not a gate; this is.
//
// A Stop gate alone produced a report, not compliance: in a live test the agent listed the missing
// steps and ended. So the same script also runs BEFORE tools (--pre, PreToolUse) and refuses work done
// out of order, which is when doing the step is cheapest:
//   A. no screen .pa.yaml (canvas Src/, not App.pa.yaml) is written, by a file tool or a shell command,
//      until DESIGN.md and design/prototype.html exist - impeccable first. Only for a NEW app (its Src
//      holds fewer than three screens), so maintenance of an established app is never held up;
//   B. no table deploy (deploy-tables.py without --plan) until the plan exists: a DOD plan in docs/dod/
//      when dod is installed, otherwise docs/acceptance-contract.md filled in (not the bare template).
// The Stop gate blocks up to three times per session (counted per session_id in the temp folder), so
// one listed summary does not end the build; after that it lets the stop through and writes the gaps
// to stderr, so it can never trap a session.
//
// It does nothing (exit 0, no output) unless the folder is a Power Platform build: canvas source
// (canvas/<app>/Src, or "canvasSrc" in scripts/canvas-app.json) or a Power BI report under fabric/.
// It never loops (stop_hook_active), stands aside when the project harness's own audit-stop hook is
// installed, and can be turned off with "pluginGate": false in .claude/hooks/standards.config.json or
// scripts/canvas-app.json. Otherwise it blocks the stop once, with every missing step in one reason:
//   1. DESIGN.md (root or docs/)                   - impeccable init
//   2. design/prototype.html (canvas source)       - the HTML design pass
//   3. docs/design-critique.md, once shipped        - impeccable critique of the published screens
//   4. docs/review.md, once shipped                 - the independent reviewer
//   5. no access token written to a file or to shared storage (lakehouse, OneLake), including a
//      token file placed there over REST
// The plan is the acceptance contract, or a DOD plan when the person chose DOD; neither is demanded
// at the stop (a measured build spent four times the cost of the one before it on an open-ended
// DOD plan, so DOD is opt-in since 0.20).
//
// Two run checks apply to every project, harness or not, read from the session transcript:
//   R1. background shell work still running (a command started with run_in_background whose
//       completion has not arrived): a headless run ends with the turn and kills it; a measured build
//       lost two legs this way. Wait for it, then end the turn.
//   R2. no person present (a headless run: entrypoint sdk-*, or "unattended": true in
//       scripts/canvas-app.json) and the last message asks the person a question: take the
//       recommendation, record it, carry on. A measured build stopped three times to ask questions
//       it had already answered with a recommendation.
//   R3. the seed is not proven back: production data was written (a walk with --allow-writes logs
//       each one in .ship-work/writes.json) and there is no clean seed check (seed-data.py check,
//       which records .ship-work/seed-check.json) newer than the last write, or the last check found
//       drift. Two measured builds handed back with their own test edits still in the seed rows; one
//       said "the final seed check showed no drift" after walks that ran later returned seeded loans.
// After tools (--post, PostToolUse on Bash and PowerShell) it keeps the build to its budget, with
// numbers rather than advice: every 40 shell calls it reports the count (a measured lead made 472
// single calls, each re-sending the whole conversation) and points at the batched tools, and at 45,
// 60, 90 and 120 minutes it reports the elapsed time against the one-hour budget; and once, when
// DESIGN.md is more than 20 minutes old and design/prototype.html is still missing, it tells the lead
// the design helper is past its cap (a measured helper ran 42 minutes). It never blocks.
// Self-test: node plugin-gate.mjs --selftest
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, readFileSafe, loadConfig, canvasSrcDirs } from './lib.mjs';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
function appConfig(root) {
  for (const c of ['scripts/canvas-app.json', 'canvas-app.json']) {
    const j = readJson(path.join(root, c));
    if (j) return j;
  }
  return {};
}
function hasReport(dir, depth = 0) {
  if (depth > 4) return false;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === 'definition.pbir') return true;
    if (e.isDirectory() && (/\.report$/i.test(e.name) || hasReport(path.join(dir, e.name), depth + 1))) return true;
  }
  return false;
}
const exists = (root, ...rels) => rels.some((r) => fs.existsSync(path.join(root, r)));

// DOD counts as installed when the plugin list or a skill folder names it.
export function dodInstalled(env = process.env) {
  const homes = [env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(Boolean);
  for (const h of homes) {
    if (/"dod@/.test(readFileSafe(path.join(h, 'plugins', 'installed_plugins.json')))) return true;
    if (fs.existsSync(path.join(h, 'skills', 'dod', 'SKILL.md'))) return true;
  }
  return false;
}

// A token written to a file or to shared storage. Heuristic, line based: a line naming a *token*
// variable next to (within two lines of) a write to a file or a lakehouse / OneLake path. Local
// credential caches in the user profile are not the concern; shared storage and project files are.
const CODE_EXT = new Set(['.py', '.ps1', '.psm1', '.mjs', '.js', '.cjs', '.ts', '.ipynb', '.sh', '.scala']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'bin', 'obj', 'scratchpad', '.claude']);
const TOKEN_ID = /\b\w*token\w*\b/i;
const SHARED = /(notebookutils|mssparkutils)\.fs\.(put|append)|onelake|abfss:\/\/|dfs\.fabric\.microsoft\.com|\/Files\/|lakehouse/i;
// A token FILE on shared storage (written over REST, e.g. a DFS PUT/PATCH, so no write call names it).
const TOKEN_FILE_ON_SHARED = /(\/Files\/|onelake|abfss:\/\/|dfs\.fabric)[^\n'"]*token[^\n'"]*\.(txt|json|key)\b/i;
const WRITE = /\.write\(|write_text\(|writeFileSync\(|Set-Content|Out-File|Add-Content|\bfs\.(put|append)\(|upload/i;
export function tokenWrites(root, limit = 5) {
  const hits = [];
  (function walk(dir, depth) {
    if (depth > 6 || hits.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); continue; }
      if (!CODE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      const lines = readFileSafe(full).split(/\r?\n/);
      const underFabric = path.relative(root, full).replace(/\\/g, '/').startsWith('fabric/');
      for (let i = 0; i < lines.length; i++) {
        const win = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
        if ((TOKEN_ID.test(lines[i]) && WRITE.test(lines[i]) && (SHARED.test(win) || underFabric)) || TOKEN_FILE_ON_SHARED.test(lines[i])) {
          hits.push(`${path.relative(root, full).replace(/\\/g, '/')}:${i + 1}`);
          break;
        }
      }
    }
  })(root, 0);
  return hits;
}

// The whole decision, pure: returns null (stay silent) or the reason to block with.
export function evaluate(root, input = {}, env = process.env) {
  if (fs.existsSync(path.join(root, '.claude', 'hooks', 'audit-stop.mjs'))) return null;   // the harness gates this project
  const cfg = loadConfig(root);
  const app = appConfig(root);
  if (cfg.pluginGate === false || app.pluginGate === false) return null;
  const hasCanvas = canvasSrcDirs(root, cfg.canvasSrcGlob || 'canvas').length > 0 || (app.canvasSrc && fs.existsSync(path.join(root, app.canvasSrc)));
  const hasBi = hasReport(path.join(root, 'fabric'));
  if (!hasCanvas && !hasBi) return null;

  let shipped = false;
  try { shipped = fs.readdirSync(path.join(root, app.outDir || 'out')).some((f) => /\.(zip|msapp)$/i.test(f)); } catch { /* nothing packed */ }
  const missing = [];
  if (!exists(root, 'DESIGN.md', 'docs/DESIGN.md')) {
    missing.push('DESIGN.md is missing. Invoke the impeccable skill (Skill tool: impeccable) init now: PRODUCT.md, DESIGN.md (create the theme if none was given), ' +
      'then design/prototype.html per references/project-setup.md section 3.');
  }
  if (hasCanvas && !exists(root, 'design/prototype.html')) {
    missing.push('design/prototype.html is missing. Design every screen at 1440 and 390 px (and the report page) in HTML with impeccable, critique it and fix it, ' +
      'before more .pa.yaml is written (references/project-setup.md section 3).');
  }
  if (shipped) {
    const critique = readFileSafe(path.join(root, 'docs', 'design-critique.md'));
    if (!(/\.png\b/i.test(critique) && /score/i.test(critique))) {
      missing.push(`docs/design-critique.md ${critique ? 'does not name the screenshots (.png) and a score' : 'is missing'}. Run impeccable critique on the published ` +
        `screens at 1440 and 390 px${hasBi ? ' and the report' : ''}, fix what it raises in one batch, and record the screenshots and the score.`);
    }
  }
  if (shipped && !exists(root, 'docs/review.md')) {
    missing.push('docs/review.md is missing. Run the independent reviewer (assets/templates/reviewer-prompt.md, orchestration.md section 7) and record its findings and what was fixed.');
  }
  const leaks = tokenWrites(root);
  if (leaks.length) {
    missing.push(`An access token appears to be written to a file or shared storage (${leaks.join(', ')}). Tokens must never be written to files or to a lakehouse; ` +
      'use a connection or an identity the service holds, or pass the token in memory.');
  }
  if (!missing.length) return null;
  return 'Power Platform build gate (power-platform plugin). Do not hand back yet: carry out each step below now, with the tools ' +
    '(listing them in a summary is not doing them), then finish:\n' + missing.map((m, i) => `${i + 1}. ${m}`).join('\n') +
    '\nTurn this gate off only with the person\'s agreement: "pluginGate": false in scripts/canvas-app.json.';
}

// ---- Run checks from the transcript (R1, R2) ---------------------------------------------------
const BG_START = /running in background with ID: ([\w-]+)/g;
const BG_DONE = /<task-id>([\w-]+)<\/task-id>[\s\S]{0,600}?<status>(completed|failed|killed|stopped|cancelled|timed_out)<\/status>/g;
// A request to the person, with or without a question mark (a live stop listed "Decisions I need from
// you" as statements); weaker wording counts only next to a question mark.
const ASKS_STRONG = /\b(waiting (?:on|for) (?:you|your)|i need (?:you|your|from you)|decisions? (?:i need|for you)|answer by number|paused until you|your (?:go-ahead|choice|decision|answer|reply|confirmation)s?\b|please (?:confirm|sign in|choose|reply|answer|decide|approve))/i;
const ASKS_WEAK = /\b(recommend(?:ed|ation)?|should i|do you want|would you like|may i|shall i)\b/i;
export function transcriptFacts(transcriptPath) {
  const facts = { entrypoint: '', pending: [], lastText: '' };
  let text = '';
  try { text = fs.readFileSync(transcriptPath, 'utf8'); } catch { return facts; }
  const started = new Map(); const done = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!facts.entrypoint) { const m = line.match(/"entrypoint":"([^"]+)"/); if (m) facts.entrypoint = m[1]; }
    if (line.includes('in background with ID')) for (const m of line.matchAll(BG_START)) started.set(m[1], true);
    if (line.includes('<task-id>')) for (const m of line.replace(/\\n/g, '\n').matchAll(BG_DONE)) done.add(m[1]);
    if (line.includes('"type":"assistant"') && !line.includes('"isSidechain":true')) {
      try {
        const e = JSON.parse(line);
        const t = (e.message?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (t.trim()) facts.lastText = t;
      } catch { /* partial line */ }
    }
  }
  facts.pending = [...started.keys()].filter((id) => !done.has(id));
  return facts;
}
export function unattended(root, facts, env = process.env) {
  if (appConfig(root).unattended === true) return true;
  return /^sdk/i.test(env.CLAUDE_CODE_ENTRYPOINT || facts.entrypoint || '');
}
export function asksPerson(text) {
  const t = text || '';
  return ASKS_STRONG.test(t) || (/\?/.test(t) && ASKS_WEAK.test(t));
}
// R3, pure: null when the seed is proven back (or nothing was written), else what is wrong.
export function seedState(root) {
  const work = path.join(root, appConfig(root).workDir || '.ship-work');
  const writes = readJson(path.join(work, 'writes.json'));
  const check = readJson(path.join(work, 'seed-check.json'));
  const lastWrite = Array.isArray(writes) && writes.length ? writes[writes.length - 1] : null;
  if (check && check.clean === false) return `the last seed check (${check.at}) found drift`;
  if (!lastWrite) return null;
  if (!check) return `production data was written (last: "${lastWrite.scenario}" at ${lastWrite.at}) and no seed check has run`;
  if (Date.parse(check.at) < Date.parse(lastWrite.at)) {
    return `the last seed check (${check.at}) is older than the last write ("${lastWrite.scenario}" at ${lastWrite.at})`;
  }
  return null;
}
export function runChecks(root, input = {}, env = process.env) {
  const facts = transcriptFacts(input.transcript_path || '');
  const out = [];
  const seed = seedState(root);
  if (seed) {
    out.push(`The seed data is not proven back: ${seed}. Walks that lend, return or approve change seed rows, and a hand-back ` +
      'with test edits in them fails its data checks. Run python scripts/seed-data.py seed --seed <seed file> --update --apply ' +
      '(it re-checks and records the result), list any test rows you leave, and only then hand back. Run no write walk after it.');
  }
  if (facts.pending.length) {
    out.push(`Background shell work started in this session is still running (${facts.pending.slice(0, 5).join(', ')}). ` +
      'When this turn ends a headless run ends with it and the work is killed. Wait for it now (Monitor with an until-loop on its ' +
      'output, or read the output file once its notification arrives), act on the result, then finish. Run walks and other ' +
      'checks you need the answer to in the foreground (timeout up to 600000 ms) or inside a helper agent.');
  }
  if (unattended(root, facts, env) && asksPerson(facts.lastText)) {
    out.push('No person is present in this run, so a question will not be answered. Do not end the turn on one: take your own ' +
      'recommendation for each question, record it in docs/decisions.md ("taken unattended"), and carry on with the work. A step only ' +
      'the person can do (a licence, a sign-in with no browser path) goes into docs/STATE.md as open, and the build continues around it. ' +
      'First try the documented no-person path: connections with canvas-browser.mjs connection, the Fabric connection in the signed-in ' +
      'browser profile (reporting.md), your own test approvals in the browser (orchestration.md section 5).');
  }
  return out;
}

// Stop: block up to MAX_BLOCKS times per session and kind, then let it through with the gaps on stderr.
export const MAX_BLOCKS = 3;
function counted(stateDir, sid, kind, reason) {
  const f = path.join(stateDir, `pp-plugin-gate-${sid}${kind}.json`);
  const n = (readJson(f) || {}).blocks || 0;
  if (n >= MAX_BLOCKS) return { block: false, note: reason };
  try { fs.writeFileSync(f, JSON.stringify({ blocks: n + 1 })); } catch { /* unwritable temp: still block this once */ }
  return { block: true, reason: n ? `(Block ${n + 1} of ${MAX_BLOCKS}: still open.)\n${reason}` : reason };
}
export function decideStop(root, input = {}, env = process.env, stateDir = os.tmpdir()) {
  const sid = String(input.session_id || '').replace(/[^\w-]/g, '');
  const run = runChecks(root, input, env);
  if (run.length) {
    const reason = 'Power Platform run gate (power-platform plugin). Not finished yet:\n' + run.map((m, i) => `${i + 1}. ${m}`).join('\n');
    if (!sid) return input.stop_hook_active === true ? { block: false, note: reason } : { block: true, reason };
    const d = counted(stateDir, sid, '-run', reason);
    if (d.block) return d;
  }
  const reason = evaluate(root, input, env);
  if (!reason) return { block: false };
  if (!sid) return input.stop_hook_active === true ? { block: false, note: reason } : { block: true, reason };   // no id: block once
  return counted(stateDir, sid, '', reason);
}

// ---- PostToolUse budget ------------------------------------------------------------------------
export const SHELL_NUDGE_EVERY = 40;
export const TIME_MARKS = [45, 60, 90, 120];
function isBuildFolder(root) {
  const app = appConfig(root);
  return !!(app.appId || app.canvasSrc) || canvasSrcDirs(root, loadConfig(root).canvasSrcGlob || 'canvas').length > 0 || hasReport(path.join(root, 'fabric'));
}
export function budgetNote(state, now = Date.now()) {
  const notes = [];
  const mins = Math.floor((now - state.start) / 60000);
  if (state.shell >= state.nextNudge) {
    notes.push(`Budget: ${state.shell} shell calls so far this session. Each call re-sends the whole conversation. Batch: ` +
      'node scripts/check-all.mjs for the static checks, one canvas-browser.mjs walk call with every scenario (walk <folder>), ' +
      'one script for a group of Dataverse reads, and helpers for anything that produces long output.');
    state.nextNudge = state.shell + SHELL_NUDGE_EVERY;
  }
  const mark = TIME_MARKS.filter((m) => mins >= m && !state.marks.includes(m)).pop();
  if (mark) {
    state.marks.push(...TIME_MARKS.filter((m) => m <= mark && !state.marks.includes(m)));
    notes.push(`Budget: ${mins} minutes since this session's first shell call, against about 60 for a five-screen app with two flows and a ` +
      'medallion. Finish what is open in one batch: fix every high and medium finding together, ship once, walk once (one call), ' +
      'refresh the report last; list the low findings in the hand-back instead of fixing them one by one.');
  }
  return notes.join('\n');
}
// The design helper's cap. A measured build's helper ran 42 minutes (a second critique round and
// polish) while the screen helpers waited for its tokens. DESIGN.md's write time starts the clock;
// the prototype ends it. Reported once, never blocks: the lead tells the helper to return.
export const DESIGN_BUDGET_MIN = 20;
export function designOverdue(root, now = Date.now()) {
  const d = ['DESIGN.md', 'docs/DESIGN.md'].map((r) => path.join(root, r)).find((p) => fs.existsSync(p));
  if (!d || fs.existsSync(path.join(root, 'design/prototype.html'))) return 0;
  let since = 0;
  try { since = Math.floor((now - fs.statSync(d).mtimeMs) / 60000); } catch { return 0; }
  return since > DESIGN_BUDGET_MIN ? since : 0;
}
export function decidePost(root, input = {}, stateDir = os.tmpdir(), now = Date.now()) {
  if (!/^(Bash|PowerShell)$/.test(input.tool_name || '')) return null;
  if (loadConfig(root).pluginGate === false || appConfig(root).pluginGate === false) return null;
  if (!isBuildFolder(root)) return null;
  const sid = String(input.session_id || '').replace(/[^\w-]/g, '') || 'nosession';
  const f = path.join(stateDir, `pp-plugin-budget-${sid}.json`);
  const state = readJson(f) || { start: now, shell: 0, nextNudge: SHELL_NUDGE_EVERY, marks: [] };
  state.shell++;
  let note = budgetNote(state, now);
  const late = state.designNoted ? 0 : designOverdue(root, now);
  if (late) {
    state.designNoted = true;
    note = [note, `Budget: DESIGN.md was written ${late} minutes ago and design/prototype.html does not exist yet; the design helper's cap is ` +
      `${DESIGN_BUDGET_MIN} minutes (orchestration.md section 1). Tell it to write the prototype as it stands, design/app-formulas.txt and ` +
      'its unfixed critique findings now, then start the screen helpers. Finish belongs to the screenshot critique after the first publish.'].filter(Boolean).join('\n');
  }
  try { fs.writeFileSync(f, JSON.stringify(state)); } catch { /* unwritable temp */ }
  return note || null;
}

// ---- PreToolUse order gates --------------------------------------------------------------------
// A glob (Src/*.pa.yaml) names no file to write, so * and ? end a name.
const SCREEN_RE = /(^|[\\/])Src[\\/](?:[^\\/\s'"`*?]+[\\/])*([^\\/\s'"`*?]+)\.pa\.yaml\b/i;
const IGNORED_SEG = /(^|[\\/])(_EditorState|node_modules|\.git|out)([\\/]|$)/i;
// A shell command writes a screen when a redirect targets one, or a write command names one. A live
// run had a read (`cat Src/*.pa.yaml 2>/dev/null`) denied by a looser test; reads must pass.
const SHELL_WRITE_CMD = /Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|\bcp\b|\bmv\b|\btee\b|WriteAllText|write_text|writeFileSync|\bopen\([^)]*['"][wa]/i;
export function shellScreenWrite(cmd) {
  for (const m of String(cmd || '').matchAll(/>>?\s*['"]?([^\s'";|&>]+)/g)) {
    const hit = screenPathIn(m[1]);
    if (hit) return hit;
  }
  return SHELL_WRITE_CMD.test(cmd) ? screenPathIn(cmd) : null;
}
export function screenPathIn(text) {
  const m = String(text || '').match(SCREEN_RE);
  if (!m || IGNORED_SEG.test(m[0])) return null;
  return /^app$/i.test(m[2]) ? null : m[0].replace(/^[\\/]/, '');
}
function ancestors(p) {
  const out = [];
  for (let d = path.resolve(p); out.length < 10; d = path.dirname(d)) { out.push(d); if (path.dirname(d) === d) break; }
  return out;
}
// An established app (three or more screens already in its Src) is maintenance, not a new build.
export const NEW_APP_MAX_SCREENS = 2;
function screenCount(srcDir) {
  try { return fs.readdirSync(srcDir).filter((f) => /\.pa\.yaml$/i.test(f) && !/^app\.pa\.yaml$/i.test(f)).length; } catch { return 0; }
}
function designReady(dirs) {
  const has = (...rels) => dirs.some((d) => rels.some((r) => fs.existsSync(path.join(d, r))));
  return { design: has('DESIGN.md', 'docs/DESIGN.md'), proto: has('design/prototype.html') };
}
const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'templates', 'acceptance-contract.md');
function planReady(root) {
  // A DOD plan counts when the person chose DOD; otherwise the acceptance contract is the plan.
  try { if (fs.readdirSync(path.join(root, 'docs', 'dod')).some((f) => /\.md$/i.test(f) && f.toLowerCase() !== 'readme.md')) return true; } catch { /* none */ }
  const c = readFileSafe(path.join(root, 'docs', 'acceptance-contract.md')).replace(/\r/g, '').trim();
  if (c && c !== readFileSafe(TEMPLATE).replace(/\r/g, '').trim()) return true;
  return 'docs/acceptance-contract.md filled in from the brief (assets/templates/acceptance-contract.md)';
}

// The PreToolUse decision, pure: null (allow, say nothing) or the reason to deny with.
export function evaluatePre(root, input = {}, env = process.env) {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const isFile = /^(Write|Edit|MultiEdit)$/.test(tool);
  const isShell = /^(Bash|PowerShell)$/.test(tool);
  if (!isFile && !isShell) return null;
  if (loadConfig(root).pluginGate === false || appConfig(root).pluginGate === false) return null;
  const cmd = isShell ? String(ti.command || '') : '';

  // A. screens before design
  const screen = isFile ? screenPathIn(ti.file_path) : shellScreenWrite(cmd);
  if (screen) {
    const target = isFile ? path.resolve(root, ti.file_path) : path.resolve(root, screen);
    const r = designReady([...new Set([...ancestors(path.dirname(target)), root])]);
    const isNewApp = screenCount(path.dirname(target)) <= NEW_APP_MAX_SCREENS;
    if (isNewApp && (!r.design || !r.proto)) {
      const need = [!r.design && 'DESIGN.md', !r.proto && 'design/prototype.html'].filter(Boolean).join(' and ');
      return `Power Platform order gate (power-platform plugin): design comes before screens. ${need} ${!r.design && !r.proto ? 'do' : 'does'} not exist yet, ` +
        'so no screen .pa.yaml is written. Invoke the impeccable skill now (Skill tool: impeccable): init for PRODUCT.md and DESIGN.md ' +
        '(create the theme when none was given), then design/prototype.html with every screen at 1440 and 390 px, critiqued and fixed once ' +
        '(references/project-setup.md section 3). Then write the screens from the prototype. ' +
        '(Only with the person\'s agreement, for work that is not a new app: "pluginGate": false in scripts/canvas-app.json.)';
    }
  }
  // B. plan before schema
  if (isShell && /deploy-tables\.py/i.test(cmd) && !/--plan\b/.test(cmd)) {
    const ok = planReady(root);
    if (ok !== true) {
      return `Power Platform order gate (power-platform plugin): plan before schema. Tables are deployed only once ${ok} exists; ` +
        'the plan is where the schema decisions are made. A dry run (deploy-tables.py --plan) is allowed.';
    }
  }
  return null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) { /* imported: no side effects */ }
else if (process.argv.includes('--selftest')) selftest();
else if (process.argv.includes('--post')) {
  const input = readStdinJson();
  const note = decidePost(input.cwd || process.cwd(), input);
  if (note) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } }));
  process.exit(0);
} else if (process.argv.includes('--pre')) {
  const input = readStdinJson();
  const reason = evaluatePre(input.cwd || process.cwd(), input);
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
} else {
  const input = readStdinJson();
  const d = decideStop(input.cwd || process.cwd(), input);
  if (d.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: d.reason }));
  else if (d.note) process.stderr.write(`power-platform build gate: handing back with steps still missing (blocked ${MAX_BLOCKS} times):\n${d.note}\n`);
  process.exit(0);
}

function selftest() {
  const fails = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-gate-'));
  const cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-gate-home-'));
  const put = (rel, text = 'x', base = tmp) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const rm = (rel) => fs.rmSync(path.join(tmp, rel), { recursive: true, force: true });
  const env = { CLAUDE_CONFIG_DIR: cfgHome };
  let CASES = 0;
  const check = (name, got, want) => { CASES++; if (!want(got)) fails.push(`${name}: got ${JSON.stringify(got)}`); };
  const silent = (g) => g === null;
  const blocks = (...frags) => (g) => typeof g === 'string' && frags.every((f) => g.includes(f));
  try {
    put('README.md', '# unrelated');
    check('unrelated project is silent', evaluate(tmp, {}, env), silent);
    put('canvas/app/Src/Screen1.pa.yaml', 'Screens: {}');
    check('canvas without DESIGN.md blocks', evaluate(tmp, {}, env), blocks('DESIGN.md is missing', 'design/prototype.html is missing'));
    const st = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-gate-state-'));
    const runs = [1, 2, 3, 4].map(() => decideStop(tmp, { session_id: 's1', stop_hook_active: true }, env, st));
    check('stop blocks three times per session, then passes', runs.map((r) => r.block), (g) => g.join() === 'true,true,true,false');
    check('the fourth stop carries the gaps', runs[3].note, (g) => typeof g === 'string' && g.includes('DESIGN.md is missing'));
    check('another session has its own count', decideStop(tmp, { session_id: 's2' }, env, st).block, (g) => g === true);
    check('no session id: stop_hook_active passes', decideStop(tmp, { stop_hook_active: true }, env, st).block, (g) => g === false);
    fs.rmSync(st, { recursive: true, force: true });
    const pre = (tool, ti) => evaluatePre(tmp, { tool_name: tool, tool_input: ti }, env);
    const denies = (...frags) => (g) => typeof g === 'string' && frags.every((f) => g.includes(f));
    check('A: Write to a screen before design is denied', pre('Write', { file_path: path.join(tmp, 'canvas/app/Src/Loans.pa.yaml') }), denies('design comes before screens', 'DESIGN.md and design/prototype.html'));
    check('A: App.pa.yaml is allowed', pre('Write', { file_path: path.join(tmp, 'canvas/app/Src/App.pa.yaml') }), silent);
    check('A: _EditorState is allowed', pre('Edit', { file_path: path.join(tmp, 'canvas/app/Src/_EditorState/Loans.pa.yaml') }), silent);
    check('A: shell write to a screen is denied', pre('PowerShell', { command: 'Set-Content canvas\\app\\Src\\Loans.pa.yaml -Value $y' }), denies('design comes before screens'));
    check('A: shell redirect to a screen is denied', pre('Bash', { command: 'echo x > canvas/app/Src/Loans.pa.yaml' }), denies('design comes before screens'));
    check('A: the live false positive (glob read, stderr redirect) is allowed', pre('Bash', { command: 'find . -type f | head -50 && cat canvas/TestApp/Src/*.pa.yaml 2>/dev/null; cat canvas/theme.json' }), silent);
    check('A: a read then a write elsewhere is allowed', pre('Bash', { command: 'cat canvas/app/Src/Loans.pa.yaml > /tmp/copy.txt' }), silent);
    check('A: shell read of a screen is allowed', pre('Bash', { command: 'cat canvas/app/Src/Loans.pa.yaml 2>&1 | head' }), silent);
    for (const n of ['A', 'B', 'C']) put(`canvas/app/Src/${n}.pa.yaml`, 'Screens: {}');
    check('A: an established app (3+ screens) is not held up', pre('Edit', { file_path: path.join(tmp, 'canvas/app/Src/A.pa.yaml') }), silent);
    for (const n of ['A', 'B', 'C']) rm(`canvas/app/Src/${n}.pa.yaml`);
    check('A: other tools are allowed', pre('Read', { file_path: path.join(tmp, 'canvas/app/Src/Loans.pa.yaml') }), silent);
    check('B: deploy-tables without a plan is denied', pre('Bash', { command: 'python scripts/deploy-tables.py --solution X' }), denies('plan before schema', 'acceptance-contract.md'));
    check('B: deploy-tables --plan is allowed', pre('Bash', { command: 'python scripts/deploy-tables.py --plan' }), silent);
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.copyFileSync(TEMPLATE, path.join(tmp, 'docs', 'acceptance-contract.md'));
    check('B: the bare template is not a plan', pre('Bash', { command: 'python scripts/deploy-tables.py' }), denies('plan before schema'));
    put('docs/acceptance-contract.md', '# Equipment Loans\n| R1 | lend an item |');
    check('B: a filled contract allows the deploy', pre('Bash', { command: 'python scripts/deploy-tables.py' }), silent);
    put('scripts/canvas-app.json', JSON.stringify({ pluginGate: false }));
    check('pre: opt-out passes', pre('Write', { file_path: path.join(tmp, 'canvas/app/Src/Loans.pa.yaml') }), silent);
    put('scripts/canvas-app.json', JSON.stringify({}));
    put('.claude/hooks/audit-stop.mjs', '// harness');
    check('project harness present passes', evaluate(tmp, {}, env), silent);
    rm('.claude/hooks/audit-stop.mjs');
    put('scripts/canvas-app.json', JSON.stringify({ pluginGate: false }));
    check('opt-out in canvas-app.json passes', evaluate(tmp, {}, env), silent);
    put('scripts/canvas-app.json', JSON.stringify({}));
    put('.claude/hooks/standards.config.json', JSON.stringify({ pluginGate: false }));
    check('opt-out in standards.config.json passes', evaluate(tmp, {}, env), silent);
    rm('.claude/hooks/standards.config.json');
    put('DESIGN.md', '# design');
    check('A: DESIGN.md without the prototype is still denied', evaluatePre(tmp, { tool_name: 'Write', tool_input: { file_path: 'canvas/app/Src/Loans.pa.yaml' } }, env), (g) => typeof g === 'string' && g.includes('design/prototype.html does'));
    put('design/prototype.html', '<!doctype html>');
    check('A: designed project may write screens', evaluatePre(tmp, { tool_name: 'Write', tool_input: { file_path: 'canvas/app/Src/Loans.pa.yaml' } }, env), silent);
    check('designed, not shipped, no DOD: passes', evaluate(tmp, {}, env), silent);
    put('out/app.zip', 'zip');
    check('shipped without critique and review blocks', evaluate(tmp, {}, env), blocks('design-critique.md', 'docs/review.md'));
    put('docs/design-critique.md', 'Score 34/40. Screens: list-1440.png list-390.png'); put('docs/review.md', '# findings');
    check('complete project passes', evaluate(tmp, {}, env), silent);
    put('plugins/installed_plugins.json', JSON.stringify({ plugins: { 'dod@dod-skill': [{}] } }), cfgHome);
    check('dod detected', dodInstalled(env), (g) => g === true);
    check('dod installed is not a demand (opt-in since 0.20)', evaluate(tmp, {}, env), silent);
    rm('docs/acceptance-contract.md');
    put('docs/dod/equipment-loans.md', '# plan');
    check('B: a DOD plan also counts as the plan', evaluatePre(tmp, { tool_name: 'Bash', tool_input: { command: 'python scripts/deploy-tables.py' } }, env), silent);
    rm('docs/dod');
    // R1, R2 from a transcript
    const tr = path.join(tmp, 't.jsonl');
    const line = (o) => JSON.stringify(o);
    const asst = (text, extra = {}) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });
    const res = (text) => line({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });
    const st2 = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-gate-state-'));
    const stop = (lines, sid = 'r', e = {}) => { fs.writeFileSync(tr, lines.join('\n')); return decideStop(tmp, { session_id: sid, transcript_path: tr }, e, st2); };
    const cli = line({ type: 'user', entrypoint: 'cli', message: { content: 'go' } });
    const sdk = line({ type: 'user', entrypoint: 'sdk-cli', message: { content: 'go' } });
    check('R1: pending background shell blocks', stop([cli, res('Command running in background with ID: b1x. Output is being written to: x'), asst('I will continue when the walks report.')], 'r1'),
      (g) => g.block && g.reason.includes('still running (b1x)'));
    check('R1: completed background shell passes', stop([cli, res('Command running in background with ID: b1x.'), line({ type: 'user', message: { content: '<task-notification>\n<task-id>b1x</task-id>\n<status>completed</status>' } }), asst('All walks passed.')], 'r1b'),
      (g) => !g.block);
    check('R2: unattended question blocks', stop([sdk, asst('Decisions I need from you:\n1. Install Playwright? Recommend: yes.')], 'r2'),
      (g) => g.block && g.reason.includes('No person is present'));
    check('R2: the same question with a person present passes', stop([cli, asst('Decisions I need from you:\n1. Install Playwright? Recommend: yes.')], 'r2b'), (g) => !g.block);
    check('R2: a request without a question mark blocks', stop([sdk, asst("I'm still waiting on your choice for the plan review: (a) run it, which I recommend.")], 'r2f'), (g) => g.block);
    check('R2: an unattended hand-back without a question passes', stop([sdk, asst('Built and verified: 35 of 35 rows pass.')], 'r2c'), (g) => !g.block);
    check('R2: "unattended": true in canvas-app.json counts', (put('scripts/canvas-app.json', JSON.stringify({ unattended: true })), stop([cli, asst('Should I publish now? I recommend yes.')], 'r2d')), (g) => g.block);
    put('scripts/canvas-app.json', JSON.stringify({}));
    check('R2: a sidechain question is not the lead\'s', stop([sdk, asst('Shall I continue? Recommend yes.', { isSidechain: true }), asst('Done.')], 'r2e'), (g) => !g.block);
    const rr = [1, 2, 3, 4].map(() => stop([sdk, asst('May I proceed? I recommend yes.')], 'r3').block);
    check('run checks block three times, then pass', rr, (g) => g.join() === 'true,true,true,false');
    put('.claude/hooks/audit-stop.mjs', '// harness');
    check('run checks apply with the project harness too', stop([sdk, asst('Shall I go on? Recommend yes.')], 'r4'), (g) => g.block);
    rm('.claude/hooks/audit-stop.mjs');
    fs.rmSync(st2, { recursive: true, force: true });
    // PostToolUse budget
    const st3 = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-gate-budget-'));
    put('scripts/canvas-app.json', JSON.stringify({ appId: 'x', canvasSrc: 'canvas/app/Src' }));
    const t0 = 1_000_000_000_000;
    const post = (n, at, tool = 'Bash') => { let out = null; for (let i = 0; i < n; i++) out = decidePost(tmp, { tool_name: tool, session_id: 'b1' }, st3, at) || out; return out; };
    check('post: a Read is ignored', decidePost(tmp, { tool_name: 'Read', session_id: 'b0' }, st3, t0), silent);
    check('post: 39 shell calls say nothing', post(39, t0), silent);
    check('post: the 40th reports the count', post(1, t0), (g) => typeof g === 'string' && g.includes('40 shell calls') && g.includes('walk <folder>'));
    check('post: the next note waits 40 more', post(39, t0), silent);
    check('post: 45 minutes reports the budget once', post(1, t0 + 46 * 60000), (g) => typeof g === 'string' && g.includes('46 minutes') && g.includes('ship once'));
    check('post: the same mark is not repeated', post(1, t0 + 50 * 60000), silent);
    check('post: a jump past several marks reports once', post(1, t0 + 125 * 60000), (g) => typeof g === 'string' && g.includes('125 minutes'));
    // Design helper cap: DESIGN.md's write time starts the clock, the prototype stops it.
    rm('design'); put('DESIGN.md', '# Design');
    const dAt = fs.statSync(path.join(tmp, 'DESIGN.md')).mtimeMs;
    const dpost = (sid, mins) => decidePost(tmp, { tool_name: 'Bash', session_id: sid }, st3, dAt + mins * 60000);
    check('post: design 15 minutes in says nothing', dpost('d1', 15), silent);
    check('post: design past 20 minutes reports once', dpost('d1', 25), (g) => typeof g === 'string' && g.includes('25 minutes ago') && g.includes('design/app-formulas.txt'));
    check('post: the design note is not repeated', dpost('d1', 30), silent);
    put('design/prototype.html', '<!doctype html>');
    check('post: prototype written, no design note', dpost('d2', 40), silent);
    check('post: silent outside a build folder', (put('scripts/canvas-app.json', '{}'), rm('canvas'), decidePost(tmp, { tool_name: 'Bash', session_id: 'b9' }, st3, t0)), silent);
    fs.rmSync(st3, { recursive: true, force: true });
    // R3 seed state
    const sw = (rel, obj) => put('.ship-work/' + rel, JSON.stringify(obj));
    rm('.ship-work');
    check('R3: nothing written, no check: silent', seedState(tmp), silent);
    sw('writes.json', [{ at: '2026-10-05T03:00:00.000Z', scenario: 'lend' }]);
    check('R3: a write and no check blocks', seedState(tmp), (g) => typeof g === 'string' && g.includes('no seed check'));
    sw('seed-check.json', { at: '2026-10-05T02:59:00.000Z', clean: true });
    check('R3: a clean check older than the write blocks', seedState(tmp), (g) => typeof g === 'string' && g.includes('older than the last write'));
    sw('seed-check.json', { at: '2026-10-05T03:05:00.000Z', clean: true });
    check('R3: a clean check after the last write passes', seedState(tmp), silent);
    sw('seed-check.json', { at: '2026-10-05T03:06:00.000Z', clean: false });
    check('R3: a check that found drift blocks', seedState(tmp), (g) => typeof g === 'string' && g.includes('found drift'));
    check('R3: reaches the stop as a run check', runChecks(tmp, {}, {}).join(' '), (g) => g.includes('seed-data.py seed'));
    rm('.ship-work');
    put('canvas/app/Src/Screen1.pa.yaml', 'Screens: {}'); put('scripts/canvas-app.json', '{}');
    put('fabric/notebooks/refresh.py', "token = get_token()\nnotebookutils.fs.put('Files/landing/t.txt', token, True)\n");
    check('token written to a lakehouse blocks', evaluate(tmp, {}, env), blocks('access token', 'fabric/notebooks/refresh.py:2'));
    put('fabric/notebooks/refresh.py', 'def token_file_url():\n    return "%s/%s/Files/_runtime/dv_token.txt" % (ONELAKE, item)\n');
    check('token file on OneLake over REST blocks', evaluate(tmp, {}, env), blocks('access token', 'fabric/notebooks/refresh.py:2'));
    put('fabric/notebooks/refresh.py', "rows = read_rows()\nnotebookutils.fs.put('Files/landing/rows.json', rows, True)\n");
    check('non-token lakehouse write passes', evaluate(tmp, {}, env), silent);
    rm('canvas'); rm('DESIGN.md'); rm('design');
    check('unrelated write stays silent', evaluatePre(tmp, { tool_name: 'Write', tool_input: { file_path: 'notes/readme.md' } }, env), silent);
    put('fabric/report/App.Report/definition.pbir', '{}');
    check('report only, no DESIGN.md blocks (no prototype demand)', evaluate(tmp, {}, env), (g) => blocks('DESIGN.md is missing')(g) && !g.includes('prototype.html is missing'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(cfgHome, { recursive: true, force: true });
  }
  if (fails.length) { console.log('selftest FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log(`selftest ok: ${CASES} plugin-gate cases (Stop: unrelated silent, design missing, three blocks per session then a note, per-session count, ` +
    'no-id fallback, harness present, two opt-outs, designed, shipped without critique/review, complete, dod opt-in, background shell pending and done, unattended question, attended question, unattended hand-back, unattended flag, sidechain, run-check cap, run checks with harness, token to ' +
    'lakehouse, token file over REST, non-token write, report-only; R3: silent, write without check, stale check, clean after write, drift, as a run check; PostToolUse: Read ignored, 39 silent, 40th note, next after 40, 45-minute mark once, no repeat, jump past marks, design cap silent, design cap once, design note once only, design cap stops at the prototype, outside a build; PreToolUse: screen write before design by file, cmdlet and redirect, glob read with a stderr redirect, read to elsewhere, established app, ' +
    'App.pa.yaml, _EditorState, shell read, other tools, prototype missing, designed, deploy-tables with and without --plan, bare template, ' +
    'filled contract, dod plan, opt-out, unrelated write)');
  process.exit(0);
}
