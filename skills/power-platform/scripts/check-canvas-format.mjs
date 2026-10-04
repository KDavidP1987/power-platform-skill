#!/usr/bin/env node
// check-canvas-format.mjs - formatting rules for canvas .pa.yaml source that no compile enforces.
//
// 1. TEXT FIT. A label bound to data shows whatever the data holds. In a fixed-height gallery row
//    a long value wraps onto lines the row does not have and is cut off mid-word; outside a gallery
//    it clips at the control's edge. Nothing reports it: the compile passes, the app runs, and the
//    user sees half a sentence. For every text control whose Text reads data, this works out the
//    widest text the expression can produce and the space the box has, and fails when the text can
//    exceed the box with no remedy in place.
// 2. THEME TOKENS. Screens reference the app's theme (variables or Named Formulas defined once in
//    App.pa.yaml), never literal colours or font names. A literal is a token bypass: it does not
//    follow a theme change, and re-theming later means hunting literals screen by screen.
//
// 3. LISTS THAT CANNOT BE NARROWED (advisory, a warning, never an error). A gallery over a data
//    source whose Items reads no input control and no variable gives the user no way to filter,
//    search or group it: fine for six rows, a scroll hunt at sixty. Warned when the source is a
//    table (not a literal or a small fixed collection), and always when the schema shows the table
//    has a choice column a user would scan by. Nested galleries and literal tables are skipped.
//    The intake question and the patterns: references/canvas-controls-and-patterns.md, "Lists".
// 4. ACCESSIBLE NAMES. An input, or a control people click that shows no text of its own (an icon,
//    an image, a shape used as a click target, a button with no text), is announced by a screen
//    reader as "button" or "edit" with no name unless AccessibleLabel is set. A visible label beside
//    an input is not associated with it in canvas. Buttons and labels with text are named by it.
// 5. TEXT CONTRAST. Text colour against what is actually behind it (its own Fill, else the nearest
//    earlier sibling shape or container that covers it, else the parent's fill, else the screen),
//    resolved through RGBA, ColorValue, ColorFade, Color.* and the app's colour tokens, at the
//    configured screen width and at phone width. Below 4.5:1 (3:1 for large text) is an error.
//    Anything it cannot resolve is counted as not examined - never as a pass.
// 6. LITERAL TEXT FIT. A literal caption or hint is measured like data: a two-line hint in a
//    one-line box clips just the same.
//
// Usage:
//   node check-canvas-format.mjs <Src folder or .pa.yaml files>... [--schema cols.json]
//        [--screen-width 1366] [--screen-height 768] [--char-em 0.56] [--galleries-only] [--no-theme] [--json]
//   node check-canvas-format.mjs --hook            PostToolUse hook: file path from stdin JSON
//   node check-canvas-format.mjs --selftest
//
// Exit: 0 clean, 1 findings, 2 nothing examined (no files, or no data-bound text control) - NOT a pass.
// The formula, its error direction and the four remedies: references/canvas-layout.md, "Long text".
// Names and contrast: references/canvas-layout.md, "Accessible names and contrast".
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BOM = String.fromCharCode(0xFEFF);

// ---------- the model ----------
// Classic Label defaults when a property is absent; the modern Text control has no padding.
export const DEFAULTS = {
  Label: { Size: 13, PaddingTop: 5, PaddingBottom: 5, PaddingLeft: 5, PaddingRight: 5, Wrap: true, LineHeight: 1.2 },
  Text: { Size: 14, PaddingTop: 0, PaddingBottom: 0, PaddingLeft: 0, PaddingRight: 0, Wrap: true, LineHeight: 1.2 },
};
// Sizes are points; the design surface renders 1 pt as 4/3 px. Width is measured in em (multiples
// of the font size). Literal text and choice labels are measured character by character with
// approximate widths for a proportional UI font. Data whose characters are unknown is costed at
// 0.56 em per character - wider than typical mixed-case text (about 0.5 em), so the estimate errs
// toward "does not fit". Semibold or bold is 6% wider. A wrapped box loses part of each line to
// word breaks: 10% of the multi-line width is held back.
export const MODEL = { pxPerPt: 4 / 3, unknownEm: 0.56, boldFactor: 1.06, wrapLoss: 0.9 };
const NARROW = { ' ': 0.27, i: 0.24, l: 0.24, j: 0.24, "'": 0.2, '.': 0.27, ',': 0.27, ':': 0.27, ';': 0.27, '!': 0.3, '|': 0.25,
  f: 0.32, t: 0.35, r: 0.35, I: 0.27, '(': 0.32, ')': 0.32, '-': 0.36, '/': 0.4 };
const WIDE = { m: 0.82, w: 0.73, M: 0.85, W: 0.9, '@': 0.9, '%': 0.8 };
export function emOf(s) {
  let em = 0;
  for (const ch of String(s)) {
    if (ch in NARROW) em += NARROW[ch];
    else if (ch in WIDE) em += WIDE[ch];
    else if (/[a-z]/.test(ch)) em += 0.52;
    else if (/[A-Z]/.test(ch)) em += 0.63;
    else if (/[0-9]/.test(ch)) em += 0.55;
    else em += 0.6;
  }
  return em;
}
// When a column is in no schema: guess the longest text from its name (and say so).
export const HEURISTIC = [
  [/payload|json|body|html|description|notes?$|comment|instructions|reason|details|summary|message|justification/i, 2000],
  [/e-?mail|address|url|link|path/i, 200],
  [/name|title|subject|label|team|role|location|department|manager|mentor|owner|category|vendor/i, 100],
  [/status|type|phase|stage|priority|route|channel|mode|kind|audience/i, 30],
  [/date|time|on$|at$|created|modified/i, 20],
  [/count|number|qty|quantity|amount|cost|offset|order|id$|days|hours/i, 12],
];
const HEURISTIC_DEFAULT = 100;

