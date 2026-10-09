#!/usr/bin/env node
// canvas-browser.mjs - drive Power Apps Studio and the published canvas player with Playwright.
//
// Part of the power-platform Agent Skill. A canvas app has no test framework: the published
// app is the test harness, and a browser is the only way to reach it. This driver makes that
// repeatable - scenarios are JSON, so a verification can be reviewed, diffed and re-run.
//
// Setup:   npm i -D playwright        (drives your installed Chrome via channel 'chrome'; on Windows
//                                      with your own Chrome open it uses Edge, remembered in <profile>.channel)
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
//   node canvas-browser.mjs create --name N --solution-id GUID [--tables a,b] [--layout responsive]
//                                                  create a blank canvas app IN the solution: first save,
//                                                  layout, Coauthoring on, data sources by logical name,
//                                                  save; writes appId to the config; holds Studio open
//   node canvas-browser.mjs connection --connector dataverse|outlook|approvals|<api> --name N [--apply] [--json]
//                                                  create (or reuse) this build's own signed-in connection: checks
//                                                  the token's account against "login" and the environment against
//                                                  "environmentUrl", creates it over the API, finishes OAuth consent
//                                                  in the signed-in profile, reads back Connected; plan unless --apply
//   node canvas-browser.mjs play [--screen NAME]   open the PUBLISHED app, capture, report console
//   node canvas-browser.mjs walk <scenario.json>   PERFORM a task and assert the result
//   node canvas-browser.mjs studio                 open Studio in EDIT mode and hold it open; prints STUDIO READY,
//                                                  or exits 3 (read-only, or no edit mode in 3 minutes) - stop the chain
//   node canvas-browser.mjs studio --reload        reload the held Studio right before a push; checks for the
//                                                  "There's been a disconnect" dialog (exit 3)
//   node canvas-browser.mjs keys [combo]           reattach to Studio: report mode / send keys
//   node canvas-browser.mjs save                   click Studio's Save button (not Ctrl+S), read "Saved: <time>"; on
//                                                  SAVE LANDED writes <workDir>/save-proof.json (a held push waits for it)
//   node canvas-browser.mjs publish [--reload-first]  publish the saved app to the player (records the hash the
//                                                  last clean push sent, from <workDir>/last-push.json)
//   node canvas-browser.mjs close-studio           leave the editor through Back (frees the lock),
//                                                  then quit the held browser (frees the profile)
//   node canvas-browser.mjs tabs                   list the held browser's tabs (Studio, blank, other)
//   node canvas-browser.mjs tidy [--all] [--studio] [--dry-run]
//                                                  close blank and error tabs in the held browser; --all
//                                                  also every non-Studio tab, --studio also older Studio
//                                                  tabs (left through Back first); the held editor stays
//   node canvas-browser.mjs second-tab [--expect a,b]  open the app's edit URL in a second tab of the held
//                                                  browser (it joins the co-authoring session) and wait
//                                                  for the named controls to render there
//   node canvas-browser.mjs studio-has <name...>   does the held Studio tab show these control names
//   node canvas-browser.mjs dirty [--toggle <formula>]  make a harmless edit so Save is enabled after a push that
//                                                  left it disabled: a trailing space, or --toggle the selected
//                                                  property to another value and back (read back); exit 7 if
//                                                  Save stays disabled
//   save / publish / dirty act on the Studio tab whose authoring frame holds a Save button, not the newest
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
//        --skip-writes    skip those scenarios instead (a read-only pass, e.g. the reviewer's)
//   publish: refused when the source is unchanged (--again), and from the third publish until
//        docs/design-critique.md and docs/review/findings.json exist (--unreviewed "<reason>"; exit 8),
//        and after the fix batch has shipped until a new batch is declared (--batch "<what>"; exit 10);
//        exit 11 when "Publish this version" is still open in any Studio tab after the wait
//   create: reopens the saved app and reads its Data pane; re-adds a missing table once, then fails
//        (exit 4) naming it. --no-verify-sources skips the check.
//        --keep-browser   close-studio: release the edit lock but leave the browser running
//        --expect a,b     second-tab: control names to wait for
//        --selectors <path>  UI anchor table (default: the skill's assets/selectors.json)
//        --player-only | --studio-only | --record   doctor: limit the surfaces / write lastVerified dates

// Playwright is loaded lazily so `lint` and `--selftest` run without it installed.
let chromium = null;
// Where Playwright may be installed. A bare import('playwright') resolves from THIS script's folder
// upward and ignores NODE_PATH, so a driver run from a plugin cache never finds the project's install
// (measured: exit 8 "not installed" while it sat in <project>/portal/node_modules). Look from the
// working folder and the config's folder (and the repo above it), then in their direct subfolders.
function playwrightRoots(cwd, configDir) {
  const roots = [];
  const add = (d) => { if (d && !roots.includes(d)) roots.push(d); };
  for (const base of [cwd, configDir, configDir ? dirname(configDir) : null]) {
    if (!base) continue;
    add(base);
    let subs = [];
    try { subs = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^(\.|node_modules$)/.test(e.name)).map((e) => join(base, e.name)); } catch { /* unreadable */ }
    for (const s of subs) if (existsSync(join(s, 'node_modules'))) add(s);
  }
  return roots;
}
async function loadPlaywright() {
  try { return { mod: await import('playwright') }; } catch { /* look in the project */ }
  const roots = playwrightRoots(process.cwd(), CONFIG_PATH ? dirname(CONFIG_PATH) : null);
  for (const r of roots) {
    try {
      const file = createRequire(join(r, 'noop.js')).resolve('playwright');
      return { mod: await import(pathToFileURL(file).href) };
    } catch { /* next */ }
  }
  return { mod: null, roots };
}
async function pw() {
  if (!chromium) {
    const found = await loadPlaywright();
    if (found.mod) chromium = found.mod.chromium || (found.mod.default && found.mod.default.chromium) || null;
    if (!chromium) {
      if (cmd === 'doctor') console.error('doctor: CANNOT VERIFY any selector - no browser can run here. This is NOT a pass.');
      console.error([
        'Playwright is not installed, so no browser check can run. Nothing has been verified.',
        '  Looked from this script\'s folder, then from (and above) each of:',
        ...(found.roots || []).map((r) => '    ' + r),
        '  Run from the project folder whose node_modules holds playwright, or pass --config from inside it.',
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
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes('--' + name);
// The flags that take a value. A positional filter that drops "--x" tokens but keeps their values
// read `walk a.json --config cfg.json` as two scenarios, the second being the config file.
export const VALUED_FLAGS = new Set(['after', 'batch', 'channel', 'config', 'connector', 'expect', 'form-factor', 'hold', 'layout', 'name',
  'out', 'port', 'profile', 'screen', 'selectors', 'settle', 'settle-dv', 'since', 'solution-id', 'tables', 'timeout', 'toggle',
  'unreviewed', 'wait-for']);
export function positionals(args, valued = VALUED_FLAGS) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a.startsWith('--')) { if (valued.has(a.slice(2)) && i + 1 < args.length && !String(args[i + 1]).startsWith('--')) i++; continue; }
    out.push(a);
  }
  return out;
}
let CHANNEL = String(flag('channel', 'chrome'));
const CHANNEL_GIVEN = has('channel');
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
  'portal.newAppUrl':         { surface: 'studio', kind: 'template', check: 'conditional',
    value: 'https://make.powerapps.com/e/{environmentId}/canvas/?action=new-blank&form-factor={formFactor}&name={name}&solution-id={solutionId}' },
  'portal.appIdInUrl':        { surface: 'studio', kind: 'regex', pattern: 'app-id=(?:%2F|/)providers(?:%2F|/)Microsoft\\.PowerApps(?:%2F|/)apps(?:%2F|/)([0-9a-f-]{36})', flags: 'i', check: 'conditional' },
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
  'studio.disconnected':      { surface: 'studio', kind: 'regex', pattern: 'There[\'’]s been a disconnect', flags: 'i', check: 'conditional' },
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
  'studio.welcomeSkip':       { surface: 'studio', kind: 'css', value: '[role="dialog"]:has-text("Welcome to Power Apps Studio") button:has-text("Skip")', check: 'conditional' },
  'studio.welcomeDontShow':   { surface: 'studio', kind: 'css', value: '[role="dialog"]:has-text("Welcome to Power Apps Studio") input[type="checkbox"]', check: 'conditional' },
  'studio.appSettings':       { surface: 'studio', kind: 'role', role: 'menuitem', name: '^app settings$', flags: 'i', check: 'conditional' },
  'studio.settingsDisplayTab': { surface: 'studio', kind: 'role', role: 'tab', name: '^display$', flags: 'i', check: 'conditional' },
  'studio.settingsUpdatesTab': { surface: 'studio', kind: 'role', role: 'tab', name: '^updates$', flags: 'i', check: 'conditional' },
  'studio.appLayout':         { surface: 'studio', kind: 'role', role: 'combobox', name: '^app layout$', flags: 'i', check: 'conditional' },
  'studio.listOption':        { surface: 'studio', kind: 'css', value: '[role="option"]', check: 'conditional' },
  'studio.modernSwitch':      { surface: 'studio', kind: 'role', role: 'switch', name: '^modern controls and themes$', flags: 'i', check: 'conditional' },
  'studio.coauthoringSwitch': { surface: 'studio', kind: 'role', role: 'switch', name: '^coauthoring$', flags: 'i', check: 'conditional' },
  'studio.saveRefreshUpdate': { surface: 'studio', kind: 'css', value: '[role="alertdialog"] button:has-text("Update")', check: 'conditional' },
  'studio.closeSettings':     { surface: 'studio', kind: 'role', role: 'button', name: '^close( settings)?$', flags: 'i', check: 'conditional' },
  'studio.addData':           { surface: 'studio', kind: 'role', role: 'menuitem', name: '^add data$', flags: 'i', check: 'conditional' },
  'studio.dataSearch':        { surface: 'studio', kind: 'role', role: 'searchbox', name: '^search$', flags: 'i', check: 'conditional' },
  'studio.dataItemDescription': { surface: 'studio', kind: 'template', value: 'Table {logical}', check: 'conditional' },
  'studio.dataSourceAdded':   { surface: 'studio', kind: 'regex', pattern: 'data source was successfully added|was added to your app', flags: 'i', check: 'conditional' },
  'studio.dataPane':          { surface: 'studio', kind: 'anyOf', check: 'conditional', anyOf: [
    { kind: 'role', role: 'tab', name: '^data$', flags: 'i' },
    { kind: 'role', role: 'button', name: '^data$', flags: 'i' }] },
  'studio.canvasRoute':       { surface: 'studio', kind: 'regex', pattern: '/canvas/', flags: '', check: 'required' },
  'studio.editUrl':           { surface: 'studio', kind: 'regex', pattern: '[?&]action=edit', flags: '', check: 'conditional' },
  'studio.formulaBar':        { surface: 'studio', kind: 'role', role: 'textbox', name: 'formula', flags: 'i', check: 'conditional' },
  'studio.formulaEditor':     { surface: 'studio', kind: 'css', value: '.monaco-editor .view-lines', check: 'conditional' },
  'browser.blankUrl':         { surface: 'portal', kind: 'regex', pattern: '^(about:blank|chrome://new-tab-page|chrome://newtab|edge://newtab|chrome-error://|chrome://crash|edge://crash)', flags: 'i', check: 'conditional' },
  'player.dropdownOption':    { surface: 'player', kind: 'role', role: 'option', name: '', flags: '', check: 'conditional' },
  'consent.confirmUrl':       { surface: 'portal', kind: 'regex', pattern: 'consent\\.azure-apim\\.net/confirm\\?[^#]*[?&]code=', flags: 'i', check: 'conditional' },
  'consent.accountTile':      { surface: 'portal', kind: 'template', value: '[data-test-id="{login}" i]', check: 'conditional' },
};
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// In the skill: assets/selectors.json. Installed into a project by setup-harness.mjs: next to this script.
const SELECTORS_PATH = resolve(String(flag('selectors', [join(SKILL_DIR, 'assets', 'selectors.json'),
  join(dirname(fileURLToPath(import.meta.url)), 'selectors.json')].find((p) => existsSync(p)) || join(SKILL_DIR, 'assets', 'selectors.json'))));
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
// The repo root holds .git; the config may sit one or more folders below it (scripts/canvas/x.json).
export function findRepo(start) { let d = start; for (let i = 0; i < 6; i++) { if (existsSync(join(d, '.git'))) return d; const up = dirname(d); if (up === d) break; d = up; } return null; }
const REPO = CONFIG_PATH ? (findRepo(dirname(resolve(CONFIG_PATH))) || resolve(dirname(CONFIG_PATH), '..')) : (findRepo(process.cwd()) || process.cwd());

// Outside the repo on purpose: this directory holds live tenant session cookies.
const PROFILE = resolve(String(flag('profile', join(homedir(), '.canvas-browser-profile'))));

// Which browser. Chrome is the default, but on Windows a Chrome launch while the person's own Chrome is
// running is handed to THEIR session: it opens a tab in their browser before Playwright fails with
// "Opening in existing browser session" and the driver falls back to Edge. One stray tab per command
// left 20+ tabs in an owner's Chrome in one session, and the driver's tab hygiene never sees them. So
// with Chrome running, go straight to Edge, and remember the choice beside the profile (a profile is
// then always opened by the same browser). --channel always wins.
const CHANNEL_FILE = PROFILE.replace(/[\\/]+$/, '') + '.channel';
export function pickChannel({ given, requested, platform, sticky, chromeRunning }) {
  if (given) return { channel: requested, remember: false };
  if (sticky) return { channel: sticky, remember: false };
  if (requested === 'chrome' && platform === 'win32' && chromeRunning()) return { channel: 'msedge', remember: true };
  return { channel: requested, remember: false };
}
function chromeRunning() {
  try {
    return /chrome\.exe/i.test(execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }));
  } catch { return false; }
}
function rememberChannel(ch) { try { writeFileSync(CHANNEL_FILE, ch + '\n'); } catch { /* read-only home: decide again next time */ } }
let CHANNEL_PICKED = false;
function resolveChannel() {
  if (CHANNEL_PICKED) return;
  CHANNEL_PICKED = true;
  let sticky = '';
  try { sticky = readFileSync(CHANNEL_FILE, 'utf8').trim(); } catch { /* first run */ }
  const d = pickChannel({ given: CHANNEL_GIVEN, requested: CHANNEL, platform: process.platform, sticky, chromeRunning });
  if (d.channel !== CHANNEL) log(`  Using ${d.channel === 'msedge' ? 'Edge' : d.channel} (${sticky ? CHANNEL_FILE : 'your Chrome is running; a Chrome launch would open a tab in it'}).`);
  CHANNEL = d.channel;
  if (d.remember) rememberChannel(CHANNEL);
}
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
// A walk while another process holds the profile (the lead's walks and the reviewer's at the same
// time, or a held Studio) runs on a copy of the signed-in profile instead of failing. A running
// browser locks its cookie store, so the copy is taken from a snapshot that every walk on the real
// profile refreshes when it closes it (about 30 MB: locks, caches and service workers left out).
// The copy is removed when the walk ends. Only read-mostly commands do this; Studio work always
// needs the one real profile.
const COPY_OK = new Set(['walk', 'play', 'check']);
export function profileCopyFilter(src) {
  const name = src.replace(/\\/g, '/').split('/').pop();
  return !/^(Singleton(Lock|Socket|Cookie)|lockfile|LOCK|Cache|Code Cache|GPUCache|GrShaderCache|ShaderCache|DawnCache|DawnGraphiteCache|CacheStorage|ScriptCache|Service Worker|Crashpad|BrowserMetrics.*|.*\.tmp)$/i.test(name);
}
const SNAPSHOT = () => PROFILE.replace(/[\\/]+$/, '') + '-snapshot';
let USED_PROFILE = null;
function refreshSnapshot() {
  if (USED_PROFILE !== PROFILE) return;
  try {
    const tmp = SNAPSHOT() + '-new';
    rmSync(tmp, { recursive: true, force: true });
    cpSync(PROFILE, tmp, { recursive: true, filter: profileCopyFilter, force: true });
    rmSync(SNAPSHOT(), { recursive: true, force: true });
    cpSync(tmp, SNAPSHOT(), { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  } catch { /* a locked file: keep the previous snapshot */ }
}
function copyProfile() {
  if (!existsSync(SNAPSHOT())) throw new Error('profile in use and no snapshot yet: run one walk on its own first (it leaves the snapshot), or wait for the other walk');
  const dest = PROFILE.replace(/[\\/]+$/, '') + '-copy-' + process.pid;
  cpSync(SNAPSHOT(), dest, { recursive: true, force: true });
  process.on('exit', () => { try { rmSync(dest, { recursive: true, force: true }); } catch { /* still closing */ } });
  return dest;
}

async function launch(opts, profileDir = PROFILE) {
  resolveChannel();
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  // No session restore and no crash-restore bubble: each run starts from one tab, not the last run's.
  const args = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--hide-crash-restore-bubble', '--disable-session-crashed-bubble'];
  if (opts.debugPort) args.push('--remote-debugging-port=' + opts.debugPort);
  let ctx;
  try {
    ctx = await (await pw()).launchPersistentContext(profileDir, {
      headless: !!opts.headless,
      // 'chromium' means Playwright's own bundled build, which takes no channel.
      ...(CHANNEL === 'chromium' ? {} : { channel: CHANNEL }),
      viewport: { width: 1600, height: 1000 },
      ignoreDefaultArgs: ['--enable-automation'],   // the maker portal behaves as in a normal browser
      args,
    });
  } catch (e) {
    // On some managed machines Chrome hands EVERY automated launch to the person's running Chrome
    // ("Opening in existing browser session"), even with a brand-new profile directory. Edge is
    // unaffected and present on every Windows machine: fall back to it unless a channel was given.
    if (!CHANNEL_GIVEN && CHANNEL === 'chrome' && /Opening in existing browser session/i.test(e.message)) {
      log('  Chrome would only open inside the running Chrome session here - using Edge instead (--channel msedge).');
      CHANNEL = 'msedge';
      rememberChannel(CHANNEL);
      return launch(opts, profileDir);
    }
    // A persistent profile can be held by only one Chrome. `close-studio --keep-browser` (or a
    // `studio` process still running in the background) keeps it; deleting Singleton* files
    // inside the profile did not help when tried. Recreate the profile with `login` instead.
    if (/distribution '.*' is not found|executable doesn't exist|Looks like Playwright/i.test(e.message)) {
      log(`BROWSER NOT FOUND for --channel ${CHANNEL}. Nothing has been verified.`);
      log('  Chrome or Edge already installed: pass --channel chrome or --channel msedge.');
      log('  Neither: run `npx playwright install chromium` (ask the user first), then --channel chromium.');
      process.exit(8);
    }
    if (/already in use|ProcessSingleton|existing browser session/i.test(e.message) && profileDir === PROFILE && COPY_OK.has(cmd) && !has('no-profile-copy')) {
      log('  profile in use (another walk or a held Studio): walking on a temporary copy of it');
      return launch(opts, copyProfile());
    }
    if (/already in use|ProcessSingleton|existing browser session/i.test(e.message)) {
      log('PROFILE IN USE: ' + profileDir);
      log('  Another Chrome holds this profile - usually a `studio` process still running.');
      log('  Run `close-studio` (it quits the held browser), or stop that process, then retry.');
      log('  If nothing holds it, pass --profile <new dir> and run `login` again.');
      log('  Do not infer the result of a check that could not run: report it as unverified.');
      process.exit(5);
    }
    throw e;
  }
  ctx.setDefaultTimeout(TIMEOUT);
  USED_PROFILE = profileDir;
  return ctx;
}

// A persistent context opens with one blank tab of its own. Use it instead of opening another, and
// close any other blank tabs: a new tab per command, plus the browser restoring the last session's
// tabs on the next launch, left a growing row of about:blank tabs in the driven browser.
// Called straight after launch, so any other tab present was restored from an earlier run (a
// restored Studio tab would also compete for the edit lock): keep one, close the rest.
async function freshPage(ctx) {
  const pages = ctx.pages();
  const page = pages.find((p) => p.url() === 'about:blank') || pages[0] || await ctx.newPage();
  for (const p of pages) if (p !== page) await p.close().catch(() => {});
  return page;
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
    // Two failures. Sideways: text wider than its box. Vertical: text taller than the box that clips it.
    // A single line centred in a box too short for its font is cut at the TOP and the BOTTOM; centred
    // overflow is not counted by scrollHeight (the top half is negative overflow), so the vertical test
    // measures the rendered text against its nearest clipping ancestor instead.
    const out = []; const seen = new Set();
    const clipBox = (el) => {
      for (let c = el; c && c !== document.body; c = c.parentElement) {
        const s = getComputedStyle(c);
        if (/hidden|clip|auto|scroll/.test(s.overflowY + ' ' + s.overflow)) return { el: c, r: c.getBoundingClientRect(), scrolls: /auto|scroll/.test(s.overflowY) };
      }
      return null;
    };
    for (const el of document.querySelectorAll('div,span,p')) {
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (el.clientWidth < 2 || el.clientHeight < 2) continue;
      const rr = el.getBoundingClientRect();
      if (rr.bottom < 0 || rr.top > innerHeight) continue;             // below the fold
      const fs = parseFloat(cs.fontSize) || 13;
      const lh = parseFloat(cs.lineHeight) || fs * 1.4;
      let dw = 0, hidden = 0, vcut = 0;
      const ownClip = !(cs.overflow === 'visible' && cs.overflowX === 'visible' && cs.overflowY === 'visible');
      if (ownClip && !/auto|scroll/.test(cs.overflowY + cs.overflowX)) {
        dw = el.scrollWidth - el.clientWidth;
        hidden = Math.floor((el.scrollHeight - el.clientHeight) / lh);   // whole lines below the box
      }
      try {
        const rg = document.createRange(); rg.selectNodeContents(el);
        const tr = rg.getBoundingClientRect();
        const cb = clipBox(el);
        if (cb && !cb.scrolls && tr.height > 0) vcut = Math.round(Math.max(0, cb.r.top - tr.top) + Math.max(0, tr.bottom - cb.r.bottom));
      } catch { /* no range */ }
      if (dw < 2 && hidden < 1 && vcut < 3) continue;
      const host = el.closest('[' + attr + ']');
      const name = host ? host.getAttribute(attr) : '(unnamed)';
      const key = name + '|' + txt.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, text: txt.slice(0, 96), dw, hidden, vcut, font: Math.round(fs * 10) / 10, box: Math.round(el.clientWidth) + 'x' + Math.round(el.clientHeight) });
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

// The widest scrollable surface in the page or the app frame, when it is wider than the window;
// 0 when nothing scrolls sideways. Small inner scrollers (a gallery, a table) are not the page.
async function horizontalOverflow(page, frame) {
  const probe = () => {
    const vw = window.innerWidth; let worst = 0;
    const els = [document.scrollingElement || document.documentElement, ...document.querySelectorAll('div, main, section')];
    for (const el of els) {
      if (!el || el.clientWidth < vw * 0.8) continue;
      const ox = el === document.scrollingElement || el === document.documentElement ? 'auto' : getComputedStyle(el).overflowX;
      if (!/auto|scroll/.test(ox)) continue;
      if (el.scrollWidth > el.clientWidth + 2) worst = Math.max(worst, el.scrollWidth);
    }
    return worst;
  };
  let worst = 0;
  for (const target of [page, frame]) {
    try { worst = Math.max(worst, await target.evaluate(probe)); } catch { /* detached frame */ }
  }
  return worst;
}

// --- target matching (pure, so --selftest proves it) -------------------------------------------
// Click and type targets used to match by case-insensitive SUBSTRING across accessible names and
// placeholders, taking the first hit. Each of these passed its step and failed later: `into: City`
// typed into a search box whose placeholder said "Search city", `click: RAR` pressed "New RAR",
// `click: Close` hit a toast's close button. So an exact name wins over a substring, and more than
// one control at the winning tier is reported, not silently resolved to the first.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// 0 exact, 1 exact ignoring case, 2 substring ignoring case, null no match.
export function matchTier(text, name) {
  const t = norm(text), n = norm(name);
  if (!t || !n) return null;
  if (n === t) return 0;
  const tl = t.toLowerCase(), nl = n.toLowerCase();
  if (nl === tl) return 1;
  if (nl.includes(tl)) return 2;
  return null;
}
export const TIER_NAMES = ['exact', 'exact (case differs)', 'substring'];
// cands: [{ names: [accessible name, placeholder, label, ...], visible }]. The best tier wins; within
// it, every candidate is returned as `tied` so the caller can report an ambiguous target. Invisible
// candidates count only when nothing visible matches (a canvas app keeps other screens in the DOM).
export function rankTargets(text, cands, { exactOnly = false } = {}) {
  const scored = cands.map((c, i) => {
    const tiers = (c.names || []).map((n) => matchTier(text, n)).filter((x) => x !== null);
    return { i, tier: tiers.length ? Math.min(...tiers) : null, visible: c.visible !== false };
  }).filter((s) => s.tier !== null && (!exactOnly || s.tier < 2));
  const pool = scored.some((s) => s.visible) ? scored.filter((s) => s.visible) : scored;
  if (!pool.length) return { best: -1, tier: null, tied: [] };
  const tier = Math.min(...pool.map((s) => s.tier));
  const tied = pool.filter((s) => s.tier === tier).map((s) => s.i);
  return { best: tied[0], tier, tied };
}
// The control a click lands on can be named differently from the text that found it (a date picker
// opened when the text sat over it). Warn when the hit control's accessible name lacks the text.
export function nameMismatch(text, accessibleName) {
  const n = norm(accessibleName);
  return !!n && matchTier(text, n) === null;
}
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const exactRx = (text) => new RegExp('^\\s*' + escapeRx(norm(text)).replace(/ /g, '\\s+') + '\\s*$', 'i');
// A chunked collection shows a PART-loaded total while it fills (a tile read 34.6M before 45.8M, a
// dashboard read blank and "$0" for about 3 minutes). samples: [{ t: ms since start, text }]. Stable
// = the same non-empty text on `reads` consecutive samples; `at` is when it first read that value.
// What a dropdown shows, read from its opener (aria-label and text both carry the control's name), against
// the value a step expects: the name is removed first, so a dropdown named "Status" is not "Status: Active"
// by accident, then the value must stand as a whole word.
export function selectedMatches(shown, want, from = '') {
  let t = String(shown || '').replace(/\s+/g, ' ');
  if (from) t = t.split(String(from)).join(' ');
  const esc = String(want).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\w])' + esc + '($|[^\\w])').test(t.trim());
}

