// Stop hook shipped with the PLUGIN (hooks/hooks.json at the plugin root), so it runs whenever the
// plugin is enabled - no project harness needed.
//
// Why: in a measured build the agent never ran the design-first and planning steps the skill calls
// required (not one mention in 72 minutes), and the project-level design gate never ran because the
// harness is installed only "when the person agrees" and nobody was present. Guidance an agent can
// skip is not a gate; this is.
//
// It does nothing (exit 0, no output) unless the folder is a Power Platform build: canvas source
// (canvas/<app>/Src, or "canvasSrc" in scripts/canvas-app.json) or a Power BI report under fabric/.
// It never loops (stop_hook_active), stands aside when the project harness's own audit-stop hook is
// installed, and can be turned off with "pluginGate": false in .claude/hooks/standards.config.json or
// scripts/canvas-app.json. Otherwise it blocks the stop once, with every missing step in one reason:
//   1. DESIGN.md (root or docs/)                   - impeccable init
//   2. design/prototype.html (canvas source)       - the HTML design pass
//   3. docs/design-critique.md, once shipped        - impeccable critique of the published screens
//   4. a DOD plan (docs/dod/*.md), when DOD is installed
//   5. docs/review.md, once shipped                 - the independent reviewer
//   6. no access token written to a file or to shared storage (lakehouse, OneLake), including a
//      token file placed there over REST
// Self-test: node plugin-gate.mjs --selftest
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  if (input && input.stop_hook_active === true) return null;
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
  if (dodInstalled(env)) {
    let plans = [];
    try { plans = fs.readdirSync(path.join(root, 'docs', 'dod')).filter((f) => /\.md$/i.test(f) && f.toLowerCase() !== 'readme.md'); } catch { /* none */ }
    if (!plans.length) missing.push('No DOD plan in docs/dod/. Invoke the dod skill (Skill tool: dod): dod plan --autonomous from the brief, and map its items to the acceptance contract.');
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
  return 'Power Platform build gate (power-platform plugin). Before handing back:\n' + missing.map((m, i) => `${i + 1}. ${m}`).join('\n') +
    '\nTurn this gate off only with the person\'s agreement: "pluginGate": false in scripts/canvas-app.json.';
}

if (process.argv.includes('--selftest')) selftest();
else {
  const reason = evaluate(process.cwd(), readStdinJson());
  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function selftest() {
  const fails = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-gate-'));
  const cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-gate-home-'));
  const put = (rel, text = 'x', base = tmp) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const rm = (rel) => fs.rmSync(path.join(tmp, rel), { recursive: true, force: true });
  const env = { CLAUDE_CONFIG_DIR: cfgHome };
  const check = (name, got, want) => { if (!want(got)) fails.push(`${name}: got ${JSON.stringify(got)}`); };
  const silent = (g) => g === null;
  const blocks = (...frags) => (g) => typeof g === 'string' && frags.every((f) => g.includes(f));
  try {
    put('README.md', '# unrelated');
    check('unrelated project is silent', evaluate(tmp, {}, env), silent);
    put('canvas/app/Src/Screen1.pa.yaml', 'Screens: {}');
    check('canvas without DESIGN.md blocks', evaluate(tmp, {}, env), blocks('DESIGN.md is missing', 'design/prototype.html is missing'));
    check('stop_hook_active passes', evaluate(tmp, { stop_hook_active: true }, env), silent);
    put('.claude/hooks/audit-stop.mjs', '// harness');
    check('project harness present passes', evaluate(tmp, {}, env), silent);
    rm('.claude/hooks/audit-stop.mjs');
    put('scripts/canvas-app.json', JSON.stringify({ pluginGate: false }));
    check('opt-out in canvas-app.json passes', evaluate(tmp, {}, env), silent);
    put('scripts/canvas-app.json', JSON.stringify({}));
    put('.claude/hooks/standards.config.json', JSON.stringify({ pluginGate: false }));
    check('opt-out in standards.config.json passes', evaluate(tmp, {}, env), silent);
    rm('.claude/hooks/standards.config.json');
    put('DESIGN.md', '# design'); put('design/prototype.html', '<!doctype html>');
    check('designed, not shipped, no DOD: passes', evaluate(tmp, {}, env), silent);
    put('out/app.zip', 'zip');
    check('shipped without critique and review blocks', evaluate(tmp, {}, env), blocks('design-critique.md', 'docs/review.md'));
    put('docs/design-critique.md', 'Score 34/40. Screens: list-1440.png list-390.png'); put('docs/review.md', '# findings');
    check('complete project passes', evaluate(tmp, {}, env), silent);
    put('plugins/installed_plugins.json', JSON.stringify({ plugins: { 'dod@dod-skill': [{}] } }), cfgHome);
    check('dod detected', dodInstalled(env), (g) => g === true);
    check('dod installed, no plan blocks', evaluate(tmp, {}, env), blocks('No DOD plan'));
    put('docs/dod/equipment-loans.md', '# plan');
    check('dod plan present passes', evaluate(tmp, {}, env), silent);
    put('fabric/notebooks/refresh.py', "token = get_token()\nnotebookutils.fs.put('Files/landing/t.txt', token, True)\n");
    check('token written to a lakehouse blocks', evaluate(tmp, {}, env), blocks('access token', 'fabric/notebooks/refresh.py:2'));
    put('fabric/notebooks/refresh.py', 'def token_file_url():\n    return "%s/%s/Files/_runtime/dv_token.txt" % (ONELAKE, item)\n');
    check('token file on OneLake over REST blocks', evaluate(tmp, {}, env), blocks('access token', 'fabric/notebooks/refresh.py:2'));
    put('fabric/notebooks/refresh.py', "rows = read_rows()\nnotebookutils.fs.put('Files/landing/rows.json', rows, True)\n");
    check('non-token lakehouse write passes', evaluate(tmp, {}, env), silent);
    rm('canvas'); rm('DESIGN.md'); rm('design');
    put('fabric/report/App.Report/definition.pbir', '{}');
    check('report only, no DESIGN.md blocks (no prototype demand)', evaluate(tmp, {}, env), (g) => blocks('DESIGN.md is missing')(g) && !g.includes('prototype.html is missing'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(cfgHome, { recursive: true, force: true });
  }
  if (fails.length) { console.log('selftest FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('selftest ok: 17 plugin-gate cases (unrelated silent, design missing, loop guard, harness present, two opt-outs, designed, shipped without critique/review, complete, dod detection and plan, token to lakehouse, token file over REST, non-token write, report-only)');
  process.exit(0);
}
