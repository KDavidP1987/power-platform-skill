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
//                         [--accept-site-consent [<site name>]] when the account is already signed in
//                         to Entra and only the site's own consent page remains, accept it: only the
//                         "Portals-<site>" app, only sign-in and profile, never for the organisation.
//                         For a run with no person present, with the person's say-so recorded up front
//                         (a measured build lost 30 minutes waiting on this page).
//   node site-walk.mjs walk --scenario <file.json> [--out <dir>] [--json <file>] [--allow-writes]
//                         [--token-cmd "<command>"] [--work-dir <dir>]
//                         walk the scenario; table on stdout, full report with --json
//   node site-walk.mjs ship --site <site folder> --scenario <file.json> [--model-version 2] [--no-clear]
//                         [--allow-writes] [walk flags]
//                         one call for the loop a site build repeats: audit-pages-permissions.py on the
//                         folder (summary line), pac pages upload, Clear config and Clear cache at
//                         /_services/about in the signed-in profile, then the walk. Measured builds made
//                         220 to 295 tool calls, most of them this loop one step at a time.
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
//   signInSelector the site's own sign-in link (default a[href*="/SignIn" i], a[href*="/Account/Login" i]);
//                  false skips the check. Before the pages (and before ship's Clear buttons) the walk
//                  opens signInPath (default /); when the link is shown it follows it and waits up to
//                  signInTimeout seconds (default 60) for the site to come back signed in. A profile
//                  keeps the Entra session but not the site session, so this usually completes with no
//                  person. When it cannot, the walk reports SW-SIGNED-OUT once and judges no page.
//   writes         true when the steps create or change data; then "restore" (how the test rows are
//                  removed, e.g. the owner's cleanup script) and "confirm" are required
//   orgUrl, dataverseTokenCommand   the Dataverse org and a command printing a token for it (confirm)
//   pages          [{path, name?, expectText?: [..], expectSelector?: [..], expectNoText?: [..],
//                   screenshotSelector?, expectWithin?}]
//                  visited at every width; a screenshot named <name>-<width>.png when name is set.
//                  Text is matched case-insensitively (innerText applies CSS text-transform)
//   steps          [{goto}|{fill, value}|{click}|{pressTwice}|{select, value}|{press, selector?}|{expectText}|
//                   {expectNoText}|{expectUrl}|{wait}|{screenshot}|{capture}]  performed once, at the
//                  first width. Any step may also carry "capture" (taken after the step).
//   api            [{name?, method?, path, body?, expectStatus?, expectNoRows?, capture?, repeat?}]  sent from
//                  inside the signed-in page with fetch, carrying the site's anti-forgery token from
//                  /_layout/tokenhtml. expectStatus: a number, a list, or "2xx" / "4xx".
//   confirm        [{table, filter, expect?: {column: value}, count?, absent?, changedDuringRun?,
//                   within?, filled?: [columns]}]  read back over the Dataverse Web API after the steps and probes. table
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
// Double writes: {"pressTwice": "<selector>"} clicks a button twice in the same moment (a person's
//   double press); an api probe with "repeat": N sends N identical requests at once (a retry loop). Follow
//   either with a confirm "count": 1, and expectNoText for any error the second press may show.
//
// Eventual consistency: "expectWithin": <seconds> on an expectText / expectNoText step or a page
//   keeps reloading (every "every" seconds, default 10) until the expectation holds. The report
//   records how long it took, so a site cache delay is measured, not hidden; past the limit it is
//   SW-STALE.
//
// Finding codes:
//   SW-NAV            a page failed to load (HTTP 400+), or a signed-in page landed on sign-in
//   SW-SIGNED-OUT     the walk is signed out of the site itself and could not sign in through the
//                     site's own link; no page was judged (exit 2)
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
//   SW-OVERFLOW       text spills out of its box, past the viewport or into the next element
//   SW-COVERED        a fixed or sticky bar covers a control when it is scrolled into view
//   SW-NAV-CURRENT    the menu marks a page other than the one shown as current (aria-current or an
//                     active/current class on a header or nav link)
//   SW-FOCUS          a control has no focus indicator of 2 px or more at 3:1 against what is behind
//                     it (outline, box-shadow or a thicker border); a 1 px colour change is not enough
//                     ("uiChecks": false turns the last two off; "navSelector" overrides the menu links)
//   SW-FILLED         confirm: a column listed in "filled" is empty on a row the run wrote
//                     (both run on every page at every width; "layoutChecks": false turns them off,
//                     "layoutIgnore": [selectors] skips a subtree meant to bleed)
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
  const verbs = ['goto', 'fill', 'click', 'pressTwice', 'select', 'press', 'expectText', 'expectNoText', 'expectUrl', 'wait', 'screenshot', 'capture'];
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
    if (c.filled && (!Array.isArray(c.filled) || !c.filled.every((x) => typeof x === 'string'))) errs.push(`confirm[${i}].filled must be a list of column names`);
    if (!c.absent && !c.expect && c.count === undefined && !c.filled) errs.push(`confirm[${i}] asserts nothing: give "expect", "count" or "absent"`);
  }
  if (s.signInSelector !== undefined && s.signInSelector !== false && !(typeof s.signInSelector === 'string' && s.signInSelector.trim())) errs.push('signInSelector must be a CSS selector, or false to skip the site sign-in check');
  if (s.signInPath !== undefined && !(typeof s.signInPath === 'string' && s.signInPath.startsWith('/'))) errs.push('signInPath must start with /');
  if (s.signInTimeout !== undefined && !(Number(s.signInTimeout) > 0)) errs.push('signInTimeout must be a number of seconds');
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
    for (const col of c.filled || []) {
      const v = r[col];
      if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) why.push(`row ${k + 1}: ${col} is empty (SW-FILLED: the site must set it)`);
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
  const cols = new Set([...Object.keys(c.expect || {}), ...(c.filled || []), 'modifiedon', 'createdon'].map((x) => x.trim()).filter(Boolean));
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
  const shown = must.filter((m) => textHas(text, m));
  return shown.length ? { code: 'SW-SIGNEDOUT-LEAK', msg: `${entry.path}: signed out, shows ${shown.map((x) => JSON.stringify(x)).join(', ')}` } : null;
}

