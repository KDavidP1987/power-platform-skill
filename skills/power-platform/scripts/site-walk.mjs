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
//
// Scenario (see assets/scenarios/site-walk.example.json):
//   baseUrl        the site, e.g. https://<site>.powerappsportals.com
//   widths         viewport widths, default [1440, 390]; the sideways-scroll check runs after
//                  every width change and on every page
//   signInPattern  regex for sign-in URLs (default: Entra, b2c, /SignIn, /Account/Login)
//   writes         true when the steps create or change data
//   pages          [{path, name?, expectText?: [..], expectSelector?: [..], screenshotSelector?}]
//                  visited at every width; a screenshot named <name>-<width>.png when name is set
//   steps          [{goto}|{fill, value}|{click}|{select, value}|{press, selector?}|{expectText}|
//                   {expectNoText}|{expectUrl}|{wait}|{screenshot}]  performed once, at the first width
//   api            [{name?, method?, path, body?, expectStatus?, expectNoRows?}]  sent from inside the
//                  signed-in page with fetch, carrying the site's anti-forgery token from
//                  /_layout/tokenhtml. expectStatus: a number, a list, or "2xx" / "4xx".
//   signedOut      [{path, mustNotShow?: [..], expectNoRows?}]  in a fresh context with no cookies:
//                  a page must redirect to sign-in or show none of mustNotShow (no mustNotShow: it
//                  must redirect); an /_api path must return no rows
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
//
// Exit: 0 clean; 1 findings; 2 nothing examined (no browser, empty scenario, scenario refused) -
// NOT a pass. Screenshots are of the page only (never browser chrome): full-page captures of the
// document, or of screenshotSelector's element.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const verbs = ['goto', 'fill', 'click', 'select', 'press', 'expectText', 'expectNoText', 'expectUrl', 'wait', 'screenshot'];
  for (const [i, st] of (s.steps || []).entries()) if (!verbs.some((v) => v in st)) errs.push(`steps[${i}] has none of ${verbs.join(', ')}`);
  for (const [i, o] of (s.signedOut || []).entries()) if (typeof o.path !== 'string') errs.push(`signedOut[${i}].path is missing`);
  return errs;
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
  const lines = rows.map((r) => `${r.step.slice(0, 56).padEnd(w1)}  ${String(r.width ?? '-').padStart(5)}  ${r.code ? r.code + ' ' + r.msg : 'ok'}`);
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
export async function runWalk(s, { ctx, freshContext, out = null, allowWrites = false }) {
  const rows = [];
  const add = (step, width, f) => rows.push({ step, width, code: f ? f.code : null, msg: f ? f.msg : '' });
  const errs = validateScenario(s);
  if (errs.length) { errs.forEach((e) => add('scenario: ' + e, null, { code: 'SW-STEP', msg: 'scenario refused' })); return { examined: 0, rows, refused: true }; }
  if (s.writes && !allowWrites) { add('scenario declares "writes": true', null, { code: 'SW-STEP', msg: 'refused without --allow-writes' }); return { examined: 0, rows, refused: true }; }
  const signIn = new RegExp(s.signInPattern || DEFAULT_SIGNIN, 'i');
  const widths = s.widths?.length ? s.widths : [1440, 390];
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

  for (const [wi, width] of widths.entries()) {
    await page.setViewportSize({ width, height: 900 });
    if (page.url() !== 'about:blank') add(`resize to ${width}`, width, await scrollCheck(page));
    for (const p of s.pages || []) {
      const label = `page ${p.name || p.path}`;
      if (!(await visit(p.path, label, width))) continue;
      const body = await page.locator('body').innerText().catch(() => '');
      let f = null;
      for (const t of p.expectText || []) if (!body.includes(t)) { f = { code: 'SW-TEXT', msg: `missing text ${JSON.stringify(t)}` }; break; }
      if (!f) for (const sel of p.expectSelector || []) if (!(await page.locator(sel).count())) { f = { code: 'SW-TEXT', msg: `missing ${sel}` }; break; }
      for (const t of p.expectNoText || []) if (!f && body.includes(t)) f = { code: 'SW-TEXT', msg: `shows ${JSON.stringify(t)}` };
      add(label, width, f);
      add(label + ': sideways scroll', width, await scrollCheck(page));
      await shot(page, out, p.name, width, p.screenshotSelector);
    }
    if (wi === 0) {
      for (const [i, st] of (s.steps || []).entries()) {
        const label = `step ${i + 1}: ` + Object.entries(st).map(([k, v]) => `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ').slice(0, 50);
        const to = Number(st.timeout || 15000);
        try {
          if ('goto' in st) { if (!(await visit(st.goto, label, width))) continue; add(label, width, await scrollCheck(page)); continue; }
          if ('fill' in st) await page.locator(st.fill).first().fill(String(st.value ?? ''), { timeout: to });
          else if ('select' in st) await page.locator(st.select).first().selectOption(String(st.value), { timeout: to });
          else if ('click' in st) { await page.locator(st.click).first().click({ timeout: to }); await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); }
          else if ('press' in st) { if (st.selector) await page.locator(st.selector).first().press(st.press); else await page.keyboard.press(st.press); await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); }
          else if ('wait' in st) await page.waitForTimeout(Number(st.wait));
          else if ('screenshot' in st) await shot(page, out, st.screenshot, width, st.selector);
          else if ('expectText' in st) {
            const ok = await page.getByText(st.expectText, { exact: false }).first().waitFor({ timeout: Number(st.timeout || 10000) }).then(() => true, () => false);
            examined++; add(label, width, ok ? null : { code: 'SW-TEXT', msg: `missing text ${JSON.stringify(st.expectText)}` }); continue;
          } else if ('expectNoText' in st) {
            const body = await page.locator('body').innerText().catch(() => '');
            examined++; add(label, width, body.includes(st.expectNoText) ? { code: 'SW-TEXT', msg: `shows ${JSON.stringify(st.expectNoText)}` } : null); continue;
          } else if ('expectUrl' in st) {
            examined++; add(label, width, new RegExp(st.expectUrl).test(page.url()) ? null : { code: 'SW-URL', msg: `url ${page.url()} does not match ${st.expectUrl}` }); continue;
          }
          add(label, width, null);
        } catch (e) { add(label, width, { code: 'SW-STEP', msg: e.message.split('\n')[0].slice(0, 140) }); }
      }
    }
  }

  if ((s.api || []).length) {
    const from = s.apiFrom || s.pages?.[0]?.path || '/';
    await visit(from, 'api: open ' + from, widths[0]);
    for (const a of s.api) {
      const label = 'api ' + (a.name || `${a.method || 'GET'} ${a.path}`);
      const r = await page.evaluate(async ({ path, method, body }) => {
        let token = '';
        try { const t = await (await fetch('/_layout/tokenhtml', { credentials: 'include' })).text(); token = (t.match(/value="([^"]+)"/) || [])[1] || ''; } catch { /* no token endpoint */ }
        const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', __RequestVerificationToken: token };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(path, { method, headers, credentials: 'include', body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, text: (await res.text()).slice(0, 20000), token: !!token };
      }, { path: a.path, method: (a.method || 'GET').toUpperCase(), body: a.body }).catch((e) => ({ status: 0, text: '', err: e.message }));
      examined++;
      add(label, null, r.err ? { code: 'SW-STEP', msg: r.err.split('\n')[0] } : apiVerdict(a, r.status, r.text));
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
  return { examined, rows };
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
  const report = await runWalk(s, {
    ctx, out: flag('out') && flag('out') !== true ? resolve(String(flag('out'))) : null, allowWrites: has('allow-writes'),
    freshContext: async () => { plain = plain || await plainBrowser(chromium); return plain.newContext(); },
  });
  await ctx.close(); if (plain) await plain.close();
  log(table(report.rows));
  const n = report.rows.filter((r) => r.code).length;
  const code = exitCode(report);
  log(code === 2 ? '\nNOTHING EXAMINED - not a pass.' : `\n${report.examined} check(s), ${n} finding(s).`);
  if (flag('json') && flag('json') !== true) writeFileSync(String(flag('json')), JSON.stringify({ scenario: file, ...report, exit: code }, null, 2));
  process.exit(code);
}

// ---------------------------------------------------------------------------------------------
// Selftest.

function fixtureServer() {
  const html = (title, body) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="margin:0;font-family:Arial">${body}</body></html>`;
  const signedIn = (req) => /(^|;\s*)sid=1/.test(req.headers.cookie || '');
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, ...extra }); res.end(body); };
    const json = (code, o) => send(code, 'application/json', JSON.stringify(o));
    const p = decodeURIComponent(u.pathname);
    if (p === '/ok') return send(200, 'text/html', html('ok', '<h1>Work items</h1><p>DEMO-1001 Fix the thing</p><form><input id="c"><button id="post" type="button" onclick="document.getElementById(\'out\').textContent=\'Posted: \'+document.getElementById(\'c\').value">Post</button></form><p id="out"></p>'));
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
  const writes = await run({ baseUrl: base, writes: true, pages: [{ path: '/ok' }] });
  check('writes refused without --allow-writes (exit 2)', exitCode(writes) === 2);
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
