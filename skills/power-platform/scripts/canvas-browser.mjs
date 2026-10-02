#!/usr/bin/env node
// canvas-browser.mjs - drive Power Apps Studio and the published canvas player with Playwright.
//
// Part of the power-platform Agent Skill. A canvas app has no test framework: the published
// app is the test harness, and a browser is the only way to reach it. This driver makes that
// repeatable - scenarios are JSON, so a verification can be reviewed, diffed and re-run.
//
// Setup:   npm i -D playwright        (drives your installed Chrome via channel 'chrome')
//          No Chrome? use --channel msedge, or `npx playwright install chromium` then --channel chromium.
// Config:  scripts/canvas-app.json    {"environmentId": "...", "appId": "...", "appName": "...",
//                                       "environmentUrl": "https://<org>.crm.dynamics.com",
//                                       "dataverseTokenCommand": "<prints a bearer token for that URL>"}
//          or --config <path>. Nothing about a specific app is written into this file.
//          The token command is how a walk CONFIRMS its write in Dataverse; for example
//          az account get-access-token --resource https://<org>.crm.dynamics.com --query accessToken -o tsv
//          (or set DATAVERSE_TOKEN). The token is used for the checks and never printed or saved.
//
// Usage:
//   node canvas-browser.mjs login                  sign in once (headed; MFA included)
//   node canvas-browser.mjs check                  is the saved profile still signed in
//   node canvas-browser.mjs play [--screen NAME]   open the PUBLISHED app, capture, report console
//   node canvas-browser.mjs walk <scenario.json>   PERFORM a task and assert the result
//   node canvas-browser.mjs studio                 open Studio in EDIT mode and hold it open
//   node canvas-browser.mjs keys [combo]           reattach to Studio: report mode / send keys
//   node canvas-browser.mjs save                   click Studio's Save button (not Ctrl+S), read "Saved: <time>"
//   node canvas-browser.mjs publish [--reload-first]  publish the saved app to the player
//   node canvas-browser.mjs close-studio           leave the editor through Back (frees the lock),
//                                                  then quit the held browser (frees the profile)
//   node canvas-browser.mjs shot <url> <name>      navigate anywhere, screenshot + aria dump
//   node canvas-browser.mjs lint <scenario.json>   check a scenario's verbs without a browser
//   node canvas-browser.mjs confirm <scenario.json> [--since <ISO time>]
//                                                  run only the scenario's Dataverse checks (no browser)
//   node canvas-browser.mjs doctor                 check every UI anchor in assets/selectors.json against a
//                                                  LIVE Studio and player (needs login); exit 0 ok, 9 stale
//   node canvas-browser.mjs --selftest             prove the scenario linter rejects bad steps
//
// Flags: --config <path>  --profile <dir>  --out <dir>  --headless  --keep-open  --channel <chrome|msedge|chromium>
//        --timeout <ms>   --port <n>  --settle <ms>  --continue-on-fail  --trace
//        --fresh          delete the player's IndexedDB/Cache Storage before loading (stale build)
//        --allow-writes   required to walk a scenario that declares "writes": true
//        --keep-browser   close-studio: release the edit lock but leave the browser running
//        --selectors <path>  UI anchor table (default: the skill's assets/selectors.json)
//        --player-only | --studio-only | --record   doctor: limit the surfaces / write lastVerified dates

// Playwright is loaded lazily so `lint` and `--selftest` run without it installed.
let chromium = null;
async function pw() {
  if (!chromium) {
    try { ({ chromium } = await import('playwright')); }
    catch {
      if (cmd === 'doctor') console.error('doctor: CANNOT VERIFY any selector - no browser can run here. This is NOT a pass.');
      console.error([
        'Playwright is not installed, so no browser check can run. Nothing has been verified.',
        '  Install it in this repo (ask the user first; it changes package.json):',
        '    npm i -D playwright            # drives the Chrome already installed on this machine',
        '  No Chrome? Use Edge with --channel msedge, or download a bundled browser:',
        '    npx playwright install chromium   # then pass --channel chromium',
        '  `lint` and `--selftest` do not need Playwright.',
      ].join('\n'));
      process.exit(8);
    }
  }
  return chromium;
}
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes('--' + name);
const CHANNEL = String(flag('channel', 'chrome'));
const log = (...a) => console.log(...a);

// --- UI anchors ------------------------------------------------------------------------------
// Every selector, text anchor, title marker and URL shape this driver relies on, in ONE table.
// Microsoft changes Studio and the player without notice; when something stops resolving, fix
// assets/selectors.json (and these defaults), then prove it with `doctor`. These compiled-in
// defaults are the fallback when the file is missing or unreadable; a file entry overrides the
// fields it names. Keep the two in step - `--selftest` fails when they differ.
const SELECTOR_DEFAULTS = {
  'portal.makerHome':         { surface: 'portal', kind: 'template', value: 'https://make.powerapps.com/', check: 'required' },
  'portal.makerUrl':          { surface: 'portal', kind: 'regex', pattern: 'make\\.powerapps\\.com', flags: '', check: 'required' },
  'portal.signedInUrl':       { surface: 'portal', kind: 'regex', pattern: 'make\\.powerapps\\.com/(environments|e/|home)', flags: '', check: 'required' },
  'portal.signInUrl':         { surface: 'portal', kind: 'regex', pattern: 'login\\.microsoftonline\\.com|signin', flags: 'i', check: 'conditional' },
  'portal.signInInput':       { surface: 'portal', kind: 'css', value: 'input[name="loginfmt"], #i0116', check: 'conditional' },
  'portal.playerUrl':         { surface: 'player', kind: 'template', value: 'https://apps.powerapps.com/play/e/{environmentId}/a/{appId}', check: 'required' },
  'portal.studioUrl':         { surface: 'studio', kind: 'template', check: 'required',
    value: 'https://make.powerapps.com/e/{environmentId}/canvas/?action=edit&app-id=/providers/Microsoft.PowerApps/apps/{appId}' },
  'player.controlAttribute':  { surface: 'player', kind: 'attribute', value: 'data-control-name', check: 'required' },
  'player.consentAllow':      { surface: 'player', kind: 'role', role: 'button', name: '^allow$', flags: 'i', check: 'conditional' },
  'player.staleBanner':       { surface: 'player', kind: 'text', pattern: 'old version of this app', flags: 'i', check: 'conditional' },
  'player.staleRefresh':      { surface: 'player', kind: 'role', role: 'button', name: '^refresh$', flags: 'i', check: 'conditional' },
  'player.batchUrl':          { surface: 'player', kind: 'regex', pattern: '/api/data/v9\\.\\d/\\$batch', flags: '', check: 'conditional' },
  'studio.titleEditing':      { surface: 'studio', kind: 'regex', pattern: '\\(Editing\\)', flags: 'i', check: 'required' },
  'studio.titleReadOnly':     { surface: 'studio', kind: 'regex', pattern: '\\(Read-only\\)', flags: 'i', check: 'conditional' },
  'studio.authoringFrameUrl': { surface: 'studio', kind: 'regex', pattern: 'authoring\\..*powerapps\\.com', flags: '', check: 'required' },
  'studio.saveButton':        { surface: 'studio', kind: 'css', value: 'button[aria-label^="Save" i]', check: 'required' },
  'studio.saveFlyout':        { surface: 'studio', kind: 'anyOf', check: 'required', anyOf: [
    { kind: 'css', value: 'button[aria-haspopup][aria-label*="save" i]:not([aria-label="Save" i]):not([aria-label^="Save (" i])' },
    { kind: 'css', value: 'button[aria-label*="more save" i]' },
    { kind: 'css', value: 'button[aria-label*="save options" i]' }] },
  'studio.savedStamp':        { surface: 'studio', kind: 'regex', pattern: '\\bSaved:[ \\t]*([^\\n]{1,48})', flags: 'i', check: 'required' },
  'studio.publishButton':     { surface: 'studio', kind: 'css', value: 'button[aria-label^="Publish" i]', check: 'required' },
  'studio.publishConfirm':    { surface: 'studio', kind: 'anyOf', check: 'conditional', anyOf: [
    { kind: 'role', role: 'button', name: 'publish this version', flags: 'i' },
    { kind: 'css', value: 'button:has-text("Publish this version")' },
    { kind: 'role', role: 'button', name: '^publish$', flags: 'i' }] },
  'studio.closePreview':      { surface: 'studio', kind: 'css', value: 'button[aria-label^="Close preview" i]', check: 'conditional' },
  'studio.leaveButton':       { surface: 'studio', kind: 'css', value: 'button:has-text("Leave")', check: 'conditional' },
  'studio.backButton':        { surface: 'studio', kind: 'css', value: 'button[aria-label^="Back" i]', check: 'required' },
  'studio.gotIt':             { surface: 'studio', kind: 'anyOf', check: 'conditional', anyOf: [
    { kind: 'role', role: 'button', name: '^got it$', flags: 'i' },
    { kind: 'css', value: 'button:has-text("Got it")' }] },
};
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELECTORS_PATH = resolve(String(flag('selectors', join(SKILL_DIR, 'assets', 'selectors.json'))));
const SPEC_FIELDS = ['surface', 'kind', 'value', 'pattern', 'flags', 'role', 'name', 'anyOf', 'check'];
function loadSelectors(file = SELECTORS_PATH) {
  const table = {}; const notes = [];
  let doc = null;
  try { doc = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { notes.push('selector table not loaded (' + file + ': ' + e.message.split('\n')[0] + ') - using the compiled-in defaults'); }
  const fromFile = (doc && doc.selectors) || {};
  for (const [id, d] of Object.entries(SELECTOR_DEFAULTS)) {
    const over = {};
    for (const k of [...SPEC_FIELDS, 'purpose', 'lastVerified']) if (fromFile[id] && k in fromFile[id]) over[k] = fromFile[id][k];
    table[id] = { ...d, ...over, id };
  }
  for (const id of Object.keys(fromFile)) if (!SELECTOR_DEFAULTS[id]) notes.push('unknown selector id in the table: ' + id + ' (ignored)');
  return { table, notes, file, doc };
}
const SELECTORS = loadSelectors();
const SEL = SELECTORS.table;
const rx = (id) => new RegExp(SEL[id].pattern, SEL[id].flags || '');
const css = (id) => SEL[id].value;
const tpl = (id, vars = {}) => SEL[id].value.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const specLocator = (scope, sp) => sp.kind === 'css' ? scope.locator(sp.value)
  : sp.kind === 'role' ? scope.getByRole(sp.role, { name: new RegExp(sp.name, sp.flags || '') })
  : sp.kind === 'text' ? scope.getByText(new RegExp(sp.pattern, sp.flags || '')) : null;
// Every locator shape an entry names, in order (an anyOf entry lists alternatives).
const locsOf = (scope, id) => (SEL[id].kind === 'anyOf' ? SEL[id].anyOf : [SEL[id]]).map((sp) => specLocator(scope, sp)).filter(Boolean);
const CTRL_ATTR = css('player.controlAttribute');
const CONTROL = 'div[' + CTRL_ATTR + ']';

// --- configuration -------------------------------------------------------------------------
// The app's identity is stated ONCE, in a config file every tool reads. Two tools pointed at
// different apps is a failure nobody notices until a ship goes to the wrong one.
function findConfig() {
  const explicit = flag('config');
  if (explicit) return resolve(String(explicit));
  for (const c of ['scripts/canvas-app.json', 'canvas-app.json', '../canvas-app.json', '../../scripts/canvas-app.json']) {
    if (existsSync(c)) return resolve(c);
  }
  return null;
}
const CONFIG_PATH = findConfig();
const APP = CONFIG_PATH ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
const REPO = CONFIG_PATH ? resolve(dirname(CONFIG_PATH), '..') : process.cwd();

// Outside the repo on purpose: this directory holds live tenant session cookies.
const PROFILE = resolve(String(flag('profile', join(homedir(), '.canvas-browser-profile'))));
const TIMEOUT = Number(flag('timeout', 120000));
const OUT = resolve(String(flag('out', join(REPO, 'scratchpad', 'browser'))));
const DEBUG_PORT = Number(flag('port', 9222));

const PLAYER_URL = APP.playerUrl || tpl('portal.playerUrl', APP);
const STUDIO_URL = tpl('portal.studioUrl', APP);

function needApp() {
  if (!APP.environmentId || !APP.appId) {
    log('No app configured. Create scripts/canvas-app.json with environmentId and appId,');
    log('or pass --config <path>. See assets/canvas-app.example.json in the skill.');
    process.exit(1);
  }
}

// --- browser plumbing ----------------------------------------------------------------------
async function launch(opts) {
  mkdirSync(PROFILE, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const args = ['--disable-blink-features=AutomationControlled'];
  if (opts.debugPort) args.push('--remote-debugging-port=' + opts.debugPort);
  let ctx;
  try {
    ctx = await (await pw()).launchPersistentContext(PROFILE, {
      headless: !!opts.headless,
      // 'chromium' means Playwright's own bundled build, which takes no channel.
      ...(CHANNEL === 'chromium' ? {} : { channel: CHANNEL }),
      viewport: { width: 1600, height: 1000 },
      ignoreDefaultArgs: ['--enable-automation'],   // the maker portal behaves as in a normal browser
      args,
    });
  } catch (e) {
    // A persistent profile can be held by only one Chrome. `close-studio --keep-browser` (or a
    // `studio` process still running in the background) keeps it; deleting Singleton* files
    // inside the profile did not help when tried. Recreate the profile with `login` instead.
    if (/distribution '.*' is not found|executable doesn't exist|Looks like Playwright/i.test(e.message)) {
      log(`BROWSER NOT FOUND for --channel ${CHANNEL}. Nothing has been verified.`);
      log('  Chrome or Edge already installed: pass --channel chrome or --channel msedge.');
      log('  Neither: run `npx playwright install chromium` (ask the user first), then --channel chromium.');
      process.exit(8);
    }
    if (/already in use|ProcessSingleton|existing browser session/i.test(e.message)) {
      log('PROFILE IN USE: ' + PROFILE);
      log('  Another Chrome holds this profile - usually a `studio` process still running.');
      log('  Run `close-studio` (it quits the held browser), or stop that process, then retry.');
      log('  If nothing holds it, pass --profile <new dir> and run `login` again.');
      log('  Do not infer the result of a check that could not run: report it as unverified.');
      process.exit(5);
    }
    throw e;
  }
  ctx.setDefaultTimeout(TIMEOUT);
  return ctx;
}

// Studio must stay open ACROSS processes: the compile runs elsewhere, so save/publish/close
// reattach to the same browser over CDP instead of launching one that knows nothing of the lock.
async function attach() {
  const b = await (await pw()).connectOverCDP('http://127.0.0.1:' + DEBUG_PORT);
  const ctx = b.contexts()[0];
  if (!ctx) throw new Error('no browser context on port ' + DEBUG_PORT + ' - run `studio` first');
  return { browser: b, ctx };
}

async function disableCache(page) {
  // The player caches the app package and a persistent profile keeps that cache across
  // restarts; the stale-version banner does not always appear. Remove the variable.
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  } catch { /* no CDP - ensureFresh still runs */ }
}

// --fresh: the player keeps the app package in an IndexedDB database named "PowerApps".
// Unregistering the service worker and emptying Cache Storage did NOT force a new build when
// tried; deleting the IndexedDB databases did - with no "old version" banner ever shown. Runs in
// every frame (the app frame can be on another origin). Returns how many databases were deleted.
async function clearAppCache(page) {
  let deleted = 0;
  for (const f of page.frames()) {
    try {
      deleted += await f.evaluate(async () => {
        let n = 0;
        try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch { /* none */ }
        try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* none */ }
        try {
          const dbs = indexedDB.databases ? await indexedDB.databases() : [{ name: 'PowerApps' }];
          for (const d of dbs) {
            if (!d.name) continue;
            await new Promise((res) => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = () => res(); });
            n++;
          }
        } catch { /* storage blocked */ }
        return n;
      });
    } catch { /* detached or cross-origin evaluate refused */ }
  }
  return deleted;
}