// Text checks read innerText, which applies CSS text-transform: a heading styled uppercase reads
// "TOTAL COST" while the scenario says "Total cost". Compare case-insensitively; innerText still
// keeps hidden text out, which textContent would not.
export function textHas(haystack, needle) {
  return String(haystack ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());
}

// The site session. A persistent profile keeps the Entra session but not the Power Pages site
// session: a new walk can land on the site signed out (the header offers "Sign in", Liquid `user` is
// empty), and then every scoped page answers "not found" for the wrong reason. state of one look:
// 'sign-in-page' (on the identity provider), 'elsewhere' (left the site), 'signed-out' (the site's
// own sign-in link is shown) or 'signed-in'.
export const DEFAULT_SITE_SIGNIN_LINK = 'a[href*="/SignIn" i], a[href*="/Account/Login" i]';
export function sessionState(url, baseUrl, signInLinks, signInPattern = DEFAULT_SIGNIN) {
  if (new RegExp(signInPattern, 'i').test(url)) return 'sign-in-page';
  let same = false;
  try { same = new URL(url).host === new URL(baseUrl).host; } catch { /* not a URL */ }
  if (!same) return 'elsewhere';
  return signInLinks > 0 ? 'signed-out' : 'signed-in';
}
export function signedOutFinding(state, selector, baseUrl) {
  if (state === 'signed-in') return null;
  const why = state === 'sign-in-page' ? 'the sign-in went to the identity provider and needs a person there'
    : state === 'elsewhere' ? 'the site\'s sign-in link left the site and did not come back'
      : `the site still shows its sign-in link (${selector}) after following it`;
  return { code: 'SW-SIGNED-OUT', msg: `the walk is signed out of the site: ${why}. Pages were not judged (they would all miss for this reason). Run \`site-walk.mjs signin --url ${baseUrl}\`, then walk again` };
}

// signin --accept-site-consent: accept only the site's own sign-in app ("Portals-<site name>"), for the
// signed-in account only, asking for sign-in and profile only. Anything else stays for a person: a
// different app, wider permissions, or a request for an administrator.
export function consentVerdict(text, siteName = null) {
  if (!/Permissions requested/i.test(text)) return { accept: false, reason: null };
  const m = /Portals-([^\n]+)/.exec(text);
  if (!m) return { accept: false, reason: 'the app asking is not a Power Pages site app (Portals-<site>)' };
  const app = 'Portals-' + m[1].trim();
  if (siteName && !app.toLowerCase().includes(siteName.toLowerCase())) return { accept: false, reason: `${app} is not the site named ${siteName}` };
  if (/Need admin approval|admin approval required/i.test(text)) return { accept: false, reason: 'the tenant asks for an administrator' };
  const asks = text.split('\n').map((l) => l.trim()).filter((l) => /^(Read|Write|Send|Access|Maintain|Have full|Sign you in|View)/i.test(l));
  const wider = asks.filter((l) => !/^(Sign you in and read your profile|View your basic profile|Maintain access to data you have given it access to)$/i.test(l));
  if (wider.length) return { accept: false, reason: `${app} asks for more than sign-in and profile: ${wider.join('; ')}` };
  return { accept: true, app };
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

// Two layout faults a sideways-scroll check cannot see (both shipped in a measured build at 390 px):
//  SW-OVERFLOW  text that spills out of its box, past the viewport or into the next element (a chip
//               row, a long title in a fixed-width cell). Scrollers, deliberate clips and ellipsis
//               are intended and skipped; only the innermost spilling element is reported.
//  SW-COVERED   a fixed or sticky bar sits over a control once that control is scrolled into view the
//               way the keyboard does it (nearest edge). The fix is usually scroll-padding-bottom on
//               html equal to the bar's height, which scrollIntoView honours, so the fix passes here.
// ignore: selectors whose subtree is skipped (a carousel that is meant to bleed).
async function layoutCheck(page, ignore = []) {
  const found = await page.evaluate((ignore) => {
    const out = [];
    const skip = (el) => ignore.some((s) => { try { return !!el.closest(s); } catch { return false; } });
    const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
    const said = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const vw = document.documentElement.clientWidth;
    const scroller = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (/auto|scroll/.test(getComputedStyle(a).overflowX)) return true; return false; };
    const spilled = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (!el.getClientRects().length || skip(el) || el.closest('[aria-hidden="true"]')) continue;
      if (/^(script|style|svg|path|img|video|canvas|iframe|input|textarea|select|option|br)$/i.test(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'inline' || cs.visibility === 'hidden' || /auto|scroll|hidden|clip/.test(cs.overflowX)) continue;
      if (el.clientWidth === 0 || el.scrollWidth <= el.clientWidth + 1 || scroller(el)) continue;
      const r = el.getBoundingClientRect(), spill = r.left + el.scrollWidth;
      const hits = [...(el.parentElement ? el.parentElement.children : [])].some((sib) => {
        if (sib === el) return false;
        const q = sib.getBoundingClientRect();
        return q.width > 0 && q.left < spill && q.left >= r.right - 1 && q.top < r.bottom && q.bottom > r.top;
      });
      if (spill > vw + 1 || hits) spilled.push({ el, hits });
    }
    for (const { el, hits } of spilled) {
      if (spilled.some((o) => o.el !== el && el.contains(o.el))) continue;   // keep the innermost
      if (out.length < 8) out.push({ code: 'SW-OVERFLOW', msg: `${desc(el)} "${said(el)}": content ${el.scrollWidth}px in a ${el.clientWidth}px box ${hits ? 'runs into the next element' : 'leaves the viewport'}` });
    }
    const bars = [...document.body.querySelectorAll('*')].filter((e) => /fixed|sticky/.test(getComputedStyle(e).position) && e.getClientRects().length && !skip(e));
    if (bars.length) {
      const controls = [...document.querySelectorAll('input:not([type=hidden]), textarea, select, button, a[href]')]
        .filter((c) => c.getClientRects().length && !skip(c) && !bars.some((b) => b.contains(c))).slice(0, 80);
      const seen = new Set();
      for (const raw of controls) {
        // A styled radio or checkbox hides its 1 px input; the person sees and taps its label.
        const small = (e) => { const q = e.getBoundingClientRect(); return q.width < 2 || q.height < 2; };
        const c = small(raw) && raw.labels && raw.labels[0] ? raw.labels[0] : raw;
        if (c !== raw && bars.some((b) => b.contains(c))) continue;
        window.scrollTo(0, 0);
        c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = c.getBoundingClientRect();
        if (small(c)) continue;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || c.contains(hit) || hit.contains(c)) continue;
        const bar = bars.find((b) => b.contains(hit));
        if (!bar || seen.has(c)) continue;
        seen.add(c);
        if (out.filter((o) => o.code === 'SW-COVERED').length < 4) out.push({ code: 'SW-COVERED', msg: `${desc(c)} "${said(c)}" is under the ${getComputedStyle(bar).position} ${desc(bar)} when scrolled to (add scroll-padding-bottom or move the bar)` });
      }
      window.scrollTo(0, 0);
    }
    return out;
  }, ignore).catch((e) => [{ code: 'SW-STEP', msg: 'layout check could not run: ' + e.message.split('\n')[0] }]);
  return found;
}

