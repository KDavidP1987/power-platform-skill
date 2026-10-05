#!/usr/bin/env node
// site-walk.mjs - walk a live Power Pages site (or any site) as a signed-in person, and prove the
// refusals the site must enforce.
//
// Part of the power-platform Agent Skill. A site is verified by performing the task on it, not by
// reading its source: every page at every width, the steps a person takes, the Web API calls a page
// would never make (a hidden row by id, a PATCH, a DELETE), and the same pages signed out. Scenarios
// are JSON, so a verification can be reviewed, diffed and re-run.
//
// Setup:   npm i -D playwright        (drives your installed Chrome via channel 'chrome')
//          No Chrome? use --channel msedge, or `npx playwright install chromium` then --channel chromium.
//          Playwright is found next to this script or in the current folder's node_modules.
//
// Usage:
//   node site-walk.mjs signin --url <site> [--marker <selector>]
//                         open a headed browser on a persistent profile; the person signs in once
//                         (Entra ID, MFA included); later walks reuse the profile headless. Done when
//                         the browser is back on the site (not on a sign-in host) and, when given,
//                         the site's own signed-in marker is visible. Waits up to 10 minutes.
//   node site-walk.mjs walk --scenario <file.json> [--out <dir>] [--json <file>] [--allow-writes]
//                         [--token-cmd "<command>"] [--work-dir <dir>]
//                         walk the scenario; table on stdout, full report with --json
//   node site-walk.mjs --selftest [--logic-only]
//                         prove every finding fires on known-bad fixtures and the good ones pass
//
// Flags:  --profile <dir>   persistent profile (default ~/.site-walk-profile)
//         --channel <chrome|msedge|chromium>   browser (default chrome, falls back to Edge when a
//                           managed Chrome refuses an automated launch)
//         --headed          walk with a visible browser
//         --allow-writes    required to walk a scenario that declares "writes": true (it posts
//                           comments, saves forms); without it such a scenario is refused
//         --token-cmd       a command that prints a Dataverse bearer token for orgUrl (overrides the
//                           scenario's dataverseTokenCommand; DATAVERSE_TOKEN in the environment wins)
//         --work-dir        where writes.json is logged (default .ship-work in the current folder)
//
// Scenario (see assets/scenarios/site-walk.example.json):
//   baseUrl        the site, e.g. https://<site>.powerappsportals.com
//   widths         viewport widths, default [1440, 390]; the sideways-scroll check runs after
//                  every width change and on every page
//   signInPattern  regex for sign-in URLs (default: Entra, b2c, /SignIn, /Account/Login)
//   writes         true when the steps create or change data; then "restore" (how the test rows are
//                  removed, e.g. the owner's cleanup script) and "confirm" are required
//   orgUrl, dataverseTokenCommand   the Dataverse org and a command printing a token for it (confirm)
//   pages          [{path, name?, expectText?: [..], expectSelector?: [..], expectNoText?: [..],
//                   screenshotSelector?, expectWithin?}]
//                  visited at every width; a screenshot named <name>-<width>.png when name is set
//   steps          [{goto}|{fill, value}|{click}|{select, value}|{press, selector?}|{expectText}|
//                   {expectNoText}|{expectUrl}|{wait}|{screenshot}|{capture}]  performed once, at the
//                  first width. Any step may also carry "capture" (taken after the step).
//   api            [{name?, method?, path, body?, expectStatus?, expectNoRows?, capture?}]  sent from
//                  inside the signed-in page with fetch, carrying the site's anti-forgery token from
//                  /_layout/tokenhtml. expectStatus: a number, a list, or "2xx" / "4xx".
//   confirm        [{table, filter, expect?: {column: value}, count?, absent?, changedDuringRun?,
//                   within?}]  read back over the Dataverse Web API after the steps and probes. table
//                  is the entity set (entitySet is accepted too). A value matches the raw value or its
//                  formatted label. changedDuringRun (default: true when the scenario writes) needs
//                  every matched row's modifiedon after the walk started, so a row from an earlier
//                  run cannot pass. within: seconds to keep re-reading (a flow that writes later).
//   signedOut      [{path, mustNotShow?: [..], expectNoRows?}]  in a fresh context with no cookies:
//                  a page must redirect to sign-in or show none of mustNotShow (no mustNotShow: it
//                  must redirect); an /_api path must return no rows
//
// Captures and variables: {"capture": {"name": "key", "from": "url"|"text"|"json", "selector"?,
//   "pattern"?, "path"?}} stores a value (pattern's first group, or the whole source; "path" walks a
//   JSON response, e.g. "value.0.id") and any later string may use {{key}}. Built in: {{runId}} (one
//   value per walk, so test rows are unique) and {{today}}, {{today+N}}, {{today-N}} (YYYY-MM-DD).
//   An unknown {{name}} fails the step that uses it.
//
// Eventual consistency: "expectWithin": <seconds> on an expectText / expectNoText step or a page
//   keeps reloading (every "every" seconds, default 10) until the expectation holds. The report
//   records how long it took, so a site cache delay is measured, not hidden; past the limit it is
//   SW-STALE.
//
// Finding codes:
//   SW-NAV            a page failed to load (HTTP 400+), or a signed-in page landed on sign-in
//   SW-TEXT           expected text or selector missing, or text that must not show is shown
//   SW-URL            expectUrl did not match
//   SW-STEP           a step could not be performed (selector not found, timeout)
//   SW-SCROLL         sideways scroll: document scrollWidth wider than clientWidth
//   SW-API-ALLOWED    a call that must be refused succeeded
//   SW-API-REFUSED    a call that must succeed was refused
//   SW-API-STATUS     any other status mismatch
//   SW-API-ROWS       a call that must return nothing returned rows
//   SW-SIGNEDOUT-LEAK signed out, a page or the Web API showed data
//   SW-CONFIRM        a Dataverse read-back did not hold (no row, wrong value, an old row, or no token)
//   SW-STALE          an expectWithin expectation still failed when its time ran out
//
// A walk with "writes": true appends {at, scenario, tool} to <work-dir>/writes.json, the log the
// plugin gate's seed check reads (the same file canvas-browser.mjs walk writes).
//
// Exit: 0 clean; 1 findings; 2 nothing examined (no browser, empty scenario, scenario refused,
// a writing scenario without confirm or restore) - NOT a pass. Screenshots are of the page only (never browser chrome): full-page captures of the
// document, or of screenshotSelector's element.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes('--' + name);
const log = (...a) => console.log(...a);

const DEFAULT_SIGNIN = 'login\\.microsoftonline\\.com|login\\.live\\.com|b2clogin\\.com|/SignIn|/Account/Login';
const PROFILE = resolve(String(flag('profile', join(homedir(), '.site-walk-profile'))));
let CHANNEL = String(flag('channel', 'chrome'));
const CHANNEL_GIVEN = has('channel');

// ---------------------------------------------------------------------------------------------
// Pure logic (no browser): validated by the logic half of the selftest.

