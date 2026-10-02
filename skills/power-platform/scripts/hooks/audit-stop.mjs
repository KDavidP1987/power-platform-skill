// Stop hook: the end-of-turn audit.
//
// Confirms the turn left no standards violations, leftover debug markers, or canvas apps over
// the file ceiling, and reminds about bookkeeping (dependency register, state file, changelog)
// when the solution changed. Blocks the stop ONCE on findings so they are fixed in the same
// turn; never blocks twice in a row (stop_hook_active), and reminders alone never block.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readStdinJson, listRepoTextFiles, isProse, isHookFile, findEmoji, findPurple, readFileSafe, loadConfig, canvasSrcDirs } from './lib.mjs';

const input = readStdinJson();
const looping = input?.stop_hook_active === true;
const root = process.cwd();
const cfg = loadConfig(root);
const files = listRepoTextFiles(root).filter((f) => !isHookFile(f));
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