// Clearing storage re-triggers the connection consent prompt ("This app will be able to: ...").
// Left unanswered, the app loads half-initialised. Accept it, and say so in the log.
async function acceptConsent(page) {
  for (const f of page.frames()) {
    for (const c of locsOf(f, 'player.consentAllow')) {
      try {
        const allow = c.first();
        if (await allow.count() > 0 && await allow.isVisible()) {
          await allow.click({ timeout: 10000 });
          log('  accepted the connection consent prompt (expected after clearing storage)');
          return true;
        }
      } catch { /* detached */ }
    }
  }
  return false;
}

// THE APP RUNS IN AN IFRAME. The top page is Microsoft's chrome; every locator must target
// the frame that holds canvas controls. In some tenants that frame is cross-origin.
async function appFrame(page) {
  for (let i = 0; i < 60; i++) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try {
        if (await f.locator(CONTROL).count() > 0) return f;
      } catch { /* detached mid-check */ }
    }
    if (i % 3 === 2) await acceptConsent(page);   // a consent prompt holds the app back
    await page.waitForTimeout(2000);
  }
  return null;
}

// Wait for the app's own controls, never for networkidle: the player holds long-polls open.
async function waitForPlayer(page) {
  await page.waitForLoadState('domcontentloaded');
  const frame = await appFrame(page);
  if (!frame) return null;
  try { await frame.locator(CONTROL).first().waitFor({ state: 'visible', timeout: TIMEOUT }); }
  catch { /* return what we have */ }
  return frame;
}

// The "old version of this app" banner arrives LATE. Check before every assertion, and use
// its own Refresh button. Returns the (possibly new) frame - a refresh detaches the old one.
async function ensureFresh(page, frame) {
  const banner = locsOf(page, 'player.staleBanner')[0];
  if (await banner.count() === 0) return frame;
  log('  !! STALE PLAYER: "old version of this app" - refreshing before going further.');
  const refresh = locsOf(page, 'player.staleRefresh')[0].first();
  if (await refresh.count() > 0) await refresh.click().catch(() => page.reload({ waitUntil: 'domcontentloaded' }));
  else await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const f = await waitForPlayer(page);
  await page.waitForTimeout(6000); // let App.OnStart re-run on the new build
  log('     refreshed; now on the current build.');
  return f || frame;
}

// Screenshot for geometry, accessibility snapshot for state and identity. Always both, and
// the aria snapshot from the APP frame or it describes Microsoft's toolbar.
async function capture(page, name, frame) {
  mkdirSync(OUT, { recursive: true });
  const png = join(OUT, name + '.png');
  await page.screenshot({ path: png, fullPage: false });
  let aria = '';
  try { aria = await (frame || page).locator('body').ariaSnapshot(); }
  catch (e) { aria = '(aria snapshot failed: ' + e.message + ')'; }
  writeFileSync(join(OUT, name + '.aria.yaml'), aria, 'utf8');
  log('  captured  ' + name + '.png + .aria.yaml (' + aria.split('\n').length + ' aria lines)');
}

async function isSignedIn(page) {
  if (rx('portal.signInUrl').test(page.url())) return false;
  if (await page.locator(css('portal.signInInput')).count() > 0) return false;
  return true;
}

// Three console buckets: app errors (count), player noise (drop), environment noise (report
// separately - a TLS-inspecting proxy is not an app fault, and hiding it would be dishonest).
const PLAYER_NOISE = [
  /unload is not allowed in this document/i,
  /Can't perform a React state update on an unmounted component/i,
  /React\.createElement: type is invalid/i,
  /Failed to load resource.*404/i,
  // After --fresh deletes the Cache Storage, the player's service worker cannot update itself on
  // the next load (seen 2026-10-02). The platform's own worker, not the app.
  /Failed to update a ServiceWorker for scope .*apps\.powerapps\.com/i,
];
const ENV_NOISE = [/ERR_CERT_/i, /ERR_NETWORK_CHANGED/i, /ERR_INTERNET_DISCONNECTED/i];

function reportConsole(errors, name) {
  const notPlayer = errors.filter((e) => !PLAYER_NOISE.some((r) => r.test(e)));
  const env = notPlayer.filter((e) => ENV_NOISE.some((r) => r.test(e)));
  const real = notPlayer.filter((e) => !ENV_NOISE.some((r) => r.test(e)));
  if (errors.length) writeFileSync(join(OUT, name + '.console.log'), errors.join('\n'), 'utf8');
  if (real.length) {
    log('\n  !! ' + real.length + ' APP console error(s):');
    real.slice(0, 20).forEach((e) => log('   - ' + e.slice(0, 300)));
  } else {
    log('  console clean of app errors (' + (errors.length - real.length) + ' filtered)');
  }
  if (env.length) log('  note: ' + env.length + ' network/TLS error(s) - environment, not the app; not counted');
  return real;
}

// --trace: record which tables each $batch read touched and how many rows came back. Monitor
// is unavailable while live updates is on; this is the substitute, and a table missing from
// the trace means the query was never issued.
function attachTrace(page, sink) {
  page.on('response', async (res) => {
    if (!rx('player.batchUrl').test(res.url())) return;
    try {
      const body = await res.text();
      for (const m of body.matchAll(/"@odata\.context":"[^"#]*#([^"(/]+)[^"]*"(?:,"@odata\.count":(\d+))?/g)) {
        sink.push({ at: new Date().toISOString(), set: m[1], count: m[2] ? Number(m[2]) : null });
      }
      // A failed inner call still arrives inside an outer HTTP 200. Record each inner 4xx/5xx
      // with its error message AND the request body - the request is the only place that says
      // which query failed.
      const inner = [...body.matchAll(/HTTP\/1\.1 ([45]\d\d)[^\r\n]*/g)].map((m) => Number(m[1]));
      if (inner.length) {
        const msgs = [...body.matchAll(/"message":"((?:[^"\\]|\\.){0,300})/g)].map((m) => m[1]);
        let req = '';
        try { req = (res.request().postData() || '').slice(0, 4000); } catch { /* no body */ }
        sink.push({ at: new Date().toISOString(), set: '(FAILED inner call)', count: null, status: inner, errors: msgs, request: req });
      }
    } catch { /* body unavailable */ }
  });
}

