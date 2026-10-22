// SessionStart hook (plugin): tell the person, at most once a week, that a newer release of this skill
// exists, with what changed and how to update. Never blocks; silent when current, offline or opted out.
//
//   node update-check.mjs              hook mode: prints SessionStart JSON only when there is something to say
//   node update-check.mjs --print      plain text for an install without hooks (a copied skill folder):
//                                      the notice, or "up to date"; the same weekly limits apply
//   node update-check.mjs --print --now   check the feed now, ignoring the weekly limits
//   node update-check.mjs --selftest
//
// Weekly: the release feed is read at most once every 7 days (a failed read is retried after a day),
// and a given newer release is announced at most once every 7 days until the skill is updated.
// State: ~/.power-platform-skill-update.json. Opt out: POWER_PLATFORM_SKILL_UPDATE_CHECK=off.
// Installed version: metadata.version in this skill's SKILL.md. What changed: the skill's CHANGELOG.md
// (shipped inside the skill folder) and the release notes the feed returns.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DAY = 864e5, WEEK = 7 * DAY;
const FEED = process.env.POWER_PLATFORM_SKILL_RELEASES
  || 'https://api.github.com/repos/KDavidP1987/power-platform-skill/releases?per_page=20';
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPDATE_CMDS = [
  'claude plugin marketplace update power-platform-skill',
  'claude plugin update power-platform@power-platform-skill',
];

