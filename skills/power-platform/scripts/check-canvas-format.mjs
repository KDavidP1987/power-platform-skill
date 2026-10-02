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
// Usage:
//   node check-canvas-format.mjs <Src folder or .pa.yaml files>... [--schema cols.json]
//        [--screen-width 1366] [--screen-height 768] [--char-em 0.56] [--galleries-only] [--no-theme] [--json]
//   node check-canvas-format.mjs --hook            PostToolUse hook: file path from stdin JSON
//   node check-canvas-format.mjs --selftest
//
// Exit: 0 clean, 1 findings, 2 nothing examined (no files, or no data-bound text control) - NOT a pass.
// The formula, its error direction and the four remedies: references/canvas-layout.md, "Long text".
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
    case 'un': { const v = numEval(n.x, ctx, depth + 1); return v === null ? null : n.op === '-' ? -v : null; }
    case 'bin': {
      const a = numEval(n.l, ctx, depth + 1), b = numEval(n.r, ctx, depth + 1);
      if (a === null || b === null) return null;
      return { '+': a + b, '-': a - b, '*': a * b, '/': b === 0 ? null : a / b }[n.op] ?? null;
    }
    case 'id': return ctx.consts.has(n.v) ? ctx.consts.get(n.v) : null;
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
      if (['rounddown', 'roundup', 'round'].includes(f)) return a[0];
      if (f === 'abs') return a[0] === null ? null : Math.abs(a[0]);
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
    return { n: Math.max(...v.values.map((s) => String(s).length)), em: Math.max(...v.values.map(emOf)) };
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
function flatten(doc, file) {
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
// Theme tokens: names set (or defined as Named Formulas) to a colour or a font in App.pa.yaml.
export function readThemeTokens(appText) {
  const tokens = new Set();
  if (!appText) return tokens;
  const COLOURISH = /^(RGBA|ColorValue|ColorFade|Color\.|Font\.|"#)/;
  for (const m of appText.matchAll(/Set\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([^\n]+?)\)\s*;?\s*$/gm)) if (COLOURISH.test(m[2].trim())) tokens.add(m[1]);
  for (const m of appText.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n;]+);/gm)) if (COLOURISH.test(m[2].trim())) tokens.add(m[1]);
  return tokens;
}