export function validateScenario(s) {
  const errs = [];
  if (!s || typeof s !== 'object') return ['scenario is not a JSON object'];
  if (!/^https?:\/\//.test(s.baseUrl || '')) errs.push('baseUrl must start with http:// or https://');
  if (s.widths && (!Array.isArray(s.widths) || !s.widths.every((w) => Number.isInteger(w) && w >= 280))) errs.push('widths must be whole numbers of 280 or more');
  for (const k of ['pages', 'steps', 'api', 'signedOut']) if (s[k] && !Array.isArray(s[k])) errs.push(k + ' must be a list');
  for (const [i, p] of (s.pages || []).entries()) if (typeof p.path !== 'string') errs.push(`pages[${i}].path is missing`);
  for (const [i, a] of (s.api || []).entries()) {
    if (typeof a.path !== 'string' || !a.path.startsWith('/')) errs.push(`api[${i}].path must start with /`);
    if (a.expectStatus === undefined && !a.expectNoRows) errs.push(`api[${i}] needs expectStatus or expectNoRows (a probe with no expectation proves nothing)`);
  }
  const verbs = ['goto', 'fill', 'click', 'select', 'press', 'expectText', 'expectNoText', 'expectUrl', 'wait', 'screenshot', 'capture'];
  for (const [i, st] of (s.steps || []).entries()) {
    if (!verbs.some((v) => v in st)) errs.push(`steps[${i}] has none of ${verbs.join(', ')}`);
    if (st.expectWithin !== undefined && !(Number(st.expectWithin) > 0)) errs.push(`steps[${i}].expectWithin must be a number of seconds`);
    if (st.capture) errs.push(...captureErrors(st.capture, `steps[${i}].capture`));
  }
  for (const [i, a] of (s.api || []).entries()) if (a.capture) errs.push(...captureErrors(a.capture, `api[${i}].capture`));
  for (const [i, o] of (s.signedOut || []).entries()) if (typeof o.path !== 'string') errs.push(`signedOut[${i}].path is missing`);
  if (s.confirm && !Array.isArray(s.confirm)) errs.push('confirm must be a list');
  for (const [i, c] of (s.confirm || []).entries()) {
    if (!(c.table || c.entitySet)) errs.push(`confirm[${i}] needs "table" (the entity set, e.g. app_comments)`);
    if (typeof c.filter !== 'string' || !c.filter.trim()) errs.push(`confirm[${i}] needs a "filter" (OData), so it reads only this run's rows`);
    if (!c.absent && !c.expect && c.count === undefined) errs.push(`confirm[${i}] asserts nothing: give "expect", "count" or "absent"`);
  }
  if ((s.confirm || []).length && !/^https?:\/\//.test(s.orgUrl || '')) errs.push('confirm needs "orgUrl" (the Dataverse org, e.g. https://<org>.crm.dynamics.com)');
  // As in canvas-browser walk: a screen that says "Saved" proves nothing about the row.
  if (s.writes === true && !(s.confirm || []).length) errs.push('a scenario that writes must have "confirm" checks that read the rows back in Dataverse');
  if (s.writes === true && !(typeof s.restore === 'string' && s.restore.trim())) errs.push('a scenario that writes must say how its rows are removed ("restore", e.g. the owner\'s cleanup script)');
  return errs;
}

function captureErrors(c, where) {
  if (!c || typeof c !== 'object') return [`${where} must be an object`];
  const e = [];
  if (!/^[A-Za-z_]\w*$/.test(c.name || '')) e.push(`${where}.name must be a simple name (letters, digits, _)`);
  if (!['url', 'text', 'json'].includes(c.from || 'text')) e.push(`${where}.from must be url, text or json`);
  if (c.from === 'json' && !c.path) e.push(`${where}: from json needs a "path" (e.g. value.0.id)`);
  if (c.pattern) { try { new RegExp(c.pattern); } catch (x) { e.push(`${where}.pattern: ${x.message}`); } }
  return e;
}

// {{name}} substitution in every string of a value. Built in: runId, today, today+N, today-N.
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function subst(value, vars, now = new Date()) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([A-Za-z_]\w*)\s*(?:([+-])\s*(\d+))?\s*\}\}/g, (m, name, sign, n) => {
      if (name === 'today') { const d = new Date(now); d.setDate(d.getDate() + (sign ? (sign === '-' ? -1 : 1) * Number(n) : 0)); return isoDay(d); }
      if (sign) throw new Error(`variable {{${name}${sign}${n}}}: only {{today}} takes an offset`);
      if (!(name in vars)) throw new Error(`unknown variable {{${name}}} (capture it in an earlier step)`);
      return String(vars[name]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => subst(v, vars, now));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'capture' ? v : subst(v, vars, now)]));
  return value;
}

// A capture's value from its source text (a URL, a page's text, or a JSON body).
export function captureValue(c, source) {
  let v = source;
  if ((c.from || 'text') === 'json') {
    let j; try { j = JSON.parse(source); } catch { throw new Error(`capture ${c.name}: the response is not JSON`); }
    v = String(c.path).split('.').reduce((o, k) => (o == null ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]), j);
    if (v === undefined || v === null) throw new Error(`capture ${c.name}: nothing at ${c.path}`);
    v = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  if (c.pattern) {
    const m = new RegExp(c.pattern).exec(v);
    if (!m) throw new Error(`capture ${c.name}: /${c.pattern}/ matched nothing`);
    v = m[1] ?? m[0];
  }
  if (v === '' || v === undefined) throw new Error(`capture ${c.name}: empty value`);
  return String(v);
}

// Judge rows read back from Dataverse for one confirm check -> list of reasons (empty = holds).
const SKEW_MS = 60000;   // clock difference between this machine and Dataverse
export function judgeRows(rows, c, runStartMs, writes) {
  const why = [];
  if (c.absent) { if (rows.length) why.push(`${rows.length} row(s) match, expected none`); return why; }
  if (c.count !== undefined && rows.length !== Number(c.count)) why.push(`${rows.length} row(s), expected ${c.count}`);
  else if (c.count === undefined && !rows.length) why.push('no row matches');
  const fresh = c.changedDuringRun ?? c.changedThisRun ?? !!writes;
  rows.forEach((r, k) => {
    for (const [col, want] of Object.entries(c.expect || {})) {
      const got = r[col];
      const label = r[col + '@OData.Community.Display.V1.FormattedValue'];
      const same = got === want || (got !== undefined && got !== null && want !== null && String(got).toLowerCase() === String(want).toLowerCase())
        || (label !== undefined && String(label) === String(want));
      if (!same) why.push(`row ${k + 1}: ${col} is ${JSON.stringify(got)}${label !== undefined ? ' ("' + label + '")' : ''}, expected ${JSON.stringify(want)}`);
    }
    if (fresh && runStartMs) {
      const m = Date.parse(r.modifiedon || r.createdon || '');
      if (!m) why.push(`row ${k + 1}: no modifiedon returned, so this run's write cannot be told from an old row`);
      else if (m < runStartMs - SKEW_MS) why.push(`row ${k + 1}: last modified ${r.modifiedon || r.createdon}, before this walk started - this run did not write it`);
    }
  });
  return why;
}

export function confirmUrl(orgUrl, c) {
  const cols = new Set([...Object.keys(c.expect || {}), 'modifiedon', 'createdon'].map((x) => x.trim()).filter(Boolean));
  return String(orgUrl).replace(/\/+$/, '') + '/api/data/v9.2/' + (c.table || c.entitySet) + '?$filter=' + encodeURIComponent(c.filter) + '&$select=' + [...cols].join(',') + '&$top=50';
}

export function countRows(bodyText) {
  let j;
  try { j = JSON.parse(bodyText); } catch { return 0; }
  if (!j || typeof j !== 'object') return 0;
  if (Array.isArray(j.value)) return j.value.length;
  if (Array.isArray(j)) return j.length;
  if (j.error) return 0;
  return Object.keys(j).some((k) => !k.startsWith('@odata')) ? 1 : 0;
}