// ---------- a YAML subset parser for machine-serialised .pa.yaml ----------
export function parseYaml(text) {
  const raw = text.replace(BOM, '').split(/\r?\n/);
  const L = raw.map((s, i) => ({ s, n: i + 1, ind: s.match(/^ */)[0].length, blank: s.trim() === '' || /^\s*#/.test(s) }));
  let i = 0;
  const skip = () => { while (i < L.length && L[i].blank) i++; };
  function node(ind) {
    skip();
    if (i >= L.length || L[i].ind < ind) return null;
    return L[i].s.slice(L[i].ind).startsWith('- ') ? seq(L[i].ind) : map(L[i].ind);
  }
  function seq(ind) {
    const out = [];
    for (;;) {
      skip();
      if (i >= L.length || L[i].ind !== ind || !L[i].s.slice(ind).startsWith('- ')) return out;
      L[i] = { ...L[i], s: ' '.repeat(ind + 2) + L[i].s.slice(ind + 2), ind: ind + 2 };
      out.push(map(ind + 2));
    }
  }
  function map(ind) {
    const out = {};
    Object.defineProperty(out, '__line', { value: L[i] ? L[i].n : 0, enumerable: false });
    for (;;) {
      skip();
      if (i >= L.length || L[i].ind !== ind || L[i].s.slice(ind).startsWith('- ')) return out;
      const m = L[i].s.slice(ind).match(/^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/);
      if (!m) { i++; continue; }
      const key = m[1].replace(/^["']|["']$/g, '');
      const val = m[2] === undefined ? '' : m[2];
      const line = L[i].n;
      i++;
      if (/^[|>][-+]?$/.test(val.trim())) {
        const parts = []; let base = null;
        while (i < L.length && (L[i].s.trim() === '' || L[i].ind > ind)) {
          if (L[i].s.trim() !== '') { if (base === null) base = L[i].ind; parts.push(L[i].s.slice(Math.min(base, L[i].ind))); } else parts.push('');
          i++;
        }
        while (parts.length && parts[parts.length - 1] === '') parts.pop();
        out[key] = { v: parts.join('\n'), line, block: true };
      } else if (val === '') {
        out[key] = node(ind + 1) ?? { v: '', line };
      } else out[key] = { v: val.replace(/^"(.*)"$/, '$1'), line };
    }
  }
  return node(0) || {};
}

// ---------- a Power Fx subset parser ----------
export function tokenize(src) {
  const t = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"') { let s = ''; i++; for (;;) { if (i >= src.length) throw new Error('unterminated string'); if (src[i] === '"') { if (src[i + 1] === '"') { s += '"'; i += 2; continue; } i++; break; } s += src[i++]; } t.push({ k: 'str', v: s }); continue; }
    if (c === "'") { let s = ''; i++; for (;;) { if (i >= src.length) throw new Error('unterminated name'); if (src[i] === "'") { if (src[i + 1] === "'") { s += "'"; i += 2; continue; } i++; break; } s += src[i++]; } t.push({ k: 'id', v: s, q: true }); continue; }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i)); if (num) { t.push({ k: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)); if (id) { t.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = /^(&&|\|\||<>|<=|>=|[=<>&+\-*/!(),.;[\]{}:@%^])/.exec(src.slice(i));
    if (op) { t.push({ k: 'op', v: op[0] }); i += op[0].length; continue; }
    throw new Error(`unexpected '${c}'`);
  }
  return t;
}
export function parseFx(src) {
  const s = String(src).trim().replace(/^=/, '');
  const t = tokenize(s); let p = 0;
  const peek = (v) => t[p] && t[p].k === 'op' && t[p].v === v;
  const kw = (...w) => t[p] && t[p].k === 'id' && !t[p].q && w.some((x) => x.toLowerCase() === t[p].v.toLowerCase());
  const eat = (v) => { if (!peek(v)) throw new Error(`expected ${v}`); p++; };
  const chain = () => { const xs = [or()]; while (peek(';')) { p++; if (p < t.length && !peek(')')) xs.push(or()); } return xs.length === 1 ? xs[0] : { t: 'seq', xs }; };
  const bin = (next, ops, kws = []) => () => {
    let l = next();
    for (;;) {
      const o = ops.find((x) => peek(x)) || (kws.length && kw(...kws) ? t[p].v.toLowerCase() : null);
      if (!o) return l;
      p++; l = { t: 'bin', op: o, l, r: next() };
    }
  };
  const unary = () => {
    if (peek('!') || peek('-')) { const op = t[p++].v; return { t: 'un', op, x: unary() }; }
    if (kw('Not')) { p++; return { t: 'un', op: '!', x: unary() }; }
    return postfix();
  };
  const mul = bin(unary, ['*', '/', '^']);
  const add = bin(mul, ['+', '-']);
  const cat = bin(add, ['&']);
  const cmp = bin(cat, ['=', '<>', '<=', '>=', '<', '>'], ['in', 'exactin']);
  const and = bin(cmp, ['&&'], ['And']);
  const or = bin(and, ['||'], ['Or']);
  function postfix() {
    let x = primary();
    for (;;) {
      if (peek('.')) { p++; const n = t[p++]; if (!n || n.k !== 'id') throw new Error('expected name'); x = { t: 'mem', o: x, name: n.v }; continue; }
      if (peek('%')) { p++; continue; }
      return x;
    }
  }
  function primary() {
    const k = t[p];
    if (!k) throw new Error('unexpected end');
    if (k.k === 'str') { p++; return { t: 'str', v: k.v }; }
    if (k.k === 'num') { p++; return { t: 'num', v: k.v }; }
    if (peek('(')) { p++; const e = chain(); eat(')'); return e; }
    if (peek('[')) { p++; const xs = []; while (!peek(']')) { xs.push(or()); if (peek(',')) p++; } p++; return { t: 'table', xs }; }
    if (peek('{')) { p++; const f = {}; while (!peek('}')) { const n = t[p++]; eat(':'); f[n.v] = or(); if (peek(',')) p++; } p++; return { t: 'rec', f }; }
    if (k.k === 'id') {
      p++;
      if (!k.q && peek('(')) {
        p++; const args = []; let alias = null;
        while (!peek(')')) {
          args.push(chain());
          if (kw('As')) { p++; alias = alias || (t[p] && t[p].v); p++; }
          if (peek(',')) p++; else if (!peek(')')) throw new Error('expected , or )');
        }
        p++;
        return alias ? { t: 'call', name: k.v, args, alias } : { t: 'call', name: k.v, args };
      }
      return { t: 'id', v: k.v, q: !!k.q };
    }
    throw new Error(`unexpected ${k.v}`);
  }
  const e = chain();
  if (p !== t.length) throw new Error('trailing tokens');
  return e;
}
const fxKey = (n) => JSON.stringify(n);

// ---------- numeric evaluation for geometry ----------
function numEval(n, ctx, depth = 0) {
  if (!n || depth > 20) return null;
  switch (n.t) {
    case 'num': return n.v;
    case 'un': { const v = numEval(n.x, ctx, depth + 1); return v === null ? null : n.op === '-' ? -v : n.op === '!' ? (v ? 0 : 1) : null; }
    case 'bin': {
      const a = numEval(n.l, ctx, depth + 1), b = numEval(n.r, ctx, depth + 1);
      if (a === null || b === null) return null;
      const v = { '+': a + b, '-': a - b, '*': a * b, '/': b === 0 ? null : a / b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b,
        '=': a === b, '<>': a !== b, '&&': !!a && !!b, and: !!a && !!b, '||': !!a || !!b, or: !!a || !!b }[n.op];
      return v === undefined || v === null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
    }
    case 'id': return ctx.consts.has(n.v) ? ctx.consts.get(n.v) : !n.q && /^(true|false)$/i.test(n.v) ? (/^true$/i.test(n.v) ? 1 : 0) : null;
    case 'mem': {
      const root = n.o.t === 'id' ? n.o.v : null;
      if (!ctx.parentProp) return null;
      if (root === 'Parent' || root === 'App') return ctx.parentProp(n.name, root);
      if (root === 'Self') return ctx.selfProp ? ctx.selfProp(n.name) : null;
      if (root && ctx.controlProp) return ctx.controlProp(root, n.name);
      return null;
    }
    case 'call': {
      const f = n.name.toLowerCase();
      const a = n.args.map((x) => numEval(x, ctx, depth + 1));
      if (['min', 'max'].includes(f)) return a.some((x) => x === null) ? null : Math[f](...a);
      if (['rounddown', 'roundup', 'round'].includes(f)) {
        if (a[0] === null) return null;
        const d = 10 ** (a[1] ?? 0);
        return f === 'round' ? Math.round(a[0] * d) / d : f === 'rounddown' ? Math.trunc(a[0] * d) / d : Math.sign(a[0]) * Math.ceil(Math.abs(a[0]) * d) / d;
      }
      if (f === 'mod') return a[0] === null || !a[1] ? null : ((a[0] % a[1]) + a[1]) % a[1];
      if (f === 'int' || f === 'trunc') return a[0] === null ? null : f === 'int' ? Math.floor(a[0]) : Math.trunc(a[0]);
      if (f === 'abs') return a[0] === null ? null : Math.abs(a[0]);
      // A condition that resolves (a layout constant such as a phone breakpoint) picks its branch.
      if (f === 'if') {
        for (let k = 0; k + 1 < n.args.length; k += 2) {
          const cv = numEval(n.args[k], ctx, depth + 1);
          if (cv === null) break;
          if (cv) return numEval(n.args[k + 1], ctx, depth + 1);
          if (k + 2 === n.args.length - 1) return numEval(n.args[k + 2], ctx, depth + 1);
          if (k + 2 >= n.args.length) return null;
        }
      }
      // An unknown condition: the box is the SMALLER branch, so a fit check stays conservative.
      if (f === 'if' || f === 'switch') {
        const vals = f === 'if' ? n.args.filter((_, k) => k % 2 === 1 || (k === n.args.length - 1 && n.args.length % 2 === 1))
          : n.args.slice(2).filter((_, k) => k % 2 === 0 || k === n.args.length - 3);
        const nv = vals.map((x) => numEval(x, ctx, depth + 1));
        return nv.length && nv.every((x) => x !== null) ? Math.min(...nv) : null;
      }
      return null;
    }
    default: return null;
  }
}

// ---------- the widest text an expression can produce ----------
// Every result: { n: characters, em: width in em, data: reads data, clamped: data was cut,
// cols: the columns read, heuristic: some length was guessed from a column name }.
const ENUM_ROOTS = new Set(['Color', 'Font', 'FontWeight', 'Align', 'VerticalAlign', 'DisplayMode', 'Overflow', 'SortOrder', 'ScreenTransition',
  'BorderStyle', 'Icon', 'ImagePosition', 'TextFormat', 'Transition', 'LayoutMode', 'DateTimeFormat', 'TextMode', 'Self', 'App', 'Parent', 'Host', 'User']);
const NUMERIC_FNS = new Set(['len', 'countrows', 'countif', 'counta', 'count', 'sum', 'average', 'datediff', 'value', 'round', 'roundup', 'rounddown', 'abs',
  'year', 'month', 'day', 'hour', 'minute', 'second', 'weekday', 'find', 'mod', 'int', 'trunc', 'max', 'min', 'sqrt', 'power']);
const BOOL_FNS = new Set(['isblank', 'isempty', 'ismatch', 'not', 'and', 'or', 'isnumeric', 'istoday', 'startswith', 'endswith', 'iserror']);
const DATE_FNS = new Set(['now', 'today', 'dateadd', 'datevalue', 'datetimevalue', 'date', 'time', 'timevalue', 'utcnow', 'utctoday']);
const PASS_FNS = new Set(['upper', 'lower', 'proper', 'trim', 'trimends', 'plaintext', 'encodeurl', 'iferror', 'coalesce', 'textbox']);
const TABLE_FNS = new Set(['filter', 'sortbycolumns', 'sort', 'search', 'addcolumns', 'forall', 'showcolumns', 'dropcolumns', 'renamecolumns', 'distinct', 'table']);
const isVariable = (v) => /^(gbl|loc|var|ctx|col|clr|tok|the|app|g_|l_)/i.test(v);

const lit = (s) => ({ n: s.length, em: emOf(s), data: false, clamped: false, cols: [] });
const fixed = (n) => ({ n, em: n * MODEL.unknownEm, data: false, clamped: false, cols: [] });
const EMPTY = { n: 0, em: 0, data: false, clamped: false, cols: [] };
const alt = (xs) => xs.length ? { n: Math.max(...xs.map((x) => x.n)), em: Math.max(...xs.map((x) => x.em)), data: xs.some((x) => x.data),
  clamped: xs.some((x) => x.clamped), cols: xs.flatMap((x) => x.cols), heuristic: xs.some((x) => x.heuristic) } : EMPTY;
const seqOf = (xs) => ({ n: xs.reduce((a, x) => a + x.n, 0), em: xs.reduce((a, x) => a + x.em, 0), data: xs.some((x) => x.data),
  clamped: xs.some((x) => x.clamped), cols: xs.flatMap((x) => x.cols), heuristic: xs.some((x) => x.heuristic) });
const cut = (x, k) => (x.n <= k ? x : { ...x, n: k, em: Math.min(x.em, k * MODEL.unknownEm), clamped: x.clamped || x.data });

// Column info from a schema value: a number, or { maxLength, values: [choice labels] }.
export function columnInfo(v) {
  if (typeof v === 'number') return { n: v, em: v * MODEL.unknownEm };
  if (!v || typeof v !== 'object') return null;
  if (Array.isArray(v.values) && v.values.length) {
    return { n: Math.max(...v.values.map((s) => String(s).length)), em: Math.max(...v.values.map(emOf)), choice: true };
  }
  const n = v.maxLength ?? v.MaxLength;
  return n ? { n, em: n * MODEL.unknownEm } : null;
}
function findColumn(name, ctx, table) {
  const look = (m) => m && (m.get(name) ?? m.get(name.toLowerCase()));
  const o = look(ctx.overrides);
  if (o) return { heuristic: false, ...o };
  if (table && ctx.tables) {
    const t = ctx.tables.get(table) || ctx.tables.get(table.toLowerCase());
    const c = look(t);
    if (c) return { heuristic: false, ...c };
  }
  const c = look(ctx.schema);
  if (c) return { heuristic: false, ...c };
  for (const [re, n] of HEURISTIC) if (re.test(name)) return { n, em: n * MODEL.unknownEm, heuristic: true };
  return { n: HEURISTIC_DEFAULT, em: HEURISTIC_DEFAULT * MODEL.unknownEm, heuristic: true };
}
const column = (name, ctx, table) => { const c = findColumn(name, ctx, table); return { n: c.n, em: c.em, data: true, clamped: false, cols: [name], heuristic: c.heuristic }; };
// The table a formula reads first: the first name in it that the schema (or a collection) knows.
function firstTable(node, ctx) {
  if (!node || !ctx.tables) return null;
  if (node.t === 'id' && ctx.tables.has(node.v)) return node.v;
  for (const k of ['o', 'l', 'r', 'x']) if (node[k]) { const t = firstTable(node[k], ctx); if (t) return t; }
  for (const a of node.args || node.xs || []) { const t = firstTable(a, ctx); if (t) return t; }
  return null;
}

export function textLen(n, ctx, bounds = new Map(), scope = 'item') {
  if (!n) return EMPTY;
  const res = rawLen(n, ctx, bounds, scope);
  const b = bounds.get(fxKey(n));
  return b !== undefined && res.n > b ? cut(res, b) : res;
}
function rawLen(n, ctx, bounds, scope) {
  const T = (x, sc = scope, c = ctx) => textLen(x, c, bounds, sc);
  switch (n.t) {
    case 'str': return lit(n.v);
    case 'num': return lit(String(n.v));
    case 'seq': return T(n.xs[n.xs.length - 1]);
    case 'un': return fixed(5);
    case 'table': case 'rec': return EMPTY;
    case 'bin': {
      if (n.op === '&') return seqOf([T(n.l), T(n.r)]);
      if (['+', '-', '*', '/', '^'].includes(n.op)) return fixed(12);
      return fixed(5);
    }
    case 'id': {
      if (ctx.locals && ctx.locals.has(n.v)) return ctx.locals.get(n.v);
      if (/^(true|false|blank)$/i.test(n.v) && !n.q) return fixed(5);
      if (n.v === 'ThisItem' || n.v === 'ThisRecord') return EMPTY;
      // A bare or quoted name inside a gallery template or a record scope is a column.
      const scoped = scope === 'record' || ctx.inGallery;
      if (n.q || (scoped && !isVariable(n.v) && (scope === 'record' || ctx.schemaHas(n.v)))) return column(n.v, ctx, ctx.table);
      return { ...EMPTY, unknown: true };
    }
    case 'mem': {
      let root = n; while (root.t === 'mem') root = root.o;
      if (root.t === 'id' && ENUM_ROOTS.has(root.v) && !root.q) return EMPTY;
      if (ctx.locals && root.t === 'id' && ctx.locals.has(root.v) && n.o === root) {
        const rec = ctx.locals.get(root.v);
        if (rec.fields && rec.fields.has(n.name)) return rec.fields.get(n.name);
      }
      // galName.Selected.Column: the selected row of a gallery is a row of that gallery's table.
      if (n.o.t === 'mem' && n.o.name === 'Selected' && n.o.o.t === 'id' && ctx.galleries?.has(n.o.o.v)) {
        return column(n.name, ctx, ctx.galleries.get(n.o.o.v));
      }
      const rootIsData = root.t === 'call' || (root.t === 'id' && (root.v === 'ThisItem' || root.v === 'ThisRecord' || isVariable(root.v) || root.q || ctx.aliases?.has(root.v)));
      if (!rootIsData) {
        // control.Property: what a person typed or picked, bounded by that control, not by data.
        if (['Text', 'Value', 'SelectedText', 'Default'].includes(n.name)) return { ...EMPTY, unknown: true };
        if (n.name === 'Selected') return EMPTY;
      }
      if (['Value', 'Text'].includes(n.name) && n.o.t === 'mem') return T(n.o);
      let table = null;
      if (n.o.t === 'id' && (n.o.v === 'ThisItem' || n.o.v === 'ThisRecord')) table = ctx.table;
      else if (n.o.t === 'id' && ctx.aliases?.has(n.o.v)) table = ctx.aliases.get(n.o.v);
      else if (n.o.t === 'call' && n.o.args[0]) table = firstTable(n.o.args[0], ctx);
      return column(n.name, ctx, table);
    }
    case 'call': {
      const f = n.name.toLowerCase();
      const A = (k, sc = scope, c = ctx) => T(n.args[k], sc, c);
      if (f === 'if') {
        const outs = []; let bnd = new Map(bounds);
        for (let k = 0; k < n.args.length; k += 2) {
          if (k === n.args.length - 1) { outs.push(textLen(n.args[k], ctx, bnd, scope)); break; }
          outs.push(textLen(n.args[k + 1], ctx, bnd, scope));
          // If(Len(X) > N, <clamped>, X): in what follows, X is at most N characters.
          const c = n.args[k];
          if (c.t === 'bin') {
            const lenOf = (x) => (x.t === 'call' && x.name.toLowerCase() === 'len' && x.args.length === 1 ? x.args[0] : null);
            let e = null, lim = null;
            if (lenOf(c.l) && c.r.t === 'num' && (c.op === '>' || c.op === '>=')) { e = lenOf(c.l); lim = c.op === '>' ? c.r.v : c.r.v - 1; }
            if (lenOf(c.r) && c.l.t === 'num' && (c.op === '<' || c.op === '<=')) { e = lenOf(c.r); lim = c.op === '<' ? c.l.v : c.l.v - 1; }
            if (e) { bnd = new Map(bnd); bnd.set(fxKey(e), lim); }
          }
        }
        return alt(outs);
      }
      if (f === 'with' && n.args[0] && n.args[0].t === 'rec' && n.args[1]) {
        const locals = new Map(ctx.locals || []);
        for (const [k, v] of Object.entries(n.args[0].f)) locals.set(k, T(v));
        return T(n.args[1], scope, { ...ctx, locals });
      }
      if (f === 'switch') {
        const outs = []; const a = n.args;
        for (let k = 2; k < a.length; k += 2) outs.push(T(a[k]));
        if (a.length % 2 === 0) outs.push(T(a[a.length - 1]));
        return alt(outs);
      }
      if (f === 'left' || f === 'right' || f === 'mid') {
        const s = A(0);
        const kArg = n.args[f === 'mid' ? 2 : 1];
        const k = kArg ? numEval(kArg, { consts: ctx.consts }) : null;
        return k === null ? s : cut(s, Math.max(0, k));
      }
      if (f === 'text') {
        if (n.args.length >= 2 && n.args[1].t === 'str') return fixed(Math.max(n.args[1].v.length + 2, 4));
        if (n.args.length >= 2) return fixed(30);
        return A(0);
      }
      if (f === 'substitute') {
        const s = A(0); const a = n.args[1], c = n.args[2];
        const grow = a && c && a.t === 'str' && c.t === 'str' && a.v.length ? Math.max(1, c.v.length / a.v.length) : 1;
        return { ...s, n: Math.ceil(s.n * grow), em: s.em * grow };
      }
      if (f === 'char') return fixed(1);
      if (f === 'concatenate') return seqOf(n.args.map((_, k) => A(k)));
      if (f === 'concat') { const x = A(1, 'record', { ...ctx, table: firstTable(n.args[0], ctx) }); return { ...x, n: Infinity, em: Infinity, data: true, heuristic: false }; }
      if (f === 'lookup') return n.args.length >= 3 ? A(2, 'record', { ...ctx, table: firstTable(n.args[0], ctx) }) : EMPTY;
      if (NUMERIC_FNS.has(f)) return fixed(12);
      if (BOOL_FNS.has(f)) return fixed(5);
      if (DATE_FNS.has(f)) return fixed(30);
      if (PASS_FNS.has(f)) return alt(n.args.map((_, k) => A(k)));
      if (TABLE_FNS.has(f) || f === 'first' || f === 'last') return EMPTY;
      return alt(n.args.map((_, k) => A(k)));
    }
    default: return EMPTY;
  }
}

// ---------- collections: measure the columns from the formula that builds them ----------
// ClearCollect(colX, ForAll(src As t, {Name: expr, ...})) or AddColumns(src, "Name", expr): each
// column is as wide as the widest expression that fills it, so a gallery over colX is measured
// like a gallery over a table.
function collectionColumns(node, ctx, out) {
  if (!node) return;
  const put = (k, v) => { const o = out.get(k); out.set(k, o ? alt([o, v]) : v); };
  if (node.t === 'rec') { for (const [k, v] of Object.entries(node.f)) put(k, textLen(v, ctx, new Map(), 'record')); return; }
  if (node.t === 'table') { node.xs.forEach((x) => collectionColumns(x, ctx, out)); return; }
  if (node.t !== 'call') return;
  const f = node.name.toLowerCase();
  if (f === 'with' && node.args[0]?.t === 'rec') {
    const locals = new Map(ctx.locals || []);
    for (const [k, v] of Object.entries(node.args[0].f)) locals.set(k, textLen(v, ctx, new Map(), 'record'));
    collectionColumns(node.args[1], { ...ctx, locals }, out); return;
  }
  if (f === 'forall') {
    const table = firstTable(node.args[0], ctx);
    const aliases = new Map(ctx.aliases || []);
    if (node.alias) aliases.set(node.alias, table);
    collectionColumns(node.args[1], { ...ctx, table, aliases }, out); return;
  }
  if (f === 'addcolumns') {
    const table = firstTable(node.args[0], ctx);
    for (let k = 1; k + 1 < node.args.length; k += 2) {
      const nm = node.args[k].t === 'str' ? node.args[k].v : node.args[k].t === 'id' ? node.args[k].v : null;
      if (nm) put(nm, textLen(node.args[k + 1], { ...ctx, table }, new Map(), 'record'));
    }
    return;
  }
  if (f === 'if' || f === 'switch') { node.args.forEach((a) => collectionColumns(a, ctx, out)); return; }
  if (['sort', 'sortbycolumns', 'filter', 'table'].includes(f)) { node.args.forEach((a) => collectionColumns(a, ctx, out)); }
}
function findCollects(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.t === 'call' && /^(clearcollect|collect)$/i.test(node.name) && node.args[0]?.t === 'id') acc.push(node);
  for (const k of ['o', 'l', 'r', 'x']) if (node[k]) findCollects(node[k], acc);
  for (const a of node.args || node.xs || []) findCollects(a, acc);
  if (node.t === 'rec') for (const v of Object.values(node.f)) findCollects(v, acc);
  return acc;
}

// ---------- the control tree ----------
export function flatten(doc, file) {
  const out = [];
  const visit = (items, parent, screen) => {
    for (const item of items || []) {
      for (const [name, body] of Object.entries(item)) {
        if (!body || typeof body !== 'object') continue;
        const props = {};
        for (const [k, v] of Object.entries(body.Properties || {})) props[k] = v && typeof v === 'object' && 'v' in v ? v : { v: '', line: 0 };
        const c = { name, file, line: item.__line || 0, control: body.Control?.v || '', variant: body.Variant?.v || '', props, parent, screen };
        out.push(c);
        if (Array.isArray(body.Children)) visit(body.Children, c, screen);
      }
    }
  };
  for (const [sname, s] of Object.entries(doc.Screens || {})) {
    const screen = { name: sname, file, control: 'Screen', props: {}, parent: null };
    for (const [k, v] of Object.entries(s.Properties || {})) screen.props[k] = v;
    out.push(screen);
    if (Array.isArray(s.Children)) visit(s.Children, screen, screen);
  }
  return out;
}

// Numeric constants defined once: Set(name, number) in App.OnStart, Named Formulas "name = number;".
export function readConstants(appText) {
  const consts = new Map();
  if (!appText) return consts;
  for (const m of appText.matchAll(/Set\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g)) consts.set(m[1], Number(m[2]));
  for (const m of appText.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/gm)) consts.set(m[1], Number(m[2]));
  return consts;
}
// Named Formulas statements (App.Formulas), split at top-level semicolons; user-defined functions skipped.
export function formulaStatements(appText) {
  let src = '';
  try { src = parseYaml(appText).App?.Properties?.Formulas?.v || ''; } catch { return []; }
  src = src.replace(/^\s*=/, '');
  const out = []; let depth = 0, cur = '', q = null;
  for (const ch of src) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    if (ch === ')' || ch === '}' || ch === ']') depth--;
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/)).filter(Boolean).map((m) => ({ name: m[1], src: m[2] }));
}
// Layout constants defined as Named Formulas over App.Width (lyW = Max(App.Width - 18, 320)),
// evaluated at the given screen size. Only numbers and booleans; anything else stays unknown.
export function evalFormulaConstants(appText, consts, screenWidth, screenHeight) {
  const out = new Map(consts);
  const stmts = formulaStatements(appText).map((x) => ({ ...x, ast: safeParse('=' + x.src) })).filter((x) => x.ast);
  const ctx = { consts: out, parentProp: (name, root) => (root === 'App' ? (name === 'Width' ? screenWidth : name === 'Height' ? screenHeight : null) : null) };
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const x of stmts) { if (out.has(x.name)) continue; const v = numEval(x.ast, ctx); if (v !== null && Number.isFinite(v)) { out.set(x.name, v); changed = true; } }
    if (!changed) break;
  }
  return out;
}
// ---------- colour: resolve, composite, contrast ----------
const NAMED_COLOURS = { White: [255, 255, 255, 1], Black: [0, 0, 0, 1], Transparent: [0, 0, 0, 0], Red: [255, 0, 0, 1], Blue: [0, 0, 255, 1],
  Green: [0, 128, 0, 1], Gray: [128, 128, 128, 1], Grey: [128, 128, 128, 1], LightGray: [211, 211, 211, 1], DarkGray: [169, 169, 169, 1],
  Silver: [192, 192, 192, 1], Yellow: [255, 255, 0, 1], Orange: [255, 165, 0, 1], Navy: [0, 0, 128, 1], DarkBlue: [0, 0, 139, 1],
  LightBlue: [173, 216, 230, 1], WhiteSmoke: [245, 245, 245, 1], Gainsboro: [220, 220, 220, 1] };