// "On screen" = in the DOM, visible by CSS, and inside the viewport with a real box. A canvas
// app renders every control into the DOM whether or not it is inside the canvas.
async function onScreen(frame, text) {
  const inApp = await visibleIn(frame, text);
  if (inApp.ok || inApp.n > 0) return inApp;
  // Notify() banners are drawn by the player, above the app and outside its frame (seen
  // 2026-10-02: "Saved - ..." was on screen while the app frame held no such text).
  for (const f of frame.page().frames()) {
    if (f === frame) continue;
    const other = await visibleIn(f, text).catch(() => ({ ok: false, n: 0 }));
    if (other.ok) return { ok: true, why: other.why + ' (in the player\'s notification bar, outside the app frame)' };
  }
  return inApp;
}
async function visibleIn(frame, text) {
  const loc = frame.getByText(text, { exact: false });
  const n = await loc.count();
  if (n === 0) return { ok: false, n, why: 'not in the DOM at all' };
  const vp = frame.page().viewportSize() || { width: 1600, height: 1000 };
  for (let i = 0; i < Math.min(n, 8); i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const b = await el.boundingBox().catch(() => null);
    if (!b || b.width < 1 || b.height < 1) continue;
    if (b.y + b.height <= 0 || b.y >= vp.height || b.x + b.width <= 0 || b.x >= vp.width) continue;
    return { ok: true, n, why: 'visible at ' + Math.round(b.x) + ',' + Math.round(b.y) };
  }
  return { ok: false, n, why: 'in the DOM (' + n + ' match' + (n > 1 ? 'es' : '') + ') but not visible inside the canvas' };
}

// --- in-page measurements (run inside the app frame) ---------------------------------------
const MEASURE = {
  clipped: (attr) => {
    const out = []; const seen = new Set();
    for (const el of document.querySelectorAll('div,span,p')) {
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      if (/auto|scroll/.test(cs.overflowY + cs.overflowX)) continue;   // scrolls on purpose
      if (el.clientWidth < 2 || el.clientHeight < 2) continue;
      const rr = el.getBoundingClientRect();
      if (rr.bottom < 0 || rr.top > innerHeight) continue;             // below the fold
      const fs = parseFloat(cs.fontSize) || 13;
      const lh = parseFloat(cs.lineHeight) || fs * 1.4;
      const dw = el.scrollWidth - el.clientWidth;
      const hidden = Math.floor((el.scrollHeight - el.clientHeight) / lh); // whole lines, not px
      if (dw < 2 && hidden < 1) continue;
      const host = el.closest('[' + attr + ']');
      const name = host ? host.getAttribute(attr) : '(unnamed)';
      const key = name + '|' + txt.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, text: txt.slice(0, 96), dw, hidden, box: Math.round(el.clientWidth) + 'x' + Math.round(el.clientHeight) });
    }
    return out;
  },
  dead: (attr) => {
    // Declaration order is z-order: decoration declared after a control is painted over it.
    const out = [];
    for (const el of document.querySelectorAll('div[' + attr + ']')) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (el.querySelector('div[' + attr + ']')) continue;
      const hit = el.querySelector('button,[role="button"],[tabindex],input,select,textarea') ||
                  (el.matches('button,[role="button"],[tabindex]') ? el : null);
      if (!hit) continue;
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (!top || el === top || el.contains(top) || top.contains(el)) continue;
      const over = top.closest('[' + attr + ']');
      out.push({ n: el.getAttribute(attr), by: over ? over.getAttribute(attr) : '(unnamed)', txt: (el.textContent || '').trim().slice(0, 34) });
    }
    return out;
  },
  overlaps: (attr) => {
    const painted = (el, r) => {
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      return !!top && (el === top || el.contains(top) || top.contains(el));
    };
    // The box as drawn: cut to every ancestor that clips its overflow. A gallery row scrolled past
    // the gallery's edge keeps its full layout box, but none of it is on screen.
    const clipped = (el) => {
      const r = el.getBoundingClientRect();
      let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.overflowX === 'visible' && ps.overflowY === 'visible') continue;
        const q = p.getBoundingClientRect();
        if (ps.overflowX !== 'visible') { x1 = Math.max(x1, q.left); x2 = Math.min(x2, q.right); }
        if (ps.overflowY !== 'visible') { y1 = Math.max(y1, q.top); y2 = Math.min(y2, q.bottom); }
      }
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    };
    const boxes = [];
    for (const el of document.querySelectorAll('div[' + attr + ']')) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      const r = clipped(el);
      if (r.width < 2 || r.height < 2) continue;
      if (el.querySelector('div[' + attr + ']')) continue;
      const txt = (el.textContent || '').trim();
      if (!txt) continue;                     // cards are text-free rectangles behind content
      if (!painted(el, r)) continue;
      boxes.push({ name: el.getAttribute(attr), x: r.x, y: r.y, w: r.width, h: r.height, txt: txt.slice(0, 30) });
    }
    const out = [];
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a], B = boxes[b];
      const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      if (ox > 2 && oy > 2) out.push({ a: A.name, b: B.name, ox: Math.round(ox), oy: Math.round(oy), at: A.txt || B.txt });
    }
    return out;
  },
  font: () => {
    const rows = [];
    for (const el of document.querySelectorAll('div,span,p')) {
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (txt.length < 12) continue;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize);
      if (!fs) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      if (!r.width || r.height > fs * 2) continue;           // single line only
      rows.push({ ratio: r.width / (txt.length * fs), fs, bold: Number(cs.fontWeight) >= 600 });
    }
    return rows;
  },
};

