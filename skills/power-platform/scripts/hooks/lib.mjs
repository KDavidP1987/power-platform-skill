// Shared helpers for the power-platform skill's Claude Code hooks. Node built-ins only.
// Self-test: node lib.mjs --selftest (only when this file is the entry point; the hooks that import
// it take --selftest themselves).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const IGNORE_MARKER = 'standards-ignore';

export function readStdinJson() {
  // A byte-order mark (PowerShell adds one when piping) would make JSON.parse throw and the hook pass vacuously.
  try { const raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
export function readFileSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
export function hookFilePath(input) {
  return input?.tool_input?.file_path || input?.tool_response?.filePath || null;
}

// Optional per-project configuration: .claude/hooks/standards.config.json
export const DEFAULT_CONFIG = {
  emoji: true,              // flag emoji in docs, UI and code
  purpleAccents: true,      // flag purple/violet/magenta accent colours
  canvasSrcGlob: 'canvas',  // folder holding canvas/<app>/Src
  canvasFileCeiling: 50,
  canvasFileWarnAt: 45,
  debugMarkers: true,       // TODO/FIXME/console.log in source, at Stop
  designGate: true,         // at Stop: a UI project needs DESIGN.md, and a critique record once shipped (false turns it off)
  auditIgnore: ['docs/dod/README.md'],   // generated files the audit never reads (the dod index writes its own symbols)
  bookkeeping: {
    solutionDir: 'solution/',
    dependencyRegister: 'docs/dependencies.md',
    stateFile: 'docs/STATE.md',
    changelog: 'CHANGELOG.md',
  },
};
// Skill-owned copies (setup-harness records them with a hash): true while the file is unchanged.
export function isVendoredCopy(root, rel) {
  let man = null;
  try { man = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'hooks', 'vendored.json'), 'utf8')); } catch { return false; }
  const want = man?.files?.[rel.replace(/\\/g, '/')];
  if (!want) return false;
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex') === want; } catch { return false; }
}
export function loadConfig(root = process.cwd()) {
  const p = path.join(root, '.claude', 'hooks', 'standards.config.json');
  try {
    const user = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ...DEFAULT_CONFIG, ...user, bookkeeping: { ...DEFAULT_CONFIG.bookkeeping, ...(user.bookkeeping || {}) } };
  } catch { return DEFAULT_CONFIG; }
}

// Emoji: Unicode pictographs only, so arrows, dashes, quotes and box-drawing are not flagged.
const EMOJI_RE = /(\p{Extended_Pictographic}|\p{Regional_Indicator})/gu;
const EMOJI_ALLOW = new Set(['©', '®', '™']);
export function findEmoji(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(IGNORE_MARKER)) return;
    for (const m of line.matchAll(EMOJI_RE)) {
      if (EMOJI_ALLOW.has(m[0])) continue;
      hits.push({ line: i + 1, char: m[0], code: 'U+' + m[0].codePointAt(0).toString(16).toUpperCase() });
    }
  });
  return hits;
}

// Purple/violet/magenta accents: a denylist of common framework hexes plus a hue-band check.
const DENY_HEX = new Set([
  '818cf8', '6366f1', '4f46e5', '4338ca', '3730a3', 'a78bfa', '8b5cf6', '7c3aed', '6d28d9', '5b21b6',
  'c084fc', 'a855f7', '9333ea', '7e22ce', '6b21a8', 'e879f9', 'd946ef', 'c026d3', 'a21caf', '86198f',
  '6b46c1', '663399', 'ddd6fe', 'c4b5fd',
]);
const DENY_NAMED = /\b(rebeccapurple|blueviolet|darkviolet|darkmagenta|mediumpurple|mediumorchid|purple|violet|indigo|magenta|fuchsia|orchid|plum|thistle)\b/i;
function hexToHsl(hex) {
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  return { h, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}
function isPurpleHex(hex) {
  const h = hex.toLowerCase();
  if (DENY_HEX.has(h)) return true;
  const { h: hue, s, l } = hexToHsl(h);
  return hue >= 260 && hue <= 330 && s >= 0.25 && l >= 0.1 && l <= 0.9;
}
// Power Fx writes colours as RGBA(r,g,b,a) or ColorValue("#hex"); CSS as #hex.
export function findPurple(text, { checkNamed = true } = {}) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(IGNORE_MARKER)) return;
    for (const m of line.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
      if (isPurpleHex(hex)) hits.push({ line: i + 1, value: m[0], why: 'purple/violet hue' });
    }
    for (const m of line.matchAll(/RGBA\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) {
      const hex = [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('');
      if (isPurpleHex(hex)) hits.push({ line: i + 1, value: m[0] + ')', why: 'purple/violet hue' });
    }
    if (checkNamed) {
      const named = line.match(DENY_NAMED);
      if (named) hits.push({ line: i + 1, value: named[0], why: 'named purple colour' });
    }
  });
  return hits;
}

