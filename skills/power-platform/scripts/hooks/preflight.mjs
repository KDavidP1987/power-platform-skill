// SessionStart hook: start every session from a known baseline. Never blocks.
// Prints git state, which environment the pac CLI points at, and the top of docs/STATE.md.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './lib.mjs';

// Self-test: node preflight.mjs --selftest. Runs this hook in temp folders with a fake pac on PATH, a
// local release feed and a temp home folder (the real update stamp is never touched).
if (process.argv.includes('--selftest')) await selftest();

async function selftest() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const self = fileURLToPath(import.meta.url);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  // A fake pac that reports a connected environment, for both shells.
  fs.writeFileSync(path.join(bin, 'pac.cmd'), '@echo Connected as someone@example.com\r\n@echo Environment Url: https://example.crm.dynamics.com/\r\n');
  fs.writeFileSync(path.join(bin, 'pac'), '#!/bin/sh\necho "Connected as someone@example.com"\necho "Environment Url: https://example.crm.dynamics.com/"\n', { mode: 0o755 });
  const feed = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ tag_name: 'v9.9.0' })); });
  await new Promise((r) => feed.listen(0, '127.0.0.1', r));
  const releases = `http://127.0.0.1:${feed.address().port}/latest`;
  const runHook = (cwd, home) => new Promise((resolve) => {
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, HOME: home, USERPROFILE: home };
    const p = spawn(process.execPath, [self], { cwd, env });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => { let ctx = ''; try { ctx = JSON.parse(out).hookSpecificOutput.additionalContext; } catch {} resolve({ code, ctx }); });
  });
  const fails = []; let n = 0;
  const check = (name, cond) => { n++; if (!cond) fails.push(name); };
  try {
    const home = path.join(tmp, 'home'); fs.mkdirSync(home);
    // 1. Not a repository, no state file.
    const bare = path.join(tmp, 'bare'); fs.mkdirSync(bare);
    let r = await runHook(bare, home);
    check('bare: exits 0 with a SessionStart context', r.code === 0 && r.ctx.startsWith('Power Platform pre-flight:'));
    check('bare: says it is not a repository', /Not a git repository yet/.test(r.ctx));
    check('bare: asks for the state file', /docs\/STATE\.md not found/.test(r.ctx));
    check('fake pac: names the environment', /connected to https:\/\/example\.crm\.dynamics\.com/.test(r.ctx));
    check('no harness.json: no update notice', !/Update available/.test(r.ctx));
    // 2. A repository with a state file and an older harness: branch, state lines, update notice.
    const repo = path.join(tmp, 'repo'); fs.mkdirSync(path.join(repo, 'docs'), { recursive: true }); fs.mkdirSync(path.join(repo, '.claude', 'hooks'), { recursive: true });
    const git = (args) => new Promise((res) => spawn('git', args, { cwd: repo }).on('close', res));
    await git(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'docs', 'STATE.md'), '# State\n- **Next:** publish the list screen\n- **Blocked:** nothing\n');
    fs.writeFileSync(path.join(repo, '.claude', 'hooks', 'harness.json'), JSON.stringify({ version: '0.1.0', releases }));
    r = await runHook(repo, home);
    check('repo: names the branch', /Branch: main/.test(r.ctx));
    check('repo: lists the state file lines without markup', /Next: publish the list screen/.test(r.ctx) && !/\*\*/.test(r.ctx));
    check('older harness: update notice from the feed', /Update available: power-platform skill 9\.9\.0 \(this harness is from 0\.1\.0\)/.test(r.ctx));
    check('feed result cached in the temp home only', fs.existsSync(path.join(home, '.power-platform-skill-latest.json')));
    // 3. Opted out of the update check: no notice even though the cache says newer.
    fs.writeFileSync(path.join(repo, '.claude', 'hooks', 'standards.config.json'), JSON.stringify({ updateCheck: false }));
    r = await runHook(repo, home);
    check('updateCheck false: no notice', r.code === 0 && !/Update available/.test(r.ctx));
    // 4. Current harness: no notice.
    fs.rmSync(path.join(repo, '.claude', 'hooks', 'standards.config.json'));
    fs.writeFileSync(path.join(repo, '.claude', 'hooks', 'harness.json'), JSON.stringify({ version: '9.9.0', releases }));
    r = await runHook(repo, home);
    check('current harness: no notice', !/Update available/.test(r.ctx));
  } finally { feed.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  if (!n) { console.log('selftest examined nothing - NOT a pass'); process.exit(2); }
  console.log(fails.length ? `selftest FAILED ${fails.length} of ${n}:\n  ` + fails.join('\n  ') : `selftest ok: ${n} checks (bare folder, fake pac, repo branch and state, update notice, cache in temp home, opt-out, current harness)`);
  process.exit(fails.length ? 1 : 0);
}

const run = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).trim(); } catch { return ''; } };
const cfg = loadConfig();
const lines = ['Power Platform pre-flight:'];

// symbolic-ref also answers in a new repository with no commits, where rev-parse fails.
const branch = run('git rev-parse --abbrev-ref HEAD') || run('git symbolic-ref --short HEAD');
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