export function settleVerdict(samples, { reads = 2 } = {}) {
  let run = 0;
  for (let k = 0; k < samples.length; k++) {
    const v = norm(samples[k].text);
    run = v && k > 0 && v === norm(samples[k - 1].text) ? run + 1 : (v ? 1 : 0);
    if (run >= reads) {
      const first = samples[k - reads + 1];
      return { stable: true, value: v, at: first.t, changes: new Set(samples.slice(0, k + 1).map((s) => norm(s.text))).size - 1 };
    }
  }
  const last = samples[samples.length - 1];
  return { stable: false, value: last ? norm(last.text) : '', at: null, changes: new Set(samples.map((s) => norm(s.text))).size - 1 };
}

// --- target resolution in the player (uses the pure functions above) ---------------------------
const CHECKBOX_SEL = 'input[type="checkbox"], [role="checkbox"]';
async function checkedState(loc) {
  return loc.evaluate((e) => {
    const b = e.matches('input[type="checkbox"], [role="checkbox"]') ? e : e.querySelector('input[type="checkbox"], [role="checkbox"]');
    if (!b) return null;
    return b.matches('input') ? b.checked : b.getAttribute('aria-checked') === 'true';
  }).catch(() => null);
}
// The accessible name of the control a click on this locator lands on: whatever is painted at its
// centre (something else may sit over the text), else the interactive element around or inside it.
async function hitName(loc) {
  return loc.evaluate((e) => {
    const sel = 'button, [role="button"], [role="checkbox"], [role="link"], [role="tab"], [role="menuitem"], a, input, select, textarea';
    const r = e.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const at = top && !e.contains(top) && !top.contains(e) ? top.closest(sel) : null;
    const b = at || (e.matches(sel) ? e : (e.closest(sel) || e.querySelector(sel)));
    if (!b) return '';
    const by = (b.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((x) => x.textContent).join(' ');
    return b.getAttribute('aria-label') || by || b.getAttribute('title') || b.innerText || b.value || '';
  }).catch(() => '');
}
async function namesOf(loc, max = 6) {
  return loc.evaluateAll((els, m) => els.slice(0, m).map((e) => (e.getAttribute('aria-label') || e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)), max).catch(() => []);
}
// Click: tiers in order, exact name before substring; within a tier, checkbox before button before
// the control wrapper before raw text (a caption is a separate text node and can sit outside the
// hit surface). Reports a tier holding more than one match, and a hit control whose name lacks the text.
async function clickTarget(frame, text, nth, exactOnly) {
  const ex = exactRx(text);
  const tiers = [
    ['exact name', [['checkbox', frame.getByRole('checkbox', { name: ex })], ['button', frame.getByRole('button', { name: ex })],
      ['link', frame.getByRole('link', { name: ex })], ['tab', frame.getByRole('tab', { name: ex })], ['menuitem', frame.getByRole('menuitem', { name: ex })]]],
    ['exact text', [['control', frame.locator(CONTROL).filter({ hasText: ex })], ['text', frame.getByText(ex)]]],
  ];
  if (!exactOnly) tiers.push(['substring', [['checkbox', frame.getByRole('checkbox', { name: text, exact: false })], ['button', frame.getByRole('button', { name: text, exact: false })],
    ['control', frame.locator(CONTROL).filter({ hasText: text })], ['text', frame.getByText(text, { exact: false })]]]);
  for (const [tierName, shapes] of tiers) {
    for (const [shape, loc] of shapes) {
      const n = await loc.count();
      if (n <= nth) continue;
      const t = loc.nth(nth);
      try { await t.waitFor({ state: 'visible', timeout: 15000 }); } catch { continue; }
      const notes = [];
      if (n > 1 && !nth) notes.push(n + ' controls matched "' + text + '" (' + tierName + ', ' + shape + '): ' + (await namesOf(loc)).map((x) => '"' + x + '"').join(', ') + ' - clicked the first; give "nth" or a more exact name');
      if (tierName === 'substring') notes.push('no control is named exactly "' + text + '"; matched by substring (' + shape + ') - "exact": true refuses this');
      const name = await hitName(t);
      if (nameMismatch(text, name)) notes.push('the control clicked is named "' + norm(name).slice(0, 60) + '", which does not contain "' + text + '" - click it by that name');
      // A checkbox hit by any shape: remember its state, so the caller can prove it toggled.
      const box = shape === 'checkbox' ? t : ((await t.locator(CHECKBOX_SEL).count().catch(() => 0)) ? t : null);
      const before = box ? await checkedState(box) : null;
      try { await t.click({ timeout: 15000 }); } catch { continue; }
      return { how: tierName + ', ' + shape, notes, checkbox: box, before };
    }
  }
  return null;
}
// Type: rank every text box by accessible name, placeholder and label (exact first), among the
// visible ones; report a tie. Falls back to Playwright's own label lookup.
const TEXTBOX_SEL = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea';
async function typeTarget(frame, into, nth, exactOnly) {
  const all = frame.locator(TEXTBOX_SEL);
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const cands = await all.evaluateAll((els) => els.map((e) => {
      const by = (e.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((x) => x.textContent);
      const labels = Array.from(e.labels || []).map((l) => l.textContent);
      const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return { names: [e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('title'), ...by, ...labels].filter(Boolean),
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' };
    })).catch(() => []);
    const rk = rankTargets(into, cands, { exactOnly });
    if (rk.best >= 0 && cands[rk.best].visible) {
      const pick = rk.tied[Math.min(nth, rk.tied.length - 1)];
      const notes = [];
      if (rk.tied.length > 1 && !nth) notes.push(rk.tied.length + ' text boxes matched "' + into + '" (' + TIER_NAMES[rk.tier] + '): ' + rk.tied.slice(0, 6).map((k) => '"' + cands[k].names[0] + '"').join(', ') + ' - typed into the first; give "nth" or a more exact name');
      if (rk.tier === 2) notes.push('no text box is named exactly "' + into + '"; matched "' + cands[pick].names.find((x) => matchTier(into, x) === 2) + '" by substring - "exact": true refuses this');
      return { box: all.nth(pick), how: TIER_NAMES[rk.tier], notes };
    }
    await frame.page().waitForTimeout(500);
  }
  if (exactOnly) return null;
  const byLabel = frame.getByLabel(into, { exact: false });
  if (await byLabel.count()) return { box: byLabel.first(), how: 'label lookup', notes: ['matched only by Playwright\'s label lookup, not by name or placeholder'] };
  return null;
}

// --- scenario steps --------------------------------------------------------------------------
// Verbs (combine freely in one step; they run in this order):
//   {"wait": 3000}                          settle
//   {"viewport": [390, 844]}                re-lay out at another size; horizontal scroll is then
//                                           measured and fails the step ("mustBeClean": false notes it)
//   {"click": "Approve", "nth": 0}          click a control by accessible name / text (0-based nth). An
//                                           exact name beats a substring; checkbox, then button, then
//                                           the control wrapper, then text. A checkbox must toggle.
//   {"type": "abc", "into": "Search"}       fill by accessible name/placeholder/label (exact first),
//                                           then Tab so .Value commits
//   "exact": true                           with click/type: refuse a substring-only match
//   {"stable": "lblTotal", "within": 300000, "every": 10000, "reads": 2}
//                                           read a control's text until two reads agree (a chunked
//                                           load shows part totals while it fills); logs time-to-stable,
//                                           FAILS past "within", notes a fill over a minute
//   {"select": "Closed", "nth": 1}          choose an option in the nth <select> (DropDown)
//   {"selected": "Active", "from": "Status"} FAIL unless that dropdown/combo box shows that value. A
//                                           selected value is not on-screen text to "expect" (measured:
//                                           expect failed on a correct default). Without "from": the
//                                           nth <select>
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
      if (step.viewport) {
        // Phone and desktop in one walk: the same session, re-laid out at another width.
        const [vw, vh] = step.viewport;
        await page.setViewportSize({ width: vw, height: vh });
        log(tag + 'viewport ' + vw + 'x' + vh);
        await page.waitForTimeout(Number(step.settle || 2500));
        // Measured after every resize, without being asked: two builds whose layouts switched to
        // the phone branch still left the player wider than the window (App.MinScreenWidth at its
        // default), so a phone user scrolled sideways. Their walks passed; a blind evaluator did not.
        const wide = await horizontalOverflow(page, frame);
        if (wide) {
          const detail = 'viewport ' + vw + 'x' + vh;
          const msg = 'horizontal scroll: content ' + wide + ' px wide in a ' + vw + ' px window (most likely App.MinScreenWidth at its default: set it to 320; canvas-layout.md, "Phone width")';
          if (step.mustBeClean === false) log(tag + 'note: ' + msg);
          else { results.failed.push({ step: i + 1, detail, error: msg }); log(tag + '!! ' + msg); }
        } else log(tag + 'no horizontal scroll at ' + vw + ' px');
      }

      if (step.click) {
        // nth is 0-based, and a gallery keeps every row in the DOM: after a filter, the row
        // you mean is nth 0; a higher nth can hit an unpainted row that swallows the click.
        const nth = Number(step.nth || 0);
        const hit = await clickTarget(frame, String(step.click), nth, !!step.exact);
        if (!hit) throw new Error('nothing clickable matched "' + step.click + '"' + (step.exact ? ' exactly' : ''));
        hit.notes.forEach((n) => log(tag + 'warn: ' + n));
        log(tag + 'click "' + step.click + '"' + (nth ? ' [nth ' + nth + ']' : '') + '  OK  (' + hit.how + ')');
        await page.waitForTimeout(Number(step.settle || 3500));
        // A classic CheckBox's wrapper takes the click and does not toggle: the save then wrote No
        // while every step passed. Read the box again after the settle; unchanged is a failure.
        if (hit.checkbox && hit.before !== null) {
          const after = await checkedState(hit.checkbox);
          if (after === hit.before) throw new Error('checkbox "' + step.click + '" is still ' + (after ? 'checked' : 'unchecked') + ' after the click - the click did not toggle it');
          log(tag + 'checkbox "' + step.click + '" ' + (hit.before ? 'checked -> unchecked' : 'unchecked -> checked'));
        }
      }

      if (step.type !== undefined) {
        // fill() then Tab. A TextInput publishes .Value on BLUR; without it the box shows the
        // text and every formula reading .Value behaves as if nothing was typed.
        const found = await typeTarget(frame, String(step.into), Number(step.nth || 0), !!step.exact);
        if (!found) throw new Error('no text box matched "' + step.into + '"' + (step.exact ? ' exactly' : '') + ' by accessible name, placeholder or label');
        found.notes.forEach((n) => log(tag + 'warn: ' + n));
        const box = found.box;
        await box.waitFor({ state: 'visible', timeout: 30000 });
        await box.click();
        await box.fill(String(step.type));
        if (step.blur !== false) await page.keyboard.press('Tab');
        log(tag + 'type "' + step.type + '" into "' + step.into + '"  OK (' + found.how + '; blurred to commit)');
        await page.waitForTimeout(Number(step.settle || 3000));
      }

      if (step.stable !== undefined) {
        // Read the control's text until it stops changing. One early read of a chunked load records
        // a part total as a defect; one late read hides minutes of blank tiles from the person.
        const within = Number(step.within || 300000), every = Number(step.every || 10000);
        const el = frame.locator('[' + CTRL_ATTR + '="' + String(step.stable).replace(/"/g, '') + '"]').first();
        const samples = []; const t0 = Date.now();
        let v = { stable: false };
        while (Date.now() - t0 <= within) {
          samples.push({ t: Date.now() - t0, text: await el.innerText({ timeout: 5000 }).catch(() => '') });
          v = settleVerdict(samples, { reads: Number(step.reads || 2) });
          if (v.stable) break;
          await page.waitForTimeout(every);
        }
        if (!v.stable) throw new Error('"' + step.stable + '" never read the same twice in ' + Math.round(within / 1000) + ' s (last "' + (samples.at(-1) || {}).text + '")');
        const secs = Math.round(v.at / 1000);
        log(tag + 'stable "' + step.stable + '" = "' + v.value + '" after ' + secs + ' s' + (v.changes ? ' (' + v.changes + ' earlier reading(s))' : ''));
        if (v.at > 60000) log(tag + 'note: ' + secs + ' s to a stable value is itself a finding - the person sees part or blank figures meanwhile');
        results.passed.push('stable:' + step.stable);
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

      if (step.selected !== undefined) {
        // A dropdown's selected value is not visible text inside the canvas, so "expect" cannot see a
        // correct default. Read the control: the named combo box or dropdown opener, else the nth <select>.
        let shown = null, how = '';
        if (step.from) {
          for (const role of ['combobox', 'button']) {
            const el = frame.getByRole(role, { name: String(step.from), exact: false }).first();
            if (await el.count() === 0) continue;
            const v = await el.inputValue().catch(() => '');
            shown = [v, await el.getAttribute('aria-label').catch(() => ''), await el.innerText().catch(() => '')].filter(Boolean).join(' | ');
            how = role; break;
          }
          if (shown === null) throw new Error('no combo box or dropdown named "' + step.from + '"');
        } else {
          const idx = Number(step.nth ?? 0);
          const dd = frame.locator('select').nth(idx);
          await dd.waitFor({ state: 'attached', timeout: 30000 });
          shown = await dd.evaluate((el) => (el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : ''));
          how = 'select[' + idx + ']';
        }
        if (!selectedMatches(shown, step.selected, step.from)) throw new Error((step.from ? '"' + step.from + '"' : how) + ' shows "' + shown + '", not "' + step.selected + '"');
        log(tag + 'selected "' + step.selected + '"' + (step.from ? ' in "' + step.from + '"' : '') + '  OK (' + how + ')');
        results.passed.push('selected:' + step.selected);
      }

      if (step.radio !== undefined) {
        const r = frame.getByRole('radio', { name: String(step.radio), exact: true }).first();
        await r.waitFor({ state: 'visible', timeout: 30000 });
        await r.click({ timeout: 15000 });
        await page.waitForTimeout(600);
        if (!(await r.isChecked().catch(() => true))) throw new Error('radio "' + step.radio + '" is not checked after the click');
        log(tag + 'radio "' + step.radio + '"  OK');
        results.passed.push('radio:' + step.radio);
        await page.waitForTimeout(Number(step.settle || 2000));
      }

      if (step.pick !== undefined) {
        // A classic DropDown in the current player is a button + listbox, not a <select>: open it
        // by its accessible name, then choose the option by role (gallery text cannot match).
        const opener = frame.getByRole('button', { name: step.from, exact: false }).first();
        await opener.waitFor({ state: 'visible', timeout: 30000 });
        await opener.click({ timeout: 15000 });
        await page.waitForTimeout(800);
        // The listbox can render inside the app frame or, as a popup layer, on the outer page.
        const optRole = SEL['player.dropdownOption'].role;
        let opt = frame.getByRole(optRole, { name: String(step.pick), exact: true });
        if (await opt.count() === 0) opt = page.getByRole(optRole, { name: String(step.pick), exact: true });
        await opt.first().click({ timeout: 15000 });
        await page.waitForTimeout(800);
        const now = await opener.getAttribute('aria-label').catch(() => '') || await opener.innerText().catch(() => '');
        if (!String(now).includes(String(step.pick))) throw new Error('dropdown "' + step.from + '" reads "' + now + '" after choosing "' + step.pick + '"');
        log(tag + 'pick "' + step.pick + '" from "' + step.from + '"  OK');
        results.passed.push('pick:' + step.pick);
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
        + (c.dw >= 2 ? '  text ' + c.dw + 'px wider than box' : '') + (c.hidden >= 1 ? '  ' + c.hidden + ' line(s) hidden' : '') + (c.vcut >= 3 ? '  text cut ' + c.vcut + 'px top+bottom (font ' + c.font + 'px)' : '') + '  "' + c.text + '"');
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
const VERBS = new Set(['wait', 'viewport', 'radio', 'pick', 'selected', 'from', 'click', 'nth', 'exact', 'type', 'into', 'blur', 'stable', 'within', 'every', 'reads', 'select', 'fillCell', 'value', 'expect', 'absent',
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
    if ('viewport' in st && !(Array.isArray(st.viewport) && st.viewport.length === 2 && st.viewport.every((n) => Number.isInteger(n) && n >= 200 && n <= 4000))) {
      errs.push(`step ${i + 1}: "viewport" is [width, height] in pixels, for example [390, 844]`);
    }
    if ('pick' in st && !st.from) errs.push(`step ${i + 1}: "pick" needs "from" (the dropdown's accessible name)`);
    if ('from' in st && !('pick' in st || 'selected' in st)) errs.push(`step ${i + 1}: "from" is only used with "pick" or "selected"`);
    if ('selected' in st && !(typeof st.selected === 'string' && st.selected.trim())) errs.push(`step ${i + 1}: "selected" is the value the dropdown must show`);
    if ('radio' in st && !(typeof st.radio === 'string' && st.radio.trim())) errs.push(`step ${i + 1}: "radio" is the option's visible label`);
    if ('exact' in st && !('click' in st || 'type' in st)) errs.push(`step ${i + 1}: "exact" is only used with "click" or "type"`);
    for (const k of ['within', 'every', 'reads']) if (k in st && !('stable' in st)) errs.push(`step ${i + 1}: "${k}" is only used with "stable"`);
    if ('stable' in st && !(typeof st.stable === 'string' && /^[A-Za-z_][\w]*$/.test(st.stable))) errs.push(`step ${i + 1}: "stable" is the control's name (data-control-name), for example lblTotal`);
    if (!keys.some((k) => !['nth', 'exact', 'into', 'from', 'blur', 'value', 'within', 'every', 'reads', 'mustBeClean', 'settle', 'note'].includes(k))) errs.push(`step ${i + 1}: no action or assertion`);
  });
  if (!(sc.steps || []).some((st) => st.expect || st.absent || st.selected || st.stable || st.deadclick || st.clipcheck || st.overlapcheck)) {
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
  const bad = { name: 'a/b', steps: [{ clik: 'Approvals' }, { type: 'x' }, { nth: 1 }, { click: 'Open', nth: -1 },
    { viewport: [390] }, { pick: 'Laptop' }, { from: 'Type' }, { selected: '' }, { radio: '' }, { expect: 'x', exact: true }, { stable: 'lbl Total' }, { expect: 'y', within: 1000 }] };
  const goodPhone = { name: 'phone', steps: [{ viewport: [390, 844] }, { pick: 'Laptop', from: 'Asset type' }, { selected: 'Laptop', from: 'Asset type' }, { selected: 'Open', nth: 1 }, { radio: 'Approved' }, { clipcheck: 'scr' },
    { click: 'Close', exact: true }, { type: 'Leeds', into: 'City', exact: true }, { stable: 'lblTotal', within: 300000, every: 10000, reads: 3 }] };
  const goodWrite = { name: 'edit-then-revert', writes: true, restore: 'revert-edit', steps: [{ fillCell: 0, value: '7.5' }, { expect: 'Saved' }],
    confirm: [{ entitySet: 'app_timeentries', filter: "app_name eq 'TEST-1'", expect: { app_hours: 7.5 }, count: 1 }] };
  const badWrite = { name: 'edit', writes: true, steps: [{ fillCell: 0, value: '7.5' }, { expect: 'Saved' }] };
  const badConfirm = { name: 'c', steps: [{ expect: 'x' }], confirm: [{ entitySet: 'bad set', filter: '', expect: {}, colour: 1 }, { entitySet: 'app_x', filter: 'a eq 1' },
    { entitySet: 'app_x', filter: 'a eq 1', absent: true, expect: { a: 1 } }] };
  const absentOnly = { name: 'w', writes: true, restore: 'r', steps: [{ expect: 'x' }], confirm: [{ entitySet: 'app_x', filter: 'a eq 1', absent: true }] };
  const g = [...lintScenario(good), ...lintScenario(goodWrite), ...lintScenario(goodPhone)];
  const b = [...lintScenario(bad), ...lintScenario(badWrite), ...lintScenario(badConfirm), ...lintScenario(absentOnly)];
  const want = ['file-name safe', 'unknown verb', 'needs "into"', 'no action', '0-based', 'asserts nothing', 'no "restore"', 'no "confirm"',
    'entity set name', '"filter" is required', 'unknown key', 'object of column', 'asserts nothing: give', 'cannot be combined',
    '[width, height]', '"pick" needs "from"', 'only used with "pick" or "selected"', 'value the dropdown must show', 'visible label', '"exact" is only used', '(data-control-name)', 'only used with "stable"'];
  // Tab hygiene: what tidy treats as blank, as the Studio editor, and as anything else.
  const T = [['about:blank', 'blank'], ['chrome-error://chromewebdata/', 'blank'], ['edge://newtab/', 'blank'],
    ['https://make.powerapps.com/e/E/canvas/?action=edit&app-id=x', 'studio'], ['https://make.powerapps.com/e/E/apps', 'other'],
    ['https://apps.powerapps.com/play/e/E/a/A', 'other']];
  const tabs = T.filter(([u, want]) => tabKind(u) !== want).map(([u, want]) => u + ' -> ' + tabKind(u) + ' (want ' + want + ')');
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
  // Connection helpers: who the token is for, which parameter needs consent, host comparison, the confirm step.
  const fakeJwt = 'x.' + Buffer.from(JSON.stringify({ upn: 'maker@example.com', oid: 'o1' })).toString('base64').replace(/=+$/, '') + '.y';
  const C = [
    ['jwt upn', jwtClaims(fakeJwt).upn === 'maker@example.com'],
    ['jwt garbage', Object.keys(jwtClaims('nope')).length === 0],
    ['oauth found', (oauthParameter({ properties: { connectionParameters: { token: { type: 'oauthSetting', oAuthSettings: { redirectUrl: 'https://r' } } } } }) || {}).redirectUrl === 'https://r'],
    ['no oauth', oauthParameter({ properties: { connectionParameters: { key: { type: 'securestring' } } } }) === null],
    ['same host', sameHost('https://org.crm.dynamics.com/', 'https://ORG.crm.dynamics.com')],
    ['other host', !sameHost('https://org1.crm.dynamics.com/', 'https://org2.crm.dynamics.com')],
    ['confirm step', rx('consent.confirmUrl').test('https://unitedstates-002.consent.azure-apim.net/confirm?state=s&code=abc')],
    ['not confirm', !rx('consent.confirmUrl').test('https://global.consent.azure-apim.net/redirect/x?code=abc')],
  ].filter(([, okc]) => !okc).map(([k]) => 'connection: ' + k);
  tabs.push(...C);
  const P = [
    ['unchanged source refused', publishRefused('h1', { hash: 'h1' }, false)],
    ['--again publishes', !publishRefused('h1', { hash: 'h1' }, true)],
    ['changed source publishes', !publishRefused('h2', { hash: 'h1' }, false)],
    ['first publish', !publishRefused('h1', undefined, false)],
    ['no source found publishes', !publishRefused(null, { hash: null }, false)],
    ['terms dialog selector covers dialog and alertdialog', /\[role="dialog"\]/.test(COAUTHOR_TERMS) && /alertdialog/.test(COAUTHOR_TERMS) && /Accept/.test(COAUTHOR_TERMS)],
    ['autoTidy skips holding commands', NO_TIDY.has('studio') && NO_TIDY.has('close-studio') && !NO_TIDY.has('walk')],
    ['profile copy leaves out locks and caches', !profileCopyFilter('C:/p/SingletonLock') && !profileCopyFilter('C:/p/Default/Cache') && !profileCopyFilter('C:/p/Default/Code Cache') && !profileCopyFilter('C:/p/Default/Service Worker')],
    ['profile copy keeps the sign-in', profileCopyFilter('C:/p/Default/Network/Cookies') && profileCopyFilter('C:/p/Local State') && profileCopyFilter('C:/p/Default/Login Data')],
    ['first and second publish need no review', reviewMissing(0, [], '').length === 0 && reviewMissing(1, [], '').length === 0],
    ['third publish needs critique and review', reviewMissing(2, [], '').length === 2],
    ['third publish with both passes', reviewMissing(2, REVIEW_FILES, '').length === 0],
    ['third publish names the one missing', reviewMissing(3, ['docs/design-critique.md'], '').join() === 'docs/review/findings.json'],
    ['--unreviewed overrides', reviewMissing(5, [], 'Studio-only fix').length === 0],
    ['before the fix batch publishes', !afterBatchRefused([{ hash: 'a' }, { hash: 'b' }], '', '')],
    ['after the fix batch refused', afterBatchRefused([{ hash: 'a' }, { hash: 'b', fixBatch: true }], '', '')],
    ['a declared batch publishes once', !afterBatchRefused([{ hash: 'a', fixBatch: true }], '', 'owner change: status names')],
    ['after a declared batch refused', afterBatchRefused([{ hash: 'a', fixBatch: true }, { hash: 'b', batch: 'x' }], '', '')],
    ['--unreviewed overrides after the batch', !afterBatchRefused([{ hash: 'a', fixBatch: true }], 'Studio-only label', '')],
    ['sources all present', missingSources([{ display: 'Loan Assets', logical: 'x_asset' }, { display: 'Loans', logical: 'x_loan' }], 'Data\nLoan Assets\nLoans\nOffice 365').length === 0],
    ['source dropped on save named', missingSources([{ display: 'Loan Assets', logical: 'x_asset' }, { display: 'Equipment Loans', logical: 'x_loan' }], 'Data\nLoan Assets\nOffice 365').map((t) => t.logical).join() === 'x_loan'],
    ['empty pane misses all', missingSources([{ display: 'A', logical: 'x_a' }], '').length === 1],
    ['blank display falls back to logical', missingSources([{ display: '', logical: 'x_a' }], 'nothing here').length === 1],
  ].filter(([, okc]) => !okc).map(([k]) => 'publish/tabs: ' + k);
  tabs.push(...P);
  // Save proof: a stamp older than the click is the previous save, not this one.
  const click = new Date(2026, 0, 1, 10, 40, 5);
  const S = [
    ['stamp 12 minutes old is UNPROVEN', stampVerdict('10:28:27', null, click) === 'old'],
    ['old stamp with AM/PM', stampVerdict('Today at 10:28 AM', null, click) === 'old'],
    ['stamp after the click lands', stampVerdict('10:40:31', '10:28:27', click) === 'landed'],
    ['minute stamp of the click minute lands', stampVerdict('10:40 AM', null, click) === 'landed'],
    ['unchanged stamp', stampVerdict('10:28:27', '10:28:27', click) === 'unchanged'],
    ['no stamp', stampVerdict(null, null, click) === 'none'],
    ['no time in the stamp', stampVerdict('just now', null, click) === 'landed-untimed'],
    ['PM parsed', stampTime('Saved 2:05 PM', click).t.getHours() === 14],
    ['yesterday late is old', stampVerdict('11:59:00 PM', null, click) === 'old'],
    // second-tab must leave the held tab open until after publish (closing it first lost the push).
    ['second-tab closes no tab', !secondTabClosesTabs()],
    // save / publish / dirty use the tab whose authoring frame holds a Save button, not the newest.
    ['save tab: the older tab with Save wins over a blank newest', (pickSaveTab([{ i: 0, saveButtons: 0, textLen: 0 }, { i: 1, saveButtons: 1, textLen: 2000 }]) || {}).i === 1],
    ['save tab: rendered beats unrendered', (pickSaveTab([{ i: 0, saveButtons: 1, textLen: 0 }, { i: 1, saveButtons: 1, textLen: 900 }]) || {}).i === 1],
    ['save tab: none holds Save', pickSaveTab([{ i: 0, saveButtons: 0, textLen: 50 }]) === null],
    ['disconnect dialog recognised', rx('studio.disconnected').test('There’s been a disconnect') && rx('studio.disconnected').test("There's been a disconnect")],
    // publish records the hash the last clean push sent; a failed push records nothing.
    ['publish hash: the last clean push', publishHash({ hash: 'p1', at: 't' }, 'd2').hash === 'p1'],
    ['publish hash: no push record -> source', publishHash(null, 'd2').hash === 'd2'],
    ['after a failed push the publish is refused', publishRefused(publishHash({ hash: 'p1' }, 'd2').hash, { hash: 'p1' }, false)],
    ['publish: a confirm left open anywhere fails the publish', publishDialogLeftOpen([2]) && !publishDialogLeftOpen([])],
    ['walk: a flag value is not a scenario', positionals(['a.json', '--config', 'cfg.json', 'b.json', '--headless', 'c.json']).join() === 'a.json,b.json,c.json'],
    ['walk: a boolean flag keeps the next positional', positionals(['--allow-writes', 'walks', '--settle', '5000']).join() === 'walks'],
    ['selected: the value after the name', selectedMatches('Status | Active', 'Active', 'Status') && selectedMatches('Asset type Laptop', 'Laptop', 'Asset type')],
    ['selected: another value fails', !selectedMatches('Status | Inactive', 'Active', 'Status') && !selectedMatches('Status', 'Status', 'Status')],
    ['close-studio: editor gone is closable', editorGone({ stillEditing: true, back: false, leave: false, preview: false }) && !editorGone({ stillEditing: true, back: true })],
    ['dirty: formula text normalised', formulaText('clrWhite  \n') === 'clrWhite'],
    ['dirty: toggle never types (auto-close)', /insertText/.test(cmdDirty.toString()) && /ControlOrMeta\+A/.test(cmdDirty.toString())],
    // clipcheck reports text cut at the top and the bottom, not only whole hidden lines.
    ['clipcheck measures vertical cuts', /vcut/.test(MEASURE.clipped.toString()) && /createRange/.test(MEASURE.clipped.toString())],
    // Never launch Chrome on Windows while the person's Chrome runs (it opens a tab in their browser).
    ['channel: Chrome running on Windows -> Edge, remembered', (() => { const d = pickChannel({ given: false, requested: 'chrome', platform: 'win32', sticky: '', chromeRunning: () => true }); return d.channel === 'msedge' && d.remember; })()],
    ['channel: no Chrome running -> Chrome', pickChannel({ given: false, requested: 'chrome', platform: 'win32', sticky: '', chromeRunning: () => false }).channel === 'chrome'],
    ['channel: the remembered browser wins', pickChannel({ given: false, requested: 'chrome', platform: 'win32', sticky: 'msedge', chromeRunning: () => false }).channel === 'msedge'],
    ['channel: --channel always wins', pickChannel({ given: true, requested: 'chrome', platform: 'win32', sticky: 'msedge', chromeRunning: () => true }).channel === 'chrome'],
    ['channel: not Windows -> no process check', pickChannel({ given: false, requested: 'chrome', platform: 'darwin', sticky: '', chromeRunning: () => { throw new Error('checked'); } }).channel === 'chrome'],
  ];
  // Playwright from the project: the working folder, then subfolders holding node_modules (portal/).
  try {
    const tmp = join(tmpdir(), 'pwroots-' + randomUUID().slice(0, 8));
    mkdirSync(join(tmp, 'portal', 'node_modules'), { recursive: true }); mkdirSync(join(tmp, 'docs'), { recursive: true });
    const r = playwrightRoots(tmp, null);
    S.push(['playwright roots: cwd then portal/', r[0] === tmp && r.includes(join(tmp, 'portal')) && !r.includes(join(tmp, 'docs'))]);
    rmSync(tmp, { recursive: true, force: true });
  } catch (e) { S.push(['playwright roots: ' + e.message, false]); }
  tabs.push(...S.filter(([, okc]) => !okc).map(([k]) => 'save/second-tab/clip: ' + k));
  // Target matching: an exact name beats a substring, and a tie is reported (walks 34, 36, 37).
  const box = (names, visible = true) => ({ names, visible });
  const M = [
    ['exact beats substring: into City', rankTargets('City', [box(['Search city']), box(['City'])]).best === 1],
    ['exact beats substring: click RAR', rankTargets('RAR', [box(['New RAR']), box(['RAR'])]).best === 1],
    ['case-only difference is tier 1', rankTargets('city', [box(['Search city']), box(['City'])]).tier === 1],
    ['substring still found when nothing is exact', rankTargets('City', [box(['Search city'])]).tier === 2],
    ['exactOnly refuses a substring-only match', rankTargets('City', [box(['Search city'])], { exactOnly: true }).best === -1],
    ['two exact matches are reported as tied', rankTargets('Close', [box(['Close']), box(['Dismiss']), box(['Close'])]).tied.length === 2],
    ['placeholder counts as a name', rankTargets('Reason', [box(['txtNotes', 'Notes']), box(['txtReason', 'Reason'])]).best === 1],
    ['a visible match beats a hidden exact one', rankTargets('City', [box(['City'], false), box(['Search city'])]).best === 1],
    ['hidden matches count when none is visible', rankTargets('City', [box(['City'], false)]).best === 0],
    ['no match', rankTargets('City', [box(['Country'])]).best === -1],
    ['whitespace normalised', matchTier('  Save  record ', 'Save record') === 0],
    ['clicked control named otherwise is flagged', nameMismatch('Submit', 'Date picker: choose a date')],
    ['clicked control containing the text is not', !nameMismatch('Submit', 'Submit request') && !nameMismatch('Submit', '')],
    ['exactRx is whole-name and case-insensitive', exactRx('New RAR').test(' new  rar ') && !exactRx('RAR').test('New RAR') && exactRx('a.b (x)').test('a.b (x)') && !exactRx('a.b').test('axb')],
    // A chunked load: blank, a part total, then the full total twice.
    ['part total is not stable', settleVerdict([{ t: 0, text: '' }, { t: 10, text: '34.6M' }, { t: 20, text: '45.8M' }]).stable === false],
    ['stable on two equal reads, timed at the first', (() => { const v = settleVerdict([{ t: 0, text: '' }, { t: 10, text: '34.6M' }, { t: 20, text: '45.8M' }, { t: 30, text: '45.8M' }]); return v.stable && v.value === '45.8M' && v.at === 20; })()],
    ['blank reads never count as stable', settleVerdict([{ t: 0, text: '' }, { t: 10, text: ' ' }]).stable === false],
    ['reads: 3 needs three equal reads', settleVerdict([{ t: 0, text: '$0' }, { t: 10, text: '$0' }], { reads: 3 }).stable === false],
  ];
  tabs.push(...M.filter(([, okc]) => !okc).map(([k]) => 'target matching: ' + k));
  const ok = g.length === 0 && missing.length === 0 && sel.length === 0 && judged.length === 0 && tabs.length === 0;
  log(ok ? `selftest ok: bad scenarios -> ${b.length} findings, good scenarios -> 0, ${J.length} Dataverse confirmation cases judged, ${T.length} tab kinds classified, 8 connection cases, 23 publish-guard, review-gate, fix-batch, data-source, profile-copy, terms-dialog and auto-tidy cases, ${S.length} save-stamp, second-tab, clipcheck, channel and Playwright-lookup cases, ${M.length} target-matching and settle cases, selector table: ${Object.keys(SEL).length} entries valid and in step with the defaults`
         : `selftest FAILED: good -> [${g.join('; ')}], missing on bad -> [${missing.join(', ')}], confirmation -> [${judged.join('; ')}], selector table -> [${sel.join('; ')}], tabs -> [${tabs.join('; ')}]`);
  process.exit(ok ? 0 : 1);
}

// --- commands --------------------------------------------------------------------------------
async function cmdLogin() {
  const ctx = await launch({ headless: false });
  const page = await freshPage(ctx);
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
  const page = await freshPage(ctx);
  await page.goto(tpl('portal.makerHome'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const ok = await isSignedIn(page);
  log(ok ? 'SIGNED IN (the saved profile is still good)' : 'NOT SIGNED IN - run: node canvas-browser.mjs login');
  await capture(page, 'check');
  await ctx.close();
  process.exitCode = ok ? 0 : 2;
}

async function openPlayer(ctx, errors, trace) {
  const page = await freshPage(ctx);
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

// walk <a.json> [b.json ...] | walk <folder>: every scenario in one call. A measured build made 81
// separate walk calls; each one re-sent the whole conversation. One call runs them in order (writes
// still need --allow-writes) and ends with a one-line-per-scenario summary.
async function cmdWalk() {
  const args = positionals(argv.slice(1)).filter((a) => !/^\d+$/.test(a));
  let files = [];
  for (const a of args) {
    let st = null; try { st = statSync(resolve(a)); } catch { /* missing */ }
    if (st && st.isDirectory()) files.push(...readdirSync(resolve(a)).filter((f) => /\.json$/i.test(f) && !/\.result\.json$/i.test(f)).sort().map((f) => join(a, f)));
    else files.push(a);
  }
  if (!files.length) { log('usage: canvas-browser.mjs walk <scenario.json> [more.json ...] | walk <folder>'); process.exitCode = 1; return; }
  const summary = [];
  for (const f of files) {
    process.exitCode = 0;
    const v = await walkOne(f);
    summary.push([v || 'FAIL', f, process.exitCode || 0]);
  }
  const counted = summary.filter((x) => x[0] !== 'SKIP');
  if (files.length > 1) {
    log('\n=== WALKS: ' + counted.filter((x) => x[0] === 'PASS').length + ' of ' + counted.length + ' pass' +
        (counted.length < summary.length ? ', ' + (summary.length - counted.length) + ' skipped (writes)' : '') + ' ===');
    for (const [v, f, c] of summary) log('  ' + v.padEnd(5) + ' ' + f + (c && v !== 'PASS' && v !== 'SKIP' ? '  (exit ' + c + ')' : ''));
  }
  process.exitCode = counted.every((x) => x[0] === 'PASS') ? 0 : (counted.find((x) => x[0] !== 'PASS')[2] || 4);
}

// Every walk that wrote production data is logged in the work folder. The plugin's Stop gate reads
// it: a seed check (seed-data.py check, which logs its own result there) must be clean and newer
// than the last write before the build hands back. A measured build restored its seed, then ran
// more walks that returned seeded loans, and handed back saying the seed held.
const WRITES_LOG = () => join(resolve(REPO, APP.workDir || '.ship-work'), 'writes.json');
function logWrite(name) {
  try {
    let w = []; try { w = JSON.parse(readFileSync(WRITES_LOG(), 'utf8')); } catch { /* first */ }
    w.push({ at: new Date().toISOString(), scenario: name });
    mkdirSync(dirname(WRITES_LOG()), { recursive: true });
    writeFileSync(WRITES_LOG(), JSON.stringify(w.slice(-100), null, 1));
  } catch { /* unwritable work folder */ }
}

async function walkOne(file) {
  needApp();
  const scenario = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const problems = lintScenario(scenario);
  if (problems.length) { problems.forEach((e) => log('BAD  ' + e)); process.exitCode = 1; return; }
  if (scenario.writes === true && has('skip-writes')) {
    log('SKIP: "' + scenario.name + '" writes production data (--skip-writes: a read-only pass, e.g. the reviewer\'s).');
    return 'SKIP';
  }
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
  if (scenario.writes === true) logWrite(scenario.name);
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
  refreshSnapshot();
  process.exitCode = verdict === 'PASS' ? 0 : 4;
  return verdict;
}

// The process that holds Studio open writes its pid beside the profile, so close-studio can end it
// when the browser or the editor is already gone (a live holder keeps the profile: the next `studio`
// then fails PROFILE IN USE and a chained compile runs with no session).
const HOLDER_PID = () => PROFILE.replace(/[\\/]+$/, '') + '.studio-pid';
// `studio --reload`: reload the held Studio tab right before a push. A Studio left idle (after a
// publish) drops its co-authoring connection, and a push then lands where no Studio is attached.
async function studioReload() {
  const { browser, ctx } = await attach();
  const { page } = await editingTab(ctx);
  if (!page || !isStudioTab(page)) { log('  !! no Studio tab in the held browser - run `studio`.'); await browser.close(); process.exitCode = 3; return; }
  page.on('dialog', async (d) => { await d.accept().catch(() => {}); });
  log('  reloading Studio before the push (nothing should be held now: a reload drops an unsaved push)');
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const r = await waitForStudioMode(page);
  if (r.ready) {
    const scan = await tabScan(page);
    if (scan.disconnected) { log('  !! still shows "There\'s been a disconnect" after the reload.'); process.exitCode = 3; }
    else log('  STUDIO READY (Editing) - connect and push now.');
  }
  await browser.close();
}
// Wait for (Editing) or (Read-only) in the title. Not ready on read-only or timeout: exit non-zero so a
// chained compile never runs against a Studio that is not editing.
async function waitForStudioMode(page) {
  log('Waiting for the editor (slow; up to 3 minutes) ...');
  let title = '';
  for (let i = 0; i < 36; i++) {
    await page.waitForTimeout(5000);
    title = await page.title().catch(() => '');
    if (rx('studio.titleEditing').test(title) || rx('studio.titleReadOnly').test(title)) break;
  }
  log('  window title: ' + (title || '(none yet)'));
  if (rx('studio.titleReadOnly').test(title)) {
    log('  !! READ-ONLY: an edit lock is stranded (a tab was killed instead of closed via Back).');
    log('     A compile will not persist from here. STUDIO NOT READY - stop the chain.');
    process.exitCode = 3;
    return { ready: false, title };
  }
  if (!rx('studio.titleEditing').test(title)) {
    log('  !! Studio did not reach edit mode in 3 minutes. STUDIO NOT READY - stop the chain.');
    process.exitCode = 3;
    return { ready: false, title };
  }
  return { ready: true, title };
}

async function cmdStudio() {
  needApp();
  if (has('reload')) return studioReload();
  const ctx = await launch({ headless: false, debugPort: DEBUG_PORT });
  const page = await freshPage(ctx);
  log('Opening Studio in EDIT mode:\n  ' + STUDIO_URL);
  await page.goto(STUDIO_URL, { waitUntil: 'domcontentloaded' });
  if (!(await isSignedIn(page))) { log('NOT SIGNED IN - run `login` first.'); await ctx.close(); process.exitCode = 2; return; }
  // The diagnosis of a stranded edit lock is one word in the title, stated nowhere else.
  const mode = await waitForStudioMode(page);
  await capture(page, 'studio');
  if (!mode.ready) {
    // Quit, so the profile is free and the exit code reaches the chain: measured, a failed `studio`
    // followed by a compile pushed nothing, and save + publish re-published the old app.
    await ctx.close().catch(() => {});
    process.exit(3);
  }
  log('  STUDIO READY (Editing). Now connect the authoring MCP, then compile.');
  log('  The push BLANKS the screen - that is the push arriving. A RELOAD DISCARDS THE PUSH.');
  log('  Save with `canvas-browser.mjs save` (clicks the button; Ctrl+S hits the outer shell).');
  try { writeFileSync(HOLDER_PID(), String(process.pid)); } catch { /* read-only home */ }
  process.on('exit', () => { try { if (readFileSync(HOLDER_PID(), 'utf8').trim() === String(process.pid)) rmSync(HOLDER_PID(), { force: true }); } catch { /* gone */ } });
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
  // A new app (or a fresh browser profile) opens on "Welcome to Power Apps Studio", whose modal
  // overlay intercepts every click until Skip.
  for (const c of locsOf(frame, 'studio.welcomeSkip')) {
    try {
      if (await c.first().count() > 0 && await c.first().isVisible()) {
        // "Don't show me this again" stops it returning after every refresh of this profile.
        const dont = frame.locator(css('studio.welcomeDontShow')).first();
        if (await dont.count() > 0 && !(await dont.isChecked().catch(() => true))) await dont.check({ timeout: 3000, force: true }).catch(() => {});
        await c.first().click({ timeout: 5000 }); n++; log('  dismissed "Welcome to Power Apps Studio" (Skip)');
      }
    } catch { /* none */ }
  }
  for (const c of locsOf(frame, 'studio.gotIt')) {
    try { if (await c.first().count() > 0 && await c.first().isVisible()) { await c.first().click({ timeout: 5000 }); n++; log('  dismissed a teaching bubble ("Got it")'); } }
    catch { /* none */ }
  }
  n += await coauthoringTerms(frame);
  return n;
}

// "Accept Coauthoring preview terms?" (Accept / Decline) blocks Studio until answered. A measured
// build stalled on it with three Studio tabs open and wrote throwaway scripts to click it. The skill
// turns Coauthoring on (the authoring server needs it), so accepting is the recommendation and an
// up-front decision: "acceptCoauthoringTerms": false in scripts/canvas-app.json stops here instead.
const COAUTHOR_TERMS = ['[role="dialog"]', '[role="alertdialog"]'].map((r) => r + ':has-text("Coauthoring preview terms") button:has-text("Accept")').join(', ');
async function coauthoringTerms(frame) {
  const frames = [frame];
  try { for (const f of frame.page().frames()) if (!frames.includes(f)) frames.push(f); } catch { /* detached */ }
  for (const f of frames) {
    try {
      const b = f.locator(COAUTHOR_TERMS).first();
      if (!(await b.count()) || !(await b.isVisible())) continue;
      if (APP.acceptCoauthoringTerms === false) {
        log('  !! Studio asks to accept the Coauthoring preview terms; "acceptCoauthoringTerms" is false, so not answering. Ask the person, then re-run.');
        process.exitCode = 9; return 0;
      }
      await b.click({ timeout: 5000 });
      log('  accepted the Coauthoring preview terms (Studio refreshes the app; "acceptCoauthoringTerms": false in canvas-app.json stops this)');
      return 1;
    } catch { /* next frame */ }
  }
  return 0;
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

// The time of day in a "Saved: <time>" stamp ("10:28:27", "10:28 AM", "Today at 3:05 PM"), as a Date on
// the click's day (the day before when that would be in the future). null when the stamp has no time.
function stampTime(stamp, ref) {
  const m = String(stamp || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[4]) { const pm = /p/i.test(m[4]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  const t = new Date(ref); t.setHours(h, Number(m[2]), m[3] ? Number(m[3]) : 0, 0);
  if (t.getTime() - ref.getTime() > 5 * 60000) t.setDate(t.getDate() - 1);
  return { t, seconds: !!m[3] };
}
// Did this click save? 'landed' (a stamp at or after the click), 'old' (a stamp from before the click:
// the flyout's previous save, not this one), 'unchanged', 'none' (no stamp read), or 'landed-untimed'.
function stampVerdict(after, before, clickedAt) {
  if (!after) return 'none';
  if (after === before) return 'unchanged';
  const s = stampTime(after, clickedAt);
  if (!s) return 'landed-untimed';
  // A stamp without seconds covers its whole minute; 30 s allows for the clocks of two machines.
  const latest = s.t.getTime() + (s.seconds ? 999 : 59999);
  return latest < clickedAt.getTime() - 30000 ? 'old' : 'landed';
}

// What a tab is, by URL alone: a Studio editor, a blank/new-tab/crashed page, or anything else.
function tabKind(url) {
  if (rx('browser.blankUrl').test(url)) return 'blank';
  if (rx('portal.makerUrl').test(url) && rx('studio.canvasRoute').test(url)) return 'studio';
  return 'other';
}
const isStudioTab = (p) => tabKind(p.url()) === 'studio';

function studioPage(ctx) {
  // The NEWEST Studio tab: after a push that blanked the first tab, a second tab joins the held
  // session and is the one that renders (and saves) the pushed document.
  return ctx.pages().filter(isStudioTab).pop() || ctx.pages().filter((p) => rx('portal.makerUrl').test(p.url())).pop() || ctx.pages()[0];
}

// The Studio tab that can SAVE: the one whose authoring frame holds a Save button. Not the newest tab:
// measured, after a push blanked Studio a second tab joined and then went blank too, while the OLDER tab
// re-rendered with the Save button; `save` on the newest tab reported "no Save button" for five minutes.
// Scan each Studio tab (newest first) and print what each holds, so the choice is visible.
async function tabScan(page) {
  let saveButtons = 0; let textLen = 0; let disconnected = false;
  for (const f of page.frames()) {
    if (!rx('studio.authoringFrameUrl').test(f.url())) continue;
    try {
      saveButtons += await f.locator(css('studio.saveButton')).count();
      const t = await f.evaluate(() => (document.body ? document.body.innerText : ''));
      textLen += t.length;
      if (rx('studio.disconnected').test(t)) disconnected = true;
    } catch { /* detached */ }
  }
  return { saveButtons, textLen, disconnected };
}
export function pickSaveTab(scans) {
  // scans: [{ i, saveButtons, textLen }] newest first. A tab with a Save button and a rendered editor wins.
  return scans.find((s) => s.saveButtons > 0 && s.textLen > 0) || scans.find((s) => s.saveButtons > 0) || null;
}
async function editingTab(ctx) {
  const tabs = ctx.pages().filter(isStudioTab).reverse();
  if (tabs.length === 0) return { page: studioPage(ctx), scan: null };
  const scans = [];
  for (const [i, p] of tabs.entries()) scans.push({ i, ...(await tabScan(p)) });
  if (tabs.length > 1) {
    for (const s of scans) log('  studio tab ' + (tabs.length - s.i) + '/' + tabs.length + ': Save buttons ' + s.saveButtons + ', editor text ' + s.textLen + (s.disconnected ? ', DISCONNECTED' : ''));
  }
  const pick = pickSaveTab(scans);
  if (pick && tabs.length > 1) log('  using studio tab ' + (tabs.length - pick.i) + ' (it holds the Save button)');
  return pick ? { page: tabs[pick.i], scan: pick } : { page: tabs[0], scan: scans[0] };
}
// A Studio left idle after a publish drops its co-authoring connection ("There's been a disconnect").
// A push then reports PUSHED CLEAN into a session no Studio is attached to, and Save is blocked.
const DISCONNECT_NOTE = '     The co-authoring connection dropped: a push since then went to a session no Studio is attached to.\n'
  + '     Reload Studio (`studio --reload`), push again, then save.';

// --- tab hygiene ------------------------------------------------------------------------------
// Every tab a run leaves open is one more for the person to close, and an extra Studio tab
// competes for the edit lock. `tabs` lists them; `tidy` closes what nothing is using.
const allPages = (browser) => browser.contexts().flatMap((c) => c.pages());

async function cmdTabs() {
  const { browser, ctx } = await attach();
  const held = studioPage(ctx);
  const pages = allPages(browser);
  for (const [i, p] of pages.entries()) {
    const kind = tabKind(p.url());
    const title = await p.title().catch(() => '?');
    log('  ' + String(i + 1).padStart(2) + '  ' + (p === held && kind === 'studio' ? 'HELD  ' : kind.padEnd(6)) + '  ' + (title || '(no title)').slice(0, 60) + '  |  ' + p.url().slice(0, 110));
  }
  log('  ' + pages.length + ' tab(s); ' + pages.filter((p) => tabKind(p.url()) === 'blank').length + ' blank. `tidy` closes the blank ones.');
  await browser.close(); // detaches; the browser stays up
}

async function cmdTidy() {
  const { browser, ctx } = await attach();
  const dry = has('dry-run');
  const held = studioPage(ctx);
  const pages = allPages(browser);
  const close = [];
  for (const p of pages) {
    const kind = tabKind(p.url());
    if (kind === 'blank') close.push([p, 'blank']);
    else if (kind === 'other' && has('all')) close.push([p, 'not Studio (--all)']);
    else if (kind === 'studio' && p !== held && has('studio')) close.push([p, 'older Studio tab (--studio)']);
  }
  // Closing the last tab quits the browser (and ends a held `studio` process): keep one.
  if (close.length && close.length === pages.length) close.shift();
  let closed = 0;
  for (const [p, why] of close) {
    const url = p.url();
    if (!dry && tabKind(url) === 'studio') {
      p.on('dialog', async (d) => { await d.accept().catch(() => {}); });
      const r = await leaveEditor(p);
      if (r.stillEditing) { log('  kept         ' + url.slice(0, 110) + '  (still in the editor; leave it by hand)'); continue; }
    }
    if (!dry) await p.close({ runBeforeUnload: false }).catch(() => {});
    closed++;
    log('  ' + (dry ? 'would close ' : 'closed ') + why.padEnd(28) + url.slice(0, 110));
  }
  log('  ' + (dry ? 'dry run: ' + closed + ' would close, ' + (pages.length - closed) : closed + ' closed, ' + allPages(browser).length) + ' open'
    + (held && isStudioTab(held) ? '; held Studio tab kept: ' + held.url().slice(0, 90) : '') + '.');
  await browser.close();
}

async function framesText(page) {
  let text = '';
  for (const f of page.frames()) { try { text += '\n' + await f.evaluate(() => (document.body ? document.body.innerText : '')); } catch { /* detached */ } }
  return text;
}

// After a push blanked the Studio tab, a SECOND tab on the same edit URL joins the held
// co-authoring session and renders the pushed document. `save`, `publish` and `dirty` then use
// whichever Studio tab holds the Save button (often the older one re-renders first). Never opened on
// a new-blank URL: that would create another app.
async function cmdSecondTab() {
  const { browser, ctx } = await attach();
  const first = ctx.pages().find(isStudioTab);
  const url = APP.appId && APP.environmentId ? STUDIO_URL : first && rx('studio.editUrl').test(first.url()) ? first.url() : null;
  if (!url) { log('  no app in the config and no Studio tab on an edit URL - nothing to join.'); await browser.close(); process.exitCode = 1; return; }
  const names = String(flag('expect', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const page = await ctx.newPage();
  log('  second Studio tab: ' + url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now(); let text = ''; let title = '';
  while (Date.now() - t0 < Number(flag('wait-for', 240000))) {
    await page.waitForTimeout(5000);
    for (const f of page.frames().filter((x) => rx('studio.authoringFrameUrl').test(x.url()))) await dismissBubbles(f).catch(() => 0);
    title = await page.title().catch(() => '');
    text = await framesText(page);
    if (rx('studio.titleReadOnly').test(title)) break;
    if (rx('studio.titleEditing').test(title) && names.every((n) => text.includes(n))) break;
  }
  for (const n of names) log('  ' + (text.includes(n) ? 'FOUND   ' : 'MISSING ') + n);
  if (names.some((n) => !text.includes(n))) log(TREE_TEXT_NOTE);
  log('  title: ' + title + (rx('studio.titleReadOnly').test(title) ? '  !! READ-ONLY: this tab did not join the editing session' : ''));
  await capture(page, 'studio-second-tab');
  if (names.some((n) => !text.includes(n))) process.exitCode = 6;
  // The older (held) Studio tab is NEVER closed here. Closing it before the save is the order that
  // loses the push: measured, Save then reported a new stamp, publish succeeded, and the published
  // package had none of the pushed screens. Every Studio tab stays open until after publish;
  // close-studio leaves and closes them all (or `tidy --studio` once the publish is proven).
  const older = ctx.pages().filter((p) => p !== page && isStudioTab(p)).length;
  if (older) log('  kept ' + older + ' older Studio tab(s) open on purpose: closing one before save and publish loses the push. close-studio closes them after publish.');
  log('  save / publish / dirty use whichever Studio tab holds a Save button; close-studio leaves every Studio tab.');
  await browser.close();
}
const TREE_TEXT_NOTE = '  (MISSING reads the rendered tree text, which is virtualised: it is not proof of absence. Confirm a push by reading a pushed'
  + ' control\'s property in the formula bar, or in the published package.)';
// --selftest: second-tab must close nothing but its own CDP connection.
const secondTabClosesTabs = () => /\.close\(/.test(cmdSecondTab.toString().replace(/browser\.close\(\)/g, ''));

// Is a pushed control actually in the editor? Read the held tab's tree view and canvas text.
async function cmdStudioHas() {
  const names = positionals(argv.slice(1));
  if (!names.length) { log('usage: canvas-browser.mjs studio-has <controlName...>'); process.exitCode = 1; return; }
  const { browser, ctx } = await attach();
  const studio = studioPage(ctx);
  const text = await framesText(studio);
  for (const n of names) log('  ' + (text.includes(n) ? 'FOUND   ' : 'MISSING ') + n);
  log('  tab: ' + await studio.title().catch(() => '?'));
  if (names.some((n) => !text.includes(n))) { log(TREE_TEXT_NOTE); process.exitCode = 6; }
  await browser.close();
}

// After a co-authoring push, Studio can hold the document with Save disabled (nothing "changed"
// locally). Default: a space appended to the selected property's formula, committed with Tab, makes the
// buffer dirty without changing what the formula means. That was not always enough: twice in a row a
// clean push left Save disabled within 2 s, and re-entering the same value did not mark Studio dirty.
// What did: change one PUSHED property to another value and back (Color clrWhite -> clrNavy -> clrWhite);
// Save then persisted the whole pushed state. `dirty --toggle <formula>` does exactly that through the
// formula bar of the selected property and reads the original back. Never through a toolbar dropdown:
// opening the wrong one wrote Font.Arial over a font token on that control.
export function formulaText(t) { return String(t || '').replace(/\u00a0/g, ' ').replace(/\s+$/, ''); }
async function saveEnabled(page) {
  const hit = await editorControl(page, css('studio.saveButton'));
  if (!hit) return null;
  try { return !(await hit.ctl.isDisabled()) && (await hit.ctl.getAttribute('aria-disabled')) !== 'true'; } catch { return null; }
}
async function cmdDirty() {
  const { browser, ctx } = await attach();
  const { page: studio } = await editingTab(ctx);
  if (rx('studio.titleReadOnly').test(await studio.title())) { log('  READ-ONLY - nothing can be saved from here.'); await browser.close(); process.exitCode = 3; return; }
  const toggle = typeof flag('toggle', '') === 'string' ? String(flag('toggle', '')).replace(/^=/, '') : '';
  let f = null;
  for (const x of studio.frames()) {
    if (!rx('studio.authoringFrameUrl').test(x.url())) continue;
    try { if (await locsOf(x, 'studio.formulaBar')[0].count() > 0) { f = x; break; } } catch { /* detached */ }
  }
  if (!f) {
    log('  !! no formula bar found in any authoring frame - select a control first.');
    await capture(studio, 'dirty-not-found');
    process.exitCode = 4;
    await browser.close();
    return;
  }
  let original = '';
  {
    try {
      const ed = f.locator(css('studio.formulaEditor')).first();
      const replaceWith = async (text) => {
        await ed.click({ timeout: 10000 });
        await studio.keyboard.press('ControlOrMeta+A');
        // insertText, not type(): typed brackets and quotes are auto-closed by the editor.
        await studio.keyboard.insertText(text);
        await studio.waitForTimeout(800);
        await studio.keyboard.press('Tab');
        await studio.waitForTimeout(2000);
      };
      if (toggle) {
        original = formulaText(await ed.innerText());
        if (!original) { log('  !! the formula bar is empty - select a pushed control and property first.'); process.exitCode = 4; await browser.close(); return; }
        log('  toggling the selected property: ' + original.slice(0, 60) + '  ->  ' + toggle + '  ->  back');
        await replaceWith(toggle);
        await replaceWith(original);
        const back = formulaText(await ed.innerText());
        if (back !== original) {
          log('  !! the property does NOT read back as it was:\n     was: ' + original.slice(0, 120) + '\n     now: ' + back.slice(0, 120));
          log('     Fix it in the formula bar before any save - a save now would persist the wrong value.');
          await capture(studio, 'dirty-readback'); process.exitCode = 4; await browser.close(); return;
        }
        log('  read back unchanged: ' + back.slice(0, 60));
      } else {
        await ed.click({ timeout: 10000 });
        await studio.keyboard.press('End');
        await studio.keyboard.type(' ');
        await studio.waitForTimeout(800);
        await studio.keyboard.press('Tab');
        await studio.waitForTimeout(1500);
        log('  formula bar edited (a trailing space).');
      }
      const en = await saveEnabled(studio);
      if (en === false) {
        log('  !! Save is still DISABLED: Studio sees nothing to save, and a save now persists nothing.');
        log('     Select a property the push CHANGED and run `dirty --toggle <another valid value>` (e.g. a colour token).');
        process.exitCode = 7;
      } else log('  Save is ' + (en ? 'enabled' : 'in an unknown state') + ' - now `save`, and read "Saved: <time>" at or after the click.');
    } catch (e) {
      log('  !! dirty stopped part-way (' + String(e.message).split('\n')[0] + ').');
      if (original) log('     Check the selected property reads exactly: ' + original.slice(0, 120) + ' - before any save.');
      await capture(studio, 'dirty-failed');
      process.exitCode = 4;
    }
  }
  await browser.close();
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
  const { page: studio, scan } = await editingTab(ctx);
  await studio.bringToFront();
  if (rx('studio.titleReadOnly').test(await studio.title())) { log('  READ-ONLY - a save cannot persist.'); await browser.close(); process.exitCode = 3; return; }
  if (scan && scan.disconnected) { log('  !! Studio shows "There\'s been a disconnect". Not saving.'); log(DISCONNECT_NOTE); await capture(studio, 'save-disconnected'); await browser.close(); process.exitCode = 3; return; }
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
  const clickedAt = new Date();
  await hit.ctl.click({ timeout: 20000 });
  log('  clicked Save at ' + clickedAt.toLocaleTimeString() + '; waiting for it to land ...');
  await studio.waitForTimeout(Number(flag('after', 25000)));
  const after = await readSaveStamp(studio, hit.frame);
  await capture(studio, 'save-after');
  const verdict = stampVerdict(after, before, clickedAt);
  if (verdict === 'old') {
    // Measured: "SAVE LANDED: Saved: 10:28:27" printed at 10:40 - the flyout's OLD stamp, after a click
    // that saved nothing (a clean push had not marked Studio dirty). A stamp older than the click is
    // not this save.
    log('  !! "Saved: ' + after + '" is OLDER than the click (' + clickedAt.toLocaleTimeString() + '): this click saved nothing. The save is UNPROVEN.');
    log('     Run `dirty`, then `save` again, and read a stamp at or after the click time.');
    process.exitCode = 7;
  } else if (verdict === 'landed' || verdict === 'landed-untimed') {
    log('  SAVE LANDED: "Saved: ' + after + '"' + (before ? '  (was "' + before + '")' : '')
      + (verdict === 'landed-untimed' ? '  (no time of day in the stamp to compare with the click - check it by eye)' : ''));
    // The proof a held push waits for: canvas-mcp.py hold releases only after a save newer than its push.
    try {
      mkdirSync(dirname(SAVE_PROOF()), { recursive: true });
      writeFileSync(SAVE_PROOF(), JSON.stringify({ atMs: clickedAt.getTime(), at: clickedAt.toISOString(), stamp: after, verdict }, null, 1));
      log('  save proof written: ' + SAVE_PROOF() + ' (a held push may now be released)');
    } catch { /* unwritable work folder: release the hold by hand */ }
  } else if (after && after === before) {
    log('  !! "Saved: ' + after + '" did not move. Studio saw nothing to save: the change may live only in the');
    log('     co-authoring session (was Studio in Preview when it arrived?). Treat the save as NOT done.');
    process.exitCode = 7;
  } else {
    log('  !! could not read "Saved: <time>" from the Save flyout - open it by hand. Until then the save is UNPROVEN.');
  }
  log('  Independent proof: reload Studio, `canvas-mcp.py sync <scratch> --diff` (0 differences), or a pac canvas download after publish.');
  await browser.close();
}
const SAVE_PROOF = () => join(resolve(REPO, APP.workDir || '.ship-work'), 'save-proof.json');

// Publish once per batch. A measured build published 21 times; a publish costs minutes and proves
// nothing new when the source has not changed. The hash recorded after each publish (in the work folder)
// is the one the last SUCCESSFUL push sent (canvas-mcp.py writes last-push.json only on a clean push),
// not the source on disk: measured, a publish after a push that never started recorded the new source,
// and the next real publish was refused as "unchanged". With no push record, the source on disk.
// An unchanged hash is refused unless --again is passed.
function srcHash() {
  const dir = APP.canvasSrc ? resolve(REPO, APP.canvasSrc) : null;
  if (!dir || !existsSync(dir)) return null;
  const h = createHash('sha256');
  for (const f of readdirSync(dir).filter((x) => /\.pa\.yaml$/i.test(x)).sort()) { h.update(f); h.update(readFileSync(join(dir, f))); }
  return h.digest('hex');
}
const PUBLISH_LOG = () => join(resolve(REPO, APP.workDir || '.ship-work'), 'publish-log.json');
const LAST_PUSH = () => join(resolve(REPO, APP.workDir || '.ship-work'), 'last-push.json');
// Which hash a publish ships: the last clean push's when there is one, else the source on disk.
export function publishDialogLeftOpen(openFrames) { return Array.isArray(openFrames) && openFrames.length > 0; }
export function publishHash(push, disk) { return push && push.hash ? { hash: push.hash, from: 'push' } : { hash: disk, from: 'source' }; }
export function publishRefused(h, last, again) { return !!(h && last && last.hash === h && !again); }
// One fix batch. The first publish ships the build and the second may repair what the first walks
// found; from the third on, the screenshot critique and the independent review must both be back,
// so their findings land in one batch. A measured build shipped a fix batch, then a second one when
// the reviewer's finding arrived twenty minutes later. --unreviewed "<reason>" overrides, recorded.
export const REVIEW_FILES = ['docs/design-critique.md', 'docs/review/findings.json'];
export function reviewMissing(count, present, override) {
  if (count < 2 || override) return [];
  return REVIEW_FILES.filter((f) => !present.includes(f));
}
// After the fix batch. The publish that ships with both review files present is THE fix batch; a
// later publish is another single-issue polish (two measured builds each spent their last publishes
// on one phone banner). Refused until a new batch is declared with --batch "<what it fixes>" (the
// owner's change request, a defect found after hand-back), or --unreviewed "<reason>". A declared
// batch publishes once; the next publish needs its own declaration.
export function afterBatchRefused(plog, override, batch) {
  if (override || batch) return false;
  return plog.some((e) => e && (e.fixBatch || e.batch));
}
// The Data pane of a reopened app lists each data source by its display name; a table counts as
// present when its display name (or logical name) appears there.
export function missingSources(want, text) {
  const t = String(text || '').toLowerCase();
  const seen = (s) => !!s && t.includes(String(s).toLowerCase());
  return want.filter((w) => !seen(w.display) && !seen(w.logical));
}
function publishLog() { try { return JSON.parse(readFileSync(PUBLISH_LOG(), 'utf8')); } catch { return []; } }

async function cmdPublish() {
  let push = null;
  try { push = JSON.parse(readFileSync(LAST_PUSH(), 'utf8')); } catch { /* no push recorded: an import-path app */ }
  const disk = srcHash();
  const { hash, from } = publishHash(push, disk);
  if (from === 'push' && disk && disk !== hash) log('  note: the source changed since the last clean push (' + push.at + '); this publish ships what was PUSHED, not the source on disk.');
  const plog = publishLog();
  const last = plog[plog.length - 1];
  if (publishRefused(hash, last, has('again'))) {
    log('  REFUSED: ' + (from === 'push' ? 'no clean push since' : 'the canvas source has not changed since') + ' the last publish (' + last.at + '). Publishing again re-tests nothing.');
    if (from === 'push') log('  A push that failed or never started records nothing: push again and read PUSHED CLEAN first.');
    log('  Batch the fixes, push them, save, then publish once. --again publishes anyway (e.g. after a Studio-only change).');
    process.exitCode = 7; return;
  }
  const override = typeof flag('unreviewed', '') === 'string' ? flag('unreviewed', '') : '';
  const gap = reviewMissing(plog.length, REVIEW_FILES.filter((f) => existsSync(join(REPO, f))), override);
  if (gap.length) {
    log('  REFUSED: this would be publish ' + (plog.length + 1) + ', and ' + gap.join(' and ') + (gap.length > 1 ? ' are' : ' is') + ' not written yet.');
    log('  Start the screenshot critique and the independent reviewer straight after the FIRST publish (orchestration.md section 7),');
    log('  walk while they run, then fix everything they and the walks found in ONE batch and publish once.');
    log('  --unreviewed "<reason>" publishes anyway; the reason is recorded in the publish log.');
    process.exitCode = 8; return;
  }
  const batch = typeof flag('batch', '') === 'string' ? flag('batch', '') : '';
  if (afterBatchRefused(plog, override, batch)) {
    const fb = [...plog].reverse().find((e) => e && (e.fixBatch || e.batch));
    log('  REFUSED: the fix batch already shipped (publish ' + (plog.indexOf(fb) + 1) + ', ' + fb.at + '). Another publish now is a');
    log('  single-issue polish: the walks, critique and review it needs were already paid for once.');
    log('  Hand back, listing what is left as a finding. If a new batch is genuinely due (the owner asked for a change,');
    log('  or a defect was found after hand-back), gather ALL of it, then --batch "<what this batch fixes>".');
    log('  --unreviewed "<reason>" publishes anyway; either reason is recorded in the publish log.');
    process.exitCode = 10; return;
  }
  const isFixBatch = plog.length >= 1 && REVIEW_FILES.every((f) => existsSync(join(REPO, f))) && !plog.some((e) => e && e.fixBatch);
  const { browser, ctx } = await attach();
  const { page: studio, scan } = await editingTab(ctx);
  await studio.bringToFront();
  if (scan && scan.disconnected && !has('reload-first')) { log('  !! Studio shows "There\'s been a disconnect". Not publishing.'); log(DISCONNECT_NOTE); await browser.close(); process.exitCode = 3; return; }
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
  // The confirm can open in another Studio tab's frame: measured with three tabs open, the click
  // landed, "Publish this version" stayed open elsewhere, every later click timed out behind it, and
  // the old toast made it look done. Look in the clicked frame first, then every Studio tab.
  const studioFrames = () => [hit.frame, ...ctx.pages().filter(isStudioTab).flatMap((p) => p.frames().filter((f) => rx('studio.authoringFrameUrl').test(f.url()))).filter((f) => f !== hit.frame)];
  let confirmed = false;
  for (const f of studioFrames()) {
    for (const c of locsOf(f, 'studio.publishConfirm')) {
      try { if (await c.first().count() === 0) continue; await c.first().click({ timeout: 15000 }); log('  confirmed "Publish this version"' + (f === hit.frame ? '' : ' (in another Studio tab)')); confirmed = true; break; }
      catch { /* next shape */ }
    }
    if (confirmed) break;
  }
  if (!confirmed) log('  !! no "Publish this version" button in any Studio tab - the dialog may not have opened.');
  await studio.waitForTimeout(Number(flag('after', 30000)));
  await capture(studio, 'publish-done');
  const stillOpen = [];
  for (const [n, f] of studioFrames().entries()) {
    for (const c of locsOf(f, 'studio.publishConfirm')) { if (await c.first().isVisible().catch(() => false)) { stillOpen.push(n); break; } }
  }
  if (publishDialogLeftOpen(stillOpen)) {
    log('  !! "Publish this version" is still open in ' + stillOpen.length + ' authoring frame(s): this publish did not start, and every');
    log('     later click lands behind the dialog. Close the extra Studio tabs (`tidy --studio`), then publish again.');
    await browser.close(); process.exitCode = 11; return;
  }
  log('  Do NOT read success from the "Publish successful" toast: it stays pinned showing a PREVIOUS');
  log('  publish\'s time. Proof is the app\'s Dataverse row (solution-aware apps):');
  log('    GET canvasapps?$filter=displayname eq \'' + (APP.appName || '<app display name>') + '\'&$select=lastpublishtime');
  log('  must move past the time you clicked. If it did not, retry with --reload-first.');
  log('  Publish ships what was SAVED when it started; the player can lag the publish by ten minutes.');
  try {
    mkdirSync(dirname(PUBLISH_LOG()), { recursive: true });
    plog.push({ at: new Date().toISOString(), hash, from, ...(override ? { unreviewed: override } : {}), ...(batch ? { batch } : {}), ...(isFixBatch && !override && !batch ? { fixBatch: true } : {}) });
    writeFileSync(PUBLISH_LOG(), JSON.stringify(plog.slice(-50), null, 1));
    log('  publish ' + plog.length + ' of this build' + (plog.length > 4 ? ' - more than four publishes means fixes are being shipped one at a time; batch them.' : '.'));
  } catch { /* unwritable work folder */ }
  await browser.close();
}

// Leave the editor the way a person does: exit Preview, Back, accept Leave. Returns which of
// those controls were seen, so `doctor` can report them, and whether the lock is still held.
async function leaveEditor(page) {
  const seen = { back: false, leave: false, preview: false };
  // Two authoring frames can exist (one a prefetch with no DOM): use the one holding Back or Leave.
  const editor = async () => {
    const fs = page.frames().filter((f) => rx('studio.authoringFrameUrl').test(f.url()));
    for (const f of fs) {
      try { if (await f.locator(css('studio.backButton')).count() || await f.locator(css('studio.leaveButton')).count()) return f; } catch { /* detached */ }
    }
    return fs[0];
  };
  for (let i = 0; i < 4; i++) {
    const ed = await editor();
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

// End the `studio` process that holds the profile, when the browser it held is already gone.
function killHolder() {
  let pid = 0;
  try { pid = Number(readFileSync(HOLDER_PID(), 'utf8').trim()); } catch { return false; }
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid); log('  ended the studio holder process ' + pid + ' (its browser was gone; the profile is free)'); } catch { /* already gone */ }
  try { rmSync(HOLDER_PID(), { force: true }); } catch { /* fine */ }
  return true;
}
// A tab whose editor is gone (no Back, no Leave, still titled Editing) cannot be left through Back;
// keeping it open kept the holder alive and the next `studio` failed PROFILE IN USE.
export function editorGone(r) { return !!(r && r.stillEditing && !r.back && !r.leave && !r.preview); }

async function cmdCloseStudio() {
  // Back, not a killed tab: a killed tab strands the edit lock (connect then returns a bare 422).
  // Exit preview first; accept the DOM "Leave" modal; a native beforeunload dialog follows, so
  // the handler is registered BEFORE the click.
  let browser, ctx;
  try { ({ browser, ctx } = await attach()); } catch (e) {
    log('  no browser on the debug port (' + String(e.message).split('\n')[0] + ').');
    if (!killHolder()) log('  nothing to close.');
    return;
  }
  // Every Studio tab: a push can leave a blank first tab plus a second tab that joined the session.
  const pages = ctx.pages().filter(isStudioTab).reverse();
  if (!pages.length) {
    log('  no Studio page on the debug port - quitting the held browser so the profile is free');
    try { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close'); } catch { await browser.close().catch(() => {}); killHolder(); }
    return;
  }
  let stillEditing = false;
  for (const [k, page] of pages.entries()) {
    page.on('dialog', async (d) => { await d.accept().catch(() => {}); });
    const r = await leaveEditor(page);
    const gone = editorGone(r);
    log('  tab ' + (k + 1) + '/' + pages.length + ': ' + (gone ? 'editor gone (no Back button) - closing the tab; a lock it held ages out in 30-60 minutes'
      : r.stillEditing ? 'still in the editor' : 'left the editor'));
    if (gone) { await page.close({ runBeforeUnload: false }).catch(() => {}); continue; }
    if (r.stillEditing) stillEditing = true;
  }
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

// --- create: a new blank canvas app, in a solution, ready for the authoring server -------------
// The step every canvas build starts with and no API offers: Studio creates the app on its first
// save. Measured sequence (2026-10): the maker portal's "New > App > Canvas app" dialog only opens
// portal.newAppUrl; the first Save turns the URL into action=edit&app-id=...; a new app has
// Coauthoring OFF (the authoring server needs it ON) and its "Save and refresh" confirmation
// reloads Studio; Add data search matches DISPLAY names only, and two tables can share one, so
// the result is chosen by the logical name in its accessible description ("Table <logical>").

// Find an anchor in whichever authoring frame currently has it (the frames change on a refresh).
async function inEditor(page, id, { wait = 0, visible = false } = {}) {
  const until = Date.now() + wait;
  do {
    for (const f of page.frames()) {
      if (!rx('studio.authoringFrameUrl').test(f.url())) continue;
      for (const loc of locsOf(f, id)) {
        try {
          const c = loc.first();
          if (await c.count() > 0 && (!visible || await c.isVisible())) return { frame: f, ctl: c };
        } catch { /* detached mid-refresh */ }
      }
    }
    if (Date.now() < until) await page.waitForTimeout(1000);
  } while (Date.now() < until);
  return null;
}

async function tableDisplayName(logical) {
  const base = String(APP.dataverseUrl || APP.environmentUrl || '').replace(/\/+$/, '');
  let token = null;
  try { token = dataverseToken(); } catch { /* reported below */ }
  if (!base || !token) return null;
  const r = await fetch(`${base}/api/data/v9.2/EntityDefinitions(LogicalName='${logical}')?$select=DisplayCollectionName`,
    { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json();
  return j.DisplayCollectionName?.UserLocalizedLabel?.Label || null;
}

async function newAppRowId(name, sinceMs) {
  const base = String(APP.dataverseUrl || APP.environmentUrl || '').replace(/\/+$/, '');
  let token = null;
  try { token = dataverseToken(); } catch { return null; }
  if (!base || !token) return null;
  const q = `${base}/api/data/v9.2/canvasapps?$select=canvasappid,createdtime&$filter=displayname eq '${String(name).replace(/'/g, "''")}'`;
  try {
    const r = await fetch(q, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!r.ok) return null;
    const rows = (await r.json()).value || [];
    const fresh = rows.filter((x) => Date.parse(x.createdtime) >= sinceMs - 120000);
    return fresh.length === 1 ? fresh[0].canvasappid : null;
  } catch { return null; }
}

// After a "Save and refresh" Studio reloads and shows the welcome dialog AGAIN; while it is open the
// command bar is aria-hidden, so role queries find nothing. Dismiss it on every pass.
async function waitForEditing(page, label) {
  let title = '';
  for (let i = 0; i < 36; i++) {
    await page.waitForTimeout(5000);
    for (const f of page.frames()) if (rx('studio.authoringFrameUrl').test(f.url())) await dismissBubbles(f).catch(() => 0);
    title = await page.title().catch(() => '');
    if (rx('studio.titleReadOnly').test(title)) break;
    if (await inEditor(page, 'studio.addData', { visible: true })) return true;
  }
  log(`  !! ${label}: Studio did not come back in edit mode (title "${title}")`);
  return false;
}

function writeAppToConfig(appId, name, solutionId) {
  const path = CONFIG_PATH || resolve('scripts/canvas-app.json');
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')); } catch { /* new file */ }
  Object.assign(cfg, { environmentId: APP.environmentId, appId, appName: name, solutionId });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  return path;
}

async function cmdCreate() {
  const name = flag('name', APP.appName);
  const solutionId = flag('solution-id', APP.solutionId);
  const formFactor = String(flag('form-factor', 'tablet')).toLowerCase();
  const layout = String(flag('layout', 'responsive')).toLowerCase();
  const tablesArg = flag('tables', Array.isArray(APP.tables) ? APP.tables.join(',') : '');
  const tables = String(tablesArg === true ? '' : tablesArg).split(',').map((s) => s.trim()).filter(Boolean);
  if (!APP.environmentId || !name || name === true || !solutionId || solutionId === true || !/^(tablet|phone)$/.test(formFactor) || !/^(responsive|fixed)$/.test(layout)) {
    log('usage: create --name "<app name>" --solution-id <solution GUID> [--form-factor tablet|phone] [--layout responsive|fixed]');
    log('               [--tables <logical>[,<logical>] | "<Display name>=<logical>,..."] [--modern] [--publish] [--close]');
    log('  environmentId comes from scripts/canvas-app.json; the new appId is written back to it.');
    process.exitCode = 1; return;
  }
  if (APP.appId && !has('force')) {
    log(`  refusing: ${CONFIG_PATH} already names app ${APP.appId}. A second app of the same name is the usual result`);
    log('  of re-running a create. Open the existing one with `studio`, or pass --force to create another.');
    process.exitCode = 1; return;
  }
  // Resolve each table's display name now: Add data cannot search by logical name.
  const want = [];
  for (const t of tables) {
    if (t.includes('=')) { const [d, l] = t.split('='); want.push({ display: d.trim(), logical: l.trim() }); continue; }
    const display = await tableDisplayName(t);
    if (!display) { log(`  !! cannot look up the display name of ${t} (no Dataverse token or URL in the config). Pass --tables "<Display name>=${t}".`); process.exitCode = 1; return; }
    want.push({ display, logical: t });
  }

  const ctx = await launch({ headless: false, debugPort: DEBUG_PORT });
  const page = await freshPage(ctx);
  page.on('dialog', async (d) => { await d.accept().catch(() => {}); });
  const url = tpl('portal.newAppUrl', { environmentId: APP.environmentId, formFactor, name: encodeURIComponent(name), solutionId });
  log('1. Creating "' + name + '" (' + formFactor + ') in solution ' + solutionId);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!(await isSignedIn(page))) { log('NOT SIGNED IN - run `login` once (it opens a browser for the sign-in), then retry.'); await ctx.close(); process.exitCode = 2; return; }
  const save = await inEditor(page, 'studio.saveButton', { wait: 180000, visible: true });
  if (!save) { log('  !! the editor never loaded'); await capture(page, 'create-no-editor'); await ctx.close(); process.exitCode = 4; return; }
  // The welcome dialog arrives a few seconds AFTER the command bar; wait for it before clicking.
  const welcome = await inEditor(page, 'studio.welcomeSkip', { wait: 20000, visible: true });
  if (welcome) await page.waitForTimeout(1000);
  await dismissBubbles(save.frame);

  // The app does not exist until the first save.
  try { await save.ctl.click({ timeout: 20000 }); }
  catch (e) { log('  !! Save was not clickable (a dialog over the editor?)'); await capture(page, 'create-blocked'); await ctx.close(); process.exitCode = 4; return; }
  // The id shows in Studio's URL in some sessions and not in others (measured both ways); the app's
  // canvasapps row, created by that first save, is the dependable source.
  const clickedAt = Date.now();
  let appId = null;
  for (let i = 0; i < 40 && !appId; i++) {
    await page.waitForTimeout(1500);
    const m = page.url().match(rx('portal.appIdInUrl'));
    if (m) appId = m[1];
    else if (i % 4 === 3) appId = await newAppRowId(name, clickedAt);
  }
  if (!appId) {
    log('  !! no app id: not in Studio\'s URL, and no new canvasapps row named "' + name + '" could be read');
    log('     (is a Dataverse token configured?). The app MAY exist - look in the solution before creating again.');
    await capture(page, 'create-no-appid');
    await leaveEditor(page).catch(() => {});   // Back, so a created app's edit lock is not stranded
    await ctx.close(); process.exitCode = 4; return;
  }
  const cfgPath = writeAppToConfig(appId, name, solutionId);
  log('   created ' + appId + '  (written to ' + cfgPath + ')');
  // Reopen the saved app by id. When the URL still reads action=new-blank, the reload that
  // "Save and refresh" performs opens ANOTHER blank app of the same name, and every later step
  // lands there ("Didn't save: This name already exists").
  if (!rx('portal.appIdInUrl').test(page.url())) {
    log('   reopening the saved app by id (Studio kept the new-blank URL)');
    await leaveEditor(page).catch(() => {});   // Back first: a navigation away would strand the edit lock
    await page.goto(tpl('portal.studioUrl', { environmentId: APP.environmentId, appId }), { waitUntil: 'domcontentloaded' });
    if (!(await waitForEditing(page, 'reopening the new app'))) { await capture(page, 'create-reopen'); await ctx.close(); process.exitCode = 4; return; }
  }

  // Settings: layout first (it rides on the save that a switch's "Save and refresh" forces).
  const modern = has('modern');
  log('2. Settings: layout ' + layout + (modern ? ', modern controls on' : '') + ', Coauthoring on');
  const openTab = async (tabId) => {
    if (!(await inEditor(page, 'studio.settingsUpdatesTab', { visible: true }))) {
      const open = await inEditor(page, 'studio.appSettings', { wait: 30000 });
      if (!open) return false;
      await open.ctl.click();
    }
    const tab = await inEditor(page, tabId, { wait: 15000 });
    if (!tab) return false;
    await tab.ctl.click();
    return true;
  };
  // Turn a Settings > Updates switch on. A new-feature switch asks to "Save and refresh"; accepting
  // reloads Studio, which closes the dialog. Returns 'on' | 'changed' | 'missing'.
  const switchOn = async (id, label) => {
    if (!(await openTab('studio.settingsUpdatesTab'))) return 'missing';
    const sw = await inEditor(page, id, { wait: 15000 });
    if (!sw) { log(`   !! ${label} switch not found`); return 'missing'; }
    if ((await sw.ctl.getAttribute('aria-checked')) === 'true') { log(`   ${label} already on`); return 'on'; }
    await sw.ctl.click();
    const upd = await inEditor(page, 'studio.saveRefreshUpdate', { wait: 15000 });
    if (upd) {
      await upd.ctl.click({ force: true });
      log(`   ${label} on: "Save and refresh" accepted, Studio reloading ...`);
      if (!(await waitForEditing(page, 'after ' + label))) { await capture(page, 'create-after-' + label.replace(/\W+/g, '-')); process.exitCode = 4; }
    } else log(`   ${label} on`);
    return 'changed';
  };
  if (!(await openTab('studio.settingsDisplayTab'))) { log('  !! App settings not found'); await capture(page, 'create-no-settings'); process.exitCode = 4; }
  else {
    const combo = await inEditor(page, 'studio.appLayout', { wait: 15000 });
    if (combo && !new RegExp('^\\s*' + layout, 'i').test(await combo.ctl.innerText())) {
      await combo.ctl.click();
      await combo.frame.locator(css('studio.listOption')).filter({ hasText: new RegExp('^\\s*' + layout + '\\s*$', 'i') }).first().click({ timeout: 10000 });
      log('   layout set to ' + layout);
    } else log(combo ? '   layout already ' + layout : '   !! App layout control not found - set it by hand (Settings > Display)');
    if (modern && (await switchOn('studio.modernSwitch', 'Modern controls')) === 'missing') process.exitCode = 4;
    const co = await switchOn('studio.coauthoringSwitch', 'Coauthoring');
    if (co === 'missing') { log('   !! the authoring server cannot connect until Coauthoring is on'); process.exitCode = 4; }
    const close = await inEditor(page, 'studio.closeSettings', { visible: true });
    if (close) await close.ctl.click().catch(() => {});
  }

  // Data sources, each chosen by its logical name.
  const addSources = async (list) => {
    for (const t of list) {
      const add = await inEditor(page, 'studio.addData', { wait: 30000 });
      if (!add) { log('  !! Add data not found'); process.exitCode = 4; break; }
      await add.ctl.click();
      const box = await inEditor(page, 'studio.dataSearch', { wait: 15000, visible: true });
      if (!box) { log('  !! Add data search box not found'); process.exitCode = 4; break; }
      await box.ctl.fill(t.display);
      await page.waitForTimeout(4000);
      const desc = new RegExp('\\b' + tpl('studio.dataItemDescription', { logical: t.logical }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      const item = box.frame.getByRole('listitem', { description: desc }).first();
      if (await item.count() === 0) {
        log(`  !! no result for "${t.display}" whose table is ${t.logical}. Nothing added; check the display name.`);
        await capture(page, 'create-no-table-' + t.logical); await page.keyboard.press('Escape').catch(() => {}); process.exitCode = 4; continue;
      }
      await item.click();
      let ok = false;
      for (let i = 0; i < 30 && !ok; i++) { await page.waitForTimeout(1000); ok = rx('studio.dataSourceAdded').test(await box.frame.evaluate(() => document.body.innerText || '').catch(() => '')); }
      log(ok ? `   added ${t.display} (${t.logical})` : `   !! ${t.display} (${t.logical}): no "added" confirmation seen - check the Data pane`);
      if (!ok) process.exitCode = 4;
    }
  };
  const saveNow = async (label) => {
    const s2 = await inEditor(page, 'studio.saveButton', { wait: 15000, visible: true });
    if (!s2) { log('   !! Save button not found - treat the save as unproven'); return false; }
    await dismissBubbles(s2.frame);
    await s2.ctl.click({ timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(Number(flag('after', 15000)));
    const stamp = await readSaveStamp(page, s2.frame);
    log(stamp ? '   ' + label + ': "Saved: ' + stamp + '"' : '   !! could not read "Saved: <time>" - treat the save as unproven');
    return !!stamp;
  };
  // The "added" toast proves Studio's memory, not the saved app: a measured build's tables were
  // confirmed added, saved, and gone when the app was reopened (14 minutes before anyone noticed).
  // So reopen the SAVED app from the server, read its Data pane, and re-add what is missing once.
  const savedSources = async () => {
    await leaveEditor(page).catch(() => {});
    await page.goto(tpl('portal.studioUrl', { environmentId: APP.environmentId, appId }), { waitUntil: 'domcontentloaded' });
    if (!(await waitForEditing(page, 'reopening to check the data sources'))) return null;
    const pane = await inEditor(page, 'studio.dataPane', { wait: 30000, visible: true });
    if (!pane) return null;
    await pane.ctl.click().catch(() => {});
    await page.waitForTimeout(3000);
    return framesText(page);
  };
  if (want.length) log('3. Data sources');
  await addSources(want);

  // Save, and prove it.
  log('4. Save');
  await saveNow('saved');
  if (want.length && !has('no-verify-sources')) {
    log('5. Data sources in the SAVED app (reopened from the server)');
    let text = await savedSources();
    let gone = text === null ? null : missingSources(want, text);
    if (gone && gone.length) {
      log('   !! not in the saved app: ' + gone.map((t) => t.display + ' (' + t.logical + ')').join(', ') + ' - adding them again and saving');
      await addSources(gone);
      await saveNow('saved again');
      text = await savedSources();
      gone = text === null ? null : missingSources(want, text);
    }
    if (gone === null) {
      log('   !! could not open the Data pane of the reopened app - the data sources are UNPROVEN.');
      log('      Check by hand: Studio > Data (left rail) lists ' + want.map((t) => t.display).join(', ') + '.');
      await capture(page, 'create-sources-unproven'); process.exitCode = 4;
    } else if (gone.length) {
      log('   !! STILL MISSING after a second add and save: ' + gone.map((t) => t.display + ' (' + t.logical + ')').join(', '));
      log('      Fix before any screen work: in Studio, Data > Add data > the table, Save, then reopen the app and');
      log('      confirm the Data pane lists it (or `studio-has "' + gone[0].display + '"` with the Data pane open).');
      await capture(page, 'create-sources-missing'); process.exitCode = 4;
    } else log('   all ' + want.length + ' data source(s) present after reopening: ' + want.map((t) => t.display).join(', '));
  }
  if (has('publish')) {
    const pub = await inEditor(page, 'studio.publishButton', { wait: 15000, visible: true });
    if (pub) {
      await dismissBubbles(pub.frame);
      try {
        await pub.ctl.click({ timeout: 20000 });
        await page.waitForTimeout(5000);
        for (const c of locsOf(pub.frame, 'studio.publishConfirm')) { try { if (await c.first().count() === 0) continue; await c.first().click({ timeout: 15000 }); break; } catch { /* next */ } }
        await page.waitForTimeout(20000);
        log('   publish clicked; prove it from the canvasapps row (lastpublishtime), not the toast');
      } catch { log('   !! Publish was not clickable (a dialog over the editor?) - publish with `publish` later'); await capture(page, 'create-publish-blocked'); process.exitCode = 4; }
    }
  }
  await capture(page, 'create-done');
  log('\nNext: connect the authoring server to app ' + appId + ' (Studio is open in edit mode, Coauthoring on).');
  if (has('close')) {
    const { stillEditing } = await leaveEditor(page);
    log(stillEditing ? '  !! still in the editor - close it by hand' : '  left Studio through Back (edit lock released)');
    await ctx.close().catch(() => {});
    return;
  }
  log('Holding Studio open (like `studio`). Save/publish/close-studio reattach to it.');
  ctx.on('close', () => { process.exit(process.exitCode || 0); });
  try { await page.waitForTimeout(Number(flag('hold', 3600000))); } catch { /* closed */ }
  await ctx.close().catch(() => {});
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
  const page = await freshPage(ctx);
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
    mark('studio.canvasRoute', rx('studio.canvasRoute').test(st.url()) ? 'ok' : 'stale', 'Studio settled on ' + st.url().split('?')[0]);
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
  const page = await freshPage(ctx);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(Number(flag('settle', 6000)));
  await capture(page, name);
  await ctx.close();
}

// --- connections ---------------------------------------------------------------------------
// A flow needs signed-in connections. Created over the API, an OAuth connection (Dataverse,
// Outlook, Teams) comes back "Unauthenticated"; the maker portal finishes it by sending the
// browser through the connector's consent link. This does the same in the driver's signed-in
// profile, so the person is never asked to click New connection. Measured: with a profile
// signed in through the Windows account the sign-in was silent, and reaching the consent
// service's confirm step set the connection Connected (no confirmConsentCode call needed).
const PA_API = 'https://api.powerapps.com/providers/Microsoft.PowerApps';
const CONNECTOR_NAMES = { dataverse: 'shared_commondataserviceforapps', outlook: 'shared_office365', office365: 'shared_office365',
  approvals: 'shared_approvals', teams: 'shared_teams', users: 'shared_office365users', sharepoint: 'shared_sharepointonline' };
function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch { return {}; }
}
const sameHost = (a, b) => { try { return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase(); } catch { return false; } };
// The OAuth parameter of a connector, if it has one (oauthSetting); null means API creation is enough.
function oauthParameter(connector) {
  const params = (connector && connector.properties && connector.properties.connectionParameters) || {};
  const k = Object.keys(params).find((n) => params[n] && params[n].type === 'oauthSetting');
  return k ? { name: k, redirectUrl: params[k].oAuthSettings && params[k].oAuthSettings.redirectUrl } : null;
}
function powerAppsToken() {
  if (process.env.POWERAPPS_TOKEN) return process.env.POWERAPPS_TOKEN.trim();
  let command = APP.powerAppsTokenCommand || process.env.POWERAPPS_TOKEN_COMMAND;
  // The usual Dataverse token commands name their resource; the same command for the Power Apps
  // service resource gives the token this needs, with no second sign-in.
  const dv = String(APP.environmentUrl || '').replace(/\/+$/, '');
  if (!command && APP.dataverseTokenCommand && dv && APP.dataverseTokenCommand.includes(dv)) command = APP.dataverseTokenCommand.split(dv).join('https://service.powerapps.com/');
  if (!command) return null;
  const out = execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, cwd: REPO });
  return out.trim().split(/\r?\n/).pop().trim() || null;
}
async function cmdConnection() {
  const want = String(flag('connector', '') || '');
  const api = CONNECTOR_NAMES[want.toLowerCase()] || want;
  const name = String(flag('name', '') || '') || (APP.connectionPrefix ? APP.connectionPrefix + '-' + api.replace(/^shared_/, '') : '');
  const env = APP.environmentId;
  const apply = has('apply');
  if (!api || api === 'true' || !name || !env) {
    log('usage: connection --connector <dataverse|outlook|approvals|teams|users|sharepoint|shared_x> --name <display name> [--apply] [--json]');
    log('  environmentId, environmentUrl and login come from scripts/canvas-app.json; --name defaults to <connectionPrefix>-<connector>.');
    process.exitCode = 1; return;
  }
  let token;
  try { token = powerAppsToken(); } catch (e) { log('  !! the token command failed: ' + String(e.stderr || e.message).split('\n').find((x) => x.trim())); process.exitCode = 2; return; }
  if (!token) { log('  !! no Power Apps token: add "powerAppsTokenCommand" (resource https://service.powerapps.com/) to the app config, or set POWERAPPS_TOKEN.'); process.exitCode = 2; return; }
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const q = 'api-version=2016-11-01&$filter=' + encodeURIComponent(`environment eq '${env}'`);
  const call = async (method, url, body) => {
    const r = await fetch(url, { method, headers: H, body: body && JSON.stringify(body) });
    const t = await r.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t.slice(0, 300) }; }
    if (!r.ok) throw new Error(method + ' ' + url.split('?')[0].replace(PA_API, '') + ' -> ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
    return j;
  };

  // 1. The profile: the token's account must be the one the config names.
  const me = jwtClaims(token);
  const upn = String(me.upn || me.preferred_username || me.unique_name || '');
  if (APP.login && upn.toLowerCase() !== String(APP.login).toLowerCase()) {
    log(`  REFUSED: the token is for ${upn || '(unknown account)'}, the config's login is ${APP.login}. Sign the token command in as ${APP.login}.`);
    process.exitCode = 3; return;
  }
  // 2. The environment: it must exist for this account and be the one whose Dataverse URL the config names.
  const e = await call('GET', `${PA_API}/environments/${env}?api-version=2016-11-01`);
  const instance = e.properties && e.properties.linkedEnvironmentMetadata && e.properties.linkedEnvironmentMetadata.instanceUrl;
  if (APP.environmentUrl && !sameHost(instance, APP.environmentUrl)) {
    log(`  REFUSED: environment ${env} (${e.properties && e.properties.displayName}) is ${instance}, the config says ${APP.environmentUrl}.`);
    process.exitCode = 3; return;
  }
  log(`  account ${upn || '(not stated in token)'}${APP.login ? ' = config login' : ' (no "login" in the config to compare)'}`);
  log(`  environment ${e.properties && e.properties.displayName} (${instance || 'no Dataverse'})`);
  // 3. Reuse this build's own connection when it already exists and is connected; never touch anyone else's.
  const connector = await call('GET', `${PA_API}/apis/${api}?${q}`);
  const oauth = oauthParameter(connector);
  const mine = ((await call('GET', `${PA_API}/apis/${api}/connections?${q}`)).value || [])
    .filter((c) => c.properties && c.properties.displayName === name && (!me.oid || !c.properties.createdBy || c.properties.createdBy.id === me.oid));
  const statusOf = (c) => ((c.properties.statuses || [])[0] || {}).status || 'Unknown';
  const done = (c, how) => {
    const out = { connector: api, id: c.name, displayName: c.properties.displayName, status: statusOf(c), environmentId: env, how };
    if (has('json')) console.log(JSON.stringify(out)); else log(`  ${how}: ${api} "${out.displayName}" id ${out.id} - ${out.status}`);
    process.exitCode = out.status === 'Connected' ? 0 : 4;
  };
  const ready = mine.find((c) => statusOf(c) === 'Connected');
  if (ready) return done(ready, 'reused');
  const id = (mine[0] && mine[0].name) || randomUUID().replace(/-/g, '');
  log(`  plan: ${mine[0] ? 'finish' : 'create'} ${api} connection "${name}" (${id})${oauth ? ', then consent in the signed-in browser profile' : ' (no sign-in needed)'}`);
  if (!apply) { log('  plan only - nothing created. Re-run with --apply.'); return; }
  const base = `${PA_API}/apis/${api}/connections/${id}`;
  if (!mine[0]) await call('PUT', `${base}?${q}`, { properties: { environment: { id: `/providers/Microsoft.PowerApps/environments/${env}`, name: env }, displayName: name } });
  if (oauth) {
    const link = await call('POST', `${base}/getConsentLink?${q}`, { redirectUrl: oauth.redirectUrl });
    const ctx = await launch({ headless: has('headless') });
    const page = await freshPage(ctx);
    let confirmed = false, code = null;
    const seeUrl = (u) => {
      if (!rx('consent.confirmUrl').test(u)) return;
      confirmed = true;
      const m = /[?&]code=([^&#]+)/.exec(u);
      if (m && !code) code = decodeURIComponent(m[1]);
    };
    page.on('request', (r) => seeUrl(r.url()));
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) seeUrl(f.url()); });
    await page.goto(link.consentLink).catch(() => {});
    const end = Date.now() + Number(flag('wait-for', 90000));
    while (!confirmed && Date.now() < end) {
      // Not silent: pick the configured account on "Pick an account" (by its attribute, else by its
      // visible text - the attribute did not match in one measured run); anything else is the person's.
      if (APP.login) {
        for (const tile of [page.locator(tpl('consent.accountTile', { login: APP.login })), page.getByText(APP.login, { exact: true })]) {
          if (await tile.count().catch(() => 0)) { await tile.first().click().catch(() => {}); break; }
        }
      }
      await page.waitForTimeout(700);
    }
    if (!confirmed) {
      const shot = join(OUT, 'connection-consent-' + Date.now() + '.png');
      await page.screenshot({ path: shot }).catch(() => {});
      log('  !! consent did not complete in this profile (a sign-in, MFA or admin-consent prompt is showing). Screenshot: ' + shot);
      log('     Run `canvas-browser.mjs login` once as ' + (APP.login || 'the build account') + ', then re-run this command; it finishes the same connection.');
    }
    await ctx.close();
    // Reaching the confirm step was enough for one connector (Office 365 Users); Dataverse and
    // Outlook stayed Unauthenticated until the code was confirmed over the API. Confirm whenever
    // the connection is not yet Connected and a code was seen. The body is { code } only.
    if (code) {
      const now = await call('GET', `${base}?${q}`);
      if (statusOf(now) !== 'Connected') await call('POST', `${base}/confirmConsentCode?${q}`, { code }).catch((e) => log('  !! confirmConsentCode: ' + e.message));
    }
  }
  let c;
  for (let i = 0; i < 15; i++) { c = await call('GET', `${base}?${q}`); if (statusOf(c) === 'Connected') break; await new Promise((r) => setTimeout(r, 2000)); }
  return done(c, mine[0] ? 'finished' : 'created');
}

// After every command, close the blank tabs in the held browser (keeping one, so the browser stays
// up). A measured build left 28 blank tabs; tidy existed but was run by hand 7 times. Commands that
// hold or end the browser, or only report on it, are skipped.
const NO_TIDY = new Set(['studio', 'login', 'close-studio', 'tidy', 'tabs', 'lint', 'doctor']);
async function autoTidy() {
  if (NO_TIDY.has(cmd) || has('no-tidy')) return;
  let browser;
  try { browser = await (await pw()).connectOverCDP('http://127.0.0.1:' + DEBUG_PORT, { timeout: 4000 }); } catch { return; }
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    const blank = pages.filter((p) => tabKind(p.url()) === 'blank');
    const close = blank.length === pages.length ? blank.slice(1) : blank;
    for (const p of close) await p.close({ runBeforeUnload: false }).catch(() => {});
    if (close.length) log('  tidy: closed ' + close.length + ' blank tab(s)');
  } finally { await browser.close().catch(() => {}); }
}

const commands = { login: cmdLogin, check: cmdCheck, create: cmdCreate, connection: cmdConnection, play: cmdPlay, walk: cmdWalk, studio: cmdStudio,
  keys: cmdKeys, save: cmdSave, publish: cmdPublish, 'close-studio': cmdCloseStudio, shot: cmdShot,
  tabs: cmdTabs, tidy: cmdTidy, 'second-tab': cmdSecondTab, 'studio-has': cmdStudioHas, dirty: cmdDirty, lint: async () => cmdLint(), doctor: cmdDoctor, confirm: cmdConfirm };

if (argv.includes('--selftest')) selftest();
else if (!commands[cmd]) {
  log('canvas-browser - drive Power Apps Studio and the published player\n');
  log('  login | check | play [--screen N] [--trace] [--fresh] | walk <scenario.json|folder> [...] [--trace] [--fresh] [--allow-writes | --skip-writes]');
  log('  confirm <scenario.json> [--since ISO]   run only the scenario\'s Dataverse checks');
  log('  connection --connector dataverse|outlook|approvals|<api> --name N [--apply] [--json]');
  log('  create --name N --solution-id GUID [--form-factor tablet|phone] [--layout responsive|fixed] [--tables a,b] [--publish] [--close]');
  log('  studio [--reload] | keys [combo] | save | publish [--reload-first] | close-studio [--keep-browser] | shot <url> <name>');
  log('  tabs | tidy [--all] [--studio] [--dry-run] | second-tab [--expect a,b] | studio-has <name...> | dirty [--toggle <formula>]');
  log('  doctor [--player-only|--studio-only] [--record]   are the UI anchors in assets/selectors.json still valid?\n');
  log('  config:  ' + (CONFIG_PATH || '(none found - pass --config or create scripts/canvas-app.json)'));
  if (APP.appId) log('  app:     ' + (APP.appName || '') + '  ' + APP.appId);
  log('  profile: ' + PROFILE + (existsSync(PROFILE) ? '  (exists)' : '  (not created yet)'));
  log('  output:  ' + OUT);
  process.exitCode = cmd ? 1 : 0;
} else {
  // Exit on a failure: an open browser context would otherwise keep the process (and the profile) alive.
  commands[cmd]().then(autoTidy).catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
}