export function isProse(file) { return ['.md', '.txt'].includes(path.extname(file).toLowerCase()); }
export function isHookFile(file) { return file.replace(/\\/g, '/').includes('.claude/hooks/'); }

export const TEXT_EXT = new Set(['.md', '.txt', '.json', '.xml', '.yaml', '.yml', '.html', '.htm', '.css',
  '.scss', '.js', '.mjs', '.ts', '.fx', '.ps1', '.py', '.svg']);
export function isTextFile(file) { return TEXT_EXT.has(path.extname(file).toLowerCase()); }

export function listRepoTextFiles(root = process.cwd()) {
  try {
    return execSync('git ls-files', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).filter(Boolean).filter(isTextFile).map((f) => path.join(root, f));
  } catch {
    const out = []; const skip = new Set(['.git', 'node_modules', 'out', 'bin', 'obj', 'scratchpad']);
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full); else if (isTextFile(full)) out.push(full);
      }
    })(root);
    return out;
  }
}

// Every canvas/<app>/Src folder under the configured canvas root.
export function canvasSrcDirs(root, canvasRoot) {
  const base = path.join(root, canvasRoot);
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(base, d.name, 'Src'))
      .filter((p) => fs.existsSync(p));
  } catch { return []; }
}

// ---- design gate (Stop) ----
// Guidance alone did not get a design step run: a measured build had the design skill installed and
// "required", and shipped with no DESIGN.md and no critique. So a project with a UI surface (canvas
// source, or a Power BI report under fabric/) must carry:
//   - DESIGN.md (repo root or docs/): blocks the stop when missing;
//   - docs/design-critique.md, naming the screenshots it judged (.png) and a score: blocks only once
//     the app has shipped (a packed .zip or .msapp in the ship output folder), a reminder before that.
// Turn it off with "designGate": false in .claude/hooks/standards.config.json.
function hasReport(dir, depth = 0) {
  if (depth > 4) return false;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === 'definition.pbir') return true;
    if (e.isDirectory() && (/\.report$/i.test(e.name) || hasReport(path.join(dir, e.name), depth + 1))) return true;
  }
  return false;
}
function appConfig(root) {
  for (const c of ['scripts/canvas-app.json', 'canvas-app.json']) {
    try { return JSON.parse(fs.readFileSync(path.join(root, c), 'utf8').replace(/^\uFEFF/, '')); } catch { /* next */ }
  }
  return {};
}
export function designGate(root, cfg) {
  const out = { findings: [], reminders: [] };
  if (cfg.designGate === false) return out;
  const app = appConfig(root);
  const hasCanvas = canvasSrcDirs(root, cfg.canvasSrcGlob).length > 0 || (app.canvasSrc && fs.existsSync(path.join(root, app.canvasSrc)));
  const hasBi = hasReport(path.join(root, 'fabric'));
  if (!hasCanvas && !hasBi) return out;
  const surface = [hasCanvas && 'canvas app', hasBi && 'Power BI report'].filter(Boolean).join(' and ');
  if (!['DESIGN.md', 'docs/DESIGN.md'].some((p) => fs.existsSync(path.join(root, p)))) {
    out.findings.push(`design: this project has a ${surface} but no DESIGN.md. Run the impeccable design skill (init, which writes PRODUCT.md and DESIGN.md), ` +
      `then turn DESIGN.md into the theme tokens and the report theme (project-setup.md section 3). If the person declined impeccable, write DESIGN.md by hand and record the decline in it.`);
  }
  const critique = readFileSafe(path.join(root, 'docs', 'design-critique.md'));
  const complete = /\.png\b/i.test(critique) && /score/i.test(critique);
  if (complete) return out;
  const outDir = path.join(root, app.outDir || 'out');
  let shipped = false;
  try { shipped = fs.readdirSync(outDir).some((f) => /\.(zip|msapp)$/i.test(f)); } catch { /* nothing packed yet */ }
  const msg = `design: ${critique ? 'docs/design-critique.md does not name the screenshots (.png) and a score' : 'no docs/design-critique.md'} - ` +
    `run impeccable's critique on the published screens at 1440 and 390 px${hasBi ? ' and the report' : ''}, fix what it raises in one batch, and record the screenshots and the score there.`;
  (shipped ? out.findings : out.reminders).push(msg);
  return out;
}

// ---- self-test (entry point only) ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes('--selftest')) libSelftest();

