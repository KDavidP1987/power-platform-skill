#!/usr/bin/env node
// feedback.mjs - draft, check and file feedback about THIS SKILL as a GitHub issue, with technical
// details and without the person's data.
//
// Part of the power-platform Agent Skill. Feedback is about the skill's behaviour (a rule that was
// wrong, a check that missed, a missing answer), never about the person's work. This tool is how
// every issue on the skill's repository is made: it adds the technical details an issue needs, and
// it refuses to send anything that looks like the person's data. The plugin gate denies a raw
// `gh issue create` / `gh issue comment` on the skill's repository, so this check cannot be skipped.
//
// Usage:
//   node feedback.mjs template defect|lesson         print the body skeleton to fill in
//   node feedback.mjs draft --kind defect|lesson --title "<mechanism, not project>" --body-file <filled.md>
//                           [--area "<reference section or script>"] [--script <name> --exit <code>]
//                                                    add the technical details, scrub, write the draft
//                                                    (.ship-work/feedback/<id>.md) and print it
//   node feedback.mjs scrub <file>                   only the privacy check
//   node feedback.mjs file <draft.md> [--yes]        file it (gh), or print a new-issue link to paste
//   node feedback.mjs comment <issue> <draft.md> [--yes]   add it to an existing issue instead
//   node feedback.mjs mode [ask|auto|off]            show or set how feedback is handled for this person
//   node feedback.mjs --selftest
//
// Modes (~/.power-platform-skill-feedback.json; POWER_PLATFORM_SKILL_FEEDBACK=ask|auto|off overrides):
//   ask  (default) the agent shows the draft; `file` needs --yes, which means the person said yes to THIS draft.
//   auto the person chose to let the agent file without asking. Still scrubbed, still deduplicated, at
//        most AUTO_PER_DAY issues a day; the agent tells the person the link afterwards.
//   off  never offer. `file` refuses unless --yes (the person asked for this one themselves).
//
// The scrub (no override flag exists - rewrite the text instead): GUIDs, email addresses, URLs and host
// names other than the skill's repository and Microsoft's documentation, tenant hosts (*.dynamics.com,
// *.sharepoint.com, *.powerappsportals.com, ...), IP addresses, tokens and keys, connection strings,
// user folders (C:\Users\<name>, /home/<name>), this machine's user and host name, git identity, and the
// project's own names read from its config (app, solution, environment, login, the publisher prefix's
// schema names such as abc_order) plus any "feedbackPrivateTerms" listed there or in .feedback-private.
// Placeholders (<org>, {org}, contoso, example) and the skill's generic prefixes (app_, core_) pass.
//
// Exit codes: 0 done (draft clean, issue filed, mode shown); 1 usage; 2 refused (mode, missing consent,
// daily limit); 3 not filed: gh unavailable or not signed in - a link to paste was printed; 5 the text
// carries private details (each listed); 6 a matching issue already exists (its link printed).
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, hostname, userInfo, platform, release, arch, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const REPO = 'KDavidP1987/power-platform-skill';
export const AUTO_PER_DAY = 3;
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = () => join(process.env.POWER_PLATFORM_SKILL_FEEDBACK_HOME || homedir(), '.power-platform-skill-feedback.json');
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const log = (s = '') => process.stdout.write(s + '\n');

