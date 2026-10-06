// Stop hook: the end-of-turn audit.
//
// Confirms the turn left no standards violations, leftover debug markers, or canvas apps over
// the file ceiling, and reminds about bookkeeping (dependency register, state file, changelog)
// when the solution changed. Blocks the stop ONCE on findings so they are fixed in the same
// turn; never blocks twice in a row (stop_hook_active), and reminders alone never block.
// Build gate: the same rules as the power-platform plugin's Stop hook (plugin-gate.mjs evaluate, which
// stands aside in a harnessed project so the two never block twice): design record, critique, review,
// the Power Pages review topics, and no token written to storage - each scoped to the surfaces that
// have it (references/rules-and-scope.md). "designGate": false turns it off.
// Self-test: node audit-stop.mjs --selftest
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readStdinJson, listRepoTextFiles, isProse, isHookFile, findEmoji, findPurple, readFileSafe, loadConfig, canvasSrcDirs, isVendoredCopy, DEFAULT_CONFIG } from './lib.mjs';
import { evaluate } from './plugin-gate.mjs';

// The build gate as findings: one finding per numbered step of the plugin gate's reason.
export function buildGate(root, cfg) {
  if (cfg.designGate === false) return [];
  const full = evaluate(root, {}, process.env, { harness: true });
  if (!full) return [];
  const reason = full.split('\nTurn this gate off')[0];
  const steps = reason.split(/\n\s*\d+\.\s+/).slice(1).map((s) => s.trim()).filter(Boolean);
  return steps.length ? steps.map((s) => 'build gate: ' + s) : ['build gate: ' + reason];
}

if (process.argv.includes('--selftest')) selftest();

function selftest() {
  const fails = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'design-gate-'));
  const put = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); };
  const run = (cfg = DEFAULT_CONFIG) => buildGate(tmp, cfg);
  const want = (name, got, n, has = '') => { if (got.length !== n || (has && !got.join(' ').includes(has))) fails.push(`${name}: ${got.length} finding(s) [${got.join(' | ').slice(0, 200)}], want ${n}${has ? ' with ' + has : ''}`); };
  try {
    put('.claude/hooks/audit-stop.mjs', '// harness');   // a harnessed project: the plugin Stop hook stands aside, this one decides
    want('no Power Platform surface', run(), 0);
    put('canvas/app/Src/Screen1.pa.yaml');
    want('canvas, no DESIGN.md', run(), 2, '[Canvas] design/prototype.html');
    want('turned off', run({ ...DEFAULT_CONFIG, designGate: false }), 0);
    put('docs/DESIGN.md'); put('design/prototype.html');
    want('designed, not shipped', run(), 0);
    put('out/app.zip');
    want('shipped without critique or review', run(), 2, 'docs/review.md');
    put('docs/design-critique.md', 'list-1440.png list-390.png - score 24/40'); put('docs/review.md', '# findings');
    want('canvas complete (no critique floor outside Power Pages)', run(), 0);
    fs.rmSync(path.join(tmp, 'canvas'), { recursive: true }); fs.rmSync(path.join(tmp, 'docs'), { recursive: true }); fs.rmSync(path.join(tmp, 'design'), { recursive: true });
    put('fabric/report/definition.pbir', '{}');
    want('report only, no DESIGN.md, shipped', run(), 3, '[Power BI]');
    fs.rmSync(path.join(tmp, 'fabric'), { recursive: true }); fs.rmSync(path.join(tmp, 'out'), { recursive: true });
    put('fabric/notebooks/load.py', "token = get_token()\nnotebookutils.fs.put('Files/t.txt', token, True)\n");
    want('Fabric only: token written to storage', run(), 1, 'Fabric');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(fails.length ? 'selftest FAILED:\n  ' + fails.join('\n  ') : 'selftest ok: 8 build-gate cases (no surface, canvas, off, designed, shipped without critique/review, canvas complete, report only, Fabric token)');
  process.exit(fails.length ? 1 : 0);
}