const parts = (v) => String(v || '').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
export function newer(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export function installedVersion(dir = SKILL_DIR) {
  try { return readFileSync(join(dir, 'SKILL.md'), 'utf8').match(/^ {2}version:\s*"?([^"\r\n]+)"?\s*$/m)?.[1] || null; }
  catch { return null; }
}

// The releases newer than the installed one, newest first, each with the first sentence of its notes.
export function summarise(releases, installed) {
  return (releases || [])
    .filter((r) => r && !r.draft && !r.prerelease && newer(r.tag_name, installed))
    .map((r) => {
      const body = String(r.body || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const first = (body.join(' ').match(/^(.+?[.!?])(\s|$)/) || [null, body.join(' ')])[1] || '';
      return { version: String(r.tag_name).replace(/^v/, ''), note: first.length > 200 ? first.slice(0, 197) + '...' : first };
    })
    .sort((a, b) => (newer(a.version, b.version) ? -1 : 1));
}

function load(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } }

export async function check({ now = Date.now(), force = false, home = homedir(), feed = FEED, installed = installedVersion() } = {}) {
  if (/^(off|false|0|no)$/i.test(process.env.POWER_PLATFORM_SKILL_UPDATE_CHECK || '')) return { state: 'off' };
  if (!installed) return { state: 'unknown' };
  const path = join(home, '.power-platform-skill-update.json');
  const s = load(path);
  const due = (!s.checkedAt || now - s.checkedAt >= WEEK) && (!s.failedAt || now - s.failedAt >= DAY);
  if (force || due) {
    try {
      const r = await fetch(feed, { signal: AbortSignal.timeout(3000), headers: { 'User-Agent': 'power-platform-skill', Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const list = await r.json();
      const rel = Array.isArray(list) ? list : [list];
      const latest = rel.filter((x) => x && !x.draft && !x.prerelease).map((x) => String(x.tag_name).replace(/^v/, ''))
        .reduce((a, b) => (newer(b, a) ? b : a), '0.0.0');
      Object.assign(s, { checkedAt: now, failedAt: undefined, latest, releases: summarise(rel, '0.0.0').slice(0, 20) });
    } catch { s.failedAt = now; }
  }
  let result = { state: 'current', installed, latest: s.latest || null };
  if (s.latest && newer(s.latest, installed)) {
    const pending = (s.releases || []).filter((x) => newer(x.version, installed));
    const announce = force || s.notifiedFor !== s.latest || !s.notifiedAt || now - s.notifiedAt >= WEEK;
    result = { state: announce ? 'notify' : 'quiet', installed, latest: s.latest, pending };
    if (announce) Object.assign(s, { notifiedAt: now, notifiedFor: s.latest });
  }
  try { writeFileSync(path, JSON.stringify(s)); } catch {}
  return result;
}

export function notice(r) {
  const lines = [`power-platform skill ${r.latest} is available (installed: ${r.installed}).`];
  for (const p of (r.pending || []).slice(0, 6)) lines.push(`  ${p.version}: ${p.note}`);
  if ((r.pending || []).length > 6) lines.push(`  ... and ${r.pending.length - 6} earlier release(s); see CHANGELOG.md`);
  lines.push('Update: ' + UPDATE_CMDS.join(' , then ') + ' (or /plugin). A copied skill folder: replace it from the latest release.');
  lines.push('Projects with the harness: re-run setup-harness.mjs (plan first) afterwards.');
  return lines.join('\n');
}

async function main() {
  const print = process.argv.includes('--print');
  const r = await check({ force: process.argv.includes('--now') });
  if (print) {
    if (r.state === 'notify' || r.state === 'quiet') console.log(notice(r));
    else if (r.state === 'current') console.log(`power-platform skill ${r.installed}: up to date${r.latest ? '' : ' (feed not read yet)'}.`);
    else console.log('power-platform skill update check: ' + r.state);
    return;
  }
  if (r.state !== 'notify') return;
  const text = notice(r);
  process.stdout.write(JSON.stringify({
    systemMessage: text,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'Skill update available. Tell the person once, early in your first reply, in two or three lines: '
        + 'the new version, the headline changes below, and the update commands; ask whether to update now. '
        + 'Do not run the update without a yes, and do not repeat the notice this session.\n' + text,
    },
  }));
}

async function selftest() {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const http = await import('node:http');
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'update-check-'));
  let served = 0, fail = false;
  const releases = [
    { tag_name: 'v1.2.0', body: 'Faster ship loop. More detail here.\n### Added\n- x' },
    { tag_name: 'v1.1.0', body: '## heading\nA new flow runner, and a procedure.' },
    { tag_name: 'v1.0.0', body: 'The installed one.' },
    { tag_name: 'v1.3.0-rc', prerelease: true, body: 'Not yet.' },
  ];
  const srv = http.createServer((req, res) => {
    served++;
    if (fail) { res.statusCode = 500; return res.end('{}'); }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(releases));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const feed = `http://127.0.0.1:${srv.address().port}/releases`;
  const fails = []; let n = 0;
  const ok = (name, cond) => { n++; if (!cond) fails.push(name); };
  const t0 = Date.UTC(2026, 0, 5);
  try {
    let r = await check({ now: t0, home: tmp, feed, installed: '1.0.0' });
    ok('newer release: notify, with every newer release newest first', r.state === 'notify' && r.latest === '1.2.0'
      && r.pending.map((p) => p.version).join() === '1.2.0,1.1.0');
    ok('the note is the first sentence, headings skipped', r.pending[0].note === 'Faster ship loop.' && r.pending[1].note === 'A new flow runner, and a procedure.');
    ok('a prerelease is never offered', !r.pending.some((p) => p.version.includes('rc')) && r.latest === '1.2.0');
    const text = notice(r);
    ok('the notice names both versions and the update commands', text.includes('1.2.0 is available (installed: 1.0.0)')
      && text.includes('claude plugin update power-platform@power-platform-skill'));
    ok('the feed was read once', served === 1);
    r = await check({ now: t0 + DAY, home: tmp, feed, installed: '1.0.0' });
    ok('next day: no second announcement and no second read', r.state === 'quiet' && served === 1);
    r = await check({ now: t0 + WEEK, home: tmp, feed, installed: '1.0.0' });
    ok('a week later, not updated: announced again (the weekly prompt), feed read again', r.state === 'notify' && served === 2);
    r = await check({ now: t0 + WEEK + DAY, home: tmp, feed, installed: '1.2.0' });
    ok('after updating: current, nothing said', r.state === 'current');
    fs.rmSync(join(tmp, '.power-platform-skill-update.json'));
    fail = true;
    r = await check({ now: t0, home: tmp, feed, installed: '1.0.0' });
    ok('feed down: silent', r.state === 'current' && r.latest === null);
    const before = served;
    await check({ now: t0 + 3600e3, home: tmp, feed, installed: '1.0.0' });
    ok('a failed read is not retried within the day', served === before);
    fail = false;
    r = await check({ now: t0 + DAY + 1, home: tmp, feed, installed: '1.0.0' });
    ok('and is retried the next day', served === before + 1 && r.state === 'notify');
    process.env.POWER_PLATFORM_SKILL_UPDATE_CHECK = 'off';
    r = await check({ now: t0 + 30 * DAY, home: tmp, feed, installed: '1.0.0' });
    ok('opted out: nothing read, nothing said', r.state === 'off' && served === before + 1);
    delete process.env.POWER_PLATFORM_SKILL_UPDATE_CHECK;
    r = await check({ now: t0 + DAY + 2, home: tmp, feed, installed: '1.0.0', force: true });
    ok('--now reads and announces regardless of the limits', r.state === 'notify' && served === before + 2);
    ok('the installed version is read from this skill\'s SKILL.md', /^\d+\.\d+\.\d+$/.test(installedVersion() || ''));
    ok('the skill folder carries its CHANGELOG.md', fs.existsSync(join(SKILL_DIR, 'CHANGELOG.md')));
  } finally { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  // exitCode, not process.exit: on Windows exit can abort while a fetch handle is still closing.
  if (!n) { console.log('selftest examined nothing - NOT a pass'); process.exitCode = 2; return; }
  console.log(fails.length ? `selftest FAILED ${fails.length} of ${n}:\n  ` + fails.join('\n  ') : `selftest ok: ${n} checks`);
  process.exitCode = fails.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--selftest')) await selftest();
  else { try { await main(); } catch {} process.exitCode = 0; }
}