function hexColour(str) {
  const h = String(str).trim().replace(/^#/, '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return NAMED_COLOURS[String(str).trim()] || null;
  const x = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16), x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1];
}
// The colours an expression can produce: [{ rgba, tag }] (tag = { cond, i } for an If/Switch branch),
// or null when any part cannot be resolved.
export function colourOptions(n, cmap, depth = 0) {
  if (!n || depth > 25) return null;
  if (n.t === 'id') return cmap.has(n.v) ? [{ rgba: cmap.get(n.v) }] : null;
  if (n.t === 'mem' && n.o.t === 'id' && n.o.v === 'Color') return NAMED_COLOURS[n.name] ? [{ rgba: NAMED_COLOURS[n.name] }] : null;
  if (n.t !== 'call') return null;
  const f = n.name.toLowerCase();
  const num = (a) => (a && a.t === 'num' ? a.v : a && a.t === 'un' && a.op === '-' && a.x.t === 'num' ? -a.x.v : null);
  if (f === 'rgba') { const v = n.args.map(num); return v.length === 4 && v.every((x) => x !== null) ? [{ rgba: v }] : null; }
  if (f === 'colorvalue') { const c = n.args[0] && n.args[0].t === 'str' ? hexColour(n.args[0].v) : null; return c ? [{ rgba: c }] : null; }
  if (f === 'colorfade') {
    const base = colourOptions(n.args[0], cmap, depth + 1), k = num(n.args[1]);
    if (!base || k === null) return null;
    return base.map((o) => ({ ...o, rgba: [0, 1, 2].map((j) => (k >= 0 ? o.rgba[j] + (255 - o.rgba[j]) * k : o.rgba[j] * (1 + k))).concat(o.rgba[3]) }));
  }
  if (f === 'if' || f === 'switch') {
    const vals = f === 'if' ? n.args.filter((_, k) => k % 2 === 1 || (k === n.args.length - 1 && n.args.length % 2 === 1))
      : n.args.slice(2).filter((_, k) => k % 2 === 0 || k === n.args.length - 3);
    const cond = fxKey(f === 'if' ? n.args.filter((_, k) => k % 2 === 0 && k < n.args.length - 1) : n.args.slice(0, 1));
    const out = [];
    for (const [i, v] of vals.entries()) { const o = colourOptions(v, cmap, depth + 1); if (!o) return null; out.push(...o.map((x) => ({ rgba: x.rgba, tag: x.tag || { cond, i } }))); }
    return out;
  }
  return null;
}
// Colour tokens: Set(name, <colour>) in App.OnStart and Named Formulas "name = <colour>;".
export function readColourMap(appText) {
  const cmap = new Map();
  if (!appText) return cmap;
  const defs = formulaStatements(appText);
  for (const m of appText.matchAll(/Set\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*((?:RGBA|ColorValue|ColorFade)\s*\([^\n]*?\)|Color\.[A-Za-z]+)\s*\)/g)) defs.push({ name: m[1], src: m[2] });
  for (let pass = 0; pass < 4; pass++) {
    for (const d of defs) {
      if (cmap.has(d.name)) continue;
      const o = colourOptions(safeParse('=' + d.src), cmap);
      if (o && o.length === 1) cmap.set(d.name, o[0].rgba);
    }
  }
  return cmap;
}
const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((j) => top[j] * a + under[j] * (1 - a)).concat(1); };
const lum = (c) => { const ch = c.slice(0, 3).map((v) => { const x = Math.max(0, Math.min(255, v)) / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]; };
export function contrastRatio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const rgbaText = (c) => `RGBA(${c.slice(0, 3).map((v) => Math.round(v)).join(', ')}, ${+(+c[3]).toFixed(2)})`;

// Theme tokens: names set (or defined as Named Formulas) to a colour or a font in App.pa.yaml.
export function readThemeTokens(appText) {
  const tokens = new Set();
  if (!appText) return tokens;
  const COLOURISH = /^(RGBA|ColorValue|ColorFade|Color\.|Font\.|"#)/;
  for (const m of appText.matchAll(/Set\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([^\n]+?)\)\s*;?\s*$/gm)) if (COLOURISH.test(m[2].trim())) tokens.add(m[1]);
  for (const m of appText.matchAll(/^\s*=?\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n;]+);/gm)) if (COLOURISH.test(m[2].trim())) tokens.add(m[1]);
  return tokens;
}