function statusMatches(expect, status) {
  if (expect === undefined || expect === null || expect === 'any') return true;
  const one = (e) => (typeof e === 'number' ? e === status : /^[1-5]xx$/i.test(String(e)) ? Math.floor(status / 100) === Number(String(e)[0]) : Number(e) === status);
  return Array.isArray(expect) ? expect.some(one) : one(expect);
}
const wantsRefusal = (expect) => [].concat(expect ?? []).length > 0 && [].concat(expect).every((e) => /^4/.test(String(e)));
const wantsSuccess = (expect) => [].concat(expect ?? []).length > 0 && [].concat(expect).every((e) => /^2/.test(String(e)));

// One API probe's result -> a finding or null.
export function apiVerdict(probe, status, bodyText) {
  const label = (probe.name || `${probe.method || 'GET'} ${probe.path}`);
  if (!statusMatches(probe.expectStatus, status)) {
    const ok2xx = status >= 200 && status < 300;
    if (wantsRefusal(probe.expectStatus) && ok2xx) return { code: 'SW-API-ALLOWED', msg: `${label}: expected refusal ${[].concat(probe.expectStatus).join('/')}, got ${status}` };
    if (wantsSuccess(probe.expectStatus) && !ok2xx) return { code: 'SW-API-REFUSED', msg: `${label}: expected ${[].concat(probe.expectStatus).join('/')}, got ${status}` };
    return { code: 'SW-API-STATUS', msg: `${label}: expected ${[].concat(probe.expectStatus).join('/')}, got ${status}` };
  }
  if (probe.expectNoRows) {
    const n = status >= 200 && status < 300 ? countRows(bodyText) : 0;
    if (n > 0) return { code: 'SW-API-ROWS', msg: `${label}: must return nothing, returned ${n} row(s)` };
  }
  return null;
}

export function scrollVerdict(scrollWidth, clientWidth) {
  return scrollWidth > clientWidth + 1 ? { code: 'SW-SCROLL', msg: `scrolls sideways: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}` } : null;
}

// Signed out: a page must have gone to sign-in, or show none of the must-not-show text.
export function signedOutVerdict(entry, finalUrl, text, signInPattern = DEFAULT_SIGNIN) {
  const redirected = new RegExp(signInPattern, 'i').test(finalUrl);
  if (redirected) return null;
  const must = entry.mustNotShow || [];
  if (!must.length) return { code: 'SW-SIGNEDOUT-LEAK', msg: `${entry.path}: signed out, not sent to sign-in (${finalUrl})` };
  const shown = must.filter((m) => text.includes(m));
  return shown.length ? { code: 'SW-SIGNEDOUT-LEAK', msg: `${entry.path}: signed out, shows ${shown.map((x) => JSON.stringify(x)).join(', ')}` } : null;
}

export function exitCode(report) {
  if (!report.examined) return 2;
  return report.rows.some((r) => r.code) ? 1 : 0;
}

