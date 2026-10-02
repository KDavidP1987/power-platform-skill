// SessionStart hook: start every session from a known baseline. Never blocks.
// Prints git state, which environment the pac CLI points at, and the top of docs/STATE.md.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
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

lines.push('  - Method: audit, compile with Studio open, build on the LIVE manifest, assert on the artifact,');
lines.push('    import, read LoadFromYaml + build stamp, then PERFORM the task in the published app.');

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }));
process.exit(0);