const TEXT_CONTROLS = /^(Label|Text|Classic\/Label|ModernText)(@|$)/i;
const COLOUR_PROPS = /(Color|Fill|Background|Border(Color)?)$/i;
const LITERAL_COLOUR = /\b(RGBA\s*\(|ColorValue\s*\(|Color\.(?!Transparent\b)[A-Z][A-Za-z]+)|"#[0-9A-Fa-f]{3,8}"/;
const LITERAL_FONT = /\bFont\.('[^']+'|[A-Za-z]+)|^="[^"]+"$/;

export function analyse(files, { schema = null, screenWidth = 1366, screenHeight = 768, galleriesOnly = false, theme = true } = {}) {
  const findings = [];
  const stats = { files: 0, textControls: 0, bound: 0, measured: 0, unparsed: 0, collections: 0, literalColours: 0, literalFonts: 0 };
  const appFile = files.find((f) => /(^|[\\/])App\.pa\.yaml$/i.test(f.path));
  const appText = appFile ? appFile.text : '';
  const consts = readConstants(appText);
  const tokens = readThemeTokens(appText);
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
    // ---- text fit ----
    if (!TEXT_CONTROLS.test(c.control)) continue;
    stats.textControls++;
    const textSrc = c.props.Text?.v;
    if (!textSrc) continue;
    const gal = galleryOf(c);
    if (galleriesOnly && !gal) continue;
    let ast; try { ast = parseFx(textSrc); } catch { stats.unparsed++; continue; }
    const L = textLen(ast, { ...baseCtx, table: gal ? firstTable(safeParse(gal.props.Items?.v), baseCtx) : null, inGallery: !!gal });
    if (!L.data) continue;
    stats.bound++;
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
      findings.push({ level: 'info', code: 'unmeasured', file: c.file, line: c.line, control: c.name,
        msg: `${where}: Width/Height/Size could not be resolved to numbers; fit not checked. Pass --screen-width or define the constant in App.pa.yaml.` });
      continue;
    }
    stats.measured++;
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
    findings.push({ level: 'error', code: auto && fixedRow ? 'autoheight-in-fixed-row' : 'text-overflow', file: c.file, line: c.line, control: c.name,
      msg: `${where}: has room for about ${capacity} characters (${lines} line${lines === 1 ? '' : 's'}, ${W}x${H} at size ${size}${wrap ? '' : ', no wrap'}) ` +
        `but can receive ${lenTxt} (${cols || 'data'}${L.heuristic ? '; a length was guessed from a column name - pass --schema' : ''}).` +
        (auto && fixedRow ? ' AutoHeight does not help in a fixed-height gallery: the row still clips.' : '') +
        ` Fix: Text: =With({v: <text>}, If(Len(v) > ${suggest}, Left(v, ${suggest - 3}) & "...", v)) with Tooltip: =<text>, or a flexible-height gallery with AutoHeight.`,
      capacity, maxLength: L.n, gallery: !!gal, guessed: !!L.heuristic });
  }
  findings.sort((a, b) => (b.gallery === true) - (a.gallery === true) || a.file.localeCompare(b.file) || a.line - b.line);
  return { findings, stats };
}
function safeParse(src) { try { return src ? parseFx(src) : null; } catch { return null; } }

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
    `${stats.literalColours} literal colour(s), ${stats.literalFonts} literal font(s).`);
  console.log('Room is an estimate that errs toward "does not fit"; confirm a borderline case in the running app.');
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
  const res = analyse(files, { schema });
  // A write-time hook blocks only on what is known: a length guessed from a column name does not block
  // (configure textFitSchema in .claude/hooks/standards.config.json to check those too).
  const bad = res.findings.filter((f) => f.level === 'error' && path.resolve(f.file) === path.resolve(file) && !(f.guessed && !schema));
  if (!bad.length) process.exit(0);
  console.error(`Formatting check failed for ${path.basename(file)} (text fit and theme tokens):\n\n  ` + bad.map((f) => `${f.code}: ${f.msg}`).join('\n  ') +
    `\n\nSee references/canvas-layout.md, "Long text: the fit rule".`);
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
    const got = [...new Set(res.findings.filter((f) => f.level !== 'info').map((f) => f.code))].sort();
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
  // With(): a bound name carries its clamped length.
  const r7 = run(screen(label('lblW', { Text: '=With({t: Left(ThisItem.Notes, 8)}, "Note " & t)', Width: '=120', Height: '=22', Size: '=10', Tooltip: '=ThisItem.Notes' })));
  if (r7.findings.some((f) => f.level === 'error') || r7.stats.bound !== 1) fails.push('With(): a bound name carries its clamped length');
  // A collection's columns are measured from the formula that builds it.
  const coll = screen(label('lblN', { Text: '=ThisItem.Short', Width: '=120', Height: '=22', Size: '=10' }), '=colRows')
    .replace('    Children:\n      - galItems:', '    Properties:\n      OnVisible: =ClearCollect(colRows, ForAll(Requests As r, {Short: Left(r.Notes, 10), Long: r.Notes}))\n    Children:\n      - galItems:');
  const rc = run(coll);
  if (rc.findings.some((f) => f.level === 'error') || rc.stats.collections !== 1) fails.push(`collection column measured from its formula (collections ${rc.stats.collections})`);
  if (!run(coll.replace('ThisItem.Short', 'ThisItem.Long')).findings.some((f) => f.code === 'text-overflow')) fails.push('a long collection column should overflow');
  // Parser: doubled quotes, quoted names, comments, chains.
  try { parseFx(`="It""s " & ThisItem.'Due Date' & Text(Now(), "yyyy") // note\n`); parseFx('=Set(a, 1); Set(b, 2)'); } catch (e) { fails.push('parser: ' + e.message); }
  const ok = fails.length === 0;
  console.log(ok ? `selftest ok: ${CASES.length} gallery cases, flexible-height, detail-pane, no-theme, floor, per-table, With and collection cases decided as expected`
                 : `selftest FAILED:\n  ${fails.join('\n  ')}`);
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest();
  else if (argv.includes('--hook')) hookMode();
  else if (argv.length === 0 || argv.includes('--help')) {
    console.log('usage: node check-canvas-format.mjs <Src folder or .pa.yaml>... [--schema cols.json] [--screen-width N] [--screen-height N] [--char-em 0.56] [--galleries-only] [--no-theme] [--json] | --hook | --selftest');
    process.exit(argv.length === 0 ? 1 : 0);
  } else {
    const opt = (f) => { const k = argv.indexOf(f); return k === -1 ? null : argv[k + 1]; };
    if (opt('--char-em')) MODEL.unknownEm = Number(opt('--char-em'));   // calibrate from canvas-browser.mjs measurefont
    const valued = new Set(['--schema', '--screen-width', '--screen-height', '--char-em'].map((f) => argv.indexOf(f)).filter((k) => k !== -1).map((k) => k + 1));
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
      galleriesOnly: argv.includes('--galleries-only'), theme: !argv.includes('--no-theme') });
    report(res, argv.includes('--json'));
    if (res.stats.bound === 0) { console.error('No data-bound text control was examined - this is NOT a pass.'); process.exit(2); }
    process.exit(res.findings.some((f) => f.level === 'error') ? 1 : 0);
  }
}