// ---- body skeletons: the same sections as the repository's issue forms -----------------------------
export const SECTIONS = {
  defect: ['What happened, and what you expected', 'How you know', 'Smallest reproduction', 'Proposed fix'],
  lesson: ['The lesson', 'Evidence', 'Where it belongs'],
};
const REQUIRED = { defect: ['What happened, and what you expected', 'How you know'], lesson: ['The lesson', 'Evidence'] };
export const LABELS = { defect: 'defect', lesson: 'lesson' };
export function template(kind) {
  const hints = {
    'What happened, and what you expected': 'The reference section, script or check; what it said or did; what happened instead.',
    'How you know': 'What was measured (a read-back, the published app, an API response) - in generic terms.',
    'Smallest reproduction': 'Generic names only (app_order, core_person, an orders and vendors example).',
    'Proposed fix': 'Optional.',
    'The lesson': 'One or two sentences: the mechanism, not the project.',
    'Evidence': 'What was measured, rewritten without names, ids or data.',
    'Where it belongs': 'The reference section, script or check it would change.',
  };
  return SECTIONS[kind].map((s) => `### ${s}\n\n<!-- ${hints[s]} -->\n`).join('\n');
}
export function missingSections(kind, body) {
  return REQUIRED[kind].filter((s) => {
    const m = String(body).match(new RegExp('^###\\s+' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$([\\s\\S]*?)(?=^###\\s|$(?![\\s\\S]))', 'mi'));
    return !m || !m[1].replace(/<!--[\s\S]*?-->/g, '').trim();
  });
}

// ---- technical details: what an issue needs, nothing that identifies anyone ---------------------
export function skillVersion(dir = SKILL_DIR) {
  try { return readFileSync(join(dir, 'SKILL.md'), 'utf8').match(/^ {2}version:\s*"?([^"\r\n]+)"?\s*$/m)?.[1] || 'unknown'; } catch { return 'unknown'; }
}
export function installKind(dir = SKILL_DIR, env = process.env, cwd = process.cwd()) {
  if (env.CLAUDE_PLUGIN_ROOT || /[\\/]plugins[\\/]/i.test(dir)) return 'plugin';
  const h = join(cwd, '.claude', 'hooks', 'harness.json');
  if (existsSync(h)) { try { return 'project harness ' + (JSON.parse(readFileSync(h, 'utf8')).version || ''); } catch { return 'project harness'; } }
  return 'skill folder';
}
function toolVersion(cmd, args, rx) {
  try { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 }); return ((r.stdout || '') + (r.stderr || '')).match(rx)?.[1] || null; } catch { return null; }
}
export function technicalDetails({ area, script, exit, mode }, probe = true) {
  const lines = [
    ['Skill version', skillVersion()],
    ['Install', installKind()],
    ['OS', `${platform()} ${String(release()).split('.').slice(0, 2).join('.')} (${arch()})`],
    ['Node', process.versions.node.split('.').slice(0, 2).join('.')],
  ];
  if (probe) {
    const py = toolVersion('python', ['--version'], /Python\s+(\d+\.\d+)/);
    if (py) lines.push(['Python', py]);
    const pac = toolVersion('pac', ['help'], /Version:\s*([\d.]+)/);
    if (pac) lines.push(['pac CLI', pac]);
  }
  if (area) lines.push(['Area', area]);
  if (script) lines.push(['Script', script + (exit != null && exit !== '' ? ' (exit ' + exit + ')' : '')]);
  lines.push(['Filed', mode === 'auto' ? 'by the agent (the person chose automatic feedback)' : 'by the agent, with the person\'s agreement']);
  return '### Technical details\n\n' + lines.map(([k, v]) => `- ${k}: ${v}`).join('\n') +
    '\n\n<sub>Drafted with scripts/feedback.mjs, which removes project data before anything is sent.</sub>\n';
}

// ---- the privacy scrub ---------------------------------------------------------------------------
const PLACEHOLDER = /^(<[^>]*>|\{[^}]*\}|\$\{?\w+\}?|x+|contoso|fabrikam|example|your-?\w*|org|tenant|site|name)$/i;
const ALLOWED_URL = [/^https?:\/\/github\.com\/KDavidP1987\/power-platform-skill\b/i, /^https?:\/\/kdavidp1987\.github\.io\/power-platform-skill\b/i, /^https?:\/\/(learn|docs)\.microsoft\.com\//i,
  /^https?:\/\/aka\.ms\//i, /^https?:\/\/docs\.github\.com\//i, /^https?:\/\/(www\.)?npmjs\.com\//i, /^https?:\/\/playwright\.dev\//i];
// The match cannot start inside a longer name: in <org>.crm.dynamics.com the label is the placeholder.
const TENANT_HOST = /(?<![\w.>}-])([a-z0-9][a-z0-9-]*)\.(crm\d*\.dynamics\.com|api\.crm\d*\.dynamics\.com|sharepoint\.com|powerappsportals\.com|powerapps\.com|onmicrosoft\.com|dynamics\.com|azurewebsites\.net|blob\.core\.windows\.net|database\.windows\.net)\b/gi;
const GENERIC_PREFIXES = new Set(['app', 'core', 'abc', 'x', 'new', 'cr', 'msdyn', 'mspp', 'adx']);
const RULES = [
  ['GUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (m) => /@(example\.(com|org)|contoso\.com|users\.noreply\.github\.com|anthropic\.com)$/i.test(m) || /^noreply@/i.test(m)],
  ['URL', /\bhttps?:\/\/[^\s)\]>"'`]+/gi, (m) => ALLOWED_URL.some((r) => r.test(m)) || /^https?:\/\/[<{]/.test(m) || /^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(m)],
  ['tenant host', TENANT_HOST, (m) => PLACEHOLDER.test(m.split('.')[0])],
  ['IP address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m) => /^(127\.0\.0\.1|0\.0\.0\.0)$/.test(m) || m.split('.').some((n) => +n > 255)],
  ['token', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g],
  ['token', /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g],
  ['key or secret', /\b(?:ghp|gho|ghs|github_pat|sk|xox[abp])_[A-Za-z0-9_]{16,}\b/g],
  ['key or secret', /\b[0-9a-f]{32,}\b/gi],
  ['key or secret', /\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/g, (m) => !/[0-9]/.test(m) || !/[A-Z]/.test(m) || !/[a-z]/.test(m)],
  ['connection string', /\b(?:AccountKey|SharedAccessSignature|SharedAccessKey|Password|Pwd|ClientSecret|client_secret)\s*=\s*[^;\s]+/gi],
  ['user folder', /\b[A-Z]:\\(?:Users|Documents and Settings)\\([^\\\s"'`,;)]+)/gi, (m) => PLACEHOLDER.test(m.split('\\')[2] || '')],
  ['user folder', /(?:^|[\s"'`(])\/(?:home|Users)\/([^/\s"'`,;)]+)/g, (m, g1) => PLACEHOLDER.test(g1)],
];

// The project's own names, read from the config files a project here keeps. Values only; short or
// generic values are skipped so the check does not flag ordinary words.
const CONFIG_FILES = ['scripts/canvas-app.json', 'canvas-app.json', 'tables.json', 'schema/tables.json', 'dataverse/tables.json',
  'scripts/site.json', 'site.json', '.claude/hooks/harness.json'];
const NAME_KEYS = /^(appName|appLogicalName|appDisplayName|solutionName|solutionUniqueName|solution|login|environmentUrl|dataverseUrl|siteUrl|siteName|workspace|workspaceName|tenant|tenantName|environmentName|lakehouse|publisherName|friendlyName|uniqueName)$/;
// A term the person listed. "prefix: abc" declares a publisher prefix (abc_anything is then private);
// listed terms are kept whatever their length ("QRS"), marked so the length filter leaves them.
const EXPLICIT = '\u0000';
function explicitTerm(t, out, prefixes) {
  const s = String(t).trim();
  const p = s.match(/^prefix:\s*([a-z][a-z0-9]{0,7})_?$/i);
  if (p) prefixes.add(p[1].toLowerCase());
  else if (s.length >= 2) out.add(EXPLICIT + s);
}
function collectConfigTerms(obj, out, prefixes) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && NAME_KEYS.test(k)) {
      out.add(v);
      // A logical name carries the publisher prefix (abc_orders -> abc).
      const p = /^(appLogicalName|solutionUniqueName|uniqueName)$/.test(k) && v.match(/^([a-z][a-z0-9]{1,7})_/i);
      if (p) prefixes.add(p[1].toLowerCase());
    }
    if (k === 'prefix' && typeof v === 'string' && /^[a-z][a-z0-9]{1,7}$/i.test(v)) prefixes.add(v.toLowerCase());
    if (k === 'feedbackPrivateTerms' && Array.isArray(v)) v.forEach((t) => typeof t === 'string' && explicitTerm(t, out, prefixes));
    if (v && typeof v === 'object') collectConfigTerms(v, out, prefixes);
  }
}
export function privateTerms(cwd = process.cwd(), { env = process.env, machine = true } = {}) {
  const terms = new Set();
  const prefixes = new Set();
  for (let d = resolve(cwd), i = 0; i < 6; i++, d = dirname(d)) {
    for (const f of CONFIG_FILES) { try { collectConfigTerms(JSON.parse(readFileSync(join(d, f), 'utf8')), terms, prefixes); } catch { /* absent */ } }
    for (const sx of ['solution/src/Other/Solution.xml', 'solution/Other/Solution.xml', 'src/Other/Solution.xml', 'Other/Solution.xml']) {
      try { const m = readFileSync(join(d, sx), 'utf8').match(/<CustomizationPrefix>\s*([a-z0-9]+)\s*</i); if (m) prefixes.add(m[1].toLowerCase()); } catch { /* absent */ }
    }
    try { readFileSync(join(d, '.feedback-private'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).forEach((l) => explicitTerm(l, terms, prefixes)); } catch { /* none */ }
    if (dirname(d) === d) break;
  }
  const people = new Set();
  if (machine) {
    try { terms.add(userInfo().username); } catch { /* none */ }
    terms.add(hostname());
    for (const k of ['user.name', 'user.email']) {
      const r = spawnSync('git', ['config', k], { encoding: 'utf8', timeout: 3000, cwd });
      if (r.status === 0 && r.stdout.trim()) (k === 'user.name' ? people : terms).add(r.stdout.trim());
    }
  }
  for (const p of people) { terms.add(p); p.split(/\s+/).filter((w) => w.length >= 4).forEach((w) => terms.add(w)); }
  for (const k of ['USERNAME', 'USER', 'USERDOMAIN', 'COMPUTERNAME']) if (env[k]) terms.add(env[k]);
  const expanded = new Set();
  const listed = new Set();
  for (const t of terms) {
    if (String(t).startsWith(EXPLICIT)) { listed.add(String(t).slice(1)); continue; }
    const s = String(t).trim();
    if (!s) continue;
    try { const u = new URL(s); expanded.add(u.hostname); expanded.add(u.hostname.split('.')[0]); } catch { expanded.add(s); }
    const at = s.indexOf('@'); if (at > 0) { expanded.add(s.slice(0, at)); expanded.add(s.slice(at + 1)); }
  }
  const keep = [...expanded].filter((t) => t.length >= 4 && !PLACEHOLDER.test(t) && !/^(true|false|null|main|test|prod|default|power|apps|app|user|admin|users|local|desktop)$/i.test(t) && !/^\d{1,4}$/.test(t));
  return { terms: [...new Set([...keep, ...listed])], prefixes: [...prefixes].filter((p) => !GENERIC_PREFIXES.has(p)) };
}
const mask = (s) => { const t = String(s); return t.length <= 4 ? t[0] + '***' : t.slice(0, 2) + '***' + t.slice(-1) + ' (' + t.length + ' chars)'; };
export function scrub(text, { terms = [], prefixes = [] } = {}) {
  const body = String(text || '').replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
  const lineOf = (i) => body.slice(0, i).split('\n').length;
  const out = [];
  for (const [type, rx, allow] of RULES) {
    for (const m of body.matchAll(rx)) {
      if (allow && allow(m[0], m[1])) continue;
      out.push({ type, line: lineOf(m.index), sample: mask(m[0].trim()) });
    }
  }
  for (const p of prefixes) {
    for (const m of body.matchAll(new RegExp('\\b' + p + '_[A-Za-z0-9_]+', 'gi'))) out.push({ type: 'project schema name', line: lineOf(m.index), sample: mask(m[0]) });
  }
  for (const t of terms) {
    const rx = new RegExp('(?<![A-Za-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'gi');
    for (const m of body.matchAll(rx)) out.push({ type: 'project or personal name', line: lineOf(m.index), sample: mask(m[0]) });
  }
  const seen = new Set();
  return out.filter((f) => { const k = f.type + f.line + f.sample; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.line - b.line);
}

// ---- state and mode ------------------------------------------------------------------------------
function loadState() { try { return JSON.parse(readFileSync(STATE(), 'utf8')); } catch { return {}; } }
function saveState(s) { try { writeFileSync(STATE(), JSON.stringify(s, null, 1)); } catch { /* read-only home */ } }
export function currentMode(env = process.env, state = loadState()) {
  const e = String(env.POWER_PLATFORM_SKILL_FEEDBACK || '').toLowerCase();
  if (/^(ask|auto|off)$/.test(e)) return { mode: e, from: 'POWER_PLATFORM_SKILL_FEEDBACK' };
  return { mode: /^(ask|auto|off)$/.test(state.mode || '') ? state.mode : 'ask', from: state.mode ? STATE() : 'default' };
}
// May this draft go out now? Pure: { ok, why }.
export function consent(mode, yes, filedToday) {
  if (mode === 'off' && !yes) return { ok: false, why: 'feedback is off for this person; file only when they ask for this one (--yes)' };
  if (mode === 'ask' && !yes) return { ok: false, why: 'mode is ask: show the person the draft, and pass --yes only after they agree to THIS draft' };
  if (mode === 'auto' && !yes && filedToday >= AUTO_PER_DAY) return { ok: false, why: `automatic feedback is limited to ${AUTO_PER_DAY} issues a day; ask the person about this one` };
  return { ok: true };
}
export const fingerprint = (kind, title) => createHash('sha256').update(kind + '\n' + normTitle(title)).digest('hex').slice(0, 12);
export const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---- the draft file ------------------------------------------------------------------------------
const HEADER = /^<!--\s*power-platform-skill feedback\s+(\{.*\})\s*-->\r?\n/;
export function parseDraft(text) {
  const m = String(text).match(HEADER);
  if (!m) return null;
  try { return { meta: JSON.parse(m[1]), body: String(text).slice(m[0].length) }; } catch { return null; }
}
function workDir() {
  for (const d of [join(process.cwd(), '.ship-work', 'feedback'), join(tmpdir(), 'power-platform-skill-feedback')]) {
    try { mkdirSync(d, { recursive: true }); return d; } catch { /* next */ }
  }
  return tmpdir();
}
function report(findings) {
  log(`PRIVATE DETAILS FOUND (${findings.length}) - nothing will be sent until the text is rewritten without them:`);
  for (const f of findings) log(`  line ${f.line}: ${f.type}  ${f.sample}`);
  log('  Rewrite in generic terms (app_order, core_person, <org>.crm.dynamics.com, "a 3,000-row table"), then draft again.');
  log('  A term the check cannot know about: add it to "feedbackPrivateTerms" in scripts/canvas-app.json or to .feedback-private.');
}

// ---- GitHub --------------------------------------------------------------------------------------
export function findGh(env = process.env) {
  const cands = [env.GH_PATH, 'gh', env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'gh', 'bin', 'gh.exe'), 'C:\\Program Files\\GitHub CLI\\gh.exe'].filter(Boolean);
  for (const c of cands) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) return c;
  }
  return null;
}
function gh(bin, args, input) { return spawnSync(bin, args, { encoding: 'utf8', timeout: 60000, input }); }
export function newIssueLink(kind, title, body) {
  const q = new URLSearchParams({ title, labels: LABELS[kind] || '', body: body.length > 6000 ? '(paste the draft file here)' : body });
  return `https://github.com/${REPO}/issues/new?${q.toString()}`;
}
function sameTitle(issues, title) { const n = normTitle(title); return (issues || []).find((i) => normTitle(i.title) === n); }

// ---- commands ------------------------------------------------------------------------------------
function cmdTemplate() {
  const kind = argv[1];
  if (!SECTIONS[kind]) { log('usage: feedback.mjs template defect|lesson'); return 1; }
  log(template(kind)); return 0;
}
function cmdScrub() {
  const f = argv[1];
  if (!f || !existsSync(f)) { log('usage: feedback.mjs scrub <file>'); return 1; }
  const found = scrub(readFileSync(f, 'utf8'), privateTerms());
  if (found.length) { report(found); return 5; }
  log('clean: no private details found'); return 0;
}
function cmdDraft() {
  const kind = flag('kind'); const title = flag('title'); const bodyFile = flag('body-file');
  if (!SECTIONS[kind] || !title || !bodyFile || !existsSync(bodyFile)) {
    log('usage: feedback.mjs draft --kind defect|lesson --title "<mechanism>" --body-file <filled.md> [--area A] [--script S --exit N]');
    log('       start the body from: feedback.mjs template ' + (SECTIONS[kind] ? kind : 'defect'));
    return 1;
  }
  const raw = readFileSync(bodyFile, 'utf8').replace(/\r/g, '').replace(HEADER, '');
  const miss = missingSections(kind, raw);
  if (miss.length) { log('the body is missing: ' + miss.map((s) => '"### ' + s + '"').join(', ') + ' (start from `template ' + kind + '`)'); return 1; }
  const { mode } = currentMode();
  const body = raw.trim() + '\n\n' + technicalDetails({ area: flag('area'), script: flag('script'), exit: flag('exit'), mode });
  const fp = fingerprint(kind, title);
  const file = join(workDir(), fp + '.md');
  writeFileSync(file, `<!-- power-platform-skill feedback ${JSON.stringify({ kind, title, fp })} -->\n` + body);
  log(`Draft (${kind}): ${title}\n`);
  log(body);
  log('draft file: ' + file);
  const found = scrub(title + '\n' + body, privateTerms());
  if (found.length) { report(found); return 5; }
  log('privacy check: clean');
  log(mode === 'auto' ? 'mode auto: file it with `feedback.mjs file ' + file + '`, then tell the person the link.'
    : mode === 'off' ? 'mode off: do not offer it unless the person asks.'
      : 'mode ask: show the person this draft and one line on why it is worth filing; on a yes, `feedback.mjs file ' + file + ' --yes`.');
  return 0;
}
function loadDraft(f) {
  if (!f || !existsSync(f)) return null;
  return parseDraft(readFileSync(f, 'utf8').replace(/\r/g, ''));
}
function cmdFile(commentOn = null) {
  const f = commentOn ? argv[2] : argv[1];
  const d = loadDraft(f);
  if (!d || (commentOn && !/^\d+$/.test(commentOn))) { log(commentOn !== null ? 'usage: feedback.mjs comment <issue number> <draft.md> [--yes]' : 'usage: feedback.mjs file <draft.md> [--yes]  (make the draft with `draft`)'); return 1; }
  const { kind, title, fp } = d.meta;
  // Scrub again: the draft file may have been edited since it was made.
  const found = scrub(title + '\n' + d.body, privateTerms());
  if (found.length) { report(found); return 5; }
  const state = loadState();
  const filed = Array.isArray(state.filed) ? state.filed : [];
  const today = new Date().toISOString().slice(0, 10);
  const { mode } = currentMode(process.env, state);
  const c = consent(mode, has('yes'), filed.filter((e) => e.auto && String(e.at).startsWith(today)).length);
  if (!c.ok) { log('REFUSED: ' + c.why + '.'); return 2; }
  const prior = filed.find((e) => e.fp === fp && !commentOn);
  if (prior) { log('ALREADY FILED from this machine: ' + prior.url + ' - add new evidence with `comment`.'); return 6; }
  const bin = findGh();
  const signedIn = bin && gh(bin, ['auth', 'status']).status === 0;
  if (!signedIn) {
    log('NOT FILED: the GitHub CLI is ' + (bin ? 'not signed in' : 'not installed') + '. Give the person this link (the draft is filled in):');
    log(commentOn ? `https://github.com/${REPO}/issues/${commentOn}  (paste the draft file as a comment: ${f})` : newIssueLink(kind, title, d.body));
    return 3;
  }
  if (!commentOn) {
    const list = gh(bin, ['issue', 'list', '--repo', REPO, '--state', 'all', '--search', normTitle(title) + ' in:title', '--json', 'number,title,url,state', '--limit', '20']);
    let issues = []; try { issues = JSON.parse(list.stdout || '[]'); } catch { /* treat as none */ }
    const dup = sameTitle(issues, title);
    if (dup) { log(`A MATCHING ISSUE EXISTS (#${dup.number}, ${dup.state}): ${dup.url}\n  Add this as evidence instead: feedback.mjs comment ${dup.number} ${f}${mode === 'auto' ? '' : ' --yes'}`); return 6; }
  }
  const tmp = mkdtempSync(join(tmpdir(), 'ppfb-'));
  const bodyFile = join(tmp, 'body.md');
  writeFileSync(bodyFile, d.body);
  const labels = [LABELS[kind], ...(mode === 'auto' && !has('yes') ? ['agent-filed'] : [])];
  const args = commentOn ? ['issue', 'comment', commentOn, '--repo', REPO, '--body-file', bodyFile]
    : ['issue', 'create', '--repo', REPO, '--title', title, '--body-file', bodyFile, ...labels.flatMap((l) => ['--label', l])];
  let r = gh(bin, args);
  // A label the repository lacks fails the whole create; file without labels rather than not at all.
  if (r.status !== 0 && !commentOn && /label/i.test(r.stderr || '')) r = gh(bin, args.filter((a, i) => a !== '--label' && args[i - 1] !== '--label'));
  rmSync(tmp, { recursive: true, force: true });
  if (r.status !== 0) { log('gh failed: ' + String(r.stderr || '').trim().split('\n').slice(-2).join(' ')); log('Give the person the link instead: ' + newIssueLink(kind, title, d.body)); return 3; }
  const url = String(r.stdout || '').trim().split('\n').pop();
  filed.push({ fp, kind, at: new Date().toISOString(), url, auto: mode === 'auto' && !has('yes'), comment: commentOn || undefined });
  saveState({ ...state, filed: filed.slice(-100) });
  log((commentOn ? 'COMMENTED: ' : 'FILED: ') + url);
  log('Tell the person in one line, with the link.');
  return 0;
}
function cmdMode() {
  const want = argv[1];
  if (want && !/^(ask|auto|off)$/.test(want)) { log('usage: feedback.mjs mode [ask|auto|off]'); return 1; }
  if (want) { const s = loadState(); s.mode = want; s.modeSetAt = new Date().toISOString(); saveState(s); }
  const { mode, from } = currentMode();
  log(`feedback mode: ${mode}  (${from})`);
  log({ ask: '  The agent offers a draft and files it only when the person says yes.',
    auto: `  The agent files scrubbed feedback itself (at most ${AUTO_PER_DAY} a day) and tells the person the link.`,
    off: '  The agent never offers feedback.' }[mode]);
  return 0;
}

// ---- selftest ------------------------------------------------------------------------------------
function selftest() {
  const fails = [];
  const check = (name, cond) => { log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`); if (!cond) fails.push(name); };
  const types = (t, o) => scrub(t, o).map((f) => f.type);
  const clean = [
    '### What happened, and what you expected', '',
    'canvas-shipping.md 4 said a renamed control keeps its z-order; the push re-added it on top.',
    'A gallery over a 3,000-row app_order table stopped at 2,000. core_person lookups were fine.',
    'See https://github.com/KDavidP1987/power-platform-skill/issues/1 and https://learn.microsoft.com/power-apps/ .',
    'Endpoint: https://<org>.crm.dynamics.com/api/data/v9.2/ and contoso.sharepoint.com. Error 0x80048d19, exit 4, version 0.39.0.',
    'Ran C:\\Users\\<you>\\src and /home/<you>/src, http://localhost:9222, 127.0.0.1.',
  ].join('\n');
  check('generic technical text passes', scrub(clean).length === 0);
  check('a GUID is caught', types('id 0f1e2d3c-4b5a-4c6d-8e7f-a0b1c2d3e4f5').includes('GUID'));
  check('an email is caught, example.com passes', types('by jane.doe@company.com').includes('email address') && !types('x@example.com').length);
  check('a tenant URL is caught', types('https://org123abc.crm.dynamics.com/main.aspx').includes('URL'));
  check('a bare tenant host is caught', types('the site acme-intake.powerappsportals.com').includes('tenant host'));
  check('a SharePoint site is caught', types('lists on acme.sharepoint.com').includes('tenant host'));
  check('an IP is caught', types('server 10.20.30.40').includes('IP address'));
  check('a JWT is caught', types('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk').includes('token'));
  check('a bearer token is caught', types('Authorization: Bearer abcdef0123456789ABCDEF').includes('token'));
  check('a GitHub token is caught', types('ghp_abcdefghijklmnopqrstuvwxyz0123').includes('key or secret'));
  check('a long hex secret is caught', types('0a1b2c3d4e5f60718293a4b5c6d7e8f9').includes('key or secret'));
  check('a connection string key is caught', types('AccountKey=abc123;').includes('connection string'));
  check('a real user folder is caught', types('C:\\Users\\jdoe\\Documents').includes('user folder') && types('cd /home/jdoe/x').includes('user folder'));
  check('a comment in the template is not scanned', scrub('<!-- jane@company.com -->').length === 0);
  check('project terms are caught, whole words only', types('the Field Requests app', { terms: ['Field Requests'] }).includes('project or personal name')
    && !types('fieldrequestsx', { terms: ['fieldrequests'] }).length);
  check('the project prefix catches schema names', types('column lnx_timesheet blank', { prefixes: ['lnx'] }).includes('project schema name')
    && !types('column app_order', { prefixes: ['lnx'] }).length);
  // project config is read
  const tmp = mkdtempSync(join(tmpdir(), 'ppfb-self-'));
  mkdirSync(join(tmp, 'scripts'));
  writeFileSync(join(tmp, 'scripts', 'canvas-app.json'), JSON.stringify({ appName: 'Equipment Loans Desk', environmentUrl: 'https://orgabc123.crm.dynamics.com', login: 'pat@fabrikam-real.com', feedbackPrivateTerms: ['Project Falcon'] }));
  writeFileSync(join(tmp, 'tables.json'), JSON.stringify({ publisher: { prefix: 'eqd' } }));
  writeFileSync(join(tmp, '.feedback-private'), '# one per line\nBlue Harbor\nBHX\nprefix: bhx\n');
  const pt = privateTerms(tmp, { env: {}, machine: false });
  check('config names, login, environment and the private list are collected', ['Equipment Loans Desk', 'orgabc123', 'pat@fabrikam-real.com', 'fabrikam-real.com', 'Project Falcon', 'Blue Harbor'].every((t) => pt.terms.includes(t)));
  check('the publisher prefix is collected, generic ones are not', pt.prefixes.includes('eqd') && !pt.prefixes.includes('app'));
  check('a listed short term and a listed prefix are kept', pt.terms.includes('BHX') && pt.prefixes.includes('bhx'));
  check('an app name is not split into ordinary words', !pt.terms.includes('Equipment') && !pt.terms.includes('Loans'));
  writeFileSync(join(tmp, 'scripts', 'canvas-app.json'), JSON.stringify({ appLogicalName: 'lnd_equipmentloans_1a2b3' }));
  mkdirSync(join(tmp, 'solution', 'src', 'Other'), { recursive: true });
  writeFileSync(join(tmp, 'solution', 'src', 'Other', 'Solution.xml'), '<Publisher><CustomizationPrefix>sbx</CustomizationPrefix></Publisher>');
  const pt2 = privateTerms(tmp, { env: {}, machine: false });
  check('the prefix is read from the app logical name and Solution.xml', pt2.prefixes.includes('lnd') && pt2.prefixes.includes('sbx'));
  check('a body naming the app is refused', scrub('The Equipment Loans Desk gallery stopped at 2,000', pt).length > 0);
  // sections, consent, dedupe, link
  check('template has the form sections', template('defect').includes('### How you know') && template('lesson').includes('### Where it belongs'));
  check('an unfilled template is missing its sections', missingSections('defect', template('defect')).length === 2);
  check('a filled body passes the section check', missingSections('lesson', '### The lesson\n\nx\n\n### Evidence\n\ny\n').length === 0);
  check('ask needs --yes', !consent('ask', false, 0).ok && consent('ask', true, 0).ok);
  check('auto files without asking, up to the daily limit', consent('auto', false, AUTO_PER_DAY - 1).ok && !consent('auto', false, AUTO_PER_DAY).ok);
  check('off refuses unless the person asked', !consent('off', false, 0).ok && consent('off', true, 0).ok);
  check('the env variable overrides the saved mode', currentMode({ POWER_PLATFORM_SKILL_FEEDBACK: 'off' }, { mode: 'auto' }).mode === 'off'
    && currentMode({}, { mode: 'auto' }).mode === 'auto' && currentMode({}, {}).mode === 'ask');
  check('a matching title is a duplicate', !!sameTitle([{ title: 'Walk: consent after the stamp!' }], 'walk - consent after the STAMP'));
  check('the fingerprint ignores case and punctuation', fingerprint('defect', 'A b!') === fingerprint('defect', 'a  B'));
  const link = newIssueLink('defect', 'T', 'body');
  check('the fallback link carries title, label and body', link.startsWith(`https://github.com/${REPO}/issues/new?`) && link.includes('labels=defect') && link.includes('body=body'));
  const draft = `<!-- power-platform-skill feedback ${JSON.stringify({ kind: 'lesson', title: 'T', fp: 'f' })} -->\nB`;
  check('a draft file round-trips', parseDraft(draft)?.meta.kind === 'lesson' && parseDraft(draft).body === 'B');
  const td = technicalDetails({ area: 'canvas-shipping.md 4', script: 'canvas-browser.mjs', exit: 4, mode: 'auto' }, false);
  check('technical details carry version, OS, Node, area, script, exit and mode', /Skill version: /.test(td) && /OS: /.test(td) && /Node: /.test(td)
    && td.includes('Area: canvas-shipping.md 4') && td.includes('(exit 4)') && td.includes('automatic'));
  check('technical details pass the scrub', scrub(td, { terms: [], prefixes: [] }).length === 0);
  rmSync(tmp, { recursive: true, force: true });
  log(`selftest: ${fails.length ? 'FAILED (' + fails.length + ')' : 'PASSED'}`);
  return fails.length ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmds = { template: cmdTemplate, draft: cmdDraft, scrub: cmdScrub, file: () => cmdFile(), comment: () => cmdFile(argv[1] || ''), mode: cmdMode };
  if (has('selftest')) process.exitCode = selftest();
  else if (cmds[argv[0]]) process.exitCode = cmds[argv[0]]();
  else { log('feedback.mjs - feedback about the power-platform skill, scrubbed of project data\n  template | draft | scrub | file | comment | mode | --selftest   (see the header of this file)'); process.exitCode = argv[0] ? 1 : 0; }
}
