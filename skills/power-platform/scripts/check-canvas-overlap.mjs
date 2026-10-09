#!/usr/bin/env node
// check-canvas-overlap.mjs - controls drawn over other controls, in canvas .pa.yaml source.
//
// The commonest layout defect in agent-built canvas apps: a new button or label is placed where
// another control already sits, and the other control is only shown under some condition (a
// warning, an empty state, a tab, a role). With the condition off at review time the screen looks
// right; with it on, a button covers text or text covers a button. A compile passes, a screenshot
// of one state passes, and the browser's overlap check sees only the state it was shown.
//
// This check reads the source, so it sees every state at once:
//   1. OVERLAP. Two text-bearing or interactive controls (labels, buttons, inputs, galleries) in the
//      same coordinate space whose boxes overlap, and whose Visible conditions are not PROVABLY
//      exclusive. Ancestors' Visible conditions are included. Exclusive means: the same name tested
//      against different literals, A against !A, A || B against !A && !B, a value against an `in`
//      list without it. Anything else can be on screen together, so it is a finding.
//   2. COVERS-CONTROL. Decoration (a Rectangle, Image or non-clickable Icon) declared AFTER an
//      interactive control and covering its centre: declaration order is z-order, so the click
//      lands on the decoration and nothing happens.
//   3. OFF-CANVAS and OUTSIDE-ROW (warnings). A screen-level control past the design surface; a
//      gallery child past its row (gallery Width, TemplateSize).
//
//   Text drawn over a CLICKABLE shape declared before it is covers-control too: the label takes the
//   click. A shape whose only OnSelect is Select(Parent) in a gallery row is the row's background.
//
// Deliberate patterns that are not findings: a card or row-background Rectangle (not clickable)
// declared BEFORE the content on it; a caption with its own OnSelect over a clickable tile; a
// modal (a later control whose condition is shared by a backdrop that covers the earlier control);
// a text-less button laid over a tile; an empty-state label whose Visible tests the gallery under
// it; a results list whose Visible reads the input it drops down from (one control's Visible names
// the other).
//
// Geometry is resolved from literals, numeric globals set in App.OnStart or Named Formulas, simple
// arithmetic, Parent.Width/Height, Parent.TemplateWidth/TemplateHeight, App.Width/Height, other
// controls' X/Y/Width/Height, Min/Max, and every branch of If/Switch. What cannot be resolved is
// counted and printed: a check that skips the offender proves nothing.
//
// Usage:
//   node check-canvas-overlap.mjs <Src folder or .pa.yaml files>... [--screen-width 1366]
//        [--screen-height 768] [--json] [--warnings-fail] [--explain]   (--explain lists every exempted pair)
//   node check-canvas-overlap.mjs --hook           PostToolUse hook: file path from stdin JSON
//   node check-canvas-overlap.mjs --selftest
//
// Exit: 0 clean, 1 findings (errors; warnings too with --warnings-fail), 2 nothing examined, or a
// screen file with under half its drawn controls resolved (errors anywhere still exit 1 first).
// The rules and their history: references/canvas-layout.md, sections 4 and 7.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseYaml, parseFx, flatten, readConstants, evalFormulaConstants } from './check-canvas-format.mjs';

// ---------- what a control is ----------
const TEXTY = /^(Label|Text|Classic\/Label|ModernText|HtmlViewer|HtmlText|Classic\/HtmlViewer)(@|$)/i;
const INTERACTIVE = /^(Button|Classic\/Button|ModernButton|TextInput|Classic\/TextInput|ModernTextInput|NumberInput|ComboBox|Classic\/ComboBox|ModernCombobox|Classic\/DropDown|Dropdown|ModernDropdown|DatePicker|Classic\/DatePicker|ModernDatePicker|Checkbox|Classic\/CheckBox|ModernCheckbox|Toggle|Classic\/Toggle|ModernToggle|Radio|Classic\/Radio|ModernRadio|ListBox|Classic\/ListBox|Slider|Classic\/Slider|TabList|Rating|Classic\/Rating|Link|PenInput|Attachments|Classic\/Attachments)(@|$)/i;
const DECOR = /^(Rectangle|Classic\/Rectangle|Circle|Line|Image|Classic\/Image|Icon|Classic\/Icon|Triangle|Pentagon|Octagon|Star|Arrow|Shape)(@|$)/i;
const GALLERY = /^(Gallery|Classic\/Gallery|ModernGallery)(@|$)/i;
const CONTAINER = /^(GroupContainer|Container|ModernContainer)(@|$)/i;
const GROUP = /^(Group)(@|$)/i;
const FORM = /^(Form|EditForm|FormViewer|Classic\/EditForm|Classic\/FormViewer|DataCard|TypedDataCard)(@|$)/i;
const INVISIBLE = /^(Timer|Classic\/Timer|ComboBoxDataField|Export|Import|Microphone|Camera|Barcode|AddMedia|Video|Audio)(@|$)/i;

const val = (c, k) => (c.props[k] && c.props[k].v !== undefined ? String(c.props[k].v).trim() : '');
const hasHandler = (c) => { const v = val(c, 'OnSelect').replace(/^=/, '').trim(); return v !== '' && !/^false$/i.test(v); };
const emptyText = (c) => /^=\s*""\s*$/.test(val(c, 'Text'));
const rowSelectOnly = (c) => !!c.parent && GALLERY.test(c.parent.control || '') && /^=?\s*Select\(\s*Parent\s*\)\s*;?\s*$/i.test(val(c, 'OnSelect'));
const transparent = (c) => /Color\.Transparent|RGBA\([^)]*,\s*0(\.0+)?\s*\)/i.test(val(c, 'Fill'));

export function kindOf(c) {
  const t = c.control || '';
  if (INVISIBLE.test(t)) return null;
  if (GALLERY.test(t)) return 'gallery';
  if (CONTAINER.test(t) || GROUP.test(t) || FORM.test(t)) return null;           // children are compared, not the frame
  if (TEXTY.test(t)) return emptyText(c) ? (hasHandler(c) ? 'clickpad' : 'decor') : 'text';
  if (/Button/i.test(t)) return emptyText(c) ? 'clickpad' : 'interactive';
  if (INTERACTIVE.test(t)) return 'interactive';
  // A shape in a gallery row whose only action is the row's own (Select(Parent)) is the row's
  // background: text on it clicks the same row. Any other handler makes it a click target.
  if (DECOR.test(t)) return hasHandler(c) && !rowSelectOnly(c) ? 'interactive' : 'decor';
  return 'text';                                                                    // unknown: assume it draws content
}
const CONTENT = new Set(['text', 'interactive', 'gallery']);