const STAMP_GATE = /^=?\s*false\s*$|admin|role|support|debug|diag|developer|owner|maker|showbuild|showstamp|User\(\)/i;
const TEXT_CONTROLS = /^(Label|Text|Classic\/Label|ModernText)(@|$)/i;
const COLOUR_PROPS = /(Color|Fill|Background|Border(Color)?)$/i;
const LITERAL_COLOUR = /\b(RGBA\s*\(|ColorValue\s*\(|Color\.(?!Transparent\b)[A-Z][A-Za-z]+)|"#[0-9A-Fa-f]{3,8}"/;
const LITERAL_FONT = /\bFont\.('[^']+'|[A-Za-z]+)|^="[^"]+"$/;

export function analyse(files, { schema = null, screenWidth = 1366, screenHeight = 768, galleriesOnly = false, theme = true, stampVar = 'gblBuild' } = {}) {
  const findings = [];
  const stampRe = stampVar ? new RegExp('(^|[^A-Za-z0-9_])' + String(stampVar).replace(/[^A-Za-z0-9_]/g, '') + '($|[^A-Za-z0-9_])') : null;
  const stats = { files: 0, textControls: 0, bound: 0, measured: 0, unparsed: 0, collections: 0, literalColours: 0, literalFonts: 0, galleries: 0, listsWithoutFilter: 0,
    literalMeasured: 0, nameChecked: 0, unnamed: 0, contrastExamined: 0, contrastUnexamined: 0, lowContrast: 0 };
  const appFile = files.find((f) => /(^|[\\/])App\.pa\.yaml$/i.test(f.path));
  const appText = appFile ? appFile.text : '';
  const consts = evalFormulaConstants(appText, readConstants(appText), screenWidth, screenHeight);
  const tokens = readThemeTokens(appText);
  const cmap = readColourMap(appText);
  const toMap = (obj) => new Map(Object.entries(obj || {}).flatMap(([k, v]) => { const c = columnInfo(v); return c ? [[k, c], [k.toLowerCase(), c]] : []; }));
  const flatCols = schema ? (schema.columns || (schema.tables ? {} : schema)) : null;
  const schemaMap = flatCols ? toMap(flatCols) : new Map();
  const tableMaps = new Map(schema && schema.tables ? Object.entries(schema.tables).flatMap(([k, v]) => { const m = toMap(v); return [[k, m], [k.toLowerCase(), m]]; }) : []);
  const all = [];
  for (const f of files) {
    if (/(^|[\\/])(App|_EditorState)\.pa\.yaml$/i.test(f.path)) continue;
    stats.files++;
    let doc; try { doc = parseYaml(f.text); } catch (e) { findings.push({ level: 'error', code: 'unreadable', file: f.path, line: 0, msg: e.message }); continue; }
    all.push(...flatten(doc, f.path));
  }
  const overrides = toMap(schema && schema.overrides);
  const baseCtx = { schema: schemaMap, tables: tableMaps, overrides, consts, inGallery: false, schemaHas: (nm) => schemaMap.has(nm) || schemaMap.has(nm.toLowerCase()) };
  // Collections: two passes, so a collection built from another one resolves.
  const formulas = [];
  for (const c of all) for (const pv of Object.values(c.props)) if (/Collect\s*\(/.test(pv.v || '')) formulas.push(pv.v);
  if (appText) { try { for (const pv of Object.values(parseYaml(appText).App?.Properties || {})) if (/Collect\s*\(/.test(pv.v || '')) formulas.push(pv.v); } catch { /* ignore */ } }
  const asts = formulas.flatMap((src) => { try { return findCollects(parseFx(src)); } catch { return []; } });
  for (let pass = 0; pass < 2; pass++) {
    const found = new Map();
    for (const call of asts) {
      const name = call.args[0].v;
      const cols = found.get(name) || new Map();
      for (const a of call.args.slice(1)) collectionColumns(a, baseCtx, cols);
      found.set(name, cols);
    }
    for (const [k, v] of found) { tableMaps.set(k, v); tableMaps.set(k.toLowerCase(), v); }
    stats.collections = found.size;
  }
  const byName = new Map(all.map((c) => [c.name, c]));
  baseCtx.galleries = new Map(all.filter((c) => /^Gallery/i.test(c.control || '')).map((c) => [c.name, firstTable(safeParse(c.props.Items?.v), baseCtx)]));
  const geom = new Map();
  const galleryOf = (c) => { for (let p = c.parent; p; p = p.parent) if (/^Gallery/i.test(p.control)) return p; return null; };
  function prop(c, k, seen = new Set()) {
    const key = c.name + '.' + k;
    if (geom.has(key)) return geom.get(key);
    if (seen.has(key)) return null;
    seen.add(key);
    let v = null;
    const src = c.props[k]?.v;
    const d = DEFAULTS[/^Text/i.test(c.control) ? 'Text' : 'Label'];
    const ctx = {
      consts,
      parentProp: (name, root) => {
        if (root === 'App') return name === 'Width' ? screenWidth : name === 'Height' ? screenHeight : null;
        const p = c.parent;
        if (!p || p.control === 'Screen') return name === 'Width' ? screenWidth : name === 'Height' ? screenHeight : null;
        if (/^Gallery/i.test(p.control)) {
          if (name === 'TemplateWidth' || name === 'Width') return prop(p, 'Width', seen);
          if (name === 'TemplateHeight') return prop(p, 'TemplateSize', seen);
        }
        return prop(p, name, seen);
      },
      selfProp: (name) => (name === k ? null : prop(c, name, seen)),
      controlProp: (cn, name) => (byName.has(cn) ? prop(byName.get(cn), name, seen) : null),
    };
    if (src !== undefined && src !== '') { try { v = numEval(parseFx(src), ctx); } catch { v = null; } }
    else if (k in d && c.control !== 'Screen' && !/^Gallery/i.test(c.control)) v = d[k];
    geom.set(key, v);
    return v;
  }
  for (const c of all) {
    // ---- theme tokens ----
    if (theme) for (const [k, pv] of Object.entries(c.props)) {
      const s = String(pv.v || '');
      if (COLOUR_PROPS.test(k) && LITERAL_COLOUR.test(s) && !/RGBA\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(s)) {
        stats.literalColours++;
        findings.push({ level: tokens.size ? 'error' : 'warn', code: 'literal-colour', file: c.file, line: pv.line, control: c.name,
          msg: `${c.name}.${k} uses a literal colour (${(s.match(LITERAL_COLOUR) || [''])[0].slice(0, 40)}). Reference a theme token defined once in App.pa.yaml` +
            (tokens.size ? ` (${tokens.size} defined, e.g. ${[...tokens].slice(0, 3).join(', ')}).` : ' - this app defines none yet: record the theme first (references/project-setup.md).') });
      }
      if (k === 'Font' && LITERAL_FONT.test(s.trim())) {
        stats.literalFonts++;
        findings.push({ level: tokens.size ? 'error' : 'warn', code: 'literal-font', file: c.file, line: pv.line, control: c.name,
          msg: `${c.name}.Font names a font directly (${s.trim().slice(0, 40)}). Reference the theme's font token.` });
      }
    }
    // ---- build stamp shown to every user ----
    // The stamp is for whoever ships and supports the app. A control that shows it (any property but
    // Visible references the variable) must be gated by WHO is looking: its own or an ancestor's Visible
    // is literal false, or names a role, admin, support, debug or owner flag (gblIsAdmin, locShowDebug,
    // User().Email lookups against a roles table...). A layout condition is not a gate: a measured
    // build shipped Visible: =!lyPhone, which hid the stamp on phones and showed it to every desktop user.
    if (stampRe) {
      const shows = Object.entries(c.props).find(([k, pv]) => k !== 'Visible' && stampRe.test(String(pv.v || '')));
      let gated = false;
      for (let a = c; a && !gated; a = a.parent) gated = STAMP_GATE.test(String(a.props?.Visible?.v ?? '').trim());
      if (shows && !gated) {
        findings.push({ level: 'error', code: 'build-stamp-visible', file: c.file, line: shows[1].line || c.line, control: c.name,
          msg: `${c.name}.${shows[0]} shows the build stamp (${stampVar}) to every user. Gate it - Visible on an admin or support flag - or move it to an about panel only those roles open (canvas-shipping.md, "The build stamp").` });
      }
    }
    // ---- text fit ----
    if (!TEXT_CONTROLS.test(c.control)) continue;
    stats.textControls++;
    const textSrc = c.props.Text?.v;
    if (!textSrc) continue;
    const gal = galleryOf(c);
    if (galleriesOnly && !gal) continue;
    let ast; try { ast = parseFx(textSrc); } catch { stats.unparsed++; continue; }
    const L = textLen(ast, { ...baseCtx, table: gal ? firstTable(safeParse(gal.props.Items?.v), baseCtx) : null, inGallery: !!gal });
    const literal = !L.data && isLiteralText(ast);
    if (!L.data && !literal) continue;
    if (literal && (!Number.isFinite(L.n) || L.n === 0 || /^=?\s*false\s*$/i.test(c.props.Visible?.v || ''))) continue;
    if (!literal) stats.bound++;
    const d = DEFAULTS[/^Text/i.test(c.control) ? 'Text' : 'Label'];
    const val = (k) => { const v = prop(c, k); return v === null || v === undefined ? d[k] ?? null : v; };
    const W = prop(c, 'Width'), H = prop(c, 'Height');
    const size = val('Size') ?? val('FontSize');
    const wrapSrc = (c.props.Wrap?.v || '').replace(/^=/, '').trim().toLowerCase();
    const wrap = wrapSrc ? wrapSrc === 'true' : d.Wrap;
    const auto = /^=?\s*true\s*$/i.test(c.props.AutoHeight?.v || '');
    const overflowScroll = /Overflow\.Scroll/.test(c.props.Overflow?.v || '');
    const bold = /FontWeight\.(Semibold|Bold)/i.test(c.props.FontWeight?.v || '') ? MODEL.boldFactor : 1;
    const lh = val('LineHeight') ?? 1.2;
    const where = `${c.name}${gal ? ` (gallery ${gal.name})` : ''}`;
    // The full text must be reachable: OnSelect opening a detail view, or a Tooltip that reads every
    // column the clamped text reads (a tooltip showing the email does not reveal a cut-off name).
    const lenCtx = { ...baseCtx, table: gal ? firstTable(safeParse(gal.props.Items?.v), baseCtx) : null, inGallery: !!gal };
    const tipAst = safeParse(c.props.Tooltip?.v);
    const tipCols = new Set(tipAst ? textLen(tipAst, lenCtx).cols : []);
    const tipMissing = [...new Set(L.cols)].filter((col) => !tipCols.has(col));
    const fullTextReachable = !!c.props.OnSelect?.v || (!!tipAst && tipMissing.length === 0);
    if (W === null || H === null || !size) {
      if (literal) continue;
      findings.push({ level: 'info', code: 'unmeasured', file: c.file, line: c.line, control: c.name,
        msg: `${where}: Width/Height/Size could not be resolved to numbers; fit not checked. Pass --screen-width or define the constant in App.pa.yaml.` });
      continue;
    }
    if (literal) stats.literalMeasured++; else stats.measured++;
    const px = size * MODEL.pxPerPt;
    const innerW = W - val('PaddingLeft') - val('PaddingRight');
    const innerH = H - val('PaddingTop') - val('PaddingBottom');
    const lines = wrap ? Math.max(1, Math.floor(innerH / (px * lh))) : 1;
    const roomPx = Math.max(0, innerW) * lines * (lines > 1 ? MODEL.wrapLoss : 1);
    const needPx = L.em * px * bold;
    const capacity = Math.floor(roomPx / (px * MODEL.unknownEm * bold));   // characters of unknown text that fit
    const cols = [...new Set(L.cols)].join(', ');
    const lenTxt = L.n === Infinity ? 'unbounded (a Concat of rows)' : `${L.n}`;
    const fixedRow = gal && !/variable|flex/i.test(gal.variant);
    if (overflowScroll && gal) {
      findings.push({ level: 'error', code: 'scroll-in-gallery-row', file: c.file, line: c.props.Overflow.line || c.line, control: c.name, gallery: true,
        msg: `${where}: Overflow.Scroll inside a gallery row. A row is not a reading pane: the wheel scrolls the label instead of the list. Clamp the text (remedy a) and open the full value in a detail pane (remedy c).` });
      continue;
    }
    if (L.clamped && !fullTextReachable) {
      findings.push({ level: 'error', code: 'clamped-without-full-text', file: c.file, line: c.line, control: c.name, gallery: !!gal,
        msg: `${where}: the text is cut to ${L.n} characters but nothing shows the rest` + (tipAst ? ` - its Tooltip does not read ${tipMissing.join(', ')}` : '') +
          `. Set Tooltip to the same expression as the text (remedy a), or OnSelect opening a detail view (remedy c).` });
    }
    if (needPx <= roomPx) continue;
    if (auto && !fixedRow) continue;                        // remedy b: grows (flexible-height gallery, or free layout)
    if (overflowScroll && !gal && wrap) continue;            // remedy d: a detail pane that scrolls
    const suggest = Math.max(4, capacity);
    if (literal) {
      findings.push({ level: 'error', code: 'literal-text-overflow', file: c.file, line: c.line, control: c.name, gallery: !!gal,
        msg: `${where}: the literal text (${L.n} characters) does not fit: the box has room for about ${capacity} characters ` +
          `(${lines} line${lines === 1 ? '' : 's'}, ${W}x${H} at size ${size}${wrap ? '' : ', no wrap'}, at ${screenWidth} px wide). Widen or heighten the box, allow wrap, or shorten the text.` });
      continue;
    }
    findings.push({ level: 'error', code: auto && fixedRow ? 'autoheight-in-fixed-row' : 'text-overflow', file: c.file, line: c.line, control: c.name,
      msg: `${where}: has room for about ${capacity} characters (${lines} line${lines === 1 ? '' : 's'}, ${W}x${H} at size ${size}${wrap ? '' : ', no wrap'}) ` +
        `but can receive ${lenTxt} (${cols || 'data'}${L.heuristic ? '; a length was guessed from a column name - pass --schema' : ''}).` +
        (auto && fixedRow ? ' AutoHeight does not help in a fixed-height gallery: the row still clips.' : '') +
        ` Fix: Text: =With({v: <text>}, If(Len(v) > ${suggest}, Left(v, ${suggest - 3}) & "...", v)) with Tooltip: =<text>, or a flexible-height gallery with AutoHeight.`,
      capacity, maxLength: L.n, gallery: !!gal, guessed: !!L.heuristic });
  }
  // ---- accessible names ----
  const kids = new Map();
  for (const c of all) if (c.parent) { if (!kids.has(c.parent)) kids.set(c.parent, []); kids.get(c.parent).push(c); }
  const hidden = (c) => /^=?\s*false\s*$/i.test(c.props.Visible?.v || '');
  const labelOf = (c) => { const v = (c.props.AccessibleLabel?.v || '').trim().replace(/^=/, '').trim(); return v && v !== '""' ? v : ''; };
  const acts = (c) => { const v = (c.props.OnSelect?.v || '').trim().replace(/^=/, '').trim(); return !!v && !/^(false|true|""|0)$/i.test(v); };
  const textOf = (c) => { const v = (c.props.Text?.v || '').trim().replace(/^=/, '').trim(); return v && v !== '""' ? v : ''; };
  for (const c of all) {
    if (c.control === 'Screen' || hidden(c)) continue;
    let why = null;
    if (A11Y_INPUTS.test(c.control)) why = 'an input';
    else if (CLICK_SHAPES.test(c.control) && acts(c) && !/^=?\s*-1\s*$/.test(c.props.TabIndex?.v || '')) why = `a clickable ${c.control.replace(/^Classic\//, '').toLowerCase()} with no text`;
    else if (/^(Button|Classic\/Button|ModernButton)(@|$)/i.test(c.control) && !textOf(c)) why = 'a button with no text';
    else continue;
    stats.nameChecked++;
    if (labelOf(c)) continue;
    stats.unnamed++;
    findings.push({ level: 'error', code: 'no-accessible-name', file: c.file, line: c.props.AccessibleLabel?.line || c.line, control: c.name,
      msg: `${c.name} is ${why} and has no AccessibleLabel${c.props.AccessibleLabel ? ' (it is empty)' : ''}: a screen reader announces it with no name. ` +
        `Set AccessibleLabel to what it does or asks for ("Search requests", "Close", "Due date").` +
        (CLICK_SHAPES.test(c.control) ? ' A shape that only repeats the click of a labelled control can leave the tab order instead (TabIndex: =-1).' : '') });
  }
  // ---- text contrast ----
  const WIDTHS = [...new Set([screenWidth, 390])];
  const constsAt = new Map(WIDTHS.map((w) => [w, evalFormulaConstants(appText, readConstants(appText), w, screenHeight)]));
  const geoAt = new Map();
  function gnum(c, k, w) {
    const key = `${w}|${c.name}.${k}`;
    if (geoAt.has(key)) return geoAt.get(key);
    geoAt.set(key, null);
    const src = c.props[k]?.v;
    let v = null;
    if (src !== undefined && src !== '') {
      const ctx = { consts: constsAt.get(w),
        parentProp: (name, root) => {
          if (root === 'App' || !c.parent || c.parent.control === 'Screen') return name === 'Width' ? w : name === 'Height' ? screenHeight : null;
          if (/^Gallery/i.test(c.parent.control)) { if (name === 'TemplateWidth' || name === 'Width') return gnum(c.parent, 'Width', w); if (name === 'TemplateHeight') return gnum(c.parent, 'TemplateSize', w); }
          return gnum(c.parent, name, w);
        },
        selfProp: (name) => (name === k ? null : gnum(c, name, w)),
        controlProp: (cn, name) => (byName.has(cn) ? gnum(byName.get(cn), name, w) : null) };
      try { v = numEval(parseFx(src), ctx); } catch { v = null; }
    } else if (k === 'X' || k === 'Y') v = 0;
    else if (k === 'Visible') v = 1;
    geoAt.set(key, v);
    return v;
  }
  const boxAt = (c, w) => { const b = ['X', 'Y', 'Width', 'Height'].map((k) => gnum(c, k, w)); return b.every((x) => x !== null) ? b : null; };
  const opts = (c, k) => { const src = c.props[k]?.v; if (!src) return undefined; return colourOptions(safeParse(src), cmap); };
  const UNKNOWN = () => ({ opts: [{ rgba: null }], sure: false });
  // What is drawn behind control x at width w: { opts: [{rgba, tag}], sure }. Unknown paint has rgba null.
  // A sibling whose Visible formula is one the text control (or an ancestor) also requires is shown whenever the text is.
  const conj = (src) => { const t = String(src || '').replace(/^\s*=/, '').replace(/\s+/g, ' ').trim(); return t ? t.split(/\s*&&\s*|\s+And\s+/) : []; };
  let shownWith = new Set();
  function behind(x, w, me, depth = 0) {
    if (depth > 12) return UNKNOWN();
    const p = x.parent;
    let maybes = [];
    const sibs = p ? (kids.get(p) || []) : [];
    for (let j = sibs.indexOf(x) - 1; j >= 0; j--) {
      const sb = sibs[j];
      if (!PAINTS.test(sb.control) && !(TEXT_CONTROLS.test(sb.control) && sb.props.Fill)) continue;
      let vis = gnum(sb, 'Visible', w);
      if (vis === 0) continue;
      if (vis === null && conj(sb.props.Visible?.v).every((t) => shownWith.has(t))) vis = 1;
      const b = boxAt(sb, w);
      const cx = me ? me[0] + me[2] / 2 : null, cy = me ? me[1] + me[3] / 2 : null;
      const covers = b && me ? (cx >= b[0] && cx <= b[0] + b[2] && cy >= b[1] && cy <= b[1] + b[3]) : null;
      if (covers === false) continue;
      const paint = paintOf(sb, w, depth);
      if (paint === 'clear') continue;
      if (covers && vis === 1) return { opts: paint.opts.concat(maybes), sure: paint.sure && maybes.length === 0 };
      maybes = maybes.concat(paint.opts);
    }
    const base = parentPaint(p, w, me, depth);
    return { opts: base.opts.concat(maybes), sure: base.sure && maybes.length === 0 };
  }
  function blend(o, ctl, w, depth) {
    if (o.every((x) => x.rgba[3] >= 1)) return { opts: o, sure: true };
    const below = behind(ctl, w, boxAt(ctl, w), depth + 1);
    const out = [];
    for (const t of o) for (const u of below.opts) out.push({ rgba: t.rgba[3] >= 1 ? t.rgba : u.rgba ? over(t.rgba, u.rgba) : null, tag: t.tag });
    return { opts: out, sure: below.sure };
  }
  function paintOf(sb, w, depth) {
    if (/^(Image|Classic\/Image|Icon|Classic\/Icon|HtmlViewer|Classic\/HtmlViewer|Button|Classic\/Button|ModernButton)(@|$)/i.test(sb.control)) return UNKNOWN();
    const o = opts(sb, /^Gallery/i.test(sb.control) && sb.props.TemplateFill ? 'TemplateFill' : 'Fill');
    if (o === undefined) return /^(Rectangle|Classic\/Rectangle|Circle|Classic\/Circle)(@|$)/i.test(sb.control) ? UNKNOWN() : 'clear';
    if (!o) return UNKNOWN();
    if (o.every((x) => x.rgba[3] === 0)) return 'clear';
    return blend(o, sb, w, depth);
  }
  function parentPaint(p, w, me, depth) {
    if (!p) return { opts: [{ rgba: [255, 255, 255, 1] }], sure: true };
    if (p.control === 'Screen') { const o = opts(p, 'Fill'); return o === undefined ? { opts: [{ rgba: [255, 255, 255, 1] }], sure: true } : o && o.every((x) => x.rgba[3] >= 1) ? { opts: o, sure: true } : UNKNOWN(); }
    if (/^(Group|Classic\/Group)(@|$)/i.test(p.control)) return behind(p, w, me, depth + 1);
    for (const k of /^Gallery/i.test(p.control) ? ['TemplateFill', 'Fill'] : ['Fill']) {
      const o = opts(p, k);
      if (o === undefined) continue;
      if (!o) return UNKNOWN();
      if (o.every((x) => x.rgba[3] === 0)) continue;
      return blend(o, p, w, depth);
    }
    if (/^Gallery/i.test(p.control) || CONTAINERS.test(p.control)) return behind(p, w, boxAt(p, w), depth + 1);
    return UNKNOWN();
  }
  for (const c of all) {
    if (!(TEXT_CONTROLS.test(c.control) || (c.props.Color && c.props.Fill && c.props.Text && !/^(Button|ModernButton)(@|$)/i.test(c.control)))) continue;
    if (hidden(c) || !textOf(c) || /DisplayMode\.Disabled/.test(c.props.DisplayMode?.v || '')) continue;
    const fg = opts(c, 'Color');
    const own = opts(c, 'Fill');
    const skip = (why) => { stats.contrastUnexamined++; findings.push({ level: 'info', code: 'contrast-unexamined', file: c.file, line: c.line, control: c.name, msg: `${c.name}: contrast not examined - ${why}.` }); };
    if (!fg || own === null) { skip(!c.props.Color ? 'no Color set (the theme default is not known here)' : !fg ? 'Color does not resolve to a colour' : 'Fill does not resolve to a colour'); continue; }
    const sizeV = gnum(c, 'Size', screenWidth) ?? gnum(c, 'FontSize', screenWidth) ?? (c.props.Size || c.props.FontSize ? null : DEFAULTS[/^Text/i.test(c.control) ? 'Text' : 'Label'].Size);
    const bold = /FontWeight\.Bold/.test(c.props.FontWeight?.v || '');
    const need = sizeV === null ? null : sizeV >= 18 || (bold && sizeV >= 14) ? 3 : 4.5;
    let worst = null, unsure = null, seen = false;
    shownWith = new Set();
    for (let a = c; a; a = a.parent) for (const t of conj(a.props.Visible?.v)) shownWith.add(t);
    for (const w of WIDTHS) {
      if (gnum(c, 'Visible', w) === 0) continue;
      seen = true;
      let bg;
      if (own && own.every((x) => x.rgba[3] >= 1)) bg = { opts: own, sure: true };
      else if (own && !own.every((x) => x.rgba[3] === 0)) bg = blend(own, c, w, 0);
      else bg = behind(c, w, boxAt(c, w));
      // Pair branches of the same condition; two different conditions cannot be paired from source.
      const fgTags = new Set(fg.map((x) => x.tag && x.tag.cond)), bgTags = new Set(bg.opts.map((x) => x.tag && x.tag.cond));
      const shared = [...fgTags].find((t) => t && bgTags.has(t));
      const crossUnknown = !shared && [...fgTags].some(Boolean) && [...bgTags].some(Boolean);
      const pairs = [];
      for (const a of fg) for (const b of bg.opts) {
        if (shared && a.tag && b.tag && a.tag.cond === shared && b.tag.cond === shared && a.tag.i !== b.tag.i) continue;
        pairs.push({ fg: a.rgba, bg: b.rgba, r: b.rgba ? contrastRatio(a.rgba[3] < 1 ? over(a.rgba, b.rgba) : a.rgba, b.rgba) : null });
      }
      const bad = (x) => x.r !== null && x.r < (need === null ? 3 : need);
      const fails = pairs.filter(bad);
      if (bg.sure && !crossUnknown) {
        if (fails.length) { const f = fails.reduce((a, b) => (a.r < b.r ? a : b)); if (!worst || f.r < worst.r) worst = { ...f, w }; }
        if (need === null && pairs.some((x) => x.r !== null && x.r >= 3 && x.r < 4.5)) unsure = 'its size does not resolve and a ratio is between 3:1 and 4.5:1';
      } else if (pairs.length && pairs.every(bad)) {
        const f = pairs.reduce((a, b) => (a.r < b.r ? a : b)); if (!worst || f.r < worst.r) worst = { ...f, w };
      } else if (pairs.length && !crossUnknown && pairs.every((x) => x.r !== null && x.r >= (need === null ? 4.5 : need))) {
        // every backdrop it could have passes: examined, not assumed
      } else unsure = crossUnknown ? 'its Color and its backdrop depend on different conditions' : pairs.some((x) => x.r === null)
        ? 'something behind it is an image, a button or a fill that does not resolve' : 'what is behind it depends on geometry or visibility that does not resolve';
    }
    if (!seen) continue;
    if (worst) {
      stats.contrastExamined++; stats.lowContrast++;
      findings.push({ level: 'error', code: 'low-contrast', file: c.file, line: c.props.Color?.line || c.line, control: c.name, gallery: !!galleryOf(c),
        msg: `${c.name}: text ${rgbaText(worst.fg)} on ${rgbaText(worst.bg)} is ${worst.r.toFixed(2)}:1 at ${worst.w} px wide; ` +
          `${need === 3 ? 'large text needs 3:1' : 'text needs 4.5:1 (3:1 only from 18 pt, or 14 pt bold)'}. Use a darker ink token on light grounds, or a lighter one on dark grounds.` });
    } else if (unsure) skip(unsure);
    else stats.contrastExamined++;
  }
  // ---- lists: can the user narrow this gallery? ----
  const inputs = new Set(all.filter((c) => INPUT_CONTROLS.test(c.control)).map((c) => c.name));
  for (const g of all) {
    if (!/^Gallery/i.test(g.control)) continue;
    stats.galleries++;
    if (galleryOf(g)) continue;                                   // nested: narrowed by its parent row
    const src = (g.props.Items?.v || '').trim().replace(/^=/, '');
    if (!src || /^(Table\s*\(|\[)/i.test(src)) continue;           // a literal list the app owns
    const ids = new Set((src.replace(/"[^"]*"/g, '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || []));
    const narrowed = [...ids].some((x) => inputs.has(x) || isVariable(x) && !/^col/i.test(x)) || /\b(GroupBy|Search)\s*\(/i.test(src);
    if (narrowed) continue;
    const table = firstTable(safeParse('=' + src), baseCtx);
    const base = (src.match(/^[A-Za-z_'][^(,]*/) || [''])[0].replace(/'/g, '').trim();
    const isCollection = /^col/i.test(base) || (table && /^col/i.test(table));
    const t = table && (tableMaps.get(table) || tableMaps.get(table.toLowerCase()));
    const choice = t ? [...t.entries()].find(([k, v]) => v && v.choice && !SYSTEM_CHOICES.test(k)) : null;
    if (isCollection && !choice) continue;                         // a collection the app built: usually small and pre-filtered
    stats.listsWithoutFilter++;
    findings.push({ level: 'warn', code: 'list-without-filter', file: g.file, line: g.props.Items?.line || g.line, control: g.name,
      msg: `gallery '${g.name}' (Items: ${src.slice(0, 80)}) reads no filter, search or grouping control` +
        (choice ? `, and its table has a choice column (${choice[0]}) a user would scan by` : '') +
        `. Ask whether users need to filter, search or group it; the default is a dropdown with "All" per choice column, ` +
        `a search box on the name, a sort, and section headers for categorised data (references/canvas-controls-and-patterns.md, "Lists").` });
  }
  findings.sort((a, b) => (b.gallery === true) - (a.gallery === true) || a.file.localeCompare(b.file) || a.line - b.line);
  return { findings, stats };
}
// System choices (record state and status reason, ownership, component state) are not what a user scans a list by.
const SYSTEM_CHOICES = /^(statecode|statuscode|status|status reason|componentstate|owneridtype|importsequencenumber)$/i;
const INPUT_CONTROLS = /^(Dropdown|ComboBox|TextInput|Text ?input|Toggle|Checkbox|Radio|DatePicker|ListBox|Slider|Classic\/(Dropdown|ComboBox|TextInput|Toggle|CheckBox|Radio|DatePicker|ListBox|Slider)|ModernDropdown|ModernCombobox|ModernTextInput|ModernToggle|ModernCheckbox|ModernRadio|ModernDatePicker|TabList)(@|$)/i;
// Inputs that need an AccessibleLabel (the DataField children of a ComboBox are not inputs themselves).
const A11Y_INPUTS = /^(Dropdown|ComboBox|TextInput|NumberInput|Toggle|Slider|Rating|DatePicker|ListBox|Radio|Classic\/(Dropdown|ComboBox|TextInput|Toggle|DatePicker|ListBox|Slider|Radio|Rating)|ModernDropdown|ModernCombobox|ModernTextInput|ModernNumberInput|ModernToggle|ModernRadio|ModernDatePicker|ModernSlider)(@|$)/i;
const CLICK_SHAPES = /^(Icon|Classic\/Icon|Image|Classic\/Image|Rectangle|Classic\/Rectangle|Circle|Classic\/Circle|Triangle|Classic\/Triangle|Pentagon|Hexagon|Octagon|Star|Arrow|Shape)(@|$)/i;
const PAINTS = /^(Rectangle|Classic\/Rectangle|Circle|Classic\/Circle|Image|Classic\/Image|Icon|Classic\/Icon|HtmlViewer|Classic\/HtmlViewer|Button|Classic\/Button|ModernButton|Gallery|GroupContainer|Container|ManualLayoutContainer|HorizontalContainer|VerticalContainer|Form|Classic\/Form|ModernCard)(@|$)/i;
const CONTAINERS = /^(GroupContainer|Container|ManualLayoutContainer|HorizontalContainer|VerticalContainer|Form|Classic\/Form|ModernCard)(@|$)/i;
function safeParse(src) { try { return src ? parseFx(src) : null; } catch { return null; } }
// Text the app writes itself: strings, joined with &, chosen by If/Switch (any condition), or cased.
function isLiteralText(n) {
  if (!n) return false;
  if (n.t === 'str') return true;
  if (n.t === 'bin' && n.op === '&') return isLiteralText(n.l) && isLiteralText(n.r);
  if (n.t !== 'call') return false;
  const f = n.name.toLowerCase();
  if (f === 'if') return n.args.every((a, k) => (k % 2 === 0 && k < n.args.length - 1) || isLiteralText(a));
  if (f === 'switch') return n.args.slice(1).every((a, k) => k % 2 === 0 || isLiteralText(a)) && isLiteralText(n.args[n.args.length - 1]);
  if (['concatenate', 'upper', 'lower', 'proper', 'trim'].includes(f)) return n.args.every(isLiteralText);
  return false;
}

// ---------- loading and CLI ----------
function collect(paths) {
  const out = [];
  const visit = (p) => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) visit(path.join(p, f)); return; }
    if (p.endsWith('.pa.yaml')) out.push({ path: p, text: fs.readFileSync(p, 'utf8') });
  };
  paths.forEach(visit);
  return out;
}
// Schema: { tables: { <table>: { <column>: n } }, columns: { <column>: n } }, or a flat { <column>: n }.
// n is the longest text the column holds: a number, { maxLength: n }, or { values: [labels] } for a choice.
// overrides: { <column>: { maxLength, reason } } - a limit the APP enforces (an input's Max, a generated
// name's pattern), tighter than the column's own; it wins over tables and columns. Give the reason.
export function loadSchema(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(BOM, ''));
  return j.tables || j.columns || j.overrides ? { tables: j.tables || null, columns: j.columns || {}, overrides: j.overrides || {} } : { columns: j };
}
function report(res, json) {
  const { findings, stats } = res;
  if (json) { console.log(JSON.stringify(res, null, 2)); return; }
  for (const f of findings.filter((x) => x.level !== 'info')) console.log(`${f.level.toUpperCase().padEnd(5)} ${f.code}  ${path.basename(f.file)}:${f.line}  ${f.msg}`);
  const unm = findings.filter((x) => x.code === 'unmeasured').length;
  console.log(`\n${stats.files} screen file(s); ${stats.textControls} text control(s), ${stats.bound} bound to data, ${stats.measured} measured` +
    `${unm ? `, ${unm} not measurable` : ''}${stats.unparsed ? `, ${stats.unparsed} formula(s) not parsed` : ''}; ${stats.collections} collection(s) measured; ` +
    `${stats.literalColours} literal colour(s), ${stats.literalFonts} literal font(s); ${stats.galleries} gallery(ies), ` +
    `${stats.listsWithoutFilter} with no filter, search or grouping (advisory); ${stats.literalMeasured} literal text control(s) measured; ` +
    `${stats.nameChecked} control(s) needing a name, ${stats.unnamed} without one; text contrast: ${stats.contrastExamined} examined, ` +
    `${stats.lowContrast} below the minimum, ${stats.contrastUnexamined} not examined (colour or backdrop unresolved - not a pass).`);
  console.log('Room is an estimate that errs toward "does not fit"; confirm a borderline case in the running app.');
}

// The build-stamp variable is the one the ship writes (canvas-app.json buildStampVariable, default gblBuild).
function readStampVar(root = process.cwd()) {
  for (const c of ['scripts/canvas-app.json', 'canvas-app.json']) {
    try { const v = JSON.parse(fs.readFileSync(path.join(root, c), 'utf8').replace(/^\uFEFF/, '')).buildStampVariable; if (v) return v; } catch { /* next */ }
  }
  return 'gblBuild';
}
function hookMode() {
  let input = {}; try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* not a hook payload */ }
  const file = input?.tool_input?.file_path || input?.tool_response?.filePath;
  if (!file || !file.endsWith('.pa.yaml') || /(^|[\\/])(App|_EditorState)\.pa\.yaml$/i.test(file)) process.exit(0);
  const dir = path.dirname(file);
  // The whole Src folder is read so collections built on other screens resolve; only this file's findings are reported.
  const files = collect([dir]);
  let schema = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.claude', 'hooks', 'standards.config.json'), 'utf8'));
    if (cfg.textFitSchema) schema = loadSchema(path.resolve(process.cwd(), cfg.textFitSchema));
  } catch { /* no config: lengths guessed from column names */ }
  const res = analyse(files, { schema, stampVar: readStampVar() });
  // A write-time hook blocks only on what is known: a length guessed from a column name does not block
  // (configure textFitSchema in .claude/hooks/standards.config.json to check those too).
  const mine = res.findings.filter((f) => f.level === 'error' && path.resolve(f.file) === path.resolve(file) && !(f.guessed && !schema));
  // Two tiers (project-setup.md section 4): a missing accessible name is real but not fatal, and an
  // existing app can have one on every screen - blocking would get the hook switched off. Note it.
  const NOTE_ONLY = new Set(['no-accessible-name']);
  const bad = mine.filter((f) => !NOTE_ONLY.has(f.code));
  const notes = mine.filter((f) => NOTE_ONLY.has(f.code));
  if (!bad.length) {
    if (notes.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext:
      `Accessibility note for ${path.basename(file)} (not blocking): ` + notes.map((f) => f.msg).join(' | ') +
      ' Give each an AccessibleLabel, or TabIndex -1 for a purely decorative click target (canvas-layout.md, "Accessible names and contrast").' } }));
    process.exit(0);
  }
  console.error(`Formatting check failed for ${path.basename(file)} (text fit, theme tokens, names and contrast):\n\n  ` + bad.map((f) => `${f.code}: ${f.msg}`).join('\n  ') +
    `\n\nSee references/canvas-layout.md, "Long text: the fit rule" and "Accessible names and contrast".`);
  process.exit(2);
}

// ---------- self-test ----------
const APP = ['App:', '  Properties:', '    OnStart: |', '      =Set(gblRowW, 600);', '      Set(clrText, RGBA(31, 41, 51, 1));', '      Set(clrMuted, RGBA(82, 96, 109, 1))'].join('\n');
function screen(rows, items = '=Requests') {
  return ['Screens:', '  scrList:', '    Children:', '      - galItems:', '          Control: Gallery', '          Variant: Vertical', '          Properties:',
    `            Items: ${items}`, '            Width: =gblRowW', '            Height: =400', '            TemplateSize: =50', '          Children:', ...rows].join('\n');
}
const label = (name, props) => ['            - ' + name + ':', '                Control: Label', '                Properties:', ...Object.entries(props).map(([k, v]) => `                  ${k}: ${v}`)];
const SCHEMA = { Title: 200, Notes: { maxLength: 2000 }, Code: 8, 'Status (app_status)': { values: ['Open', 'Waiting on Approval', 'Closed'] } };
const CASES = [
  // [name, rows, expected codes]
  ['long-title-clips', label('lblTitle', { Text: '=ThisItem.Title', Width: '=300', Height: '=22', Size: '=11' }), ['text-overflow']],
  ['clamped-with-tooltip', label('lblTitle', { Text: '=With({v: ThisItem.Title}, If(Len(v) > 34, Left(v, 31) & "...", v))', Tooltip: '=ThisItem.Title', Width: '=300', Height: '=22', Size: '=11' }), []],
  ['clamped-inline-with-tooltip', label('lblTitle', { Text: '=If(Len(ThisItem.Title) > 34, Left(ThisItem.Title, 31) & "...", ThisItem.Title)', Tooltip: '=ThisItem.Title', Width: '=300', Height: '=22', Size: '=11' }), []],
  ['clamped-without-tooltip', label('lblTitle', { Text: '=Left(ThisItem.Title, 30)', Width: '=300', Height: '=22', Size: '=11' }), ['clamped-without-full-text']],
  ['clamped-tooltip-reads-other-column', label('lblTitle', { Text: '=Left(ThisItem.Title, 30)', Tooltip: '=ThisItem.Code', Width: '=300', Height: '=22', Size: '=11' }), ['clamped-without-full-text']],
  ['clamped-opens-detail', label('lblTitle', { Text: '=Left(ThisItem.Title, 30)', OnSelect: '=Set(locOpen, ThisItem)', Width: '=300', Height: '=22', Size: '=11' }), []],
  ['short-code-fits', label('lblCode', { Text: '="Ref " & ThisItem.Code', Width: '=120', Height: '=22', Size: '=10' }), []],
  ['choice-measured-by-its-labels', label('lblStatus', { Text: '=ThisItem.\'Status (app_status)\' & ""', Width: '=150', Height: '=24', Size: '=10', FontWeight: '=FontWeight.Semibold' }), []],
  ['choice-too-narrow', label('lblStatus', { Text: '=ThisItem.\'Status (app_status)\' & ""', Width: '=90', Height: '=24', Size: '=10' }), ['text-overflow']],
  ['parent-width-relative', label('lblNotes', { Text: '=ThisItem.Notes', Width: '=Parent.TemplateWidth - 20', Height: '=40', Size: '=10' }), ['text-overflow']],
  ['autoheight-in-fixed-row', label('lblNotes', { Text: '=ThisItem.Notes', Width: '=300', Height: '=40', Size: '=10', AutoHeight: '=true' }), ['autoheight-in-fixed-row']],
  ['scroll-in-row', label('lblNotes', { Text: '=ThisItem.Notes', Width: '=300', Height: '=40', Size: '=10', Overflow: '=Overflow.Scroll' }), ['scroll-in-gallery-row']],
  ['literal-colour-with-theme', label('lblCode', { Text: '=ThisItem.Code', Width: '=120', Height: '=22', Size: '=10', Color: '=RGBA(200, 0, 0, 1)' }), ['literal-colour']],
  ['token-colour', label('lblCode', { Text: '=ThisItem.Code', Width: '=120', Height: '=22', Size: '=10', Color: '=clrText' }), []],
];
function selftest() {
  const fails = [];
  const run = (text, schema = SCHEMA, name = 's') => analyse([{ path: 'App.pa.yaml', text: APP }, { path: name + '.pa.yaml', text }], { schema });
  for (const [name, rows, want] of CASES) {
    const res = run(screen(rows), SCHEMA, name);
    const got = [...new Set(res.findings.filter((f) => f.level !== 'info' && f.code !== 'list-without-filter').map((f) => f.code))].sort();
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) fails.push(`${name}: expected [${want.join(', ')}], got [${got.join(', ')}]`);
    if (res.stats.bound !== 1) fails.push(`${name}: expected 1 bound text control examined, got ${res.stats.bound}`);
  }
  // Remedy b: a flexible-height gallery with AutoHeight grows. Remedy d: a detail pane outside a gallery may scroll.
  const flex = screen(label('lblNotes', { Text: '=ThisItem.Notes', Width: '=300', Height: '=40', Size: '=10', AutoHeight: '=true' })).replace('Variant: Vertical', 'Variant: VariableHeight');
  if (run(flex).findings.some((f) => f.level === 'error')) fails.push('flexible-height + AutoHeight should pass');
  const pane = (scroll) => ['Screens:', '  scrDetail:', '    Children:', '      - lblBody:', '          Control: Label', '          Properties:',
    '            Text: =gblRequest.Notes', '            Width: =600', '            Height: =200', ...(scroll ? ['            Overflow: =Overflow.Scroll'] : [])].join('\n');
  const r2 = run(pane(true));
  if (r2.findings.some((f) => f.level === 'error') || r2.stats.bound !== 1) fails.push(`detail pane with Overflow.Scroll should pass (bound ${r2.stats.bound})`);
  if (!run(pane(false)).findings.some((f) => f.code === 'text-overflow')) fails.push('detail pane without scroll should overflow');
  // No theme defined: literal colours are warnings, not errors.
  const r4 = analyse([{ path: 's.pa.yaml', text: screen(label('lblCode', { Text: '=ThisItem.Code', Width: '=120', Height: '=22', Size: '=10', Color: '=RGBA(200, 0, 0, 1)' })) }], { schema: SCHEMA });
  if (!r4.findings.some((f) => f.code === 'literal-colour' && f.level === 'warn')) fails.push('literal colour without a theme should warn');
  // The floor: a literal label is not bound, so a screen of literals examines nothing (CLI exit 2).
  if (run(screen(label('lblStatic', { Text: '="Requests"', Width: '=120', Height: '=22' }))).stats.bound !== 0) fails.push('a literal label must not count as bound');
  // Per-table schema: the gallery shows Requests, where the same column name is short.
  const tschema = { tables: { Requests: { Category: 11 }, Tasks: { Category: 40 } }, columns: { Category: 40 } };
  if (run(screen(label('lblCat', { Text: '=ThisItem.Category', Width: '=120', Height: '=22', Size: '=10' })), tschema).findings.some((f) => f.level === 'error'))
    fails.push('per-table schema: an 11-character column should fit 120 px');
  // gallery.Selected.Column outside the gallery resolves against that gallery's table.
  const sel = (col) => screen(label('lblCat', { Text: '=ThisItem.Category', Width: '=120', Height: '=22', Size: '=10' })) +
    ['', '      - lblSel:', '          Control: Label', '          Properties:', `            Text: =galItems.Selected.${col}`,
     '            Width: =120', '            Height: =22', '            Size: =10'].join('\n');
  const rs = run(sel('Category'), tschema);
  if (rs.findings.some((f) => f.level === 'error') || rs.stats.bound !== 2) fails.push(`Selected.Category of a Requests gallery should fit (bound ${rs.stats.bound})`);
  if (!run(sel('Notes')).findings.some((f) => f.code === 'text-overflow' && /lblSel/.test(f.msg + (f.control || '')))) fails.push('Selected.Notes (2,000) should overflow 120 px');
  // With(): a bound name carries its clamped length.
  const r7 = run(screen(label('lblW', { Text: '=With({t: Left(ThisItem.Notes, 8)}, "Note " & t)', Width: '=120', Height: '=22', Size: '=10', Tooltip: '=ThisItem.Notes' })));
  if (r7.findings.some((f) => f.level === 'error') || r7.stats.bound !== 1) fails.push('With(): a bound name carries its clamped length');
  // A collection's columns are measured from the formula that builds it.
  const coll = screen(label('lblN', { Text: '=ThisItem.Short', Width: '=120', Height: '=22', Size: '=10' }), '=colRows')
    .replace('    Children:\n      - galItems:', '    Properties:\n      OnVisible: =ClearCollect(colRows, ForAll(Requests As r, {Short: Left(r.Notes, 10), Long: r.Notes}))\n    Children:\n      - galItems:');
  const rc = run(coll);
  if (rc.findings.some((f) => f.level === 'error') || rc.stats.collections !== 1) fails.push(`collection column measured from its formula (collections ${rc.stats.collections})`);
  if (!run(coll.replace('ThisItem.Short', 'ThisItem.Long')).findings.some((f) => f.code === 'text-overflow')) fails.push('a long collection column should overflow');
  // Lists: a table gallery with no input feeding it is advised; a dropdown or search feeding it, a
  // literal table, or a nested gallery is not. The advice is a warning, so the CLI exit stays 0.
  const listCode = (text) => run(text).findings.filter((f) => f.code === 'list-without-filter').map((f) => f.level);
  const plain = screen(label('lblCode', { Text: '=ThisItem.Code', Width: '=120', Height: '=22', Size: '=10' }));
  if (JSON.stringify(listCode(plain)) !== '["warn"]') fails.push(`list: an unfiltered table gallery should warn once, got ${JSON.stringify(listCode(plain))}`);
  const withDrop = plain.replace("Items: =Requests", "Items: =Filter(Requests, drpStatus.Selected.Value = \"All\" || Status = drpStatus.Selected.Value)")
    .replace('    Children:\n      - galItems:', '    Children:\n      - drpStatus:\n          Control: Dropdown\n          Properties:\n            Items: =["All", "Open"]\n      - galItems:');
  if (listCode(withDrop).length) fails.push('list: a gallery filtered by a dropdown should not warn');
  if (listCode(plain.replace('Items: =Requests', 'Items: =Table({Code: "A"}, {Code: "B"})')).length) fails.push('list: a literal table should not warn');
  if (listCode(plain.replace('Items: =Requests', 'Items: =Search(Requests, locQuery, Title)')).length) fails.push('list: a searched gallery should not warn');

  // ---- accessible names, contrast and literal fit ----
  // Free-standing controls on a screen: [name, control, {props}] in declaration order (later draws on top).
  const free = (ctrls, screenProps = {}) => ['Screens:', '  scrA:', ...(Object.keys(screenProps).length ? ['    Properties:', ...Object.entries(screenProps).map(([k, v]) => `      ${k}: ${v}`)] : []),
    '    Children:', ...ctrls.flatMap(([n, ctl, props]) => [`      - ${n}:`, `          Control: ${ctl}`, '          Properties:', ...Object.entries(props).map(([k, v]) => `            ${k}: ${v}`)])].join('\n');
  const APP2 = ['App:', '  Properties:', '    Formulas: |-', '      =clrNavy = RGBA(25, 44, 83, 1);', '      clrOnNavy = ColorFade(clrNavy, 0.9);', '      clrInk = RGBA(27, 37, 51, 1);',
    '      lyW = Max(App.Width - 18, 320);', '      lyPhone = lyW < 700;', '      lyPad = If(lyPhone, 14, 28);', '      lyCols = If(lyPhone, 2, 6);'].join('\n');
  const expect = (name, text, want, extra) => {
    const r = analyse([{ path: 'App.pa.yaml', text: APP2 }, { path: 'a.pa.yaml', text }]);
    const got = [...new Set(r.findings.filter((f) => f.level !== 'info' && !['list-without-filter', 'literal-colour'].includes(f.code)).map((f) => f.code))].sort();
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) fails.push(`${name}: expected [${want.join(', ')}], got [${got.join(', ')}]`);
    if (extra) { const m = extra(r); if (m) fails.push(`${name}: ${m}`); }
  };
  const box = { X: '=20', Y: '=20', Width: '=300', Height: '=40', Size: '=11' };
  // Names: inputs, clickable shapes and text-less buttons need one; text names buttons and labels.
  expect('name: text input without a label', free([['txtSearch', 'TextInput', { ...box }]]), ['no-accessible-name']);
  expect('name: text input with a label', free([['txtSearch', 'TextInput', { ...box, AccessibleLabel: '="Search requests"' }]]), []);
  expect('name: empty label on a combo box', free([['cmbOwner', 'ComboBox', { ...box, AccessibleLabel: '=""' }]]), ['no-accessible-name']);
  expect('name: clickable icon without a label', free([['icoClose', 'Classic/Icon', { ...box, OnSelect: '=Back()' }]]), ['no-accessible-name']);
  expect('name: clickable icon with a label', free([['icoClose', 'Classic/Icon', { ...box, OnSelect: '=Back()', AccessibleLabel: '="Close"' }]]), []);
  expect('name: click pad out of the tab order', free([['recPad', 'Rectangle', { ...box, OnSelect: '=Select(btnOpen)', TabIndex: '=-1', Fill: '=Color.Transparent' }]]), []);
  expect('name: decorative image', free([['imgBand', 'Image', { ...box, AccessibleLabel: '=""' }]]), []);
  expect('name: button named by its text', free([['btnSave', 'Button', { ...box, Text: '="Save"', OnSelect: '=Set(x, 1)' }]]), []);
  expect('name: button with no text', free([['btnGo', 'Button', { ...box, Text: '=""', OnSelect: '=Set(x, 1)' }]]), ['no-accessible-name']);
  expect('name: hidden input', free([['txtOld', 'TextInput', { ...box, Visible: '=false' }]]), []);
  // Contrast: grey 150 on the default white screen is 2.96:1, grey 130 is 3.95:1 (fails normal, passes large).
  expect('contrast: light grey on white', free([['lblHint', 'Label', { ...box, Text: '="Due"', Color: '=RGBA(150, 150, 150, 1)' }]]), ['low-contrast'],
    (r) => (r.stats.lowContrast === 1 ? null : `lowContrast ${r.stats.lowContrast}`));
  expect('contrast: mid grey, normal size', free([['lblHint', 'Label', { ...box, Text: '="Due"', Color: '=RGBA(130, 130, 130, 1)' }]]), ['low-contrast']);
  expect('contrast: mid grey, 18 pt', free([['lblHint', 'Label', { ...box, Text: '="Due"', Color: '=RGBA(130, 130, 130, 1)', Size: '=18' }]]), []);
  expect('contrast: mid grey, 14 pt bold', free([['lblHint', 'Label', { ...box, Text: '="Due"', Color: '=RGBA(130, 130, 130, 1)', Size: '=14', FontWeight: '=FontWeight.Bold' }]]), []);
  expect('contrast: token ink on white', free([['lblHint', 'Label', { ...box, Text: '="Due"', Color: '=clrInk' }]]), [], (r) => (r.stats.contrastExamined === 1 ? null : 'not examined'));
  expect('contrast: screen fill is the ground', free([['lblHint', 'Label', { ...box, Text: '="Due"', Color: '=clrNavy' }]], { Fill: '=clrNavy' }), ['low-contrast']);
  const header = (color, extra = {}, labelExtra = {}) => free([['recHead', 'Rectangle', { X: '=0', Y: '=0', Width: '=App.Width', Height: '=60', Fill: '=clrNavy', ...extra }],
    ['lblTitle', 'Label', { X: '=lyPad', Y: '=10', Width: '=400', Height: '=40', Size: '=14', Text: '="Orders"', Color: color, ...labelExtra }]]);
  expect('contrast: faded token on a navy band', header('=clrOnNavy'), [], (r) => (r.stats.contrastExamined === 1 ? null : 'not examined'));
  expect('contrast: navy text on a navy band', header('=RGBA(35, 58, 104, 1)'), ['low-contrast']);
  expect('contrast: a band of unknown height is not a pass', header('=clrOnNavy', { Height: '=CountRows(colRows) * 20' }), [],
    (r) => (r.stats.contrastUnexamined === 1 && r.stats.contrastExamined === 0 ? null : `examined ${r.stats.contrastExamined}, unexamined ${r.stats.contrastUnexamined}`));
  expect('contrast: band shown on a tab the label shares', header('=clrOnNavy', { Visible: '=locTab = "a"' }, { Visible: '=locTab = "a"' }), [],
    (r) => (r.stats.contrastExamined === 1 ? null : 'shared visibility not paired'));
  expect('contrast: a half-transparent scrim is composited', free([['recScrim', 'Rectangle', { X: '=0', Y: '=0', Width: '=App.Width', Height: '=App.Height', Fill: '=RGBA(0, 0, 0, 0.5)' }],
    ['lblMsg', 'Label', { ...box, Text: '="Saving"', Color: '=Color.White' }]]), ['low-contrast']);
  expect('contrast: paired branches of one condition', free([['lblChip', 'Label', { ...box, Text: '="Open"', Fill: '=If(locSel, clrNavy, Color.White)', Color: '=If(locSel, Color.White, clrNavy)' }]]), [],
    (r) => (r.stats.contrastExamined === 1 ? null : 'paired branches not examined'));
  expect('contrast: one bad branch is a defect', free([['lblChip', 'Label', { ...box, Text: '="Open"', Fill: '=If(locSel, clrNavy, Color.White)', Color: '=If(locSel, Color.White, Color.White)' }]]), ['low-contrast']);
  expect('contrast: two different conditions are not knowable', free([['lblChip', 'Label', { ...box, Text: '="Open"', Fill: '=If(locSel, clrNavy, Color.White)', Color: '=If(locHot, Color.White, clrNavy)' }]]), [],
    (r) => (r.stats.contrastUnexamined === 1 ? null : 'cross-condition pairing should be unexamined'));
  expect('contrast: colour from data is not examined', free([['lblChip', 'Label', { ...box, Text: '="Open"', Color: '=LookUp(colStage, L = "a").Fg' }]]), [],
    (r) => (r.stats.contrastUnexamined === 1 && r.stats.contrastExamined === 0 ? null : 'data colour must be unexamined'));
  // Literal fit: a long hint in a one-line 120 px box clips; a short caption fits; text with data is not literal.
  const hint = '="Pick the vendor first, then the order lines, then confirm the delivery date."';
  expect('literal: long hint clips', free([['lblHint', 'Label', { ...box, Width: '=120', Height: '=22', Size: '=10', Text: hint }]]), ['literal-text-overflow']);
  expect('literal: hint with room', free([['lblHint', 'Label', { ...box, Width: '=600', Height: '=40', Size: '=10', Text: hint }]]), []);
  expect('literal: If of captions', free([['lblHint', 'Label', { ...box, Width: '=60', Height: '=22', Size: '=10', Text: '=If(locNew, "New order for this vendor", "Edit")' }]]), ['literal-text-overflow']);
  expect('literal: a count is not literal text', free([['lblN', 'Label', { ...box, Width: '=60', Height: '=22', Size: '=10', Text: '=CountRows(colRows)' }]]), []);
  // Build stamp: shown to everyone is an error; gated by any Visible formula is not.
  expect('stamp: shown to every user', free([['lblBuild', 'Label', { ...box, Text: '="Build " & gblBuild' }]]), ['build-stamp-visible']);
  expect('stamp: Visible true is not a gate', free([['lblBuild', 'Label', { ...box, Text: '="Build " & gblBuild', Visible: '=true' }]]), ['build-stamp-visible']);
  expect('stamp: admins only', free([['lblBuild', 'Label', { ...box, Text: '="Build " & gblBuild', Visible: '=gblIsAdmin' }]]), []);
  expect('stamp: a layout condition is not a gate', free([['lblBuild', 'Label', { ...box, Text: '=gblBuild', Visible: '=!lyPhone' }]]), ['build-stamp-visible']);
  expect('stamp: a name that merely contains it', free([['lblBuild', 'Label', { ...box, Text: '="Build " & gblBuildNotes' }]]), []);
  // Layout constants from Named Formulas: If on a resolved breakpoint, Mod and RoundDown.
  const cst = evalFormulaConstants(APP2, new Map(), 1366, 768), cstP = evalFormulaConstants(APP2, new Map(), 390, 844);
  if (cst.get('lyPad') !== 28 || cstP.get('lyPad') !== 14 || cst.get('lyCols') !== 6) fails.push(`formula constants: lyPad ${cst.get('lyPad')}/${cstP.get('lyPad')}, lyCols ${cst.get('lyCols')}`);
  if (numEval(parseFx('=Mod(4, lyCols) * 10 + RoundDown(4 / lyCols, 0)'), { consts: cst }) !== 40) fails.push('Mod/RoundDown on constants');
  if (Math.abs(contrastRatio([255, 255, 255, 1], [0, 0, 0, 1]) - 21) > 0.01) fails.push('contrast ratio of white on black should be 21');

  // Parser: doubled quotes, quoted names, comments, chains.
  try { parseFx(`="It""s " & ThisItem.'Due Date' & Text(Now(), "yyyy") // note\n`); parseFx('=Set(a, 1); Set(b, 2)'); } catch (e) { fails.push('parser: ' + e.message); }
  const ok = fails.length === 0;
  console.log(ok ? `selftest ok: ${CASES.length} gallery cases, flexible-height, detail-pane, no-theme, floor, per-table, Selected, With, collection, 4 list, 10 name, 15 contrast, 4 literal-fit and 5 build-stamp cases decided as expected`
                 : `selftest FAILED:\n  ${fails.join('\n  ')}`);
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest();
  else if (argv.includes('--hook')) hookMode();
  else if (argv.length === 0 || argv.includes('--help')) {
    console.log('usage: node check-canvas-format.mjs <Src folder or .pa.yaml>... [--schema cols.json] [--screen-width N] [--screen-height N] [--char-em 0.56] [--galleries-only] [--no-theme] [--stamp-var gblBuild] [--json] | --hook | --selftest');
    process.exit(argv.length === 0 ? 1 : 0);
  } else {
    const opt = (f) => { const k = argv.indexOf(f); return k === -1 ? null : argv[k + 1]; };
    if (opt('--char-em')) MODEL.unknownEm = Number(opt('--char-em'));   // calibrate from canvas-browser.mjs measurefont
    const valued = new Set(['--schema', '--screen-width', '--screen-height', '--char-em', '--stamp-var'].map((f) => argv.indexOf(f)).filter((k) => k !== -1).map((k) => k + 1));
    const paths = argv.filter((a, k) => !a.startsWith('--') && !valued.has(k));
    const files = collect(paths);
    // App.pa.yaml supplies constants and theme tokens even when only screen files are named.
    for (const p of paths) {
      const dir = fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
      const app = path.join(dir, 'App.pa.yaml');
      if (fs.existsSync(app) && !files.some((f) => path.resolve(f.path) === path.resolve(app))) files.push({ path: app, text: fs.readFileSync(app, 'utf8') });
    }
    if (files.length === 0) { console.error('No .pa.yaml files found under: ' + paths.join(', ') + ' - this is NOT a pass.'); process.exit(2); }
    const schema = opt('--schema') ? loadSchema(opt('--schema')) : null;
    const res = analyse(files, { schema, screenWidth: Number(opt('--screen-width') || 1366), screenHeight: Number(opt('--screen-height') || 768),
      galleriesOnly: argv.includes('--galleries-only'), theme: !argv.includes('--no-theme'), stampVar: opt('--stamp-var') || readStampVar() });
    report(res, argv.includes('--json'));
    // An error found anywhere (a visible build stamp, a literal colour) fails the run even when no
    // data-bound text was examined; only a run with nothing examined AND nothing found is "cannot judge".
    if (res.findings.some((f) => f.level === 'error')) process.exit(1);
    if (res.stats.bound === 0) { console.error('No data-bound text control was examined - this is NOT a pass.'); process.exit(2); }
    process.exit(res.findings.some((f) => f.level === 'error') ? 1 : 0);
  }
}