// --- scenario steps --------------------------------------------------------------------------
// Verbs (combine freely in one step; they run in this order):
//   {"wait": 3000}                          settle
//   {"click": "Approve", "nth": 0}          click a control by accessible name / text (0-based nth)
//   {"type": "abc", "into": "Search"}       fill by placeholder/label, then Tab so .Value commits
//   {"select": "Closed", "nth": 1}          choose an option in the nth <select> (DropDown)
//   {"fillCell": 3, "value": "7.5"}         fill the nth text input in the frame, then Tab
//   {"expect": "Saved"}                     FAIL unless that text is visibly on screen
//   {"absent": "Delete"}                    FAIL if that text IS visibly on screen (gates)
//   {"scroll": "bottom" | 400}              does the screen scroll at all
//   {"clipcheck": "screen-name"}            measured clipped text
//   {"deadclick": "screen-name"}            interactive controls something else is painted over
//   {"overlapcheck": "screen-name"}         text-bearing controls overlapping as rendered
//   {"measurefont": true}                   rendered px per character per px of font size
//   {"capture": "name"}                     screenshot + aria snapshot
//   "mustBeClean": false                    report clip/dead/overlap findings without failing
//   "settle": 5000                          wait after click/type/select (ms)
// Scenario top level: "name", "description", "steps", and optionally
//   "build": "<stamp>"      asserted first, so the verdict names the package the player ran
//   "writes": true          the scenario saves production data; walk refuses without --allow-writes
//   "restore": "<how>"      required with writes: the revert scenario or steps that put it back
//   "confirm": [ ... ]      Dataverse checks run AFTER the steps, on every walk (required with writes):
//       {"entitySet": "app_requests", "filter": "app_number eq 'REQ-0042'",
//        "expect": {"app_status": 100000002}, "count": 1}          the row exists and holds these values
//       {"entitySet": "app_requests", "filter": "...", "absent": true}   no row matches (a gate refused)
//       "changedThisRun": true (the default when the scenario writes): every matched row's modifiedon
//       is after the walk started, so a row left over from an earlier run cannot pass the check.
async function runSteps(page, frameRef, steps, results) {
  for (const [i, step] of steps.entries()) {
    const tag = '  step ' + (i + 1) + '/' + steps.length + ' ';
    let frame = frameRef.f;
    try {
      frame = frameRef.f = await ensureFresh(page, frame);
      if (step.wait) await page.waitForTimeout(Number(step.wait));

      if (step.click) {
        // Prefer the control over its caption text: a caption is a separate text node and can
        // sit outside the hit surface - the click "succeeds" and nothing happens.
        const candidates = [
          frame.getByRole('button', { name: step.click, exact: false }),
          frame.locator(CONTROL).filter({ hasText: step.click }),
          frame.getByText(step.click, { exact: false }),
        ];
        // nth is 0-based, and a gallery keeps every row in the DOM: after a filter, the row
        // you mean is nth 0; a higher nth can hit an unpainted row that swallows the click.
        const nth = Number(step.nth || 0);
        let clicked = false;
        for (const c of candidates) {
          if (await c.count() <= nth) continue;
          const t = c.nth(nth);
          try { await t.waitFor({ state: 'visible', timeout: 15000 }); await t.click({ timeout: 15000 }); clicked = true; break; }
          catch { /* next shape */ }
        }
        if (!clicked) throw new Error('nothing clickable matched "' + step.click + '"');
        log(tag + 'click "' + step.click + '"' + (nth ? ' [nth ' + nth + ']' : '') + '  OK');
        await page.waitForTimeout(Number(step.settle || 3500));
      }

      if (step.type !== undefined) {
        // fill() then Tab. A TextInput publishes .Value on BLUR; without it the box shows the
        // text and every formula reading .Value behaves as if nothing was typed.
        let box = frame.getByPlaceholder(step.into, { exact: false }).first();
        if (await box.count() === 0) box = frame.getByLabel(step.into, { exact: false }).first();
        await box.waitFor({ state: 'visible', timeout: 30000 });
        await box.click();
        await box.fill(String(step.type));
        if (step.blur !== false) await page.keyboard.press('Tab');
        log(tag + 'type "' + step.type + '" into "' + step.into + '"  OK (blurred to commit)');
        await page.waitForTimeout(Number(step.settle || 3000));
      }

      if (step.select !== undefined) {
        // A canvas DropDown is a <select> with no accessible name, and labels repeat across
        // dropdowns - so address by index and log which one moved. selectOption fires change.
        const idx = Number(step.nth ?? 0);
        const dd = frame.locator('select').nth(idx);
        await dd.waitFor({ state: 'visible', timeout: 30000 });
        const label = (el) => (el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '');
        const before = await dd.evaluate(label);
        const labels = await dd.evaluate((el) => Array.from(el.options).map((o) => o.text));
        if (!labels.includes(step.select)) throw new Error('dropdown[' + idx + '] has no option "' + step.select + '" - it offers: ' + labels.join(', '));
        await dd.selectOption({ label: String(step.select) });
        await page.waitForTimeout(600);
        const after = await dd.evaluate(label);
        if (after !== step.select) throw new Error('dropdown[' + idx + '] still reads "' + after + '"');
        log(tag + 'select dropdown[' + idx + '] "' + before + '" -> "' + after + '"');
        results.passed.push('select:' + step.select);
        await page.waitForTimeout(Number(step.settle || 3000));
      }

      if (step.fillCell !== undefined) {
        const boxes = frame.locator('input[type="text"], input:not([type]), textarea');
        const n = Number(step.fillCell);
        if (await boxes.count() <= n) throw new Error('no text input at index ' + n);
        const box = boxes.nth(n);
        const before = await box.inputValue().catch(() => '');
        await box.click({ timeout: 15000 });
        await box.fill(String(step.value));
        await page.keyboard.press('Tab');
        log(tag + 'cell[' + n + '] "' + before + '" -> "' + step.value + '"  (blurred to commit)');
        await page.waitForTimeout(Number(step.settle || 6000));
      }

      if (step.expect) {
        const v = await onScreen(frame, step.expect);
        if (!v.ok) throw new Error('"' + step.expect + '" is not on screen: ' + v.why);
        log(tag + 'expect "' + step.expect + '"  ON SCREEN');
        results.passed.push(step.expect);
      }

      if (step.absent) {
        const v = await onScreen(frame, step.absent);
        if (v.ok) throw new Error('text that must NOT be visible is on screen: "' + step.absent + '"');
        log(tag + 'absent "' + step.absent + '"  CONFIRMED (' + v.why + ')');
        results.passed.push('absent:' + step.absent);
      }

      if (step.scroll !== undefined) {
        const before = await frame.evaluate(() => { const d = document.scrollingElement || document.body; return { top: d.scrollTop, h: d.scrollHeight, c: d.clientHeight }; });
        await frame.evaluate((y) => { const d = document.scrollingElement || document.body; d.scrollTop = y === 'bottom' ? d.scrollHeight : Number(y); }, step.scroll);
        await page.waitForTimeout(1200);
        const after = await frame.evaluate(() => (document.scrollingElement || document.body).scrollTop);
        log(tag + 'scroll ' + step.scroll + ': scrollTop ' + before.top + ' -> ' + after + ' (content ' + before.h + 'px in ' + before.c + 'px'
            + (after === before.top ? ', DID NOT MOVE - screen does not scroll)' : ')'));
      }

      const sweep = async (key, fn, describe) => {
        if (!step[key]) return;
        const where = typeof step[key] === 'string' ? step[key] : 'screen';
        const found = await frame.evaluate(fn, CTRL_ATTR);
        if (found.length === 0) { log(tag + key + ' ' + where + ': clean'); results.passed.push(key + ':' + where); return; }
        log(tag + key + ' ' + where + ': ' + found.length + ' finding(s)');
        found.forEach((f) => log('      !! ' + describe(f)));
        if (step.mustBeClean !== false) results.failed.push({ step: i + 1, detail: key + ' ' + where, error: found.length + ' finding(s)' });
      };
      await sweep('clipcheck', MEASURE.clipped, (c) => c.name + '  box ' + c.box
        + (c.dw >= 2 ? '  text ' + c.dw + 'px wider than box' : '') + (c.hidden >= 1 ? '  ' + c.hidden + ' line(s) hidden' : '') + '  "' + c.text + '"');
      await sweep('deadclick', MEASURE.dead, (d) => d.n + ' "' + d.txt + '" is covered by ' + d.by);
      await sweep('overlapcheck', MEASURE.overlaps, (p) => p.a + ' over ' + p.b + ' by ' + p.ox + 'x' + p.oy + 'px "' + p.at + '"');

      if (step.measurefont) {
        const rows = await frame.evaluate(MEASURE.font);
        if (!rows.length) log(tag + 'measurefont: nothing measurable');
        for (const kind of [false, true]) {
          const rs = rows.filter((r) => r.bold === kind).map((r) => r.ratio).sort((a, b) => a - b);
          if (!rs.length) continue;
          const pct = (p) => rs[Math.min(rs.length - 1, Math.floor(rs.length * p))].toFixed(3);
          // State the unit. The ratio is per CSS px of font size; a canvas Size is in POINTS
          // (Size 11 renders at ~14.7px), so per unit of Size the same ratio is x 4/3.
          log(tag + 'measurefont ' + (kind ? 'bold' : 'regular') + ': n=' + rs.length + ' median ' + pct(0.5) + ' p90 ' + pct(0.9) + ' max ' + pct(0.999)
              + ' px/char per px of font-size  (= ' + (Number(pct(0.9)) * 4 / 3).toFixed(2) + ' px/char per unit of canvas Size, p90)');
        }
      }

      if (step.capture) await capture(page, step.capture, frame);
    } catch (e) {
      log(tag + 'FAILED: ' + e.message.split('\n')[0]);
      results.failed.push({ step: i + 1, detail: JSON.stringify(step), error: e.message.split('\n')[0] });
      await capture(page, 'FAIL-step' + (i + 1), frameRef.f).catch(() => {});
      if (!has('continue-on-fail')) break;
    }
  }
}

// --- scenario lint (no browser) ---------------------------------------------------------------
const VERBS = new Set(['wait', 'click', 'nth', 'type', 'into', 'blur', 'select', 'fillCell', 'value', 'expect', 'absent',
  'scroll', 'clipcheck', 'deadclick', 'overlapcheck', 'measurefont', 'capture', 'mustBeClean', 'settle', 'note']);