// Contrast of two CSS colours (rgb()/rgba(), alpha blended on the background).
export function contrast(fg, bg) {
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
  const b = parse(bg) || { r: 255, g: 255, b: 255, a: 1 }, f = parse(fg);
  if (!f) return 1;
  const mix = (x, y) => x * f.a + y * (1 - f.a);
  const lum = (r, g, bl) => { const ch = [r, g, bl].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]; };
  const L1 = lum(mix(f.r, b.r), mix(f.g, b.g), mix(f.b, b.b)), L2 = lum(b.r, b.g, b.b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

// Is the current-page marker on the right menu link? marked: hrefs of links carrying aria-current or an
// active/current class; links: every menu href; here: the page's path. Pure, for the selftest.
export function navVerdict(here, links, marked) {
  if (!marked.length) return null;   // no marker in use: nothing to judge
  const norm = (p) => { const x = (p || '/').split(/[?#]/)[0]; return x.length > 1 ? x.replace(/\/+$/, '') : '/'; };
  const h = norm(here);
  const matches = (l) => { const q = norm(l); return q === h || (q !== '/' && h.startsWith(q + '/')); };
  const wrong = marked.filter((m) => !matches(m));
  if (wrong.length) return { code: 'SW-NAV-CURRENT', msg: `the menu marks ${wrong.map(norm).join(', ')} as current on ${h}` };
  const exact = links.find((l) => norm(l) === h);
  if (exact && !marked.some((m) => norm(m) === h)) return { code: 'SW-NAV-CURRENT', msg: `${h} is in the menu but not marked as current` };
  return null;
}

// Across pages: once any page marks its menu link as current, every page that is itself in the menu
// must be marked too. seen: [{here, links, marked}]. Pure, for the selftest.
export function navConsistency(seen) {
  if (!seen.some((n) => n.marked.length)) return [];
  const norm = (p) => { const x = (p || '/').split(/[?#]/)[0]; return x.length > 1 ? x.replace(/\/+$/, '') : '/'; };
  const bad = [...new Set(seen.filter((n) => !n.marked.length && n.links.some((l) => norm(l) === norm(n.here))).map((n) => norm(n.here)))];
  return bad.length ? [{ code: 'SW-NAV-CURRENT', msg: `other pages mark their menu link as current, but ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not marked` }] : [];
}

// SW-NAV-CURRENT and SW-FOCUS on the page as shown. A measured site's cached header marked the wrong page
// on every desktop page; another's text fields showed focus only as a pale 1.2:1 halo.
async function uiCheck(page, navSelector, seen = null) {
  const out = [];
  const nav = await page.evaluate((sel) => {
    const links = [...document.querySelectorAll(sel || 'header nav a[href], nav a[href], header a[href]')].filter((a) => a.getClientRects().length);
    const on = (a) => a.getAttribute('aria-current') === 'page' || [a, a.parentElement].some((e) => e && /(^|\s)(active|current|is-active|is-current|selected)(\s|$)/i.test(e.className || ''));
    const path = (a) => { try { const u = new URL(a.href, location.href); return u.origin === location.origin ? u.pathname : null; } catch { return null; } };
    const own = links.filter((a) => path(a));
    return { here: location.pathname, links: own.map(path), marked: own.filter(on).map(path) };
  }, navSelector).catch(() => null);
  if (nav) { const v = navVerdict(nav.here, nav.links, [...new Set(nav.marked)]); if (v) out.push(v); if (seen) seen.push(nav); }
  await page.keyboard.press('Shift').catch(() => {});   // keyboard modality, so :focus-visible applies
  const weak = await page.evaluate(async () => {
    const bgOf = (el) => { for (let a = el.parentElement; a; a = a.parentElement) { const c = getComputedStyle(a).backgroundColor; if (c && !/rgba\([^)]*,\s*0\)|transparent/.test(c)) return c; } return 'rgb(255, 255, 255)'; };
    const px = (v) => parseFloat(v) || 0;
    const shadows = (v) => (v && v !== 'none' ? v.split(/,(?![^(]*\))/).map((x) => { const color = (/rgba?\([^)]+\)/.exec(x) || [''])[0]; const n = x.replace(color, '').trim().split(/\s+/).map(px); return { color, blur: n[2] || 0, spread: n[3] || 0, inset: /inset/.test(x) }; }) : []);
    const seen = new Set(), res = [];
    const els = [...document.querySelectorAll('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea, select, button, a[href]')].filter((e) => e.getClientRects().length && !e.disabled);
    for (const el of els) {
      const kind = el.tagName.toLowerCase() + (el.type && el.tagName === 'INPUT' ? '[' + el.type + ']' : '');
      if (seen.has(kind)) continue;
      seen.add(kind);
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      const before = getComputedStyle(el);
      const b0 = { bw: px(before.borderTopWidth), bc: before.borderTopColor, sh: before.boxShadow };
      el.focus({ preventScroll: true });
      await new Promise((ok) => setTimeout(ok, 450));   // a focus ring that fades in is read at its end state
      const cs = getComputedStyle(el), bg = bgOf(el);
      const cands = [];
      if (cs.outlineStyle === 'auto') cands.push({ how: 'the browser focus ring', color: 'auto' });   // the default ring is drawn to be visible
      else if (cs.outlineStyle !== 'none' && px(cs.outlineWidth) >= 2) cands.push({ how: `outline ${cs.outlineWidth}`, color: cs.outlineColor });
      if (cs.boxShadow !== b0.sh) for (const sh of shadows(cs.boxShadow)) if (sh.spread >= 2 || sh.blur >= 4) cands.push({ how: `box-shadow ${sh.spread || sh.blur}px`, color: sh.color });
      if (px(cs.borderTopWidth) >= 2 && cs.borderTopColor !== b0.bc) cands.push({ how: `border ${cs.borderTopWidth}`, color: cs.borderTopColor });
      res.push({ kind, said: (el.innerText || el.getAttribute('aria-label') || el.name || el.id || '').trim().slice(0, 30), bg, cands });
      el.blur();
    }
    return res;
  }).catch(() => []);
  for (const w of weak) {
    const best = w.cands.map((c) => ({ ...c, ratio: c.color === 'auto' ? 21 : contrast(c.color, w.bg) })).sort((a, b) => b.ratio - a.ratio)[0];
    if (!best) out.push({ code: 'SW-FOCUS', msg: `${w.kind} "${w.said}": no focus indicator of 2 px or more (a 1 px colour change does not count)` });
    else if (best.ratio < 3) out.push({ code: 'SW-FOCUS', msg: `${w.kind} "${w.said}": focus ${best.how} at ${best.ratio.toFixed(1)}:1 against its background (needs 3:1)` });
  }
  return out;
}

async function shot(page, out, name, width, selector) {
  if (!out || !name) return;
  mkdirSync(out, { recursive: true });
  const file = join(out, `${name}-${width}.png`);
  if (selector) { const el = page.locator(selector).first(); if (await el.count()) { await el.screenshot({ path: file }); return; } }
  await page.screenshot({ path: file, fullPage: true });   // the page only: never browser chrome
}

// Make sure the walk is signed in to the site itself, not only to Entra: open signInPath (default /),
// and when the site's own sign-in link (signInSelector) is shown, follow it and wait for the return
// to the site - with an Entra session it completes without a person. Returns {finding, note}.
export async function ensureSiteSession(page, s) {
  const sel = s.signInSelector === undefined ? DEFAULT_SITE_SIGNIN_LINK : s.signInSelector;
  if (sel === false) return { finding: null, note: 'not checked (signInSelector false)' };
  const pattern = s.signInPattern || DEFAULT_SIGNIN;
  const links = () => page.evaluate((q) => [...document.querySelectorAll(q)].filter((e) => e.getClientRects().length).length, sel).catch(() => 0);
  const look = async () => sessionState(page.url(), s.baseUrl, await links(), pattern);
  await page.goto(abs(s.baseUrl, s.signInPath || '/'), { waitUntil: 'load', timeout: 45000 }).catch(() => {});
  let state = await look();
  if (state === 'signed-in') return { finding: null, note: 'signed in' };
  if (state === 'signed-out') {
    await page.evaluate((q) => { const a = [...document.querySelectorAll(q)].find((e) => e.getClientRects().length); if (a) a.click(); }, sel).catch(() => {});
    const end = Date.now() + Number(s.signInTimeout || 60) * 1000;
    do {
      await page.waitForTimeout(1000);
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      state = await look();
    } while (state !== 'signed-in' && Date.now() < end);
    if (state === 'signed-in') { await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); return { finding: null, note: 'signed in through the site\'s own sign-in link' }; }
  }
  return { finding: signedOutFinding(state, sel, s.baseUrl), note: '' };
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
  const navSeen = [];
  let examined = 0;
  const page = ctx.pages()[0] || await ctx.newPage();

  // Signed out of the site, every page and step below would miss for that one reason: say so once.
  if ((s.pages || []).length || (s.steps || []).length || (s.api || []).length) {
    const sess = await ensureSiteSession(page, s);
    add('site session', null, sess.finding, sess.note);
    if (sess.finding) return { examined: 0, rows, vars, timings, signedOut: true };
  }

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
        for (const t of p.expectText || []) if (!textHas(body, t)) return { code: 'SW-TEXT', msg: `missing text ${JSON.stringify(t)}` };
        for (const sel of p.expectSelector || []) if (!(await page.locator(sel).count())) return { code: 'SW-TEXT', msg: `missing ${sel}` };
        for (const t of p.expectNoText || []) if (textHas(body, t)) return { code: 'SW-TEXT', msg: `shows ${JSON.stringify(t)}` };
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
      if (s.layoutChecks !== false) {
        const found = await layoutCheck(page, s.layoutIgnore || []);
        if (!found.length) add(label + ': spill and cover', width, null);
        for (const lf of found) add(label + ': ' + (lf.code === 'SW-COVERED' ? 'cover' : 'spill'), width, lf);
      }
      if (s.uiChecks !== false) {
        const found = await uiCheck(page, s.navSelector || null, navSeen);
        if (!found.length) add(label + ': menu marker and focus', width, null);
        for (const uf of found) add(label + ': ' + (uf.code === 'SW-NAV-CURRENT' ? 'menu marker' : 'focus'), width, uf);
      }
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
          else if ('pressTwice' in st) {
            await page.locator(st.pressTwice).first().waitFor({ timeout: to });
            await page.evaluate((sel) => { const b = document.querySelector(sel); b.click(); b.click(); }, st.pressTwice);
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(1500);
          }
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
              return !textHas(await bodyText(), text);
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

  // A menu that marks the current page on some pages and not on others (a cached header) is wrong
  // on the unmarked ones.
  for (const v of navConsistency(navSeen)) add('menu marker across pages', null, v);

  if ((s.api || []).length) {
    const from = s.apiFrom || s.pages?.[0]?.path || '/';
    await visit(subst(from, vars), 'api: open ' + from, widths[0]);
    for (const rawProbe of s.api) {
      const label = 'api ' + (rawProbe.name || `${rawProbe.method || 'GET'} ${rawProbe.path}`);
      let a;
      try { a = subst(rawProbe, vars); } catch (e) { add(label, null, { code: 'SW-STEP', msg: e.message }); continue; }
      const n = Math.max(1, Math.min(10, Number(a.repeat) || 1));
      const all = await page.evaluate(async ({ path, method, body, n }) => {
        let token = '';
        try { const t = await (await fetch('/_layout/tokenhtml', { credentials: 'include' })).text(); token = (t.match(/value="([^"]+)"/) || [])[1] || ''; } catch { /* no token endpoint */ }
        const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', __RequestVerificationToken: token };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const one = async () => { const res = await fetch(path, { method, headers, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, text: (await res.text()).slice(0, 20000), token: !!token }; };
        return Promise.all(Array.from({ length: n }, one));   // repeat: the same request n times at once
      }, { path: a.path, method: (a.method || 'GET').toUpperCase(), body: a.body, n }).catch((e) => [{ status: 0, text: '', err: e.message }]);
      const r = all[0];
      examined++;
      let f = r.err ? { code: 'SW-STEP', msg: r.err.split('\n')[0] } : apiVerdict(a, r.status, r.text), note = n > 1 ? `${n} at once: ${all.map((x) => x.status).join(', ')}` : '';
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
      add(label, null, why.length ? { code: why.every((w) => /SW-FILLED/.test(w)) ? 'SW-FILLED' : 'SW-CONFIRM', msg: why.join('; ').slice(0, 300) } : null, note);
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
  const accept = flag('accept-site-consent');
  let accepted = false;
  while (Date.now() < end && !done) {
    await page.waitForTimeout(2000);
    const u = page.url();
    if (accept && !accepted && signIn.test(u)) {
      const text = await page.locator('body').innerText().catch(() => '');
      const verdict = consentVerdict(text, accept === true ? null : String(accept));
      if (verdict.accept) {
        const org = page.getByRole('checkbox', { name: /on behalf of your organi[sz]ation/i });
        if (await org.count() && await org.first().isChecked()) await org.first().uncheck().catch(() => {});
        await page.getByRole('button', { name: /^Accept$/ }).click().catch(() => {});
        accepted = true;
        log(`Accepted the site's own sign-in consent (${verdict.app}) for this account only. Record it in docs/decisions.md.`);
      } else if (verdict.reason) { log('Consent page left for a person: ' + verdict.reason); }
    }
    if (new URL(u).host === host && !signIn.test(u)) done = marker && marker !== true ? (await page.locator(String(marker)).count()) > 0 : true;
  }
  await ctx.close();
  if (!done) { console.error('signin: timed out before the site showed the signed-in state. Nothing was saved as signed in.'); process.exit(2); }
  log('Signed in; profile saved at ' + PROFILE + '. Walks reuse it headless.');
}

// ship: audit, upload, clear the site cache, walk - one command, one report.
export function shipPlan(site, modelVersion = '2', clear = true) {
  return [
    { step: 'audit', cmd: `python "${join(dirname(fileURLToPath(import.meta.url)), 'audit-pages-permissions.py')}" "${site}"`, fatal: false },
    { step: 'upload', cmd: `pac pages upload --path "${site}" --modelVersion ${modelVersion}`, fatal: true },
    ...(clear ? [{ step: 'clear', cmd: null, fatal: false }] : []),
    { step: 'walk', cmd: null, fatal: true },
  ];
}
async function cmdShip() {
  const site = flag('site'), file = flag('scenario');
  if (!site || site === true || !existsSync(String(site))) { console.error('ship: --site <folder from pac pages download> is required'); process.exit(2); }
  if (!file || file === true || !existsSync(String(file))) { console.error('ship: --scenario <file.json> is required'); process.exit(2); }
  const s = JSON.parse(readFileSync(String(file), 'utf8'));
  for (const st of shipPlan(String(site), String(flag('model-version', '2')), !has('no-clear'))) {
    if (st.step === 'audit' || st.step === 'upload') {
      let out = '', ok = true;
      try { out = execSync(st.cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }); }
      catch (e) { ok = false; out = String(e.stdout || '') + String(e.stderr || ''); }
      const lines = out.split(/\r?\n/).filter((l) => l.trim());
      if (st.step === 'audit') {
        const serious = lines.filter((l) => /^\s*(CRITICAL|WARNING)\b/.test(l));
        log(`ship audit: ${serious.length ? serious.length + ' critical/warning finding(s) - resolve or list each in the hand-back' : 'no critical or warning finding'}`);
        serious.slice(0, 12).forEach((l) => log('  ' + l.trim().slice(0, 200)));
      } else {
        log(`ship upload: ${ok ? 'done' : 'FAILED'}`);
        if (!ok) { lines.slice(-12).forEach((l) => log('  ' + l)); process.exit(2); }
      }
    } else if (st.step === 'clear') {
      const chromium = await loadPlaywright(); if (!chromium) noBrowser('ship');
      const ctx = await persistent(chromium, true);
      const page = ctx.pages()[0] || await ctx.newPage();
      const done = [];
      // Signed out of the site, /_services/about shows no Clear buttons, which reads as a missing role.
      const sess = await ensureSiteSession(page, s);
      if (sess.finding) { await ctx.close(); log(`ship clear: ${sess.finding.code} ${sess.finding.msg}. Clear config and Clear cache NOT pressed.`); continue; }
      await page.goto(abs(s.baseUrl, '/_services/about'), { waitUntil: 'load', timeout: 45000 }).catch(() => {});
      for (const name of [/clear config/i, /clear cache/i]) {
        const b = page.getByRole('button', { name });
        if (await b.count().catch(() => 0)) { await b.first().click().catch(() => {}); await page.waitForTimeout(3000); done.push(String(name).replace(/[/i]/g, '')); }
      }
      await ctx.close();
      log(done.length ? `ship clear: ${done.join(' and ')} pressed at /_services/about` : 'ship clear: no Clear buttons at /_services/about (the signed-in contact needs a web role with all website access); permission and setting changes may take minutes to apply');
    } else {
      await cmdWalk();   // exits with the walk's code
    }
  }
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
    const chips = '<div style="display:flex;gap:8px"><span style="display:block;width:70px;white-space:nowrap">Waiting for review</span><span style="display:block;width:70px">Done</span></div>';
    if (p === '/spill') return send(200, 'text/html', html('spill', chips));
    if (p === '/spill-ok') return send(200, 'text/html', html('spill ok', `<div style="overflow-x:auto">${chips}</div><p style="width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">A long title cut with an ellipsis</p>`));
    const form = (pad) => `<style>html{scroll-padding-bottom:${pad}px}.r input{position:absolute;width:1px;height:1px;opacity:0}</style><form>${Array.from({ length: 30 }, (_, i) => `<p class="r"><input type="radio" name="k" id="r${i}"><label for="r${i}">Option ${i}</label></p>`).join('')}</form><div style="position:fixed;bottom:0;left:0;right:0;height:80px;background:#0066B3"><button type="button">Send</button></div><div style="height:90px"></div>`;
    if (p === '/covered') return send(200, 'text/html', html('covered', form(0)));
    if (p === '/covered-ok') return send(200, 'text/html', html('covered ok', form(96)));
    const menu = (cur) => `<header><nav><a href="/navok"${cur === 'ok' ? ' aria-current="page"' : ''}>Shared</a> <a href="/navwrong"${cur === 'wrong' ? ' aria-current="page"' : ''}>Mine</a> <a href="/navnone">None</a></nav></header>`;
    if (p === '/navok') return send(200, 'text/html', html('nav ok', menu('ok') + '<h1>Shared</h1>'));
    if (p === '/navnone') return send(200, 'text/html', html('nav none', menu('none') + '<h1>None</h1>'));
    if (p === '/navwrong') return send(200, 'text/html', html('nav wrong', menu('ok') + '<h1>Mine</h1>'));
    const field = (css) => `<style>input{border:1px solid #8a8a8a}input:focus{outline:none;${css}}</style><label>Name <input id="n"></label>`;
    if (p === '/focusweak') return send(200, 'text/html', html('focus weak', field('box-shadow:0 0 0 3px #E1EFFA;border-color:#0066B3')));
    if (p === '/focusok') return send(200, 'text/html', html('focus ok', field('outline:2px solid #0066B3;outline-offset:2px')));
    const twice = (guard) => `<input id="c" value="hello"><button id="go" type="button" onclick="${guard ? "if(this.dataset.busy)return;this.dataset.busy=1;" : ''}fetch('/post-comment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:document.getElementById('c').value})})">Post</button>`;
    if (p === '/twice') return send(200, 'text/html', html('twice', twice(false)));
    if (p === '/once') return send(200, 'text/html', html('once', twice(true)));
    // A site session apart from sign-in (what a persistent profile meets): /site/ offers Sign in until
    // its cookie is set, and /site/SignIn sets it and returns; /dead/SignIn returns without it.
    if (p === '/site/SignIn') return send(302, 'text/plain', '', { Location: u.searchParams.get('returnUrl') || '/site/home', 'Set-Cookie': 'ss=1; Path=/' });
    if (p === '/dead/SignIn') return send(302, 'text/plain', '', { Location: '/dead/home' });
    if (p === '/site/home' || p === '/dead/home') {
      const pre = p.split('/')[1], on = pre === 'site' && /(^|;\s*)ss=1/.test(req.headers.cookie || '');
      return send(200, 'text/html', html('home', `<header>${on ? '<a href="/site/signout">Sign out</a>' : `<a href="/${pre}/SignIn?returnUrl=/${pre}/home">Sign in</a>`}</header>`
        + `<h2 style="text-transform:uppercase">Total cost of work</h2><p>${on ? 'SCOPED-ITEM' : 'Not found'}</p>`));
    }
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

  // Menu marker and focus contrast, pure.
  check('nav: right page marked passes', navVerdict('/my-requests/', ['/', '/shared/', '/my-requests/'], ['/my-requests/']) === null);
  check('nav: wrong page marked -> SW-NAV-CURRENT', navVerdict('/shared/', ['/shared/', '/my-requests/'], ['/my-requests/'])?.code === 'SW-NAV-CURRENT');
  check('nav: a detail page under a section may mark the section', navVerdict('/shared/item/', ['/shared/', '/my-requests/'], ['/shared/']) === null);
  check('nav: page in the menu but unmarked while markers are used', /not marked/.test(navVerdict('/request/', ['/shared/', '/request/'], ['/shared/x'])?.msg || '') || navVerdict('/request/', ['/shared/', '/request/'], ['/shared/'])?.code === 'SW-NAV-CURRENT');
  check('nav: no marker anywhere is not judged', navVerdict('/x/', ['/a/'], []) === null);
  check('nav across pages: marked on one, unmarked on another menu page', navConsistency([{ here: '/a/', links: ['/a/', '/b/'], marked: ['/a/'] }, { here: '/b/', links: ['/a/', '/b/'], marked: [] }]).length === 1);
  check('nav across pages: never marked is not judged', navConsistency([{ here: '/a/', links: ['/a/'], marked: [] }]).length === 0);
  check('nav across pages: a page outside the menu may be unmarked', navConsistency([{ here: '/a/', links: ['/a/'], marked: ['/a/'] }, { here: '/item/', links: ['/a/'], marked: [] }]).length === 0);
  check('nav: home marked only on home', navVerdict('/', ['/', '/a/'], ['/']) === null && navVerdict('/a/', ['/', '/a/'], ['/'])?.code === 'SW-NAV-CURRENT');
  const plan = shipPlan('site/portal', '2', true);
  check('ship: audit, upload, clear, walk in that order', plan.map((x) => x.step).join() === 'audit,upload,clear,walk' && /pac pages upload --path "site\/portal" --modelVersion 2/.test(plan[1].cmd) && /audit-pages-permissions\.py" "site\/portal"/.test(plan[0].cmd));
  check('ship: --no-clear skips the cache step', shipPlan('x', '2', false).every((x) => x.step !== 'clear'));
  check('contrast: pale halo on white is about 1.2:1', Math.abs(contrast('rgb(225, 239, 250)', 'rgb(255, 255, 255)') - 1.2) < 0.1);
  check('contrast: brand blue on white passes 3:1', contrast('rgb(0, 102, 179)', 'rgb(255, 255, 255)') > 3);
  check('confirm: filled column empty -> SW-FILLED reason', judgeRows([{ app_source: null, modifiedon: '2026-10-05T12:01:00Z' }], { filled: ['app_source'], changedDuringRun: false }, start, false).some((w) => /SW-FILLED/.test(w)));
  check('confirm: filled column set passes', judgeRows([{ app_source: 'Portal' }], { filled: ['app_source'], changedDuringRun: false }, start, false).length === 0);
  check('confirm url selects filled columns', /\$select=app_source,modifiedon,createdon/.test(confirmUrl('https://o', { table: 't', filter: 'a eq 1', filled: ['app_source'] })));
  check('confirm with only filled is accepted', validateScenario({ baseUrl: 'https://x', orgUrl: 'https://o', confirm: [{ table: 't', filter: 'a eq 1', filled: ['b'] }] }).length === 0);

  // The site's own consent: accepted only when it is the site app asking for sign-in and profile.
  const consent = (app, lines) => `Microsoft\nuser@example.com\nPermissions requested\n${app}\nunverified\nThis app would like to:\n${lines.join('\n')}\nAccept\nCancel`;
  check('consent: site app, profile only -> accept', consentVerdict(consent('Portals-Work Portal', ['Sign you in and read your profile']), 'Work Portal').accept === true);
  check('consent: not a consent page -> nothing', consentVerdict('Pick an account').accept === false && consentVerdict('Pick an account').reason === null);
  check('consent: another app -> left for a person', /not a Power Pages/.test(consentVerdict(consent('Contoso Mail Helper', ['Sign you in and read your profile'])).reason || ''));
  check('consent: another site -> left for a person', /is not the site/.test(consentVerdict(consent('Portals-Other Site', ['Sign you in and read your profile']), 'Work Portal').reason || ''));
  check('consent: wider permissions -> left for a person', /more than sign-in/.test(consentVerdict(consent('Portals-Work Portal', ['Sign you in and read your profile', 'Read and write all users\' full profiles'])).reason || ''));
  check('consent: admin approval -> left for a person', /administrator/.test(consentVerdict(consent('Portals-Work Portal', ['Need admin approval'])).reason || ''));

  // Text-transform and the site session.
  check('text: innerText of an uppercase heading misses with a plain includes (the trap)', !'TOTAL COST OF INVESTMENTS'.includes('Total Cost of Investments'));
  check('text: case-insensitive match finds it', textHas('Summary\nTOTAL COST OF INVESTMENTS\n', 'Total Cost of Investments') && !textHas('Total', 'Totals'));
  const site = 'https://work.example.com';
  check('session: sign-in link on the site -> signed-out', sessionState(site + '/home/', site, 1) === 'signed-out');
  check('session: no sign-in link -> signed-in', sessionState(site + '/home/', site, 0) === 'signed-in');
  check('session: on Entra -> sign-in-page', sessionState('https://login.microsoftonline.com/x/oauth2', site, 0) === 'sign-in-page');
  check('session: another host -> elsewhere', sessionState('https://other.example.com/', site, 0) === 'elsewhere');
  check('session: signed out -> SW-SIGNED-OUT naming the signin command', signedOutFinding('signed-out', 'a.signin', site)?.code === 'SW-SIGNED-OUT' && /signin --url https:\/\/work\.example\.com/.test(signedOutFinding('signed-out', 'a.signin', site).msg));
  check('session: signed in -> no finding', signedOutFinding('signed-in', 'a', site) === null);
  check('scenario: signInSelector false accepted, a number refused, signInPath must start with /',
    validateScenario({ baseUrl: site, signInSelector: false }).length === 0 && validateScenario({ baseUrl: site, signInSelector: 3 }).length === 1 && validateScenario({ baseUrl: site, signInPath: 'home' }).length === 1);

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
  // Layout: spill and cover, and their fixes.
  const lay = async (path) => run({ baseUrl: base, widths: [390], pages: [{ path }] });
  const spill = await lay('/spill'), spillOk = await lay('/spill-ok'), covered = await lay('/covered'), coveredOk = await lay('/covered-ok');
  check('spill into the next chip -> SW-OVERFLOW, once (innermost)', spill.rows.filter((r) => r.code === 'SW-OVERFLOW').length === 1 && !codes(spill).has('SW-SCROLL'));
  check('spill inside a scroller or behind an ellipsis passes', codes(spillOk).size === 0);
  check('fixed bar over a field -> SW-COVERED', codes(covered).has('SW-COVERED'));
  check('scroll-padding-bottom fixes SW-COVERED', codes(coveredOk).size === 0);
  if (codes(coveredOk).size) log(table(coveredOk.rows.filter((r) => r.code)));
  check('layoutChecks false turns both off', codes(await run({ baseUrl: base, widths: [390], layoutChecks: false, pages: [{ path: '/spill' }, { path: '/covered' }] })).size === 0);
  check('layoutIgnore skips a subtree', !codes(await run({ baseUrl: base, widths: [390], layoutIgnore: ['div'], pages: [{ path: '/spill' }] })).has('SW-OVERFLOW'));

  // Menu marker, focus, double press, repeated request.
  const one = async (path) => run({ baseUrl: base, widths: [1440], pages: [{ path }] });
  check('menu marks the wrong page -> SW-NAV-CURRENT', codes(await one('/navwrong')).has('SW-NAV-CURRENT'));
  check('menu marks the right page passes', !codes(await one('/navok')).has('SW-NAV-CURRENT'));
  check('marker on one page, missing on another -> SW-NAV-CURRENT', codes(await run({ baseUrl: base, widths: [1440], pages: [{ path: '/navok' }, { path: '/navnone' }] })).has('SW-NAV-CURRENT'));
  const fw = await one('/focusweak');
  check('pale 3px halo -> SW-FOCUS', codes(fw).has('SW-FOCUS'));
  if (!codes(fw).has('SW-FOCUS')) log(table(fw.rows));
  check('2px brand outline passes', !codes(await one('/focusok')).has('SW-FOCUS'));
  check('uiChecks false turns both off', codes(await run({ baseUrl: base, widths: [1440], uiChecks: false, pages: [{ path: '/navwrong' }, { path: '/focusweak' }] })).size === 0);
  const tw = (path, tag) => writer({ steps: [{ goto: path }, { fill: '#c', value: tag }, { pressTwice: '#go' }], confirm: [{ table: 'app_comments', filter: `app_body eq '${tag}'`, count: 1 }] });
  check('double press without a guard saves twice -> SW-CONFIRM', codes(await run(tw('/twice', 'T-{{runId}}-a'), dv)).has('SW-CONFIRM'));
  const once = await run(tw('/once', 'T-{{runId}}-b'), dv);
  check('double press with a guard saves once', codes(once).size === 0);
  if (codes(once).size) log(table(once.rows.filter((r) => r.code)));
  const rep3 = await run({ baseUrl: base, widths: [1440], apiFrom: '/ok', api: [{ name: 'repeat', path: '/_api/items(3)', expectStatus: 200, repeat: 3 }] });
  check('repeat sends the request three times at once', rep3.rows.some((r) => /3 at once: 200, 200, 200/.test(r.note)));

  // The site session, and text under text-transform.
  const sess = await run({ baseUrl: base, widths: [1440], signInPath: '/site/home', pages: [{ path: '/site/home', expectText: ['SCOPED-ITEM'], expectNoText: ['Not found'] }] });
  check('signed out of the site: signs in through its own link, then judges pages', codes(sess).size === 0 && /own sign-in link/.test(sess.rows.find((r) => r.step === 'site session')?.note || ''));
  if (codes(sess).size) log(table(sess.rows.filter((r) => r.code)));
  const dead = await run({ baseUrl: base, widths: [1440], signInPath: '/dead/home', signInTimeout: 3, pages: [{ path: '/dead/home', expectText: ['SCOPED-ITEM'] }] });
  check('a sign-in that does not take -> SW-SIGNED-OUT once, no page-level misses, exit 2', dead.rows.filter((r) => r.code === 'SW-SIGNED-OUT').length === 1 && !codes(dead).has('SW-TEXT') && exitCode(dead) === 2);
  const upper = await run({ baseUrl: base, widths: [1440], signInSelector: false, pages: [{ path: '/dead/home', expectText: ['Total cost of work'] }, { path: '/dead/home', expectNoText: ['total COST'] }] });
  check('signInSelector false skips the check', /not checked/.test(upper.rows.find((r) => r.step === 'site session')?.note || '') && !codes(upper).has('SW-SIGNED-OUT'));
  check('uppercase heading: expectText holds, expectNoText catches it in any case', upper.rows.filter((r) => r.code === 'SW-TEXT').length === 1 && upper.rows.some((r) => r.code === 'SW-TEXT' && /shows "total COST"/.test(r.msg)));
  const upStep = await run({ baseUrl: base, widths: [1440], signInSelector: false, steps: [{ goto: '/dead/home' }, { expectText: 'Total cost of work' }] });
  check('uppercase heading: an expectText step holds', codes(upStep).size === 0);

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
else if (cmd === 'ship') await cmdShip();
else { log(HELP); process.exit(cmd && cmd !== '--help' && cmd !== '-h' ? 2 : 0); }
