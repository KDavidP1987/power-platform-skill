// Shared helpers for the power-platform skill's Claude Code hooks. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

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
  bookkeeping: {
    solutionDir: 'solution/',
    dependencyRegister: 'docs/dependencies.md',
    stateFile: 'docs/STATE.md',
    changelog: 'CHANGELOG.md',
  },
};
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
    return execSync('git ls-files', { cwd: root, encoding: 'utf8' })
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