export function lintScenario(sc) {
  const errs = [];
  if (!sc || typeof sc !== 'object') return ['scenario is not an object'];
  if (!sc.name || /[\/:*?"<>|]/.test(sc.name)) errs.push('"name" is required and must be file-name safe');
  if (!Array.isArray(sc.steps) || sc.steps.length === 0) errs.push('"steps" must be a non-empty array');
  (sc.steps || []).forEach((st, i) => {
    const keys = Object.keys(st || {});
    for (const k of keys) if (!VERBS.has(k)) errs.push(`step ${i + 1}: unknown verb "${k}"`);
    if ('type' in st && !st.into) errs.push(`step ${i + 1}: "type" needs "into" (placeholder or label)`);
    if ('fillCell' in st && !('value' in st)) errs.push(`step ${i + 1}: "fillCell" needs "value"`);
    if ('nth' in st && !(Number.isInteger(st.nth) && st.nth >= 0)) errs.push(`step ${i + 1}: "nth" is a 0-based integer`);
    if (!keys.some((k) => !['nth', 'into', 'blur', 'value', 'mustBeClean', 'settle', 'note'].includes(k))) errs.push(`step ${i + 1}: no action or assertion`);
  });
  if (!(sc.steps || []).some((st) => st.expect || st.absent || st.deadclick || st.clipcheck || st.overlapcheck)) {
    errs.push('scenario asserts nothing (no expect/absent/deadclick/clipcheck/overlapcheck) - it would pass vacuously');
  }
  // Every write is production data. A scenario that saves must say so ("writes": true) and say
  // how the write is put back ("restore": a revert scenario's name, or the exact steps).
  if ('writes' in sc && typeof sc.writes !== 'boolean') errs.push('"writes" must be true or false');
  if (sc.writes === true && !(typeof sc.restore === 'string' && sc.restore.trim())) {
    errs.push('scenario declares "writes": true but no "restore" (the revert scenario or steps that put the data back)');
  }
  // The screen that wrote the row is the least independent witness: a scenario that saves must
  // say where the write lands and what it holds, and the walk checks it there on every run.
  if (sc.writes === true && !(Array.isArray(sc.confirm) && sc.confirm.some((c) => c && !c.absent))) {
    errs.push('scenario declares "writes": true but no "confirm" check that finds the written row (entitySet + filter + expect)');
  }
  if (sc.confirm !== undefined) {
    if (!Array.isArray(sc.confirm) || sc.confirm.length === 0) errs.push('"confirm" must be a non-empty array of Dataverse checks');
    else sc.confirm.forEach((c, i) => {
      const at = `confirm ${i + 1}: `;
      if (!c || typeof c !== 'object') { errs.push(at + 'not an object'); return; }
      for (const k of Object.keys(c)) if (!CONFIRM_KEYS.has(k)) errs.push(at + `unknown key "${k}"`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.entitySet || '')) errs.push(at + '"entitySet" is the Web API entity set name (plural logical name, e.g. app_requests)');
      if (!(typeof c.filter === 'string' && c.filter.trim())) errs.push(at + '"filter" is required (an OData $filter that finds exactly the rows this scenario touched)');
      if ('expect' in c && (typeof c.expect !== 'object' || Array.isArray(c.expect) || !Object.keys(c.expect).length)) errs.push(at + '"expect" is an object of column: value');
      if ('count' in c && !(Number.isInteger(c.count) && c.count >= 0)) errs.push(at + '"count" is an integer >= 0');
      if (c.absent === true && ('expect' in c || ('count' in c && c.count !== 0))) errs.push(at + '"absent" cannot be combined with "expect" or a non-zero "count"');
      if (!c.absent && !('expect' in c) && !('count' in c)) errs.push(at + 'asserts nothing: give "expect", "count" or "absent"');
    });
  }
  return errs;
}
const CONFIRM_KEYS = new Set(['entitySet', 'filter', 'select', 'expect', 'count', 'absent', 'changedThisRun', 'note']);

// --- Dataverse confirmation ------------------------------------------------------------------
// Judge the rows one check returned. Pure, so --selftest proves it without a tenant.
const SKEW_MS = 120000;   // a client clock ahead of the server must not fail a real write
export function judgeRows(rows, c, runStartMs, writes) {
  const why = [];
  if (c.absent) { if (rows.length) why.push(rows.length + ' row(s) match; expected none'); return why; }
  if ('count' in c && rows.length !== c.count) why.push(rows.length + ' row(s) match; expected ' + c.count);
  if (!('count' in c) && rows.length === 0) why.push('no row matches the filter');
  const fresh = c.changedThisRun ?? writes;
  rows.forEach((r, k) => {
    for (const [col, want] of Object.entries(c.expect || {})) {
      const got = r[col] === undefined ? undefined : r[col];
      const label = r[col + '@OData.Community.Display.V1.FormattedValue'];
      const same = got === want || (got !== undefined && got !== null && want !== null && String(got).toLowerCase() === String(want).toLowerCase())
        || (label !== undefined && String(label) === String(want));
      if (!same) why.push(`row ${k + 1}: ${col} is ${JSON.stringify(got)}${label !== undefined ? ' ("' + label + '")' : ''}, expected ${JSON.stringify(want)}`);
    }
    if (fresh && runStartMs) {
      const m = Date.parse(r.modifiedon || '');
      if (!m) why.push(`row ${k + 1}: no modifiedon returned, so this run's write cannot be told from an old row`);
      else if (m < runStartMs - SKEW_MS) why.push(`row ${k + 1}: last modified ${r.modifiedon}, before this walk started - this run did not write it`);
    }
  });
  return why;
}
function dataverseToken() {
  if (process.env.DATAVERSE_TOKEN) return process.env.DATAVERSE_TOKEN.trim();
  const command = APP.dataverseTokenCommand || process.env.DATAVERSE_TOKEN_COMMAND;
  if (!command) return null;
  const out = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, cwd: REPO });
  const lines = out.trim().split(/\r?\n/);
  return lines[lines.length - 1].trim() || null;
}
async function confirmInDataverse(checks, runStartMs, writes) {
  const base = String(APP.dataverseUrl || APP.environmentUrl || '').replace(/\/+$/, '');
  if (!base) return { cannot: 'no "environmentUrl" in the app config, so the write cannot be confirmed' };
  let token;
  try { token = dataverseToken(); }
  catch (e) { return { cannot: 'the token command failed: ' + String(e.stderr || e.message).split('\n').find((x) => x.trim()) }; }
  if (!token) return { cannot: 'no Dataverse token: add "dataverseTokenCommand" to the app config (a command that prints a bearer token for ' + base + ') or set DATAVERSE_TOKEN' };
  const results = [];
  for (const c of checks) {
    const cols = new Set([...(c.select ? String(c.select).split(',') : []), ...Object.keys(c.expect || {}), 'modifiedon'].map((x) => x.trim()).filter(Boolean));
    const url = base + '/api/data/v9.2/' + c.entitySet + '?$filter=' + encodeURIComponent(c.filter) + '&$select=' + [...cols].join(',') + '&$top=50';
    let rows = null, err = null;
    try {
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0',
        Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } });
      const body = await res.text();
      if (!res.ok) err = 'HTTP ' + res.status + ': ' + ((() => { try { return JSON.parse(body).error.message; } catch { return body.slice(0, 160); } })());
      else rows = JSON.parse(body).value || [];
    } catch (e) { err = e.message; }
    const why = err ? [err] : judgeRows(rows, c, runStartMs, writes);
    results.push({ check: c.entitySet + ' ' + c.filter, rows: rows ? rows.length : null, ok: why.length === 0, why });
  }
  return { results };
}
function logConfirmation(conf) {
  if (conf.cannot) { log('  DATAVERSE: CANNOT CONFIRM - ' + conf.cannot + '. This is NOT a pass.'); return false; }
  for (const r of conf.results) {
    log('  DATAVERSE ' + (r.ok ? 'CONFIRMED' : 'NOT CONFIRMED') + '  ' + r.check + (r.rows === null ? '' : '  (' + r.rows + ' row(s))'));
    r.why.forEach((w) => log('      !! ' + w));
  }
  return conf.results.every((r) => r.ok);
}
async function cmdConfirm() {
  const file = argv[1];
  if (!file) { log('usage: canvas-browser.mjs confirm <scenario.json> [--since <ISO time>]'); process.exitCode = 1; return; }
  const scenario = JSON.parse(readFileSync(resolve(file), 'utf8'));
  if (!Array.isArray(scenario.confirm) || !scenario.confirm.length) { log('"' + scenario.name + '" has no "confirm" checks.'); process.exitCode = 1; return; }
  const since = flag('since') ? Date.parse(String(flag('since'))) : 0;
  if (flag('since') && !since) { log('--since is not a date: ' + flag('since')); process.exitCode = 1; return; }
  log('CONFIRM: ' + scenario.name + (since ? '  (rows must have changed since ' + new Date(since).toISOString() + ')' : '  (no --since: freshness not checked)'));
  const ok = logConfirmation(await confirmInDataverse(scenario.confirm, since, !!since));
  process.exitCode = ok ? 0 : 4;
}
function cmdLint() {
  const file = argv[1];
  if (!file) { log('usage: canvas-browser.mjs lint <scenario.json>'); process.exitCode = 1; return; }
  const errs = lintScenario(JSON.parse(readFileSync(resolve(file), 'utf8')));
  log(errs.length ? errs.map((e) => 'BAD  ' + e).join('\n') : 'ok   ' + file);
  process.exitCode = errs.length ? 1 : 0;
}
// The selector table must load, name every anchor the driver uses, carry lastVerified and a
// purpose per entry, compile, and agree with the compiled-in defaults (else a missing file would
// silently change behaviour). A missing file must fall back to the defaults, with a note.
function selectorTableProblems() {
  const out = [];
  if (!SELECTORS.doc) out.push('table not loaded from ' + SELECTORS.file);
  out.push(...SELECTORS.notes.filter((n) => n.startsWith('unknown')));
  const fromFile = (SELECTORS.doc && SELECTORS.doc.selectors) || {};
  for (const id of Object.keys(SELECTOR_DEFAULTS)) {
    const f = fromFile[id];
    if (!f) { out.push(id + ' missing from the table'); continue; }
    if (!f.lastVerified) out.push(id + ' has no lastVerified');
    if (!f.purpose) out.push(id + ' has no purpose');
    for (const k of SPEC_FIELDS) if (JSON.stringify(f[k]) !== JSON.stringify(SELECTOR_DEFAULTS[id][k])) out.push(id + '.' + k + ' differs from SELECTOR_DEFAULTS');
    for (const sp of f.kind === 'anyOf' ? f.anyOf || [] : [f]) {
      try {
        if (sp.kind === 'regex' || sp.kind === 'text') new RegExp(sp.pattern, sp.flags || '');
        else if (sp.kind === 'role') new RegExp(sp.name, sp.flags || '');
        else if (!['css', 'template', 'attribute'].includes(sp.kind)) out.push(id + ': unknown kind ' + sp.kind);
      } catch (e) { out.push(id + ': ' + e.message); }
    }
  }
  const fallback = loadSelectors(join(SKILL_DIR, 'assets', '__no_such_table__.json'));
  if (fallback.doc || !fallback.notes.length || Object.keys(fallback.table).length !== Object.keys(SELECTOR_DEFAULTS).length) out.push('a missing table did not fall back to the defaults');
  const filled = tpl('portal.playerUrl', { environmentId: 'E', appId: 'A' });
  if (filled.includes('{') || !filled.endsWith('/e/E/a/A')) out.push('portal.playerUrl template did not fill: ' + filled);
  return out;
}

function selftest() {
  const good = { name: 'ok', steps: [{ click: 'Approvals', settle: 3000 }, { type: 'x', into: 'Search' }, { expect: 'Saved' }, { deadclick: 'scr' }] };
  const bad = { name: 'a/b', steps: [{ clik: 'Approvals' }, { type: 'x' }, { nth: 1 }, { click: 'Open', nth: -1 }] };
  const goodWrite = { name: 'edit-then-revert', writes: true, restore: 'revert-edit', steps: [{ fillCell: 0, value: '7.5' }, { expect: 'Saved' }],
    confirm: [{ entitySet: 'app_timeentries', filter: "app_name eq 'TEST-1'", expect: { app_hours: 7.5 }, count: 1 }] };
  const badWrite = { name: 'edit', writes: true, steps: [{ fillCell: 0, value: '7.5' }, { expect: 'Saved' }] };
  const badConfirm = { name: 'c', steps: [{ expect: 'x' }], confirm: [{ entitySet: 'bad set', filter: '', expect: {}, colour: 1 }, { entitySet: 'app_x', filter: 'a eq 1' },
    { entitySet: 'app_x', filter: 'a eq 1', absent: true, expect: { a: 1 } }] };
  const absentOnly = { name: 'w', writes: true, restore: 'r', steps: [{ expect: 'x' }], confirm: [{ entitySet: 'app_x', filter: 'a eq 1', absent: true }] };
  const g = [...lintScenario(good), ...lintScenario(goodWrite)];
  const b = [...lintScenario(bad), ...lintScenario(badWrite), ...lintScenario(badConfirm), ...lintScenario(absentOnly)];
  const want = ['file-name safe', 'unknown verb', 'needs "into"', 'no action', '0-based', 'asserts nothing', 'no "restore"', 'no "confirm"',
    'entity set name', '"filter" is required', 'unknown key', 'object of column', 'asserts nothing: give', 'cannot be combined'];
  // judgeRows: values, choice labels, counts, absence and freshness.
  const t0 = Date.parse('2026-01-01T12:00:00Z');
  const row = (o) => ({ modifiedon: '2026-01-01T12:00:30Z', ...o });
  const J = [
    ['match', judgeRows([row({ app_hours: 7.5 })], { expect: { app_hours: 7.5 }, count: 1 }, t0, true), 0],
    ['choice label', judgeRows([row({ app_status: 100000002, 'app_status@OData.Community.Display.V1.FormattedValue': 'Denied' })], { expect: { app_status: 'Denied' } }, t0, true), 0],
    ['wrong value', judgeRows([row({ app_hours: 8 })], { expect: { app_hours: 7.5 } }, t0, true), 1],
    ['no row', judgeRows([], { expect: { app_hours: 7.5 } }, t0, true), 1],
    ['count', judgeRows([row({}), row({})], { count: 1 }, t0, true), 1],
    ['absent ok', judgeRows([], { absent: true }, t0, true), 0],
    ['absent but present', judgeRows([row({})], { absent: true }, t0, true), 1],
    ['stale row', judgeRows([row({ app_hours: 7.5, modifiedon: '2025-12-31T09:00:00Z' })], { expect: { app_hours: 7.5 } }, t0, true), 1],
    ['clock skew tolerated', judgeRows([row({ modifiedon: '2026-01-01T11:59:00Z' })], { count: 1 }, t0, true), 0],
    ['read-only walk ignores age', judgeRows([row({ modifiedon: '2025-01-01T00:00:00Z' })], { count: 1 }, t0, false), 0],
  ];
  const judged = J.filter(([, w, n]) => w.length !== n).map(([k, w]) => k + ' -> ' + JSON.stringify(w));
  const missing = want.filter((w) => !b.some((e) => e.includes(w)));
  const sel = selectorTableProblems();
  const ok = g.length === 0 && missing.length === 0 && sel.length === 0 && judged.length === 0;
  log(ok ? `selftest ok: bad scenarios -> ${b.length} findings, good scenarios -> 0, ${J.length} Dataverse confirmation cases judged, selector table: ${Object.keys(SEL).length} entries valid and in step with the defaults`
         : `selftest FAILED: good -> [${g.join('; ')}], missing on bad -> [${missing.join(', ')}], confirmation -> [${judged.join('; ')}], selector table -> [${sel.join('; ')}]`);
  process.exit(ok ? 0 : 1);
}