function libSelftest() {
  const fails = [];
  let n = 0;
  const check = (name, cond) => { n++; if (!cond) fails.push(name); };
  // Fixture values are built, not written literally, so this file passes the standards check.
  const rocket = String.fromCodePoint(0x1f680);
  const violet = '#' + '7c3aed', violet3 = '#' + 'a3e';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-lib-'));
  const put = (rel, text = 'x') => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  try {
    // findEmoji
    check('emoji found with line and code point', JSON.stringify(findEmoji(`a\nb ${rocket}`)) === JSON.stringify([{ line: 2, char: rocket, code: 'U+1F680' }]));
    check('arrows, dashes and (c) are not emoji', findEmoji('a -> b → c — d © e').length === 0);
    check('ignore marker exempts an emoji line', findEmoji(`${rocket} ${IGNORE_MARKER}`).length === 0);
    // findPurple
    check('purple hex found', findPurple(`color: ${violet};`).length === 1);
    check('three-digit purple hex found', findPurple(`color: ${violet3};`).length === 1);
    check('purple RGBA found', findPurple('Fill: =RGBA(124, 58, 237, 1)').length === 1);
    check('brand blue and teal are clean', findPurple('#0066b3 #00c0f3 #0a6e8f RGBA(25, 44, 83, 1)').length === 0);
    check('named purple found in code', findPurple("c = 'indigo'").length === 1);
    check('named colour word skipped when checkNamed is false', findPurple('the violet line', { checkNamed: false }).length === 0);
    check('ignore marker exempts a purple line', findPurple(`${violet} ${IGNORE_MARKER}`).length === 0);
    // file classifiers
    check('isProse', isProse('a/b.md') && isProse('c.TXT') && !isProse('d.json'));
    check('isHookFile (both separators)', isHookFile('x/.claude/hooks/a.mjs') && isHookFile('x\\.claude\\hooks\\a.mjs') && !isHookFile('x/hooks/a.mjs'));
    check('isTextFile', isTextFile('a.pa.yaml') && isTextFile('b.PS1') && !isTextFile('c.png') && !isTextFile('d.msapp'));
    check('hookFilePath reads tool_input then tool_response', hookFilePath({ tool_input: { file_path: 'a' } }) === 'a' &&
      hookFilePath({ tool_response: { filePath: 'b' } }) === 'b' && hookFilePath({}) === null);
    // loadConfig: defaults, then a partial file merged over them (bookkeeping merged one level deep)
    check('loadConfig defaults without a file', loadConfig(tmp) === DEFAULT_CONFIG);
    put('.claude/hooks/standards.config.json', JSON.stringify({ emoji: false, bookkeeping: { changelog: 'HISTORY.md' } }));
    const c = loadConfig(tmp);
    check('loadConfig merges a partial file', c.emoji === false && c.purpleAccents === true &&
      c.bookkeeping.changelog === 'HISTORY.md' && c.bookkeeping.stateFile === DEFAULT_CONFIG.bookkeeping.stateFile);
    put('.claude/hooks/standards.config.json', '{ not json');
    check('loadConfig falls back on a broken file', loadConfig(tmp) === DEFAULT_CONFIG);
    // isVendoredCopy: a recorded hash that matches, one that does not, and no manifest
    check('isVendoredCopy false without a manifest', isVendoredCopy(tmp, 'tool.mjs') === false);
    put('tool.mjs', 'v1');
    const sha = crypto.createHash('sha256').update('v1').digest('hex');
    put('.claude/hooks/vendored.json', JSON.stringify({ files: { 'tool.mjs': sha } }));
    check('isVendoredCopy true while unchanged', isVendoredCopy(tmp, 'tool.mjs') === true);
    put('tool.mjs', 'v2 edited');
    check('isVendoredCopy false once edited', isVendoredCopy(tmp, 'tool.mjs') === false);
    // canvasSrcDirs: only folders that hold Src
    put('canvas/AppOne/Src/App.pa.yaml'); put('canvas/AppTwo/readme.md');
    const dirs = canvasSrcDirs(tmp, 'canvas');
    check('canvasSrcDirs lists only apps with Src', dirs.length === 1 && dirs[0].endsWith(path.join('AppOne', 'Src')));
    check('canvasSrcDirs empty when the root is missing', canvasSrcDirs(tmp, 'nope').length === 0);
    // listRepoTextFiles: the walk outside git skips node_modules and binaries
    put('node_modules/pkg/index.js'); put('img/logo.png');
    const listed = listRepoTextFiles(tmp).map((f) => path.relative(tmp, f).replace(/\\/g, '/'));
    check('listRepoTextFiles walks text files only', listed.includes('canvas/AppOne/Src/App.pa.yaml') &&
      !listed.some((f) => f.startsWith('node_modules/') || f.endsWith('.png')));
    // readStdinJson: a byte-order mark must not turn the event into {} (the hook would pass vacuously)
    const probe = `import { readStdinJson } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)}; process.stdout.write(JSON.stringify(readStdinJson()));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { input: '﻿{"tool_name":"Write"}', encoding: 'utf8' });
    check('readStdinJson strips a byte-order mark', r.stdout === '{"tool_name":"Write"}');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (!n) { console.log('selftest examined nothing - NOT a pass'); process.exit(2); }
  console.log(fails.length ? `selftest FAILED ${fails.length} of ${n}:\n  ` + fails.join('\n  ') : `selftest ok: ${n} checks of the shared hook helpers`);
  process.exit(fails.length ? 1 : 0);
}