const input = readStdinJson();
const looping = input?.stop_hook_active === true;
const root = process.cwd();
const cfg = loadConfig(root);
const ignore = new Set((cfg.auditIgnore || []).map((r) => r.replace(/\\/g, '/')));
const files = listRepoTextFiles(root).filter((f) => {
  const rel = path.relative(root, f).replace(/\\/g, '/');
  return !isHookFile(f) && !ignore.has(rel) && !isVendoredCopy(root, rel);
});
const findings = [];
const reminders = [];

for (const file of files) {
  const rel = path.relative(root, file);
  const text = readFileSafe(file);
  if (cfg.emoji) for (const e of findEmoji(text)) findings.push(`${rel}:${e.line} emoji ${e.code} - use an icon/SVG`);
  if (cfg.purpleAccents) for (const p of findPurple(text, { checkNamed: !isProse(file) })) findings.push(`${rel}:${p.line} colour ${p.value} (${p.why})`);
  if (cfg.debugMarkers && /\.(js|mjs|ts|ps1|py|fx|xml)$/i.test(file)) {
    text.split(/\r?\n/).forEach((ln, i) => {
      if (ln.includes('standards-ignore')) return;
      if (/\b(TODO|FIXME|XXX|HACK|DEBUG_ONLY)\b|console\.log\(/.test(ln)) findings.push(`${rel}:${i + 1} leftover marker: ${ln.trim().slice(0, 80)}`);
    });
  }
}

for (const src of canvasSrcDirs(root, cfg.canvasSrcGlob)) {
  const n = fs.readdirSync(src).filter((f) => f.endsWith('.pa.yaml')).length;
  if (n > cfg.canvasFileCeiling) {
    findings.push(`${path.relative(root, src)}: ${n} .pa.yaml files exceeds the ${cfg.canvasFileCeiling}-file ceiling - ` +
      `the compile will be refused and a subset push evicts screens. Fold a screen into an overlay.`);
  }
}

findings.push(...buildGate(root, cfg));

try {
  const changed = execSync('git diff --name-only HEAD', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split(/\r?\n/).filter(Boolean);
  const bk = cfg.bookkeeping;
  const touchedSolution = changed.some((f) => f.startsWith(bk.solutionDir) || /\.pa\.yaml$/.test(f));
  if (touchedSolution && !changed.some((f) => f === bk.dependencyRegister)) {
    reminders.push(`Solution or canvas source changed - confirm ${bk.dependencyRegister} still reflects tables, flows and integrations.`);
  }
  if (touchedSolution && !changed.some((f) => f === bk.stateFile)) {
    reminders.push(`Source changed - update ${bk.stateFile} (what is live, in flight, next, waiting on a person).`);
  }
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const commitsToday = execSync(`git log --since="${today} 00:00" --oneline`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (commitsToday && !readFileSafe(path.join(root, bk.changelog)).includes(today)) {
    reminders.push(`${bk.changelog} has no entry dated ${today} but there are commits today.`);
  }
} catch { /* not a git repo, or no HEAD yet */ }

if (findings.length === 0 && reminders.length === 0) {
  process.stdout.write(JSON.stringify({ suppressOutput: true }));
  process.exit(0);
}
const report = [];
if (findings.length) {
  report.push(`Audit found ${findings.length} issue(s):`);
  report.push(...findings.slice(0, 40).map((f) => `  - ${f}`));
  if (findings.length > 40) report.push(`  ...and ${findings.length - 40} more.`);
}
if (reminders.length) { report.push('Reminders:'); report.push(...reminders.map((r) => `  - ${r}`)); }
const text = report.join('\n');
if (findings.length > 0 && !looping) process.stdout.write(JSON.stringify({ decision: 'block', reason: text }));
else process.stdout.write(JSON.stringify({ systemMessage: text }));
process.exit(0);
