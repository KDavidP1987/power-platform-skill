// SessionStart hook: start every session from a known baseline. Never blocks.
// Prints git state, which environment the pac CLI points at, and the top of docs/STATE.md.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './lib.mjs';

const run = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).trim(); } catch { return ''; } };
const cfg = loadConfig();
const lines = ['Power Platform pre-flight:'];

const branch = run('git rev-parse --abbrev-ref HEAD');
if (branch) {
  const dirty = run('git status --porcelain');
  const ahead = run('git rev-list --count @{u}..HEAD');
  lines.push(`  - Branch: ${branch}${dirty ? ' (uncommitted changes)' : ' (clean)'}`);
  if (ahead && ahead !== '0') lines.push(`  - ${ahead} local commit(s) not pushed`);
} else lines.push('  - Not a git repository yet');

const who = run('pac org who');
if (who) {
  const url = (who.match(/(https:\/\/[^\s]+\.dynamics\.com\/?)/) || [])[1];
  lines.push(`  - pac: ${url ? 'connected to ' + url : 'authenticated; confirm the environment with pac org who'}`);
} else lines.push('  - pac: not authenticated or not installed (pac auth create --environment <url>)');

const state = cfg.bookkeeping.stateFile;
if (existsSync(state)) {
  const top = readFileSync(state, 'utf8').split(/\r?\n/).filter((l) => /^- \*\*/.test(l)).slice(0, 6);
  if (top.length) { lines.push(`  - ${state} (read first):`); top.forEach((l) => lines.push('    ' + l.replace(/^- /, '').replace(/\*\*/g, ''))); }
} else lines.push(`  - ${state} not found - create it as the current-state file.`);

// Update notice: at most one network call a day, three-second timeout, silent when offline.
const harness = (() => { try { return JSON.parse(readFileSync('.claude/hooks/harness.json', 'utf8')); } catch { return null; } })();
if (harness && harness.releases && cfg.updateCheck !== false) {
  const stamp = join(homedir(), '.power-platform-skill-latest.json');
  let latest = null;
  try { const c = JSON.parse(readFileSync(stamp, 'utf8')); if (Date.now() - c.at < 864e5) latest = c.tag; } catch {}
  if (!latest) {
    try {
      const r = await fetch(harness.releases, { signal: AbortSignal.timeout(3000), headers: { 'User-Agent': 'power-platform-skill' } });
      if (r.ok) { latest = String((await r.json()).tag_name || '').replace(/^v/, ''); writeFileSync(stamp, JSON.stringify({ at: Date.now(), tag: latest })); }
    } catch {}
  }
  const n = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0);
  const newer = (a, b) => { const [x, y] = [n(a), n(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  if (latest && newer(latest, harness.version)) {
    lines.push(`  - Update available: power-platform skill ${latest} (this harness is from ${harness.version}). Offer to update the skill,`);
    lines.push('    then re-run setup-harness.mjs (plan first) so the hooks and tools match it. CHANGELOG lists what changed.');
  }
}

lines.push('  - Method: audit, compile with Studio open, build on the LIVE manifest, assert on the artifact,');
lines.push('    import, read LoadFromYaml + build stamp, then PERFORM the task in the published app.');

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }));
process.exitCode = 0;   // not process.exit: on Windows it can abort while the fetch handle is still closing