// ---------- Visible conditions ----------
// A condition is a list of terms that must all hold (AND). A term is a list of atoms of which one
// must hold (OR). An atom: { key: the tested expression, op: 'eq' | 'neq' | 'in', vals: Set }.
const keyOf = (n) => JSON.stringify(n);
function literalOf(n) {
  if (!n) return null;
  if (n.t === 'str') return 's:' + n.v;
  if (n.t === 'num') return 'n:' + n.v;
  if (n.t === 'un' && n.op === '-' && n.x.t === 'num') return 'n:-' + n.x.v;
  if (n.t === 'id' && !n.q && /^(true|false)$/i.test(n.v)) return 'b:' + n.v.toLowerCase();
  if (n.t === 'call' && /^(true|false)$/i.test(n.name) && n.args.length === 0) return 'b:' + n.name.toLowerCase();
  // An option or enum value: Name.Member or 'Quoted Name'.Member (not ThisItem, Self, Parent or a variable).
  if (n.t === 'mem' && n.o.t === 'id' && (n.o.q || !/^(ThisItem|ThisRecord|Self|Parent|App|Host|User|gbl|loc|var|ctx)/i.test(n.o.v))) return 'm:' + n.o.v + '.' + n.name;
  return null;
}
const atom = (key, op, vals) => ({ key, op, vals: new Set(vals) });
function normalise(n, positive = true) {
  // Returns terms (AND of ORs).
  if (!n) return [];
  if (n.t === 'un' && n.op === '!') return normalise(n.x, !positive);
  if (n.t === 'call' && /^not$/i.test(n.name) && n.args.length === 1) return normalise(n.args[0], !positive);
  if (n.t === 'call' && /^(and|or)$/i.test(n.name) && n.args.length >= 2) {
    const op = n.name.toLowerCase() === 'and' ? '&&' : '||';
    return normalise(n.args.slice(1).reduce((l, r) => ({ t: 'bin', op, l, r }), n.args[0]), positive);
  }
  const isAnd = n.t === 'bin' && (n.op === '&&' || n.op === 'and');
  const isOr = n.t === 'bin' && (n.op === '||' || n.op === 'or');
  if ((isAnd && positive) || (isOr && !positive)) return [...normalise(n.l, positive), ...normalise(n.r, positive)];
  if ((isOr && positive) || (isAnd && !positive)) {
    const l = normalise(n.l, positive), r = normalise(n.r, positive);
    if (l.length === 1 && r.length === 1) return [[...l[0], ...r[0]]];
    return [[atom(keyOf(n), 'eq', [positive ? 'b:true' : 'b:false'])]];
  }
  if (n.t === 'bin' && (n.op === '=' || n.op === '<>')) {
    let subj = n.l, v = literalOf(n.r);
    if (v === null && literalOf(n.l) !== null) { subj = n.r; v = literalOf(n.l); }
    if (v !== null) {
      const eq = (n.op === '=') === positive;
      // X = true / X = false fold into the bare boolean form, so `X` and `X = false` compare.
      if (v === 'b:true' || v === 'b:false') return [[atom(keyOf(subj), 'eq', [(v === 'b:true') === eq ? 'b:true' : 'b:false'])]];
      return [[atom(keyOf(subj), eq ? 'eq' : 'neq', [v])]];
    }
    // x = y against x <> y is exclusive whatever y is; x = y against x = z is not (y may equal z).
    const eq = (n.op === '=') === positive;
    return [[atom(keyOf(n.l), eq ? 'eq' : 'neq', ['x:' + keyOf(n.r)])]];
  }
  if (n.t === 'bin' && (n.op === 'in' || n.op === 'exactin') && n.r.t === 'table') {
    const vs = n.r.xs.map(literalOf);
    if (vs.every((x) => x !== null)) return [[atom(keyOf(n.l), positive ? 'in' : 'nin', vs)]];
  }
  if (n.t === 'bin' && ['<', '<=', '>', '>='].includes(n.op)) {
    // x > 0 against x = 0: numeric ranges on the same expression.
    let subj = n.l, k = literalOf(n.r), op = n.op;
    if (!(k && k.startsWith('n:')) && literalOf(n.l) && literalOf(n.l).startsWith('n:')) { subj = n.r; k = literalOf(n.l); op = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' }[op]; }
    if (k && k.startsWith('n:')) {
      if (!positive) op = { '<': '>=', '<=': '>', '>': '<=', '>=': '<' }[op];
      const v = Number(k.slice(2));
      const r = { '<': [-Infinity, v, false, false], '<=': [-Infinity, v, false, true], '>': [v, Infinity, false, false], '>=': [v, Infinity, true, false] }[op];
      return [[{ key: keyOf(subj), op: 'rng', vals: new Set(), lo: r[0], hi: r[1], loIn: r[2], hiIn: r[3] }]];
    }
  }
  if (literalOf(n) === 'b:true') return positive ? [] : [[atom('never', 'eq', ['b:true'])]];
  if (literalOf(n) === 'b:false') return positive ? [[atom('never', 'eq', ['b:true'])]] : [];
  return [[atom(keyOf(n), 'eq', [positive ? 'b:true' : 'b:false'])]];
}
function atomsExclusive(a, b) {
  if (a.key === 'never' || b.key === 'never') return true;
  if (a.key !== b.key) return false;
  const one = (x) => [...x.vals][0];
  const range = (x) => {
    if (x.op === 'rng') return x;
    if (x.op === 'eq' && x.vals.size === 1 && one(x).startsWith('n:')) { const v = Number(one(x).slice(2)); return { lo: v, hi: v, loIn: true, hiIn: true }; }
    return null;
  };
  const ra = range(a), rb = range(b);
  if (ra && rb) {
    const lo = Math.max(ra.lo, rb.lo), hi = Math.min(ra.hi, rb.hi);
    if (lo > hi) return true;
    if (lo < hi) return false;
    const inA = (r) => (r.lo < lo || r.loIn) && (r.hi > lo || r.hiIn);
    return !(inA(ra) && inA(rb));
  }
  if (a.op === 'rng' || b.op === 'rng') return false;
  if (a.op === 'nin' || b.op === 'nin') {
    const [n, o] = a.op === 'nin' ? [a, b] : [b, a];
    if (o.op === 'eq' || o.op === 'in') return [...o.vals].every((x) => n.vals.has(x));
    return false;
  }
  const eqLike = (x) => (x.op === 'eq' ? new Set(x.vals) : x.op === 'in' ? x.vals : null);
  const A = eqLike(a), B = eqLike(b);
  if (A && B) return [...A, ...B].every((x) => !x.startsWith('x:')) && [...A].every((x) => !B.has(x));
  if (A && b.op === 'neq') return A.size === 1 && A.has(one(b));
  if (B && a.op === 'neq') return B.size === 1 && B.has(one(a));
  return false;
}
// Is atom x ruled out by condition C? Some term of C, all of whose atoms exclude x.
const atomRuledOut = (x, C) => C.some((term) => term.length > 0 && term.every((y) => atomsExclusive(x, y)));
export function exclusive(A, B) {
  const side = (P, Q) => P.some((term) => term.length > 0 && term.every((x) => atomRuledOut(x, Q)));
  return side(A, B) || side(B, A);
}
const never = (C) => C.some((t) => t.length === 1 && t[0].key === 'never');

// ---------- geometry ----------
// Every value is a list of alternatives { v, as, why }: the number, and the condition under which
// the formula produces it (from If/Switch branches). A position written as If(locType = "on", 140,
// 100) is 140 only while locType = "on", so it is compared only with layouts where that can hold.
const CAP = 16;
const condKey = (C) => C.map((t) => keyOf(t.map((a) => [a.key, a.op, [...a.vals], a.lo, a.hi]))).sort().join('&');
function uniq(xs) {
  const seen = new Map();
  for (const x of xs) { const k = Math.round(x.v * 100) / 100 + '|' + condKey(x.as); if (!seen.has(k)) seen.set(k, { ...x, v: Math.round(x.v * 100) / 100 }); }
  return [...seen.values()].slice(0, CAP);
}
const plain = (v) => [{ v, as: [], why: [] }];
function cross(a, b, f) {
  const out = [];
  for (const x of a) for (const y of b) {
    if (exclusive(x.as, y.as)) continue;
    const v = f(x.v, y.v);
    if (v === null || !Number.isFinite(v)) return null;
    out.push({ v, as: [...x.as, ...y.as], why: [...new Set([...x.why, ...y.why])] });
  }
  return out.length ? uniq(out) : null;
}
// A short source form of a condition, for messages.
export function show(n) {
  if (!n) return '';
  switch (n.t) {
    case 'num': return String(n.v);
    case 'str': return JSON.stringify(n.v);
    case 'id': return n.q ? `'${n.v}'` : n.v;
    case 'mem': return show(n.o) + '.' + n.name;
    case 'un': return n.op + show(n.x);
    case 'bin': return show(n.l) + ' ' + n.op + ' ' + show(n.r);
    case 'call': return n.name + '(' + n.args.map(show).join(', ') + ')';
    case 'table': return '[' + n.xs.map(show).join(', ') + ']';
    default: return '...';
  }
}

export function analyse(files, { screenWidth = 1366, screenHeight = 768 } = {}) {
  const findings = [];
  const stats = { files: 0, controls: 0, compared: 0, resolved: 0, skipped: 0, skipReasons: {}, skippedControls: [], perFile: {}, alwaysHidden: 0, pairs: 0, exempt: { exclusive: 0, modal: 0, linked: 0, clickpad: 0 }, exempted: [] };
  const appFile = files.find((f) => /(^|[\\/])App\.pa\.yaml$/i.test(f.path));
  const appText = appFile ? appFile.text : '';
  const consts = evalFormulaConstants(appText, readConstants(appText), screenWidth, screenHeight);
  const all = [];
  for (const f of files) {
    if (/(^|[\\/])(App|_EditorState)\.pa\.yaml$/i.test(f.path)) continue;
    stats.files++;
    let doc; try { doc = parseYaml(f.text); } catch (e) { findings.push({ level: 'error', code: 'unreadable', file: f.path, line: 0, msg: e.message }); continue; }
    all.push(...flatten(doc, f.path));
  }
  all.forEach((c, k) => { c.order = k; });
  const byName = new Map(all.map((c) => [c.name, c]));
  const skip = (c, why) => { c.skip = why; };

  // Coordinate space, offset and the parent box each control is measured in.
  const spaceOf = (c) => {
    for (let p = c.parent; p; p = p.parent) {
      if (p.control === 'Screen') return p.name;
      if (GALLERY.test(p.control)) return p.name + '#row';
      if (FORM.test(p.control)) return null;
      if (CONTAINER.test(p.control) || GROUP.test(p.control)) continue;
      return null;                                                  // child of a non-container (ComboBox fields)
    }
    return null;
  };
  const isAuto = (c) => /auto/i.test(c.variant || '') || /LayoutMode\.Auto/i.test(val(c, 'LayoutMode'));

  const memo = new Map();
  function prop(c, k, depth = 0) {
    const key = c.name + '.' + k;
    if (memo.has(key)) return memo.get(key);
    if (depth > 30) return null;
    memo.set(key, null);                                            // cycle guard
    let out = null;
    if (c.control === 'Screen') out = k === 'Width' ? plain(screenWidth) : k === 'Height' ? plain(screenHeight) : k === 'X' || k === 'Y' ? plain(0) : null;
    else {
      const src = val(c, k);
      if (!src) out = k === 'X' || k === 'Y' ? plain(0) : null;
      else { let ast = null; try { ast = parseFx(src); } catch { ast = null; } out = ast ? num(ast, c, depth + 1) : null; }
    }
    memo.set(key, out);
    return out;
  }
  function parentDim(c, name, depth) {
    let p = c.parent;
    while (p && GROUP.test(p.control)) p = p.parent;                  // a classic group has no frame of its own
    if (!p || p.control === 'Screen') return name === 'Width' ? plain(screenWidth) : name === 'Height' ? plain(screenHeight) : name === 'X' || name === 'Y' ? plain(0) : null;
    if (GALLERY.test(p.control)) {
      if (name === 'TemplateWidth' || name === 'Width') return prop(p, 'Width', depth);
      if (name === 'TemplateHeight' || name === 'Height') return prop(p, 'TemplateSize', depth);
    }
    return prop(p, name, depth);
  }
  function num(n, c, depth) {
    if (!n || depth > 30) return null;
    switch (n.t) {
      case 'num': return plain(n.v);
      case 'un': { const v = num(n.x, c, depth + 1); return v && n.op === '-' ? v.map((x) => ({ ...x, v: -x.v })) : null; }
      case 'bin': {
        const a = num(n.l, c, depth + 1), b = a && num(n.r, c, depth + 1);
        if (!a || !b) return null;
        const f = { '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => (y === 0 ? null : x / y) }[n.op];
        return f ? cross(a, b, f) : null;
      }
      case 'id': return consts.has(n.v) ? plain(consts.get(n.v)) : null;
      case 'mem': {
        if (n.o.t !== 'id') return null;
        const root = n.o.v;
        if (root === 'Parent') return parentDim(c, n.name, depth + 1);
        if (root === 'Self') return prop(c, n.name, depth + 1);
        if (root === 'App') return /Width$/.test(n.name) ? plain(screenWidth) : /Height$/.test(n.name) ? plain(screenHeight) : null;
        const other = byName.get(root);
        if (!other) return null;
        if (other.control === 'Screen') return n.name === 'Width' ? plain(screenWidth) : n.name === 'Height' ? plain(screenHeight) : null;
        return ['X', 'Y', 'Width', 'Height', 'TemplateSize', 'Size'].includes(n.name) ? prop(other, n.name, depth + 1) : null;
      }
      case 'call': {
        const f = n.name.toLowerCase();
        if (f === 'if' || f === 'switch') {
          // Each branch: its value expression and the condition that selects it (earlier tests false).
          const branches = [];
          const prior = [];
          const not = (x) => '!(' + show(x) + ')';
          if (f === 'if') {
            for (let k = 0; k + 1 < n.args.length; k += 2) {
              branches.push({ e: n.args[k + 1], as: [...prior.flatMap((x) => normalise(x, false)), ...normalise(n.args[k])], why: [...prior.map(not), show(n.args[k])] });
              prior.push(n.args[k]);
            }
            if (n.args.length % 2 === 1) branches.push({ e: n.args[n.args.length - 1], as: prior.flatMap((x) => normalise(x, false)), why: prior.map(not) });
          } else {
            for (let k = 1; k + 1 < n.args.length; k += 2) {
              const test = { t: 'bin', op: '=', l: n.args[0], r: n.args[k] };
              branches.push({ e: n.args[k + 1], as: [...prior.flatMap((x) => normalise(x, false)), ...normalise(test)], why: [show(test)] });
              prior.push(test);
            }
            if (n.args.length % 2 === 0) branches.push({ e: n.args[n.args.length - 1], as: prior.flatMap((x) => normalise(x, false)), why: prior.map(not) });
          }
          const out = [];
          for (const b of branches) {
            const vs = num(b.e, c, depth + 1);
            if (!vs) return null;
            for (const x of vs) if (!exclusive(x.as, b.as)) out.push({ v: x.v, as: [...x.as, ...b.as], why: [...new Set([...x.why, ...b.why])] });
          }
          return out.length ? uniq(out) : null;
        }
        const a = n.args.map((x) => num(x, c, depth + 1));
        if (a.some((x) => !x)) return null;
        if (f === 'min' || f === 'max') return a.reduce((acc, x) => cross(acc, x, (p, q) => Math[f](p, q)));
        if (['round', 'roundup', 'rounddown', 'int', 'trunc'].includes(f)) return a[0];
        if (f === 'abs') return a[0].map((x) => ({ ...x, v: Math.abs(x.v) }));
        return null;
      }
      default: return null;
    }
  }

  // Absolute boxes within each space (containers add their offset).
  const offsets = (c) => {
    let xs = plain(0), ys = plain(0);
    for (let p = c.parent; p && p.control !== 'Screen' && !GALLERY.test(p.control); p = p.parent) {
      if (GROUP.test(p.control)) continue;
      const px = prop(p, 'X'), py = prop(p, 'Y');
      if (!px || !py) return null;
      xs = cross(xs, px, (a, b) => a + b); ys = cross(ys, py, (a, b) => a + b);
    }
    return { xs, ys };
  };

  const boxes = [];
  for (const c of all) {
    if (c.control === 'Screen') continue;
    stats.controls++;
    const kind = kindOf(c);
    if (!kind) continue;
    c.kind = kind;
    c.space = spaceOf(c);
    if (!c.space) continue;                                          // inside a form or a compound control
    let inAuto = false;
    for (let p = c.parent; p && p.control !== 'Screen'; p = p.parent) if ((CONTAINER.test(p.control)) && isAuto(p)) inAuto = true;
    stats.compared++;
    const pf = stats.perFile[c.file] || (stats.perFile[c.file] = { compared: 0, resolved: 0 });
    pf.compared++;
    // Visible: own AND every ancestor's.
    const terms = [];
    for (let p = c; p && p.control !== 'Screen'; p = p.parent) {
      const v = val(p, 'Visible');
      if (!v) continue;
      try { terms.push(...normalise(parseFx(v))); } catch { terms.push([atom('unparsed:' + p.name + ':' + v, 'eq', ['b:true'])]); }
    }
    c.cond = terms;
    if (never(terms)) { stats.alwaysHidden++; continue; }
    if (inAuto) { skip(c, 'inside an auto-layout container (positions come from the flow)'); }
    else {
      const X = prop(c, 'X'), Y = prop(c, 'Y'), W = prop(c, 'Width'), H = prop(c, 'Height'), off = offsets(c);
      const miss = [['X', X], ['Y', Y], ['Width', W], ['Height', H]].filter(([, v]) => !v).map(([k]) => k);
      if (!off) miss.push('container X/Y');
      if (miss.length) skip(c, miss.join(', ') + ' not resolvable');
      else {
        const alts = [];
        for (const ox of off.xs) for (const oy of off.ys) for (const x of X) for (const y of Y) for (const w of W) for (const h of H) {
          if (alts.length >= 64) break;
          const parts = [ox, oy, x, y, w, h];
          const as = parts.flatMap((q) => q.as);
          if (parts.some((q, i) => parts.slice(i + 1).some((r) => exclusive(q.as, r.as))) || exclusive(as, terms)) continue;
          alts.push({ x: x.v + ox.v, y: y.v + oy.v, w: w.v, h: h.v, as, why: [...new Set(parts.flatMap((q) => q.why))] });
        }
        if (alts.length) c.alts = alts; else skip(c, 'no geometry branch is consistent with its Visible');
      }
    }
    if (c.skip) { stats.skipped++; stats.skipReasons[c.skip] = (stats.skipReasons[c.skip] || 0) + 1; stats.skippedControls.push({ name: c.name, file: c.file, line: c.line, why: c.skip }); continue; }
    stats.resolved++;
    pf.resolved++;
    boxes.push(c);
  }

  const ov = (A, B) => {
    const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
    const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
    return ox > 2 && oy > 2 ? { ox: Math.round(ox), oy: Math.round(oy) } : null;
  };
  // Only layouts that can hold while both controls are visible count.
  const allPairs = (a, b, f) => {
    let hit = 0, excl = 0, first = null, when = [];
    for (const A of a.alts) for (const B of b.alts) {
      const r = f(A, B);
      if (!r) continue;
      if (exclusive([...a.cond, ...A.as], [...b.cond, ...B.as])) { excl++; continue; }
      hit++; if (!first) { first = r; when = [...new Set([...A.why, ...B.why])]; }
    }
    return { hit, excl, first, when };
  };
  const condText = (c) => {
    const parts = [];
    for (let p = c; p && p.control !== 'Screen'; p = p.parent) { const v = val(p, 'Visible'); if (v && !/^=\s*true\s*$/i.test(v)) parts.push((p === c ? '' : p.name + ': ') + v.replace(/^=/, '').replace(/\s+/g, ' ').slice(0, 90)); }
    return parts.length ? parts.join(' AND ') : 'always';
  };
  const names = (c) => new Set((val(c, 'Visible').match(/[A-Za-z_][A-Za-z0-9_]*/g) || []));
  // An empty-state label laid over its gallery: when it shows, the gallery has no rows to paint.
  // It must be THAT gallery's empty state: its Visible names the gallery, reads the gallery's source,
  // or tests a variable whose Set() reads that source.
  const EMPTY_TEST = /CountRows|IsEmpty|AllItemsCount|=\s*0\b/i;
  // Standalone names only: not a member after a dot (".Value"), not a function call.
  const sourceIds = (g) => new Set([...val(g, 'Items').matchAll(/(?<![.\w'])([A-Za-z_]\w{3,})(?!\w*\s*\()/g)].map((m) => m[1])
    .filter((x) => !/^(ThisItem|ThisRecord|Self|Parent|true|false|And|Or|Not|Descending|Ascending|SortOrder)$/i.test(x)));
  const allText = files.map((f) => f.text).join('\n');
  const setFrom = (v) => { const m = allText.match(new RegExp('Set\\(\\s*' + v + '\\s*,([^;]{0,400})')); return m ? m[1] : ''; };
  const emptyState = (g, t) => {
    if (g.kind !== 'gallery' || t.kind !== 'text' || !EMPTY_TEST.test(val(t, 'Visible'))) return false;
    const ids = names(t), src = sourceIds(g);
    if (ids.has(g.name) || [...ids].some((x) => src.has(x))) return true;
    return [...ids].some((v) => /^(gbl|loc|var)/i.test(v) && [...src].some((x) => setFrom(v).includes(x)));
  };
  const linked = (a, b) => names(a).has(b.name) || names(b).has(a.name) || emptyState(a, b) || emptyState(b, a);
  // A modal backdrop covers its whole space (screen or row); a tab card or panel is body content.
  const fullSurface = (R, space) => {
    const g = space.endsWith('#row') ? byName.get(space.slice(0, -4)) : null;
    const W = g ? Math.max(...(prop(g, 'Width') || plain(0)).map((x) => x.v)) : screenWidth;
    const H = g ? Math.max(...(prop(g, 'TemplateSize') || plain(0)).map((x) => x.v)) : screenHeight;
    return R.alts.every((r) => r.x <= 2 && r.y <= 2 && r.x + r.w >= W * 0.98 && r.y + r.h >= H * 0.98);
  };
  const covers = (R, E) => R.alts.every((r) => E.alts.every((e) => r.x <= e.x + 2 && r.y <= e.y + 2 && r.x + r.w >= e.x + e.w - 2 && r.y + r.h >= e.y + e.h - 2));
  const subset = (P, Q) => { const q = new Set(Q.map((t) => keyOf(t.map((a) => [a.key, a.op, [...a.vals]])))); return P.every((t) => q.has(keyOf(t.map((a) => [a.key, a.op, [...a.vals]])))); };
  const condKey = (C) => C.map((t) => keyOf(t.map((a) => [a.key, a.op, [...a.vals]])));

  const spaces = new Map();
  for (const c of boxes) { if (!spaces.has(c.space)) spaces.set(c.space, []); spaces.get(c.space).push(c); }
  for (const [space, list] of spaces) {
    list.sort((a, b) => a.order - b.order);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const E = list[i], L = list[j];                                // E declared first, L drawn on top
      const contentPair = CONTENT.has(E.kind) && CONTENT.has(L.kind);
      // Decoration declared AFTER content paints over it: a button stops clicking, text disappears.
      const deadClick = (E.kind === 'interactive' || E.kind === 'clickpad' || E.kind === 'text' || E.kind === 'gallery') && L.kind === 'decor';
      const padOver = L.kind === 'clickpad' || E.kind === 'clickpad'
        || (DECOR.test(E.control || '') && E.kind === 'interactive' && L.kind === 'text' && hasHandler(L));   // a caption with its own click
      // Text drawn over a CLICKABLE shape declared before it: the text takes the click (a dead click on
      // the caption). A non-interactive shape under text is a card or row background - never compared.
      const textOverShape = DECOR.test(E.control || '') && E.kind === 'interactive' && L.kind === 'text' && !hasHandler(L);
      if (!contentPair && !deadClick && !padOver) continue;
      const centre = (e, l) => { const cx = e.x + e.w / 2, cy = e.y + e.h / 2; return cx > l.x && cx < l.x + l.w && cy > l.y && cy < l.y + l.h ? { ox: Math.round(e.w), oy: Math.round(e.h) } : null; };
      const geo = textOverShape ? allPairs(E, L, ov)
        : deadClick
        ? allPairs(E, L, (e, l) => { const cx = e.x + e.w / 2, cy = e.y + e.h / 2; return cx > l.x && cx < l.x + l.w && cy > l.y && cy < l.y + l.h && !transparent(L) ? { ox: Math.round(e.w), oy: Math.round(e.h) } : null; })
        : allPairs(E, L, ov);
      if (!geo.hit && !geo.excl) continue;
      stats.pairs++;
      const exempt = (why, extra = '') => { stats.exempt[why]++; stats.exempted.push(`${why.padEnd(9)} ${path.basename(E.file)}  ${L.name} over ${E.name}${extra}`); };
      if (!geo.hit) { exempt('exclusive'); continue; }
      if (padOver) { exempt('clickpad'); continue; }
      if (linked(E, L)) { exempt('linked'); continue; }
      // A modal: some backdrop declared between them covers E, and L's condition carries the backdrop's.
      // The backdrop may carry its own OnSelect (click outside to dismiss); that is still a backdrop.
      const backdrop = list.find((R) => R.order > E.order && R.order <= L.order && (R.kind === 'decor' || R.kind === 'interactive' || R.kind === 'clickpad' || R === L)
        && R.cond.length > 0 && subset(R.cond, L.cond) && !subset(R.cond, E.cond) && fullSurface(R, space));
      if (backdrop) { exempt('modal', `  (backdrop ${backdrop.name})`); continue; }
      // The dialog's own content sits on its backdrop: E is the backdrop and L shows only with it.
      if (E.cond.length > 0 && subset(E.cond, L.cond) && fullSurface(E, space)) { exempt('modal', `  (backdrop ${E.name})`); continue; }
      const where = path.basename(E.file);
      const layout = geo.when.length ? ` In the layout where ${geo.when.join(' and ')}.` : '';
      const cond = `${E.name} shows ${condText(E) === 'always' ? 'always' : 'when ' + condText(E)}; ${L.name} shows ${condText(L) === 'always' ? 'always' : 'when ' + condText(L)}`;
      if (textOverShape) {
        const onCentre = allPairs(E, L, centre).hit > 0;
        findings.push({ level: 'error', code: onCentre ? 'covers-control' : 'overlap', file: E.file, line: L.line, space, a: L.name, b: E.name,
          msg: `${L.name} (${L.control}, line ${L.line}) is text drawn over the clickable ${E.control.toLowerCase()} ${E.name} (line ${E.line}) by ${geo.first.ox}x${geo.first.oy} px: `
            + `a click on the text lands on the label and ${E.name}.OnSelect does not run. ${cond}.${layout} Give the label the same OnSelect, or put a text-less transparent button on top (the click-pad pattern), or move it.` });
      } else if (deadClick) {
        const clicks = E.kind === 'interactive' || E.kind === 'clickpad';
        findings.push({ level: 'error', code: clicks ? 'covers-control' : 'hidden-under', file: E.file, line: L.line, space, a: L.name, b: E.name,
          msg: `${L.name} (${L.control}, line ${L.line}) is declared after ${E.name} (${E.control}, line ${E.line}) and covers its centre: `
            + (clicks ? `the click lands on the ${L.control.toLowerCase()} and nothing happens.` : `it is painted over, so it does not show.`)
            + ` ${cond}.${layout} Declare ${E.name} after ${L.name} (declaration order is z-order), or move it.` });
      } else {
        findings.push({ level: 'error', code: 'overlap', file: E.file, line: L.line, space, a: L.name, b: E.name,
          msg: `${L.name} (${L.control}, line ${L.line}, drawn on top) overlaps ${E.name} (${E.control}, line ${E.line}) by ${geo.first.ox}x${geo.first.oy} px${space.endsWith('#row') ? ' in each gallery row' : ''}. ${cond}: not provably exclusive, so both can be on screen at once.${layout}` });
      }
    }
    // Edges.
    for (const c of list) {
      if (space.endsWith('#row')) {
        const g = byName.get(space.slice(0, -4));
        const gw = g && prop(g, 'Width'), th = g && prop(g, 'TemplateSize');
        if (!gw || !th) continue;
        const out = c.alts.every((b) => b.x + b.w > Math.max(...gw) + 2 || b.y + b.h > Math.max(...th) + 2 || b.x < -2 || b.y < -2);
        if (out) findings.push({ level: 'warn', code: 'outside-row', file: c.file, line: c.line, space, a: c.name,
          msg: `${c.name} runs past its gallery row (${g.name}: ${Math.max(...gw)} wide, TemplateSize ${Math.max(...th)}); the row clips it.` });
      } else {
        const out = c.alts.every((b) => b.x + b.w > screenWidth + 2 || b.y + b.h > screenHeight + 2 || b.x < -2 || b.y < -2);
        if (out) { const b = c.alts[0]; findings.push({ level: 'warn', code: 'off-canvas', file: c.file, line: c.line, space, a: c.name,
          msg: `${c.name} (${b.x},${b.y} ${b.w}x${b.h}) runs past the ${screenWidth}x${screenHeight} design surface.` }); }
      }
    }
  }
  return { findings, stats };
}

// ---------- loading, report, CLI ----------
function collect(paths) {
  const out = [];
  const visit = (p) => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) visit(path.join(p, f)); return; }
    if (p.endsWith('.pa.yaml')) out.push({ path: p, text: fs.readFileSync(p, 'utf8') });
  };
  paths.forEach(visit);
  for (const p of paths) {
    const dir = fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
    const app = path.join(dir, 'App.pa.yaml');
    if (fs.existsSync(app) && !out.some((f) => path.resolve(f.path) === path.resolve(app))) out.push({ path: app, text: fs.readFileSync(app, 'utf8') });
  }
  return out;
}
// Screens the check mostly could not read. A whole-app share hides a new screen at 0 of 113 among
// screens that resolve, and "0 errors" then reads as a pass for the one screen just written.
export function thinFiles(stats) {
  return Object.entries(stats.perFile).filter(([, n]) => n.compared && n.resolved * 2 < n.compared)
    .map(([file, n]) => ({ file, ...n }));
}
function report(res, json, explain = false) {
  if (json) { console.log(JSON.stringify(res, null, 2)); return; }
  const { findings, stats } = res;
  for (const f of findings) console.log(`${f.level.toUpperCase().padEnd(5)} ${f.code}  ${path.basename(f.file)}:${f.line}  ${f.msg}`);
  const e = stats.exempt;
  console.log(`\n${stats.files} screen file(s); ${stats.compared} drawn control(s): ${stats.resolved} resolved, ${stats.skipped} skipped, ${stats.alwaysHidden} never visible.`
    + ` ${stats.pairs} overlapping pair(s) examined; exempt: ${e.exclusive} exclusive by Visible, ${e.modal} modal, ${e.linked} linked, ${e.clickpad} text-less click pad.`);
  for (const [why, n] of Object.entries(stats.skipReasons)) console.log(`  skipped ${n}: ${why}`);
  for (const k of stats.skippedControls) console.log(`    ${k.name}  ${k.file ? path.basename(k.file) : ''}${k.line ? ':' + k.line : ''}  (${k.why})`);
  if (explain) { console.log('\nExempted pairs (audit these: an exemption that hides a real overlap is a bug in this check):'); stats.exempted.forEach((x) => console.log('  ' + x)); }
  console.log(`${findings.filter((f) => f.level === 'error').length} error(s), ${findings.filter((f) => f.level === 'warn').length} warning(s). A skipped control was NOT checked; the published app is the authority (canvas-browser.mjs overlapcheck / deadclick).`);
  for (const t of thinFiles(stats)) console.log(`!! ${path.basename(t.file)}: only ${t.resolved} of ${t.compared} drawn control(s) resolved - this screen was NOT checked (exit 2 unless there are errors).`);
  if (stats.compared && stats.resolved * 2 < stats.compared) console.log(`\n!! WARNING: only ${stats.resolved} of ${stats.compared} drawn controls were resolved - most of this app was NOT checked, whatever the error count says. Make the skipped geometry resolvable (layout constants in App.Formulas) before trusting a clean result.`);
}
function hookMode() {
  let input = {}; try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* not a hook payload */ }
  const file = input?.tool_input?.file_path || input?.tool_response?.filePath;
  if (!file || !file.endsWith('.pa.yaml') || /(^|[\\/])(App|_EditorState)\.pa\.yaml$/i.test(file)) process.exit(0);
  const res = analyse(collect([path.dirname(file)]));
  const bad = res.findings.filter((f) => f.level === 'error' && path.resolve(f.file) === path.resolve(file));
  if (!bad.length) process.exit(0);
  console.error(`Overlap check failed for ${path.basename(file)}: a control is drawn over another that can be on screen at the same time.\n\n  `
    + bad.map((f) => `${f.code}: ${f.msg}`).join('\n  ')
    + `\n\nMove one of them, or make their Visible conditions exclusive. See references/canvas-layout.md, sections 4 and 7.`);
  process.exit(2);
}

// ---------- self-test ----------
const APP = ['App:', '  Properties:', '    OnStart: |', '      =Set(gblGutter, 24);', '      Set(gblHeaderH, 64)'].join('\n');
const ctl = (name, control, props, ind = 6) => {
  const p = ' '.repeat(ind);
  return [`${p}- ${name}:`, `${p}    Control: ${control}`, `${p}    Properties:`, ...Object.entries(props).map(([k, v]) => `${p}      ${k}: ${v}`)];
};
const scr = (...rows) => ['Screens:', '  scrS:', '    Children:', ...rows.flat()].join('\n');
const L = (name, extra = {}) => ctl(name, 'Label', { Text: `="${name} text"`, X: '=24', Y: '=100', Width: '=300', Height: '=24', ...extra });
const B = (name, extra = {}) => ctl(name, 'Button', { Text: '="Save"', X: '=200', Y: '=96', Width: '=120', Height: '=32', ...extra });
const CASES = [
  // [name, yaml, expected error/warn codes]
  ['button-over-conditional-label', scr(L('lblWarn', { Visible: '=locShowWarn' }), B('btnSave')), ['overlap']],
  ['label-over-button', scr(B('btnSave'), L('lblHint', { Visible: '=IsBlank(txtName.Value)' })), ['overlap']],
  ['separate-geometry', scr(L('lblWarn', { Visible: '=locShowWarn' }), B('btnSave', { Y: '=140' })), []],
  ['tabs-exclusive', scr(L('lblA', { Visible: '=locTab = "items"' }), B('btnB', { Visible: '=locTab = "roles"' })), []],
  ['not-exclusive-same-tab', scr(L('lblA', { Visible: '=locTab = "items"' }), B('btnB', { Visible: '=locTab = "items" && gblIsAdmin' })), ['overlap']],
  ['a-vs-not-a', scr(L('lblA', { Visible: '=gblIsAdmin' }), B('btnB', { Visible: '=!gblIsAdmin' })), []],
  ['or-vs-and-not', scr(L('lblA', { Visible: '=locA || locB' }), B('btnB', { Visible: '=!locA && !locB' })), []],
  ['eq-false-vs-bare', scr(L('lblA', { Visible: '=locOpen = false' }), B('btnB', { Visible: '=locOpen' })), []],
  ['in-list', scr(L('lblA', { Visible: '=locTab in ["a", "b"]' }), B('btnB', { Visible: '=locTab = "c"' })), []],
  ['option-values', scr(L('lblA', { Visible: "=locCase.Status = 'Case Status'.Open" }), B('btnB', { Visible: "=locCase.Status = 'Case Status'.Closed" })), []],
  ['block-scalar-visible', scr(L('lblA', { Visible: '|\n                  =locTab = "items"' }), B('btnB', { Visible: '=locTab = "roles"' })), []],
  ['globals-resolve', scr(L('lblA', { X: '=gblGutter', Y: '=gblHeaderH + 36' }), B('btnB', { X: '=gblGutter + 100', Y: '=gblHeaderH + 32' })), ['overlap']],
  ['parent-width', scr(L('lblA', { X: '=Parent.Width - 324' }), B('btnB', { X: '=Parent.Width - 200' })), ['overlap']],
  ['card-behind', scr(ctl('recCard', 'Rectangle', { X: '=0', Y: '=80', Width: '=600', Height: '=200', Fill: '=clrCard' }), L('lblA'), B('btnB', { Y: '=140' })), []],
  ['card-after-label', scr(L('lblCount'), ctl('recCard', 'Rectangle', { X: '=0', Y: '=80', Width: '=600', Height: '=200', Fill: '=clrCard' })), ['hidden-under']],
  ['transparent-after-label', scr(L('lblCount'), ctl('recFrame', 'Rectangle', { X: '=0', Y: '=80', Width: '=600', Height: '=200', Fill: '=Color.Transparent' })), []],
  ['rectangle-after-button', scr(B('btnB'), ctl('recPill', 'Rectangle', { X: '=190', Y: '=90', Width: '=200', Height: '=60', Fill: '=clrPill' })), ['covers-control']],
  ['modal-with-backdrop', scr(L('lblA'), ctl('recShade', 'Rectangle', { Visible: '=locDlg', X: '=0', Y: '=0', Width: '=Parent.Width', Height: '=Parent.Height', Fill: '=clrShade' }),
    B('btnOk', { Visible: '=locDlg' })), []],
  ['modal-clickable-backdrop', scr(L('lblA'), ctl('recShade', 'Rectangle', { Visible: '=locDlg', X: '=0', Y: '=0', Width: '=Parent.Width', Height: '=Parent.Height', Fill: '=clrShade', OnSelect: '=UpdateContext({locDlg: false})' }),
    B('btnOk', { Visible: '=locDlg' })), []],
  ['modal-text-on-clickable-backdrop', scr(ctl('recShade', 'Rectangle', { Visible: '=locDlg', X: '=0', Y: '=0', Width: '=Parent.Width', Height: '=Parent.Height', Fill: '=clrShade', OnSelect: '=UpdateContext({locDlg: false})' }),
    L('lblDlgTitle', { Visible: '=locDlg' })), []],
  ['clickpad-over-tile', scr(L('lblTile'), ctl('btnTile', 'Button', { Text: '=""', X: '=24', Y: '=100', Width: '=300', Height: '=24', OnSelect: '=Navigate(scrX)' })), []],
  ['empty-state-over-gallery', scr(ctl('galCases', 'Gallery', { Items: '=colCases', X: '=24', Y: '=100', Width: '=600', Height: '=300', TemplateSize: '=48' }),
    L('lblEmpty', { Visible: '=CountRows(colCases) = 0', Y: '=200' })), []],
  ['results-list-names-its-input', scr(ctl('txtSearch', 'TextInput', { X: '=24', Y: '=100', Width: '=300', Height: '=32' }),
    ctl('galResults', 'Gallery', { Items: '=Search(People, txtSearch.Value, Name)', Visible: '=Len(txtSearch.Value) >= 2', X: '=24', Y: '=110', Width: '=300', Height: '=200', TemplateSize: '=32' })), []],
  ['two-galleries-same-row-coords', ['Screens:', '  scrS:', '    Children:',
    ...ctl('galA', 'Gallery', { Items: '=A', X: '=0', Y: '=80', Width: '=600', Height: '=200', TemplateSize: '=40' }), '          Children:',
    ...L('lblRowA', { X: '=8', Y: '=8' }).map((s) => '      ' + s),
    ...ctl('galB', 'Gallery', { Items: '=B', X: '=0', Y: '=300', Width: '=600', Height: '=200', TemplateSize: '=40' }), '          Children:',
    ...L('lblRowB', { X: '=8', Y: '=8' }).map((s) => '      ' + s)].join('\n'), []],
  ['row-overlap', ['Screens:', '  scrS:', '    Children:',
    ...ctl('galA', 'Gallery', { Items: '=A', X: '=0', Y: '=80', Width: '=600', Height: '=200', TemplateSize: '=40' }), '          Children:',
    ...L('lblRowA', { X: '=8', Y: '=8' }).map((s) => '      ' + s),
    ...B('btnRow', { X: '=200', Y: '=4' }).map((s) => '      ' + s)].join('\n'), ['overlap']],
  ['off-canvas', scr(L('lblA', { X: '=1300' })), ['off-canvas']],
  ['if-geometry-one-branch-overlaps', scr(L('lblA'), B('btnB', { Y: '=If(locWide, 96, 300)' })), ['overlap']],
  // The position is chosen by the same test that shows the label: never on screen together.
  ['if-geometry-correlated', scr(L('lblHint', { Visible: '=locType = "on"' }), B('btnB', { Y: '=If(locType = "on", 140, 96)' })), []],
  ['switch-geometry-correlated', scr(L('lblHint', { Visible: '=locTab = "a"' }), B('btnB', { Y: '=Switch(locTab, "a", 140, "b", 96, 96)' })), []],
  ['numeric-range-exclusive', scr(L('lblNone', { Visible: '=gblTotal = 0' }), B('btnB', { Visible: '=gblTotal > 0' })), []],
  ['numeric-range-overlapping', scr(L('lblFew', { Visible: '=gblTotal < 5' }), B('btnB', { Visible: '=gblTotal > 0' })), ['overlap']],
  ['variable-eq-vs-neq', scr(L('lblPick', { Visible: '=locSel = gblNoId' }), B('btnB', { Visible: '=locSel <> gblNoId' })), []],
  ['variable-eq-vs-eq', scr(L('lblPick', { Visible: '=locSel = gblNoId' }), B('btnB', { Visible: '=locSel = gblOther' })), ['overlap']],
  ['negated-in', scr(L('lblMode', { Visible: '=ThisItem.Key in ["a", "b"]' }), B('btnB', { Visible: '=!(ThisItem.Key in ["a", "b"])' })), []],
  ['empty-state-zero-test', scr(ctl('galItems', 'Gallery', { Items: '=Filter(colItems, Active)', X: '=24', Y: '=100', Width: '=600', Height: '=300', TemplateSize: '=48',
    OnVisible: '=Set(gblItemShown, CountRows(colItems))' }), L('lblNone', { Visible: '=gblItemShown = 0', Y: '=200' })), []],
  ['empty-state-of-another-gallery', scr(ctl('galMgr', 'Gallery', { Items: '=Search(People, txtMgr.Value, Name)', X: '=24', Y: '=100', Width: '=600', Height: '=300', TemplateSize: '=48' }),
    L('lblMentorHint', { Visible: '=galMentor.AllItemsCount = 0', Y: '=200' })), ['overlap']],
  ['button-over-empty-state', scr(L('lblNone', { Visible: '=gblItemShown = 0' }), B('btnAdd')), ['overlap']],
  ['text-on-card-background', scr(ctl('recCard', 'Rectangle', { X: '=0', Y: '=80', Width: '=600', Height: '=200', Fill: '=clrCard' }), L('lblA'), L('lblB', { Y: '=140' })), []],
  ['text-on-row-background', ['Screens:', '  scrS:', '    Children:',
    ...ctl('galA', 'Gallery', { Items: '=A', X: '=0', Y: '=80', Width: '=600', Height: '=200', TemplateSize: '=40' }), '          Children:',
    ...ctl('recRow', 'Rectangle', { X: '=0', Y: '=0', Width: '=600', Height: '=40', Fill: '=clrRow', OnSelect: '=Select(Parent)' }).map((s) => '      ' + s),
    ...L('lblRowA', { X: '=8', Y: '=8' }).map((s) => '      ' + s)].join('\n'), []],
  ['label-over-clickable-rectangle', scr(ctl('recTile', 'Rectangle', { X: '=24', Y: '=96', Width: '=300', Height: '=40', Fill: '=clrTile', OnSelect: '=Navigate(scrOrders)' }), L('lblTile')), ['covers-control']],
  ['label-with-its-own-click-over-tile', scr(ctl('recTile', 'Rectangle', { X: '=24', Y: '=96', Width: '=300', Height: '=40', Fill: '=clrTile', OnSelect: '=Navigate(scrOrders)' }), L('lblTile', { OnSelect: '=Navigate(scrOrders)' })), []],
  ['never-visible-spacer', scr(L('lblA'), ctl('recSpacer', 'Rectangle', { Visible: '=false', X: '=0', Y: '=0', Width: '=999', Height: '=999' }), B('btnB', { Y: '=200' })), []],
];
function selftest() {
  const fails = [];
  for (const [name, yaml, want] of CASES) {
    let res;
    try { res = analyse([{ path: 'App.pa.yaml', text: APP }, { path: name + '.pa.yaml', text: yaml }]); }
    catch (e) { fails.push(`${name}: threw ${e.message}`); continue; }
    const got = [...new Set(res.findings.map((f) => f.code))].sort();
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) fails.push(`${name}: expected [${want.join(', ')}], got [${got.join(', ')}]  ${res.findings.map((f) => f.msg).join(' | ')}`);
    if (res.stats.skipped) fails.push(`${name}: ${res.stats.skipped} control(s) skipped: ${Object.keys(res.stats.skipReasons).join('; ')}`);
  }
  // Layout constants after a comment in App.Formulas resolve (the shared formula reader strips comments):
  // before, a comment glued itself to lyW, lyK and lyX never resolved, and the check compared nothing.
  const APPC = ['App:', '  Properties:', '    Formulas: |-', '      =// layout', '      lyW = Max(App.Width - 18, 320);', '      // scale', '      lyK = lyW / 1348;',
    '      lyX = (lyW - 1348 * lyK) / 2;'].join('\n');
  const rc = analyse([{ path: 'App.pa.yaml', text: APPC }, { path: 'c.pa.yaml', text: scr(L('lblA', { X: '=lyX + 24 * lyK', Width: '=300 * lyK' }), B('btnB', { X: '=lyX + 200 * lyK', Width: '=120 * lyK' })) }]);
  if (rc.stats.resolved !== 2 || !rc.findings.some((f) => f.code === 'overlap')) fails.push(`comment before lyW: resolved ${rc.stats.resolved} of 2, findings [${rc.findings.map((f) => f.code).join(', ')}]`);
  // The floor: unresolvable geometry is counted, not passed silently.
  const r = analyse([{ path: 's.pa.yaml', text: scr(L('lblA', { X: '=Rand() * 10' })) }]);
  if (r.stats.resolved !== 0 || r.stats.skipped !== 1 || r.stats.skippedControls.length !== 1) fails.push('an unresolvable X must be counted as skipped and named');
  // The per-file floor: one unreadable screen among readable ones is named, so the run does not pass
  // on the screen just written (a 113-control screen at 0 resolved once read as "0 errors").
  const rt = analyse([{ path: 'App.pa.yaml', text: APP }, { path: 'good.pa.yaml', text: scr(L('lblA'), B('btnB', { Y: '=200' }), L('lblC', { Y: '=300' })) },
    { path: 'new.pa.yaml', text: scr(L('lblN', { X: '=Rand() * 10' }), L('lblM', { X: '=Rand() * 20', Y: '=200' })) }]);
  const thin = thinFiles(rt.stats);
  if (rt.stats.resolved * 2 < rt.stats.compared || thin.length !== 1 || thin[0].file !== 'new.pa.yaml') fails.push(`per-file floor: expected new.pa.yaml alone under half, got [${thin.map((t) => t.file).join(', ')}]`);
  const rh = analyse([{ path: 'App.pa.yaml', text: APP }, { path: 'half.pa.yaml', text: scr(L('lblA'), L('lblN', { X: '=Rand() * 10', Y: '=200' })) }]);
  if (thinFiles(rh.stats).length) fails.push('per-file floor: exactly half resolved is not under half');
  const ok = fails.length === 0;
  console.log(ok ? `selftest ok: ${CASES.length} layouts decided as expected (overlaps, exclusive conditions, modal (clickable backdrops too), card and row backgrounds, text over a clickable shape, click pad, empty state, gallery rows, edges), layout constants after a comment, the skip floor and the per-file floor`
    : `selftest FAILED:\n  ${fails.join('\n  ')}`);
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest();
  else if (argv.includes('--hook')) hookMode();
  else if (argv.length === 0 || argv.includes('--help')) {
    console.log('usage: node check-canvas-overlap.mjs <Src folder or .pa.yaml>... [--screen-width N] [--screen-height N] [--json] [--warnings-fail] | --hook | --selftest');
    process.exit(argv.length === 0 ? 1 : 0);
  } else {
    const opt = (f) => { const k = argv.indexOf(f); return k === -1 ? null : argv[k + 1]; };
    const valued = new Set(['--screen-width', '--screen-height'].map((f) => argv.indexOf(f)).filter((k) => k !== -1).map((k) => k + 1));
    const files = collect(argv.filter((a, k) => !a.startsWith('--') && !valued.has(k)));
    if (!files.length) { console.error('No .pa.yaml files found - this is NOT a pass.'); process.exit(2); }
    const res = analyse(files, { screenWidth: Number(opt('--screen-width') || 1366), screenHeight: Number(opt('--screen-height') || 768) });
    report(res, argv.includes('--json'), argv.includes('--explain'));
    if (res.stats.resolved === 0) { console.error('No control geometry was resolved - this is NOT a pass.'); process.exit(2); }
    const fail = res.findings.some((f) => f.level === 'error' || (argv.includes('--warnings-fail') && f.level === 'warn'));
    if (fail) process.exit(1);
    const thin = thinFiles(res.stats);
    if (thin.length) { console.error(`${thin.length} screen file(s) had under half their drawn controls resolved - this is NOT a pass for them.`); process.exit(2); }
    process.exit(0);
  }
}