function table(rows) {
  const w1 = Math.min(56, Math.max(4, ...rows.map((r) => r.step.length)));
  const lines = rows.map((r) => `${r.step.slice(0, 56).padEnd(w1)}  ${String(r.width ?? '-').padStart(5)}  ${r.code ? r.code + ' ' + r.msg : r.note ? 'ok (' + r.note + ')' : 'ok'}`);
  return [`${'step'.padEnd(w1)}  width  result`, ...lines].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Browser.

async function loadPlaywright() {
  try { return (await import('playwright')).chromium; } catch { /* try the current folder */ }
  try {
    const req = createRequire(join(process.cwd(), 'noop.js'));
    const m = await import(pathToFileURL(req.resolve('playwright')).href);   // CommonJS entry: chromium is on default
    return m.chromium || m.default?.chromium || null;
  } catch { return null; }
}

function noBrowser(what) {
  console.error([
    `${what}: Playwright is not installed, so no browser can run. Nothing has been verified - this is NOT a pass.`,
    '  Install it (ask the user first; it changes package.json):  npm i -D playwright',
    '  No Chrome? Use --channel msedge, or `npx playwright install chromium` and --channel chromium.',
  ].join('\n'));
  process.exit(2);
}

const ARGS = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--hide-crash-restore-bubble'];
const channelOpt = () => (CHANNEL === 'chromium' ? {} : { channel: CHANNEL });
function fallbackChannel(e) {
  // A managed Chrome may hand an automated launch to the person's running Chrome, which shows as
  // "Opening in existing browser session" or as the browser closing at once. Edge is unaffected.
  if (!CHANNEL_GIVEN && CHANNEL === 'chrome' && /Opening in existing browser session|distribution 'chrome' is not found|has been closed/i.test(e.message)) { CHANNEL = 'msedge'; return true; }
  if (!CHANNEL_GIVEN && CHANNEL === 'msedge' && /distribution 'msedge' is not found/i.test(e.message)) { CHANNEL = 'chromium'; return true; }
  return false;
}

async function persistent(chromium, headless) {
  mkdirSync(PROFILE, { recursive: true });
  try {
    return await chromium.launchPersistentContext(PROFILE, { headless, ...channelOpt(), viewport: { width: 1440, height: 900 }, ignoreDefaultArgs: ['--enable-automation'], args: ARGS });
  } catch (e) {
    if (fallbackChannel(e)) return persistent(chromium, headless);
    if (/already in use|ProcessSingleton/i.test(e.message)) { console.error('PROFILE IN USE: ' + PROFILE + ' (close the other browser on it, or pass --profile).'); process.exit(2); }
    throw e;
  }
}

async function plainBrowser(chromium, headless = true) {
  try { return await chromium.launch({ headless, ...channelOpt(), args: ARGS }); } catch (e) {
    if (fallbackChannel(e)) return plainBrowser(chromium, headless);
    throw e;
  }
}

const abs = (base, p) => new URL(p, base.endsWith('/') ? base : base + '/').href;

async function scrollCheck(page) {
  const d = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  return scrollVerdict(d.s, d.c);
}

async function shot(page, out, name, width, selector) {
  if (!out || !name) return;
  mkdirSync(out, { recursive: true });
  const file = join(out, `${name}-${width}.png`);
  if (selector) { const el = page.locator(selector).first(); if (await el.count()) { await el.screenshot({ path: file }); return; } }
  await page.screenshot({ path: file, fullPage: true });   // the page only: never browser chrome
}

// Walk one scenario. ctx is a signed-in context; freshContext() makes a cookie-free one.
// getToken(scenario) returns a Dataverse token for orgUrl (or throws); runStart defaults to now.
export async function runWalk(s, { ctx, freshContext, out = null, allowWrites = false, getToken = null, runStart = Date.now() }) {
  const rows = [];
  const add = (step, width, f, note = '') => rows.push({ step, width, code: f ? f.code : null, msg: f ? f.msg : '', note });
  const errs = validateScenario(s);
  if (errs.length) { errs.forEach((e) => add('scenario: ' + e, null, { code: 'SW-STEP', msg: 'scenario refused' })); return { examined: 0, rows, refused: true }; }
  if (s.writes && !allowWrites) { add('scenario declares "writes": true', null, { code: 'SW-STEP', msg: 'refused without --allow-writes' }); return { examined: 0, rows, refused: true }; }
  const signIn = new RegExp(s.signInPattern || DEFAULT_SIGNIN, 'i');
  const widths = s.widths?.length ? s.widths : [1440, 390];
  const vars = { runId: s.runId || new Date(runStart).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) };
  const timings = [];
  let examined = 0;
  const page = ctx.pages()[0] || await ctx.newPage();

  async function visit(path, label, width) {
    let resp = null;
    try { resp = await page.goto(abs(s.baseUrl, path), { waitUntil: 'load', timeout: 45000 }); } catch (e) { add(label, width, { code: 'SW-NAV', msg: e.message.split('\n')[0] }); return false; }
    examined++;
    if (signIn.test(page.url())) { add(label, width, { code: 'SW-NAV', msg: 'landed on sign-in: run `site-walk.mjs signin --url ' + s.baseUrl + '` first' }); return false; }
    if (resp && resp.status() >= 400) { add(label, width, { code: 'SW-NAV', msg: 'HTTP ' + resp.status() }); return false; }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    return true;
  }

  // Keep re-checking (reloading between tries) until check() holds or `within` seconds pass.
  // The first try needs no reload. Returns {ok, secs, tries}; secs is how long the site took.
  async function eventually(check, within, every) {
    const t0 = Date.now(), end = t0 + within * 1000;
    let tries = 0;
    for (;;) {
      tries++;
      if (await check()) return { ok: true, secs: Math.round((Date.now() - t0) / 1000), tries };
      if (Date.now() + every * 1000 > end) return { ok: false, secs: Math.round((Date.now() - t0) / 1000), tries };
      await page.waitForTimeout(every * 1000);
      await page.reload({ waitUntil: 'load', timeout: 45000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }
  }
  const bodyText = () => page.locator('body').innerText().catch(() => '');

  async function capture(c, jsonText = null) {
    const from = c.from || 'text';
    const source = from === 'url' ? page.url() : from === 'json' ? jsonText
      : c.selector ? await page.locator(c.selector).first().innerText({ timeout: 10000 }) : await bodyText();
    if (source === null || source === undefined) throw new Error(`capture ${c.name}: no response to read`);
    vars[c.name] = captureValue(c, source);
    return vars[c.name];
  }

  for (const [wi, width] of widths.entries()) {
    await page.setViewportSize({ width, height: 900 });
    if (page.url() !== 'about:blank') add(`resize to ${width}`, width, await scrollCheck(page));
    for (const raw of s.pages || []) {
      let p;
      try { p = subst(raw, vars); } catch (e) { add(`page ${raw.name || raw.path}`, width, { code: 'SW-STEP', msg: e.message }); continue; }
      const label = `page ${p.name || p.path}`;
      if (!(await visit(p.path, label, width))) continue;
      const judge = async () => {
        const body = await bodyText();
        for (const t of p.expectText || []) if (!body.includes(t)) return { code: 'SW-TEXT', msg: `missing text ${JSON.stringify(t)}` };
        for (const sel of p.expectSelector || []) if (!(await page.locator(sel).count())) return { code: 'SW-TEXT', msg: `missing ${sel}` };
        for (const t of p.expectNoText || []) if (body.includes(t)) return { code: 'SW-TEXT', msg: `shows ${JSON.stringify(t)}` };
        return null;
      };
      let f = await judge(), note = '';
      if (f && p.expectWithin) {
        const r = await eventually(async () => !(f = await judge()), Number(p.expectWithin), Number(p.every || 10));
        timings.push({ step: label, width, seconds: r.secs, ok: r.ok });
        if (r.ok) note = `after ${r.secs} s`; else f = { code: 'SW-STALE', msg: `${f.msg} after ${r.secs} s (limit ${p.expectWithin} s)` };
      }
      add(label, width, f, note);
      add(label + ': sideways scroll', width, await scrollCheck(page));
      await shot(page, out, p.name, width, p.screenshotSelector);
    }
    if (wi === 0) {
      for (const [i, rawStep] of (s.steps || []).entries()) {
        const what = Object.entries(rawStep).filter(([k]) => k !== 'capture').map(([k, v]) => `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ').slice(0, 50);
        const label = `step ${i + 1}: ` + (what || 'capture ' + rawStep.capture?.name);
        const to = Number(rawStep.timeout || 15000);
        let st;
        try { st = subst(rawStep, vars); } catch (e) { add(label, width, { code: 'SW-STEP', msg: e.message }); continue; }
        let f = null, note = '', checked = false;
        try {
          if ('goto' in st) { if (!(await visit(st.goto, label, width))) continue; f = await scrollCheck(page); }
          else if ('fill' in st) await page.locator(st.fill).first().fill(String(st.value ?? ''), { timeout: to });
          else if ('select' in st) await page.locator(st.select).first().selectOption(String(st.value), { timeout: to });
          else if ('click' in st) { await page.locator(st.click).first().click({ timeout: to }); await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); }
          else if ('press' in st) { if (st.selector) await page.locator(st.selector).first().press(st.press); else await page.keyboard.press(st.press); await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); }
          else if ('wait' in st) await page.waitForTimeout(Number(st.wait));
          else if ('screenshot' in st) await shot(page, out, st.screenshot, width, st.selector);
          else if ('expectText' in st || 'expectNoText' in st) {
            checked = true;
            const want = 'expectText' in st;
            const text = want ? st.expectText : st.expectNoText;
            const once = async (first) => {
              if (want) return page.getByText(text, { exact: false }).first().waitFor({ timeout: first ? Number(st.timeout || 10000) : 3000 }).then(() => true, () => false);
              return !(await bodyText()).includes(text);
            };
            let ok = await once(true);
            if (!ok && st.expectWithin) {
              let first = true;
              const r = await eventually(async () => { if (first) { first = false; return false; } return once(false); }, Number(st.expectWithin), Number(st.every || 10));
              timings.push({ step: label, width, seconds: r.secs, ok: r.ok });
              ok = r.ok;
              if (ok) note = `after ${r.secs} s`;
              else f = { code: 'SW-STALE', msg: `${want ? 'missing' : 'still shows'} ${JSON.stringify(text)} after ${r.secs} s (limit ${st.expectWithin} s)` };
            }
            if (!ok && !f) f = { code: 'SW-TEXT', msg: `${want ? 'missing text' : 'shows'} ${JSON.stringify(text)}` };
          } else if ('expectUrl' in st) {
            checked = true;
            if (!new RegExp(st.expectUrl).test(page.url())) f = { code: 'SW-URL', msg: `url ${page.url()} does not match ${st.expectUrl}` };
          }
          if (st.capture && !f) { const v = await capture(st.capture); note = (note ? note + '; ' : '') + `${st.capture.name} = ${v.slice(0, 40)}`; }
        } catch (e) { f = { code: 'SW-STEP', msg: e.message.split('\n')[0].slice(0, 140) }; }
        if (checked) examined++;
        add(label, width, f, note);
      }
    }
  }

  if ((s.api || []).length) {
    const from = s.apiFrom || s.pages?.[0]?.path || '/';
    await visit(subst(from, vars), 'api: open ' + from, widths[0]);
    for (const rawProbe of s.api) {
      const label = 'api ' + (rawProbe.name || `${rawProbe.method || 'GET'} ${rawProbe.path}`);
      let a;
      try { a = subst(rawProbe, vars); } catch (e) { add(label, null, { code: 'SW-STEP', msg: e.message }); continue; }
      const r = await page.evaluate(async ({ path, method, body }) => {
        let token = '';
        try { const t = await (await fetch('/_layout/tokenhtml', { credentials: 'include' })).text(); token = (t.match(/value="([^"]+)"/) || [])[1] || ''; } catch { /* no token endpoint */ }
        const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', __RequestVerificationToken: token };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(path, { method, headers, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, text: (await res.text()).slice(0, 20000), token: !!token };
      }, { path: a.path, method: (a.method || 'GET').toUpperCase(), body: a.body }).catch((e) => ({ status: 0, text: '', err: e.message }));
      examined++;
      let f = r.err ? { code: 'SW-STEP', msg: r.err.split('\n')[0] } : apiVerdict(a, r.status, r.text), note = '';
      if (!f && a.capture) {
        try { note = `${a.capture.name} = ${(await capture(a.capture, r.text)).slice(0, 40)}`; }
        catch (e) { f = { code: 'SW-STEP', msg: e.message }; }
      }
      add(label, null, f, note);
    }
  }

  // Read the rows back where they land, every run: a page that says "Saved" proves nothing.
  if ((s.confirm || []).length) {
    let token = null, cannot = null;
    try { token = getToken ? await getToken(s) : null; if (!token) cannot = 'no Dataverse token: add "dataverseTokenCommand" to the scenario, pass --token-cmd, or set DATAVERSE_TOKEN'; }
    catch (e) { cannot = 'the token command failed: ' + String(e.stderr || e.message).split('\n').find((x) => x.trim()); }
    for (const rawCheck of s.confirm) {
      const label = 'confirm ' + (rawCheck.table || rawCheck.entitySet) + ' ' + String(rawCheck.filter).slice(0, 40);
      examined++;
      if (cannot) { add(label, null, { code: 'SW-CONFIRM', msg: 'cannot confirm - ' + cannot + '. NOT a pass.' }); continue; }
      let c;
      try { c = subst(rawCheck, vars); } catch (e) { add(label, null, { code: 'SW-CONFIRM', msg: e.message }); continue; }
      const read = async () => {
        try {
          const res = await fetch(confirmUrl(s.orgUrl, c), { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0',
            Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } });
          const body = await res.text();
          if (!res.ok) return ['HTTP ' + res.status + ': ' + ((() => { try { return JSON.parse(body).error.message; } catch { return body.slice(0, 160); } })())];
          return judgeRows(JSON.parse(body).value || [], c, runStart, s.writes === true);
        } catch (e) { return [e.message]; }
      };
      let why = await read(), note = '';
      if (why.length && c.within) {
        const t0 = Date.now(), end = t0 + Number(c.within) * 1000;
        while (why.length && Date.now() + 5000 <= end) { await new Promise((ok) => setTimeout(ok, 5000)); why = await read(); }
        const secs = Math.round((Date.now() - t0) / 1000);
        timings.push({ step: label, width: null, seconds: secs, ok: !why.length });
        if (!why.length) note = `after ${secs} s`;
      }
      add(label, null, why.length ? { code: 'SW-CONFIRM', msg: why.join('; ').slice(0, 300) } : null, note);
    }
  }

  if ((s.signedOut || []).length) {
    const fresh = await freshContext();
    const p2 = await fresh.newPage();
    await p2.setViewportSize({ width: widths[0], height: 900 });
    for (const o of s.signedOut) {
      const label = 'signed out ' + o.path;
      examined++;
      if (o.path.startsWith('/_api')) {
        const r = await fresh.request.get(abs(s.baseUrl, o.path), { headers: { Accept: 'application/json' }, maxRedirects: 0, failOnStatusCode: false }).catch(() => null);
        const n = r && r.status() >= 200 && r.status() < 300 ? countRows(await r.text()) : 0;
        add(label, null, n ? { code: 'SW-SIGNEDOUT-LEAK', msg: `${o.path}: signed out, Web API returned ${n} row(s)` } : null);
        continue;
      }
      await p2.goto(abs(s.baseUrl, o.path), { waitUntil: 'load', timeout: 45000 }).catch(() => {});
      const text = await p2.locator('body').innerText().catch(() => '');
      add(label, widths[0], signedOutVerdict(o, p2.url(), text, s.signInPattern || DEFAULT_SIGNIN));
    }
    await fresh.close();
  }
  return { examined, rows, vars, timings };
}

// The token for confirm: DATAVERSE_TOKEN, else the last line printed by --token-cmd, the scenario's
// dataverseTokenCommand or DATAVERSE_TOKEN_COMMAND.
function tokenFor(s) {
  if (process.env.DATAVERSE_TOKEN) return process.env.DATAVERSE_TOKEN.trim();
  const command = (flag('token-cmd') && flag('token-cmd') !== true ? String(flag('token-cmd')) : null) || s.dataverseTokenCommand || process.env.DATAVERSE_TOKEN_COMMAND;
  if (!command) return null;
  const outText = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  const lines = outText.trim().split(/\r?\n/);
  return lines[lines.length - 1].trim() || null;
}

// The same log canvas-browser.mjs walk keeps, so the plugin gate's seed check sees site writes too.
export function logWrite(workDir, name) {
  const file = join(resolve(workDir), 'writes.json');
  try {
    let w = []; try { w = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first */ }
    w.push({ at: new Date().toISOString(), scenario: name, tool: 'site-walk' });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(w.slice(-100), null, 1));
    return file;
  } catch { return null; }   // unwritable work folder
}

// ---------------------------------------------------------------------------------------------
// Commands.

async function cmdSignin() {
  const url = flag('url');
  if (!url || url === true) { console.error('signin: --url <site> is required'); process.exit(2); }
  const chromium = await loadPlaywright(); if (!chromium) noBrowser('signin');
  const ctx = await persistent(chromium, false);
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(String(url)).catch(() => {});
  log('Sign in in the browser window (Microsoft account, MFA if asked). Waiting up to 10 minutes...');
  const host = new URL(String(url)).host;
  const marker = flag('marker');
  const signIn = new RegExp(DEFAULT_SIGNIN, 'i');
  const end = Date.now() + 10 * 60 * 1000;
  let done = false;
  while (Date.now() < end && !done) {
    await page.waitForTimeout(2000);
    const u = page.url();
    if (new URL(u).host === host && !signIn.test(u)) done = marker && marker !== true ? (await page.locator(String(marker)).count()) > 0 : true;
  }
  await ctx.close();
  if (!done) { console.error('signin: timed out before the site showed the signed-in state. Nothing was saved as signed in.'); process.exit(2); }
  log('Signed in; profile saved at ' + PROFILE + '. Walks reuse it headless.');
}

async function cmdWalk() {
  const file = flag('scenario') || argv[1];
  if (!file || file === true || !existsSync(String(file))) { console.error('walk: --scenario <file.json> is required'); process.exit(2); }
  const s = JSON.parse(readFileSync(String(file), 'utf8'));
  const errs = validateScenario(s);
  if (errs.length) { console.error('Scenario refused:\n  ' + errs.join('\n  ')); process.exit(2); }
  const chromium = await loadPlaywright(); if (!chromium) noBrowser('walk');
  const ctx = await persistent(chromium, !has('headed'));
  let plain = null;
  const runStart = Date.now();
  const report = await runWalk(s, {
    ctx, out: flag('out') && flag('out') !== true ? resolve(String(flag('out'))) : null, allowWrites: has('allow-writes'),
    freshContext: async () => { plain = plain || await plainBrowser(chromium); return plain.newContext(); },
    getToken: async (sc) => tokenFor(sc), runStart,
  });
  await ctx.close(); if (plain) await plain.close();
  if (s.writes === true && !report.refused) {
    const logged = logWrite(flag('work-dir') && flag('work-dir') !== true ? String(flag('work-dir')) : '.ship-work', s.name || String(file));
    if (logged) log(`(write logged in ${logged}; the seed check must run after it)`);
  }
  log(table(report.rows));
  const n = report.rows.filter((r) => r.code).length;
  const code = exitCode(report);
  log(code === 2 ? '\nNOTHING EXAMINED - not a pass.' : `\n${report.examined} check(s), ${n} finding(s).`);
  for (const t of report.timings || []) log(`  ${t.ok ? 'settled' : 'STALE'} after ${t.seconds} s: ${t.step}`);
  if (s.writes === true && !report.refused) log(`  Test rows from this run carry ${report.vars?.runId}. Remove them with: ${s.restore}`);
  if (flag('json') && flag('json') !== true) writeFileSync(String(flag('json')), JSON.stringify({ scenario: file, ...report, exit: code }, null, 2));
  process.exit(code);
}

// ---------------------------------------------------------------------------------------------
// Selftest.

function fixtureServer() {
  const html = (title, body) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;font-family:Arial">${body}</body></html>`;
  const signedIn = (req) => /(^|;\s*)sid=1/.test(req.headers.cookie || '');
  // A fake Dataverse: comments posted by the page land here with this run's timestamps; one old row
  // stands for a leftover from an earlier run.
  const comments = [{ app_commentid: 1, app_body: 'OLD', app_status: 1, createdon: '2020-01-01T00:00:00Z', modifiedon: '2020-01-01T00:00:00Z' }];
  let eventualHits = 0;
  const postScript = "(async()=>{const v=document.getElementById('c').value;const r=await fetch('/post-comment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:v})});const j=await r.json();document.getElementById('out').textContent='Posted: '+v+' (id '+j.id+')';})()";
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, ...extra }); res.end(body); };
    const json = (code, o) => send(code, 'application/json', JSON.stringify(o));
    const p = decodeURIComponent(u.pathname);
    if (p === '/ok') return send(200, 'text/html', html('ok', `<h1>Work items</h1><p>DEMO-1001 Fix the thing</p><form><input id="c"><button id="post" type="button" onclick="${postScript}">Post</button></form><p id="out"></p>`));
    if (p === '/post-comment' && req.method === 'POST') {
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => { const now = new Date().toISOString(); const id = comments.length + 41; comments.push({ app_commentid: id, app_body: JSON.parse(b).body, app_status: 1, createdon: now, modifiedon: now }); json(200, { id }); });
      return;
    }
    if (p.startsWith('/api/data/v9.2/app_comments')) {
      if (req.headers.authorization !== 'Bearer dvtok') return json(401, { error: { message: 'no token' } });
      const m = /app_body eq '((?:[^']|'')*)'/.exec(u.searchParams.get('$filter') || '');
      const want = m ? m[1].replace(/''/g, "'") : null;
      return json(200, { value: comments.filter((c) => c.app_body === want).map((c) => ({ ...c, 'app_status@OData.Community.Display.V1.FormattedValue': c.app_status === 1 ? 'New' : 'Closed' })) });
    }
    if (p.startsWith('/item/')) return send(200, 'text/html', html('item', `<h1>Item ${p.slice(6)}</h1>`));
    if (p === '/eventual') { eventualHits++; return send(200, 'text/html', html('eventual', `<p>Status: ${eventualHits >= 3 ? 'To Do' : 'Backlog'}</p>`)); }
    if (p === '/never') return send(200, 'text/html', html('never', '<p>Status: Backlog</p>'));
    if (p === '/wide') return send(200, 'text/html', html('wide', '<div style="width:600px;height:40px;background:#0066B3">fixed 600px</div>'));
    if (p === '/SignIn') return send(200, 'text/html', html('sign in', '<p>Please sign in</p>'));
    if (p === '/secret') return signedIn(req) ? send(200, 'text/html', html('secret', '<p>SECRET-ITEM</p>')) : send(302, 'text/plain', '', { Location: '/SignIn' });
    if (p === '/leaky') return send(200, 'text/html', html('leaky', '<p>SECRET-ITEM</p>'));
    if (p === '/_layout/tokenhtml') return send(200, 'text/html', '<input name="__RequestVerificationToken" type="hidden" value="tok123" />');
    if (p === '/_api/open') return json(200, { value: [{ id: 9 }] });   // leaks to anyone, signed in or not
    if (p.startsWith('/_api/')) {
      if (req.headers.__requestverificationtoken !== 'tok123') return json(400, { error: { message: 'missing token' } });
      if (p === '/_api/items(1)') return json(403, { error: { code: '90040120', message: 'no permission' } });
      if (p === '/_api/items(2)') return json(200, { '@odata.context': 'x', id: 2, title: 'hidden' });
      if (p === '/_api/items(3)') return json(200, { '@odata.context': 'x', id: 3, title: 'shared' });
      if (p === '/_api/items' && req.method === 'GET') return json(200, { value: u.searchParams.get('$filter') ? [] : [{ id: 3 }] });
      return json(405, { error: { message: 'not allowed' } });
    }
    return send(404, 'text/html', html('404', 'not found'));
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