// --- commands --------------------------------------------------------------------------------
async function cmdLogin() {
  const ctx = await launch({ headless: false });
  const page = await ctx.newPage();
  log('Opening the maker portal. Sign in with your work account (MFA included).');
  await page.goto(tpl('portal.makerHome'), { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForURL(rx('portal.signedInUrl'), { timeout: 300000 });
    log('SIGNED IN. Profile saved to ' + PROFILE + ' (keep it out of any repo: it holds session cookies).');
  } catch { log('Did not reach the maker portal in time. Re-run `login` and finish the prompts.'); }
  if (!has('keep-open')) await ctx.close();
}

async function cmdCheck() {
  const ctx = await launch({ headless: has('headless') });
  const page = await ctx.newPage();
  await page.goto(tpl('portal.makerHome'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const ok = await isSignedIn(page);
  log(ok ? 'SIGNED IN (the saved profile is still good)' : 'NOT SIGNED IN - run: node canvas-browser.mjs login');
  await capture(page, 'check');
  await ctx.close();
  process.exitCode = ok ? 0 : 2;
}

async function openPlayer(ctx, errors, trace) {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  if (trace) attachTrace(page, trace);
  await disableCache(page);
  await page.goto(PLAYER_URL, { waitUntil: 'domcontentloaded' });
  if (!(await isSignedIn(page))) return { page, frame: null, signedIn: false };
  if (has('fresh')) {
    // Let the frames attach so their origins can be cleared too, then clear and reload.
    await page.waitForTimeout(8000);
    const n = await clearAppCache(page);
    log('  --fresh: deleted ' + n + ' IndexedDB database(s) and the Cache Storage; reloading');
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  let frame = await waitForPlayer(page);
  await page.waitForTimeout(Number(flag('settle', 8000)));   // let App.OnStart settle
  if (frame) frame = await ensureFresh(page, frame);
  return { page, frame, signedIn: true };
}

function writeTrace(trace, name) {
  if (!trace || !trace.length) return;
  writeFileSync(join(OUT, name + '.odata-trace.json'), JSON.stringify(trace, null, 2), 'utf8');
  const by = {};
  for (const t of trace) by[t.set] = (by[t.set] || 0) + 1;
  log('  OData reads by entity set: ' + Object.entries(by).map(([k, v]) => k + ' x' + v).join(', '));
  const failed = trace.filter((t) => t.status);
  if (failed.length) {
    log('  !! ' + failed.length + ' $batch response(s) carried a FAILED inner call (outer status 200):');
    failed.slice(0, 5).forEach((t) => log('     ' + t.status.join(',') + '  ' + (t.errors[0] || '(no message)').slice(0, 200)));
    log('     request bodies are in ' + name + '.odata-trace.json');
  }
  log('  A table missing from this list was never queried (dead source or an earlier throw).');
}

async function cmdPlay() {
  needApp();
  const ctx = await launch({ headless: has('headless') });
  const errors = []; const trace = has('trace') ? [] : null;
  log('Opening the PUBLISHED app (what a user gets):\n  ' + PLAYER_URL);
  const { page, frame, signedIn } = await openPlayer(ctx, errors, trace);
  if (!signedIn) { log('NOT SIGNED IN - run `login` first.'); await ctx.close(); process.exitCode = 2; return; }
  log(frame ? 'App shell rendered.' : 'App frame did NOT appear - capturing anyway.');
  const name = String(flag('screen', 'player-home'));
  await capture(page, name, frame);
  reportConsole(errors, name);
  writeTrace(trace, name);
  if (has('keep-open')) { log('--keep-open: Ctrl+C when done.'); await page.waitForTimeout(3600000); }
  await ctx.close();
  process.exitCode = frame ? 0 : 3;
}

async function cmdWalk() {
  needApp();
  const file = argv[1];
  if (!file) { log('usage: canvas-browser.mjs walk <scenario.json>'); process.exitCode = 1; return; }
  const scenario = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const problems = lintScenario(scenario);
  if (problems.length) { problems.forEach((e) => log('BAD  ' + e)); process.exitCode = 1; return; }
  if (scenario.writes === true && !has('allow-writes')) {
    // A negative test whose gate is OPEN writes a real row. Refuse unless the operator has
    // confirmed the restore (and parked any flow that would message a person about the row).
    log('REFUSED: "' + scenario.name + '" writes production data. Restore: ' + scenario.restore);
    log('  Park any flow that watches the table, then re-run with --allow-writes, then run the restore.');
    process.exitCode = 6; return;
  }
  log('SCENARIO: ' + scenario.name + (scenario.description ? '\n  ' + scenario.description : ''));
  if (scenario.writes === true) log('  WRITES production data - restore afterwards with: ' + scenario.restore);
  const ctx = await launch({ headless: has('headless') });
  const errors = []; const trace = has('trace') ? [] : null;
  const { page, frame, signedIn } = await openPlayer(ctx, errors, trace);
  if (!signedIn) { log('NOT SIGNED IN - run `login` first.'); await ctx.close(); process.exitCode = 2; return; }
  if (!frame) { log('App frame never appeared. Cannot perform the task.'); await ctx.close(); process.exitCode = 3; return; }
  const results = { passed: [], failed: [] };
  const frameRef = { f: frame };
  // Optional top-level "build": the stamp the ship wrote. Without it, a result may describe
  // the previous package while every offline check says the new one shipped.
  const steps = scenario.build ? [{ expect: scenario.build }, ...scenario.steps] : scenario.steps;
  const runStart = Date.now();
  await runSteps(page, frameRef, steps, results);
  const real = reportConsole(errors, scenario.name);
  writeTrace(trace, scenario.name);
  // Confirm where the write lands, every run: the screen saying "Saved" proves nothing about the row.
  let confirmation = null, confirmed = true;
  if (scenario.confirm) {
    await page.waitForTimeout(Number(flag('settle-dv', 4000)));
    confirmation = await confirmInDataverse(scenario.confirm, runStart, scenario.writes === true);
    confirmed = logConfirmation(confirmation);
  } else log('  note: no "confirm" checks - nothing was verified in Dataverse (a read-only walk).');
  const verdict = results.failed.length === 0 && real.length === 0 && confirmed ? 'PASS' : 'FAIL';
  log('\n=== ' + scenario.name + ' ===');
  log('  assertions passed: ' + results.passed.length + '   steps failed: ' + results.failed.length);
  results.failed.forEach((f) => log('   !! step ' + f.step + ' ' + f.detail + ' -> ' + f.error));
  log('  VERDICT: ' + verdict + '  (performed in the published app as the signed-in user;'
      + ' a restriction is unproven unless this ran as a non-admin)');
  if (!scenario.build) log('  note: no "build" stamp asserted - confirm which package the player ran.');
  if (scenario.writes === true) log('  RESTORE NOW: ' + scenario.restore + '  - then confirm the table is back at its baseline.');
  writeFileSync(join(OUT, scenario.name + '.result.json'),
    JSON.stringify({ scenario: scenario.name, at: new Date().toISOString(), runStart: new Date(runStart).toISOString(), verdict, ...results, appErrors: real, dataverse: confirmation }, null, 2), 'utf8');
  await ctx.close();
  process.exitCode = verdict === 'PASS' ? 0 : 4;
}

async function cmdStudio() {
  needApp();
  const ctx = await launch({ headless: false, debugPort: DEBUG_PORT });
  const page = await ctx.newPage();
  log('Opening Studio in EDIT mode:\n  ' + STUDIO_URL);
  await page.goto(STUDIO_URL, { waitUntil: 'domcontentloaded' });
  if (!(await isSignedIn(page))) { log('NOT SIGNED IN - run `login` first.'); await ctx.close(); process.exitCode = 2; return; }
  // The diagnosis of a stranded edit lock is one word in the title, stated nowhere else.
  log('Waiting for the editor (slow; up to 3 minutes) ...');
  let title = '';
  for (let i = 0; i < 36; i++) {
    await page.waitForTimeout(5000);
    title = await page.title();
    if (rx('studio.titleEditing').test(title) || rx('studio.titleReadOnly').test(title)) break;
  }
  log('  window title: ' + (title || '(none yet)'));
  if (rx('studio.titleReadOnly').test(title)) {
    log('  !! READ-ONLY: an edit lock is stranded (a tab was killed instead of closed via Back).');
    log('     A compile will not persist from here.');
  } else if (rx('studio.titleEditing').test(title)) {
    log('  EDIT MODE. Now connect the authoring MCP, then compile.');
    log('  The push BLANKS the screen - that is the push arriving. A RELOAD DISCARDS THE PUSH.');
    log('  Save with `canvas-browser.mjs save` (clicks the button; Ctrl+S hits the outer shell).');
  }
  await capture(page, 'studio');
  log('\nHolding Studio open. Leave with `close-studio`, never by killing the window.');
  // close-studio quits this browser once the lock is released; exit cleanly when it does, so
  // this process stops holding the persistent profile.
  ctx.on('close', () => { log('  browser closed - studio process exiting (profile released).'); process.exit(0); });
  try { await page.waitForTimeout(Number(flag('hold', 3600000))); } catch { /* closed under us */ }
  await ctx.close().catch(() => {});
}

// Studio's first-run and teaching surfaces ("Welcome to Power Apps Studio", "Did you know?", the
// read-only bubble over Override) swallow every command-bar click until dismissed.
async function dismissBubbles(frame) {
  let n = 0;
  for (const c of locsOf(frame, 'studio.gotIt')) {
    try { if (await c.first().count() > 0 && await c.first().isVisible()) { await c.first().click({ timeout: 5000 }); n++; log('  dismissed a teaching bubble ("Got it")'); } }
    catch { /* none */ }
  }
  return n;
}

// Proof of a save is the "Saved: <time>" line in Save's flyout (or a fresh session) - never the
// window title, a toast, or Preview, which shows a push that only lives in the session.
async function readSaveStamp(studio, frame) {
  const stamp = rx('studio.savedStamp');
  const grab = async () => {
    try {
      const t = await frame.evaluate(() => document.body.innerText || '');
      const m = t.match(stamp);
      return m ? m[1].trim() : null;
    } catch { return null; }
  };
  let s = await grab();
  if (s) return s;
  // The flyout chevron, never the Save button itself (a read must not save).
  for (const loc of locsOf(frame, 'studio.saveFlyout')) {
    const c = loc.first();
    try {
      if (await c.count() === 0) continue;
      await c.click({ timeout: 8000 });
      await studio.waitForTimeout(1500);
      s = await grab();
      await studio.keyboard.press('Escape').catch(() => {});
      if (s) return s;
    } catch { /* next shape */ }
  }
  return null;
}

function studioPage(ctx) {
  return ctx.pages().find((p) => rx('portal.makerUrl').test(p.url())) || ctx.pages()[0];
}

// Studio's editor is an authoring.*.powerapps.com iframe; there can be two (one a prefetch with
// no DOM). Pick the frame that CONTAINS the control, not the one whose URL looks right.
async function editorControl(page, selector) {
  for (const f of page.frames()) {
    if (!rx('studio.authoringFrameUrl').test(f.url())) continue;
    try { const c = f.locator(selector).first(); if (await c.count() > 0) return { frame: f, ctl: c }; }
    catch { /* detached */ }
  }
  return null;
}

async function cmdKeys() {
  const combo = argv[1];
  const { browser, ctx } = await attach();
  const studio = studioPage(ctx);
  const title = await studio.title();
  const mode = rx('studio.titleEditing').test(title) ? 'EDITING' : rx('studio.titleReadOnly').test(title) ? 'READ-ONLY' : 'UNKNOWN';
  log('  tab:  ' + title + '\n  mode: ' + mode);
  if (combo) {
    if (mode === 'READ-ONLY') { log('  refusing: the session is read-only.'); await browser.close(); process.exitCode = 3; return; }
    // This command never navigates or reloads - that would discard a held push.
    const hit = await editorControl(studio, css('studio.publishButton'));
    if (hit) { const b = await hit.ctl.boundingBox(); if (b) await studio.mouse.click(b.x + b.width / 2, b.y + b.height + 60); }
    await studio.keyboard.press(combo);
    log('  sent: ' + combo + '  (for saving, prefer `save` - a keystroke may reach the shell)');
    await studio.waitForTimeout(Number(flag('after', 8000)));
  }
  await browser.close(); // detaches from CDP; Studio stays open
}

async function cmdSave() {
  const { browser, ctx } = await attach();
  const studio = studioPage(ctx);
  await studio.bringToFront();
  if (rx('studio.titleReadOnly').test(await studio.title())) { log('  READ-ONLY - a save cannot persist.'); await browser.close(); process.exitCode = 3; return; }
  const hit = await editorControl(studio, css('studio.saveButton'));
  if (!hit) { log('  !! no Save button in any authoring frame.'); await capture(studio, 'save-not-found'); await browser.close(); process.exitCode = 4; return; }
  await dismissBubbles(hit.frame);
  if (await hit.frame.locator(css('studio.closePreview')).count() > 0) {
    log('  !! Studio is in PREVIEW. A push that landed while in Preview was lost on Save twice when measured;');
    log('     exit Preview, read the change back in the formula bar, then save.');
  }
  const before = await readSaveStamp(studio, hit.frame);
  // A REAL click (trusted event, actionability checks). element.click() through evaluate() was
  // measured to do nothing on Studio's command bar while reporting success.
  await hit.ctl.click({ timeout: 20000 });
  log('  clicked Save; waiting for it to land ...');
  await studio.waitForTimeout(Number(flag('after', 25000)));
  const after = await readSaveStamp(studio, hit.frame);
  await capture(studio, 'save-after');
  if (after && after !== before) {
    log('  SAVE LANDED: "Saved: ' + after + '"' + (before ? '  (was "' + before + '")' : ''));
  } else if (after && after === before) {
    log('  !! "Saved: ' + after + '" did not move. Studio saw nothing to save: the change may live only in the');
    log('     co-authoring session (was Studio in Preview when it arrived?). Treat the save as NOT done.');
    process.exitCode = 7;
  } else {
    log('  !! could not read "Saved: <time>" from the Save flyout - open it by hand. Until then the save is UNPROVEN.');
  }
  log('  Independent proof: a FRESH Studio session, or a pac canvas download after publish.');
  await browser.close();
}

async function cmdPublish() {
  const { browser, ctx } = await attach();
  const studio = studioPage(ctx);
  await studio.bringToFront();
  if (has('reload-first')) {
    // Publish was measured inert (dialog opened, confirm clicked, nothing published) in a tab
    // that had carried a co-authoring push, and worked first time after a reload. Safe ONLY
    // after the save has landed and the push session is released - a reload discards a held push.
    log('  --reload-first: reloading Studio before publishing (the save must already have landed)');
    studio.on('dialog', async (d) => { await d.accept().catch(() => {}); });
    await studio.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    let title = '';
    for (let i = 0; i < 36; i++) { await studio.waitForTimeout(5000); title = await studio.title().catch(() => ''); if (rx('studio.titleEditing').test(title) || rx('studio.titleReadOnly').test(title)) break; }
    log('  window title: ' + (title || '(none)'));
    if (!rx('studio.titleEditing').test(title)) { log('  !! not back in edit mode - not publishing.'); await browser.close(); process.exitCode = 3; return; }
  }
  // Locate by the aria-label ATTRIBUTE: getByRole did not match <button aria-label="Publish (Ctrl+Shift+P)">.
  const hit = await editorControl(studio, css('studio.publishButton'));
  if (!hit) { log('  !! no Publish button in any authoring frame.'); await capture(studio, 'publish-not-found'); await browser.close(); process.exitCode = 4; return; }
  await dismissBubbles(hit.frame);
  await hit.ctl.click({ timeout: 20000 });
  log('  clicked Publish');
  await studio.waitForTimeout(5000);
  for (const c of locsOf(hit.frame, 'studio.publishConfirm')) {
    try { if (await c.first().count() === 0) continue; await c.first().click({ timeout: 15000 }); log('  confirmed "Publish this version"'); break; }
    catch { /* next shape */ }
  }
  await studio.waitForTimeout(Number(flag('after', 30000)));
  await capture(studio, 'publish-done');
  log('  Do NOT read success from the "Publish successful" toast: it stays pinned showing a PREVIOUS');
  log('  publish\'s time. Proof is the app\'s Dataverse row (solution-aware apps):');
  log('    GET canvasapps?$filter=displayname eq \'' + (APP.appName || '<app display name>') + '\'&$select=lastpublishtime');
  log('  must move past the time you clicked. If it did not, retry with --reload-first.');
  log('  Publish ships what was SAVED when it started; the player can lag the publish by ten minutes.');
  await browser.close();
}

// Leave the editor the way a person does: exit Preview, Back, accept Leave. Returns which of
// those controls were seen, so `doctor` can report them, and whether the lock is still held.
async function leaveEditor(page) {
  const seen = { back: false, leave: false, preview: false };
  const editor = () => page.frames().find((f) => rx('studio.authoringFrameUrl').test(f.url()));
  for (let i = 0; i < 4; i++) {
    const ed = editor();
    if (!ed) break;
    const preview = ed.locator(css('studio.closePreview')).first();
    if (await preview.count() > 0) { seen.preview = true; await preview.click({ timeout: 12000 }).catch(() => {}); log('  exited preview'); await page.waitForTimeout(6000); continue; }
    const leave = ed.locator(css('studio.leaveButton')).first();
    if (await leave.count() > 0) { seen.leave = true; await leave.click({ timeout: 10000, noWaitAfter: true }).catch(() => {}); log('  clicked Leave'); }
    else {
      const back = ed.locator(css('studio.backButton')).first();
      if (await back.count() === 0) break;
      seen.back = true;
      await back.click({ timeout: 12000, noWaitAfter: true }).catch(() => {}); log('  clicked Back');
    }
    await page.waitForTimeout(9000);
    let t = ''; try { t = await page.title(); } catch { t = '(page gone)'; }
    if (!rx('studio.titleEditing').test(t)) break;
  }
  let t = ''; try { t = await page.title(); } catch { t = '(page gone)'; }
  return { ...seen, stillEditing: rx('studio.titleEditing').test(t) };
}

async function cmdCloseStudio() {
  // Back, not a killed tab: a killed tab strands the edit lock (connect then returns a bare 422).
  // Exit preview first; accept the DOM "Leave" modal; a native beforeunload dialog follows, so
  // the handler is registered BEFORE the click.
  const { browser, ctx } = await attach();
  const page = ctx.pages().find((p) => rx('portal.makerUrl').test(p.url()));
  if (!page) { log('no Studio page on the debug port'); await browser.close(); return; }
  page.on('dialog', async (d) => { await d.accept().catch(() => {}); });
  const { stillEditing } = await leaveEditor(page);
  log(stillEditing ? '  !! STILL IN THE EDITOR - close it by hand before the next compile or import' : '  edit lock released');
  // Releasing the edit lock does not release the PROFILE: the `studio` process keeps the browser
  // (and its persistent profile) open, so the next launch fails "profile is already in use".
  // Quit the browser itself unless asked not to - but never while still in the editor.
  if (!stillEditing && !has('keep-browser')) {
    try {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close');
      log('  browser quit - the persistent profile is free for the next run');
      return;
    } catch (e) { log('  note: could not quit the browser (' + e.message.split('\n')[0] + ') - stop the `studio` process by hand'); }
  }
  await browser.close();
}

// --- doctor: are the UI anchors still where the driver expects them? ---------------------------
// Opens the maker portal, the published player and Studio with the saved profile and checks every
// entry of the selector table that a normal session can show. Never passes without a live,
// signed-in session: offline, signed out or without an app configured it says CANNOT VERIFY.
// Exit: 0 every required anchor resolved, 9 at least one is stale, 2 cannot verify (offline, signed
// out, the app did not load, or a required anchor was not reached), 8 no browser.
async function cmdDoctor() {
  const results = new Map();
  const mark = (id, status, detail = '') => results.set(id, { status, detail });
  const cannot = async (why, ctx) => {
    log('doctor: CANNOT VERIFY - ' + why);
    log('  Nothing was checked against Studio or the player. This is NOT a pass; run `login`, then `doctor` again.');
    if (ctx) await ctx.close().catch(() => {});
    process.exitCode = 2;
  };
  for (const n of SELECTORS.notes) log('  note: ' + n);
  log('doctor: checking ' + Object.keys(SEL).length + ' UI anchors from ' + (SELECTORS.doc ? SELECTORS.file : 'the compiled-in defaults'));
  if (!APP.environmentId || !APP.appId) return cannot('no app configured (scripts/canvas-app.json or --config): the player and Studio cannot be opened.');
  const ctx = await launch({ headless: has('headless') });
  const page = await ctx.newPage();
  try { await page.goto(tpl('portal.makerHome'), { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { return cannot('the maker portal did not load (' + e.message.split('\n')[0] + ') - offline, proxied or blocked.', ctx); }
  await page.waitForTimeout(6000);
  if (!(await isSignedIn(page))) return cannot('the saved profile is not signed in.', ctx);
  mark('portal.makerHome', 'ok', 'loaded');
  try { await page.waitForURL(rx('portal.signedInUrl'), { timeout: 60000 }); mark('portal.signedInUrl', 'ok', 'matched ' + new URL(page.url()).pathname); }
  catch { mark('portal.signedInUrl', 'stale', 'signed in, but the portal settled on a URL the pattern does not match: ' + page.url().split('?')[0]); }
  mark('portal.makerUrl', rx('portal.makerUrl').test(page.url()) ? 'ok' : 'stale', page.url().split('?')[0]);
  await page.close().catch(() => {});

  if (!has('studio-only')) {
    log('  player: opening the published app ...');
    const pl = await ctx.newPage();
    let batches = 0;
    pl.on('response', (r) => { if (rx('player.batchUrl').test(r.url())) batches++; });
    try { await pl.goto(PLAYER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
    catch (e) { await ctx.close(); return cannot('the player did not load (' + e.message.split('\n')[0] + ').'); }
    const frame = await waitForPlayer(pl);
    if (frame) {
      const n = await frame.locator(CONTROL).count();
      mark('player.controlAttribute', 'ok', n + ' controls carry ' + CTRL_ATTR);
      mark('portal.playerUrl', 'ok', 'the app frame rendered');
    } else {
      await capture(pl, 'doctor-player').catch(() => {});
      // An app that did not load (wrong ids, no access, an error page) says nothing about the
      // selectors: report it as unverifiable, not as stale and not as a pass.
      const text = await pl.locator('body').innerText().catch(() => '');
      const childFrames = pl.frames().length - 1;
      if (childFrames === 0 && /invalid|not found|does not exist|don't have access|not authorized|error/i.test(text)) {
        const why = 'the app itself did not load (' + text.replace(/\s+/g, ' ').slice(0, 120) + ') - check the ids in the config and your access';
        mark('player.controlAttribute', 'cannot-verify', why);
        mark('portal.playerUrl', 'cannot-verify', why);
      } else {
        mark('player.controlAttribute', 'stale', 'no frame holds ' + CONTROL + ' (' + childFrames + ' child frame(s); see doctor-player.png)');
        mark('portal.playerUrl', 'stale', 'the app frame never appeared at ' + PLAYER_URL.split('?')[0]);
      }
    }
    await pl.waitForTimeout(Number(flag('settle', 8000)));
    const banner = locsOf(pl, 'player.staleBanner')[0];
    if (await banner.count() > 0) {
      mark('player.staleBanner', 'ok', 'shown on this load');
      mark('player.staleRefresh', await locsOf(pl, 'player.staleRefresh')[0].count() > 0 ? 'ok' : 'stale', 'the banner is up; its Refresh button ' + 'was looked for');
    }
    for (const f of pl.frames()) for (const c of locsOf(f, 'player.consentAllow')) {
      try { if (await c.count() > 0) mark('player.consentAllow', 'ok', 'consent prompt shown on this load'); } catch { /* detached */ }
    }
    if (batches > 0) mark('player.batchUrl', 'ok', batches + ' $batch responses matched');
    else mark('player.batchUrl', 'not-exercised', 'no response matched; STALE if this app reads Dataverse (check the network tab)');
    await pl.close().catch(() => {});
  }

  if (!has('player-only')) {
    log('  studio: opening the app in edit mode (doctor leaves through Back; it never saves or publishes) ...');
    const st = await ctx.newPage();
    st.on('dialog', async (d) => { await d.accept().catch(() => {}); });
    try { await st.goto(STUDIO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
    catch (e) { await ctx.close(); return cannot('Studio did not load (' + e.message.split('\n')[0] + ').'); }
    let title = '';
    for (let i = 0; i < 36; i++) {
      await st.waitForTimeout(5000);
      title = await st.title().catch(() => '');
      if (rx('studio.titleEditing').test(title) || rx('studio.titleReadOnly').test(title)) break;
    }
    if (rx('studio.titleEditing').test(title)) mark('studio.titleEditing', 'ok', 'title: ' + title);
    else if (rx('studio.titleReadOnly').test(title)) {
      mark('studio.titleReadOnly', 'ok', 'title: ' + title);
      mark('studio.titleEditing', 'not-exercised', 'the edit lock is held elsewhere; close that session and re-run');
    } else {
      mark('studio.titleEditing', 'stale', 'after 3 minutes the title matches neither marker: "' + title + '"');
      mark('studio.titleReadOnly', 'stale', 'see studio.titleEditing');
    }
    let hit = null;
    for (let i = 0; i < 12 && !hit; i++) { hit = await editorControl(st, css('studio.saveButton')); if (!hit) await st.waitForTimeout(5000); }
    const authoring = st.frames().filter((f) => rx('studio.authoringFrameUrl').test(f.url()));
    mark('studio.authoringFrameUrl', authoring.length ? 'ok' : 'stale',
      authoring.length ? authoring.length + ' frame(s) matched' : 'no frame URL matched; frames: ' + st.frames().map((f) => { try { return new URL(f.url()).host; } catch { return '?'; } }).join(', '));
    mark('portal.studioUrl', authoring.length ? 'ok' : 'stale', authoring.length ? 'the editor loaded' : 'the editor never appeared');
    if (!authoring.length) {
      const text = await st.locator('body').innerText().catch(() => '');
      if (/invalid|not found|does not exist|don't have access|not authorized|error/i.test(text)) {
        const why = 'Studio showed an error instead of the editor (' + text.replace(/\s+/g, ' ').slice(0, 120) + ')';
        for (const id of ['portal.studioUrl', 'studio.authoringFrameUrl', 'studio.titleEditing', 'studio.titleReadOnly']) mark(id, 'cannot-verify', why);
      }
      await capture(st, 'doctor-studio').catch(() => {});
    }
    if (authoring.length) {
      if (await dismissBubbles(hit ? hit.frame : authoring[0]) > 0) mark('studio.gotIt', 'ok', 'a teaching bubble was dismissed');
      mark('studio.saveButton', hit ? 'ok' : 'stale', hit ? 'found' : 'no authoring frame contains ' + css('studio.saveButton'));
      const ed = hit ? hit.frame : authoring[0];
      for (const id of ['studio.publishButton', 'studio.backButton']) {
        const n = await ed.locator(css(id)).count().catch(() => 0);
        mark(id, n > 0 ? 'ok' : 'stale', n > 0 ? 'found' : 'not found: ' + css(id));
      }
      let flyout = false;
      for (const l of locsOf(ed, 'studio.saveFlyout')) if (await l.count().catch(() => 0) > 0) flyout = true;
      mark('studio.saveFlyout', flyout ? 'ok' : 'stale', flyout ? 'found' : 'no shape matched');
      if (flyout) {
        const stamp = await readSaveStamp(st, ed);
        mark('studio.savedStamp', stamp ? 'ok' : 'stale', stamp ? 'read "Saved: ' + stamp + '"' : 'the flyout opened but no text matched the pattern');
      } else mark('studio.savedStamp', 'not-exercised', 'needs the Save flyout');
      if (await ed.locator(css('studio.closePreview')).count().catch(() => 0) > 0) mark('studio.closePreview', 'ok', 'Studio was in Preview');
    }
    const left = await leaveEditor(st);
    if (left.leave) mark('studio.leaveButton', 'ok', 'the Leave prompt appeared');
    if (left.stillEditing) log('  !! STILL IN THE EDITOR - close Studio by hand (Back) before the next compile or import.');
    else log('  left the editor; edit lock released');
  }
  await ctx.close().catch(() => {});

  const surfaces = has('player-only') ? ['portal', 'player'] : has('studio-only') ? ['portal', 'studio'] : ['portal', 'player', 'studio'];
  for (const [id, e] of Object.entries(SEL)) {
    if (results.has(id) || !surfaces.includes(e.surface)) continue;
    mark(id, 'not-exercised', e.check === 'conditional' ? 'appears only in a state doctor does not create' : 'not reached this run');
  }
  const rows = [...results].sort(([a], [b]) => a.localeCompare(b));
  log('');
  for (const [id, r] of rows) log('  ' + r.status.toUpperCase().padEnd(14) + id.padEnd(26) + (SEL[id].lastVerified ? '[' + SEL[id].lastVerified + '] ' : '') + r.detail);
  const stale = rows.filter(([, r]) => r.status === 'stale');
  const skipped = rows.filter(([, r]) => r.status === 'not-exercised');
  // A required anchor that was not seen working is not verified, even when nothing is stale.
  const unproven = rows.filter(([id, r]) => SEL[id].check === 'required' && r.status !== 'ok' && r.status !== 'stale');
  log('\n  ' + rows.filter(([, r]) => r.status === 'ok').length + ' resolved, ' + stale.length + ' STALE, ' + skipped.length + ' not exercised, '
      + rows.filter(([, r]) => r.status === 'cannot-verify').length + ' could not be verified.');
  if (!stale.length && unproven.length) log('  CANNOT VERIFY: required anchor(s) not seen working: ' + unproven.map(([id]) => id).join(', ') + '. This is NOT a pass.');
  if (skipped.length) log('  Not exercised is not verified: those anchors appear only in states doctor does not create (signed out, Preview, a publish dialog, a stale build).');
  if (stale.length) log('  Fix the stale entries in ' + SELECTORS.file + ' (and SELECTOR_DEFAULTS), then run doctor again.');
  if (has('record') && SELECTORS.doc && !stale.length && !unproven.length) {
    const today = new Date().toISOString().slice(0, 10);
    for (const [id, r] of rows) if (r.status === 'ok' && SELECTORS.doc.selectors[id]) SELECTORS.doc.selectors[id].lastVerified = today;
    writeFileSync(SELECTORS.file, JSON.stringify(SELECTORS.doc, null, 2) + '\n', 'utf8');
    log('  --record: lastVerified set to ' + today + ' for the resolved entries in ' + SELECTORS.file);
  } else if (has('record')) log('  --record: nothing written (' + (stale.length || unproven.length ? 'not every required anchor was verified' : 'no table file loaded') + ').');
  process.exitCode = stale.length ? 9 : unproven.length ? 2 : 0;
}

async function cmdShot() {
  const url = argv[1]; const name = argv[2] || 'shot';
  if (!url) { log('usage: canvas-browser.mjs shot <url> <name>'); process.exitCode = 1; return; }
  const ctx = await launch({ headless: has('headless') });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(Number(flag('settle', 6000)));
  await capture(page, name);
  await ctx.close();
}

const commands = { login: cmdLogin, check: cmdCheck, play: cmdPlay, walk: cmdWalk, studio: cmdStudio,
  keys: cmdKeys, save: cmdSave, publish: cmdPublish, 'close-studio': cmdCloseStudio, shot: cmdShot, lint: async () => cmdLint(), doctor: cmdDoctor, confirm: cmdConfirm };

if (argv.includes('--selftest')) selftest();
else if (!commands[cmd]) {
  log('canvas-browser - drive Power Apps Studio and the published player\n');
  log('  login | check | play [--screen N] [--trace] [--fresh] | walk <scenario.json> [--trace] [--fresh] [--allow-writes]');
  log('  confirm <scenario.json> [--since ISO]   run only the scenario\'s Dataverse checks');
  log('  studio | keys [combo] | save | publish [--reload-first] | close-studio [--keep-browser] | shot <url> <name>');
  log('  doctor [--player-only|--studio-only] [--record]   are the UI anchors in assets/selectors.json still valid?\n');
  log('  config:  ' + (CONFIG_PATH || '(none found - pass --config or create scripts/canvas-app.json)'));
  if (APP.appId) log('  app:     ' + (APP.appName || '') + '  ' + APP.appId);
  log('  profile: ' + PROFILE + (existsSync(PROFILE) ? '  (exists)' : '  (not created yet)'));
  log('  output:  ' + OUT);
  process.exitCode = cmd ? 1 : 0;
} else {
  commands[cmd]().catch((e) => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
}