async function selftest() {
  const fails = [];
  const check = (name, cond) => { if (!cond) fails.push(name); log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); };

  // Logic half: no browser needed.
  check('scenario without baseUrl refused', validateScenario({}).length > 0);
  check('probe without expectation refused', validateScenario({ baseUrl: 'https://x', api: [{ path: '/_api/a' }] }).some((e) => /proves nothing/.test(e)));
  check('good scenario accepted', validateScenario({ baseUrl: 'https://x', pages: [{ path: '/' }], api: [{ path: '/_api/a', expectStatus: 403 }] }).length === 0);
  check('rows: value list', countRows('{"value":[{"a":1},{"a":2}]}') === 2);
  check('rows: single entity', countRows('{"@odata.context":"x","a":1}') === 1);
  check('rows: error body is none', countRows('{"error":{"message":"x"}}') === 0);
  check('rows: empty list', countRows('{"value":[]}') === 0);
  check('api: refusal that succeeded -> SW-API-ALLOWED', apiVerdict({ path: '/x', expectStatus: [401, 403, 404] }, 200, '{}')?.code === 'SW-API-ALLOWED');
  check('api: refusal held', apiVerdict({ path: '/x', expectStatus: '4xx' }, 403, '{}') === null);
  check('api: success refused -> SW-API-REFUSED', apiVerdict({ path: '/x', expectStatus: '2xx' }, 403, '{}')?.code === 'SW-API-REFUSED');
  check('api: other mismatch -> SW-API-STATUS', apiVerdict({ path: '/x', expectStatus: 404 }, 500, '{}')?.code === 'SW-API-STATUS');
  check('api: rows that must not exist -> SW-API-ROWS', apiVerdict({ path: '/x', expectNoRows: true }, 200, '{"value":[{"a":1}]}')?.code === 'SW-API-ROWS');
  check('api: empty filter passes', apiVerdict({ path: '/x', expectStatus: 200, expectNoRows: true }, 200, '{"value":[]}') === null);
  check('scroll: 600 in 390 -> SW-SCROLL', scrollVerdict(600, 390)?.code === 'SW-SCROLL');
  check('scroll: equal widths pass', scrollVerdict(390, 390) === null);
  check('signed out: redirected passes', signedOutVerdict({ path: '/a', mustNotShow: ['X'] }, 'https://login.microsoftonline.com/abc', 'X') === null);
  check('signed out: shown text -> leak', signedOutVerdict({ path: '/a', mustNotShow: ['X'] }, 'https://site/a', 'has X')?.code === 'SW-SIGNEDOUT-LEAK');
  check('signed out: no list and no redirect -> leak', signedOutVerdict({ path: '/a' }, 'https://site/a', '')?.code === 'SW-SIGNEDOUT-LEAK');
  check('exit 2 when nothing examined', exitCode({ examined: 0, rows: [] }) === 2);
  check('exit 1 on a finding', exitCode({ examined: 1, rows: [{ code: 'SW-TEXT' }] }) === 1);
  check('exit 0 when clean', exitCode({ examined: 1, rows: [{ code: null }] }) === 0);

  // Variables and captures.
  const day = new Date(2026, 0, 30);
  check('subst: runId and captured names', subst('[TEST] {{runId}} on {{ cid }}', { runId: 'R1', cid: '42' }, day) === '[TEST] R1 on 42');
  check('subst: today+N crosses the month', subst('{{today+2}} {{today}} {{today-30}}', {}, day) === '2026-02-01 2026-01-30 2025-12-31');
  let threw = ''; try { subst({ fill: '#x', value: '{{nope}}' }, {}); } catch (e) { threw = e.message; }
  check('subst: unknown variable throws, naming it', /unknown variable \{\{nope\}\}/.test(threw));
  check('subst: nested lists and objects, capture spec untouched', JSON.stringify(subst({ a: ['{{x}}'], capture: { name: 'y', pattern: '{{x}}' } }, { x: 'v' })) === '{"a":["v"],"capture":{"name":"y","pattern":"{{x}}"}}');
  check('capture: json path', captureValue({ name: 'id', from: 'json', path: 'value.0.id' }, '{"value":[{"id":7}]}') === '7');
  check('capture: pattern group from text', captureValue({ name: 'cid', pattern: 'id (\\d+)' }, 'Posted: x (id 42)') === '42');
  threw = ''; try { captureValue({ name: 'k', pattern: 'DEMO-\\d+' }, 'nothing here'); } catch (e) { threw = e.message; }
  check('capture: no match throws', /matched nothing/.test(threw));
  threw = ''; try { captureValue({ name: 'k', from: 'json', path: 'value.3.id' }, '{"value":[]}'); } catch (e) { threw = e.message; }
  check('capture: missing json path throws', /nothing at value\.3\.id/.test(threw));

  // Confirm judgement and the write rules.
  const start = Date.parse('2026-10-05T12:00:00Z');
  const fresh = { app_status: 1, 'app_status@OData.Community.Display.V1.FormattedValue': 'New', modifiedon: '2026-10-05T12:01:00Z' };
  check('confirm: value by label and freshness hold', judgeRows([fresh], { expect: { app_status: 'New' }, count: 1 }, start, true).length === 0);
  check('confirm: raw value holds', judgeRows([fresh], { expect: { app_status: 1 } }, start, true).length === 0);
  check('confirm: wrong value fails', judgeRows([fresh], { expect: { app_status: 'Closed' } }, start, true).some((w) => /expected "Closed"/.test(w)));
  check('confirm: an old row fails when the scenario writes', judgeRows([{ ...fresh, modifiedon: '2026-10-04T09:00:00Z' }], { expect: { app_status: 1 } }, start, true).some((w) => /before this walk started/.test(w)));
  check('confirm: an old row passes when changedDuringRun is false', judgeRows([{ ...fresh, modifiedon: '2026-10-04T09:00:00Z' }], { expect: { app_status: 1 }, changedDuringRun: false }, start, true).length === 0);
  check('confirm: count and absent', judgeRows([fresh, fresh], { count: 1, changedDuringRun: false }, start, false).length === 1 && judgeRows([fresh], { absent: true }, start, false).length === 1 && judgeRows([], { absent: true }, start, false).length === 0);
  check('confirm: no row fails', judgeRows([], { expect: { a: 1 } }, start, false).some((w) => /no row/.test(w)));
  check('confirm url', confirmUrl('https://org.example/', { table: 'app_comments', filter: "app_body eq 'a b'", expect: { app_status: 1 } }) === "https://org.example/api/data/v9.2/app_comments?$filter=app_body%20eq%20'a%20b'&$select=app_status,modifiedon,createdon&$top=50");
  const writerSpec = { baseUrl: 'https://x', writes: true, steps: [{ goto: '/' }] };
  check('writing scenario without confirm or restore refused', validateScenario(writerSpec).filter((e) => /confirm|restore/.test(e)).length === 2);
  check('confirm without orgUrl refused', validateScenario({ ...writerSpec, restore: 'cleanup', confirm: [{ table: 't', filter: 'a eq 1', count: 1 }] }).some((e) => /orgUrl/.test(e)));
  check('confirm that asserts nothing refused', validateScenario({ baseUrl: 'https://x', orgUrl: 'https://o', confirm: [{ table: 't', filter: 'a eq 1' }] }).some((e) => /asserts nothing/.test(e)));
  check('bad capture name refused', validateScenario({ baseUrl: 'https://x', steps: [{ capture: { name: '1x' } }] }).some((e) => /simple name/.test(e)));
  check('complete writing scenario accepted', validateScenario({ ...writerSpec, restore: 'cleanup', orgUrl: 'https://o', confirm: [{ table: 't', filter: 'a eq 1', count: 1 }] }).length === 0);
  const wd = mkdtempSync(join(tmpdir(), 'site-walk-writes-'));
  logWrite(join(wd, '.ship-work'), 'one'); logWrite(join(wd, '.ship-work'), 'two');
  const logged = JSON.parse(readFileSync(join(wd, '.ship-work', 'writes.json'), 'utf8'));
  check('writes.json appended in the shape the seed gate reads', logged.length === 2 && logged[1].scenario === 'two' && !!Date.parse(logged[1].at));
  rmSync(wd, { recursive: true, force: true });

  if (has('logic-only')) {
    log(fails.length ? `\n${fails.length} FAILED` : '\nlogic half passed. Browser half NOT run (--logic-only): run --selftest without it where Playwright is installed.');
    process.exit(fails.length ? 1 : 0);
  }

  // Browser half: a real browser against a local fixture site.
  const chromium = await loadPlaywright();
  if (!chromium) noBrowser('selftest browser half');
  const srv = await fixtureServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const out = mkdtempSync(join(tmpdir(), 'site-walk-selftest-'));
  let browser;
  try { browser = await plainBrowser(chromium); } catch (e) { srv.close(); console.error('selftest: no browser could start (' + e.message.split('\n')[0] + '). NOT a pass.'); process.exit(2); }
  const signedInCtx = async () => {
    const c = await browser.newContext();
    await c.addCookies([{ name: 'sid', value: '1', url: base }]);
    return c;
  };
  const run = async (s, opts = {}) => { const ctx = await signedInCtx(); const r = await runWalk(s, { ctx, freshContext: () => browser.newContext(), out, ...opts }); await ctx.close(); return r; };
  const codes = (r) => new Set(r.rows.filter((x) => x.code).map((x) => x.code));

  const good = await run({
    baseUrl: base, widths: [1440, 390], signInPattern: '/SignIn',
    pages: [{ path: '/ok', name: 'ok', expectText: ['Work items', 'DEMO-1001'] }, { path: '/secret', expectText: ['SECRET-ITEM'] }],
    steps: [{ goto: '/ok' }, { fill: '#c', value: 'hello' }, { click: '#post' }, { expectText: 'Posted: hello' }, { expectNoText: 'SECRET-ITEM' }, { expectUrl: '/ok$' }],
    api: [{ name: 'hidden by id refused', path: '/_api/items(1)', expectStatus: [403, 404] }, { name: 'filter on hidden key empty', path: "/_api/items?$filter=key eq 'X'", expectStatus: 200, expectNoRows: true }],
    signedOut: [{ path: '/secret', mustNotShow: ['SECRET-ITEM'] }],
  });
  check('good fixtures: no findings', codes(good).size === 0 && good.examined > 0);
  if (codes(good).size) log(table(good.rows.filter((r) => r.code)));
  check('screenshot written per width, page only', existsSync(join(out, 'ok-1440.png')) && existsSync(join(out, 'ok-390.png')) && statSync(join(out, 'ok-390.png')).size > 500);
  check('wide page passes at 1440', (await run({ baseUrl: base, widths: [1440], pages: [{ path: '/wide' }] })).rows.every((r) => !r.code));

  const bad = await run({
    baseUrl: base, widths: [1440, 390], signInPattern: '/SignIn',
    pages: [{ path: '/wide' }, { path: '/ok', expectText: ['Not on this page'] }, { path: '/missing' }],
    api: [{ name: 'hidden by id must be refused', path: '/_api/items(2)', expectStatus: [403, 404] }, { name: 'list must work', path: '/_api/items(1)', expectStatus: '2xx' },
          { name: 'unfiltered must be empty', path: '/_api/items', expectNoRows: true, expectStatus: 200 }],
    signedOut: [{ path: '/leaky', mustNotShow: ['SECRET-ITEM'] }],
  });
  const bc = codes(bad);
  const apiLeak = await run({ baseUrl: base, signedOut: [{ path: '/_api/open' }, { path: '/_api/items(1)' }] });
  check('signed-out Web API rows -> SW-SIGNEDOUT-LEAK (and a refused call passes)', apiLeak.rows.filter((r) => r.code === 'SW-SIGNEDOUT-LEAK').length === 1);
  for (const c of ['SW-SCROLL', 'SW-TEXT', 'SW-NAV', 'SW-API-ALLOWED', 'SW-API-REFUSED', 'SW-API-ROWS', 'SW-SIGNEDOUT-LEAK']) check(`bad fixtures raise ${c}`, bc.has(c));
  check('SW-SCROLL only at 390', bad.rows.filter((r) => r.code === 'SW-SCROLL').every((r) => r.width === 390));

  const stepFail = await run({ baseUrl: base, widths: [1440], steps: [{ goto: '/ok' }, { click: '#nope', timeout: 1 }, { expectUrl: '/elsewhere' }] });
  check('missing selector -> SW-STEP, wrong url -> SW-URL', codes(stepFail).has('SW-STEP') && codes(stepFail).has('SW-URL'));
  const writer = (extra) => ({ baseUrl: base, widths: [1440], writes: true, restore: 'the fixture forgets on exit', orgUrl: base, ...extra });
  const writes = await run(writer({ pages: [{ path: '/ok' }], confirm: [{ table: 'app_comments', filter: "app_body eq 'x'", count: 1 }] }));
  check('writes refused without --allow-writes (exit 2)', exitCode(writes) === 2);

  // A write performed, captured, carried forward and confirmed in (fake) Dataverse.
  const dv = { allowWrites: true, getToken: async () => 'dvtok' };
  const goodWrite = await run(writer({
    steps: [{ goto: '/ok' }, { fill: '#c', value: '[TEST] {{runId}}' }, { click: '#post' },
      { expectText: 'Posted: [TEST] {{runId}}', capture: { name: 'cid', selector: '#out', pattern: 'id (\\d+)' } },
      { goto: '/item/{{cid}}' }, { expectText: 'Item {{cid}}' }],
    apiFrom: '/ok', api: [{ name: 'list', path: '/_api/items', expectStatus: 200, capture: { name: 'iid', from: 'json', path: 'value.0.id' } },
      { name: 'captured id opens', path: '/_api/items({{iid}})', expectStatus: 200 }],
    confirm: [{ table: 'app_comments', filter: "app_body eq '[TEST] {{runId}}'", expect: { app_status: 'New' }, count: 1 }],
  }), dv);
  check('write: posted, captured, carried, confirmed - no findings', codes(goodWrite).size === 0 && goodWrite.examined > 0 && /^\d+$/.test(goodWrite.vars?.cid || '') && goodWrite.vars?.iid === '3');
  if (codes(goodWrite).size) log(table(goodWrite.rows.filter((r) => r.code)));
  const badConfirm = await run(writer({ steps: [{ goto: '/ok' }],
    confirm: [{ table: 'app_comments', filter: "app_body eq 'OLD'", count: 1 }, { table: 'app_comments', filter: "app_body eq 'OLD'", expect: { app_status: 'Closed' }, changedDuringRun: false }] }), dv);
  check('old row and wrong value -> SW-CONFIRM (twice)', badConfirm.rows.filter((r) => r.code === 'SW-CONFIRM').length === 2);
  const noToken = await run(writer({ steps: [{ goto: '/ok' }], confirm: [{ table: 'app_comments', filter: "app_body eq 'OLD'", count: 1 }] }), { allowWrites: true, getToken: async () => null });
  check('no token -> SW-CONFIRM, never a pass', noToken.rows.some((r) => r.code === 'SW-CONFIRM' && /NOT a pass/.test(r.msg)));
  const unknownVar = await run({ baseUrl: base, widths: [1440], steps: [{ goto: '/item/{{missing}}' }] });
  check('unknown variable -> SW-STEP', unknownVar.rows.some((r) => r.code === 'SW-STEP' && /unknown variable/.test(r.msg)));

  // A cache delay is measured, and a page that never settles is SW-STALE.
  const late = await run({ baseUrl: base, widths: [1440], steps: [{ goto: '/eventual' }, { expectText: 'Status: To Do', expectWithin: 20, every: 1, timeout: 500 }] });
  const lateRow = late.rows.find((r) => /expectText/.test(r.step));
  check('expectWithin: settles after reloads, time recorded', codes(late).size === 0 && /^after \d+ s$/.test(lateRow?.note || '') && late.timings.length === 1 && late.timings[0].ok);
  const stale = await run({ baseUrl: base, widths: [1440], steps: [{ goto: '/never' }, { expectText: 'Status: To Do', expectWithin: 3, every: 1, timeout: 500 }],
    pages: [{ path: '/never', expectText: ['Status: Done'], expectWithin: 2, every: 1 }] });
  check('expectWithin: never settles -> SW-STALE (step and page)', stale.rows.filter((r) => r.code === 'SW-STALE').length === 2);
  const empty = await run({ baseUrl: base });
  check('empty scenario: nothing examined (exit 2)', exitCode(empty) === 2);

  await browser.close(); srv.close(); rmSync(out, { recursive: true, force: true });
  log(fails.length ? `\n${fails.length} FAILED` : '\nall passed (logic and browser halves).');
  process.exit(fails.length ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------

const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n');
if (has('selftest')) await selftest();
else if (cmd === 'signin') await cmdSignin();
else if (cmd === 'walk') await cmdWalk();
else { log(HELP); process.exit(cmd && cmd !== '--help' && cmd !== '-h' ? 2 : 0); }
