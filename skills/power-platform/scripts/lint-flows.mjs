#!/usr/bin/env node
// lint-flows.mjs - static checks on Power Automate cloud-flow definitions.
//
// Activation is the only compile a flow gets, and a flow shipped deliberately OFF never reaches
// it. Several defects also pass activation and fail only at run time, or never fail at all and
// simply do the wrong thing. This checks the known ones in source, offline, in milliseconds.
//
// Usage:
//   node lint-flows.mjs <path>...            files or folders (solution/src/Workflows, drafts)
//   node lint-flows.mjs <path> --entity-sets sets.json   also verify every entityName
//   node lint-flows.mjs <path> --date-only cols.json     flag date-only columns used as instants
//                                                        (cols.json: ["app_approvedon", ...])
//   node lint-flows.mjs --selftest
//   --json  machine-readable output
//   --work-dir <dir>  where the run record goes (default .ship-work in the current folder)
//
// Every run records itself in <work-dir>/flow-lint.json ({at, clean, count, paths}). The plugin's
// order gate refuses `pac solution import` while flows exist and that record is missing, has errors,
// covers fewer flows than the folder holds, or is older than the newest flow (SKILL.md non-negotiable 8).
//
// Accepts a solution flow file ({properties:{definition, connectionReferences}}), a bare
// {definition: ...}, or a bare definition ({triggers, actions}).
//
// self-trigger-loop parses the expressions (WDL: equals/not/and/or/coalesce/empty/if/..., trigger
// and row reads with ?['col'] and ['body/col'], @{...} interpolation, one level of Compose and
// variable indirection) and evaluates the write's path conditions with the written values put
// into the row. Guarded = some condition reads a written column AND is false after the write.
// Anything it cannot evaluate counts as unknown, never as a guard. A guard that holds only if a
// value read at run time is non-blank is a warning (self-write-guard-assumes-value).
//
// Exit: 0 clean (warnings allowed), 1 errors found, 2 nothing could be read (NOT a pass).
import fs from 'node:fs';
import path from 'node:path';

const SEND_OPS = /^(SendEmail|SendEmailV\d|SendEmailWithOptions|SendMailWithOptions|PostMessage|PostMessageToConversation|PostCardToConversation|PostFeedNotification|SendNotification|PostMessageToChannel)/i;
const READ_FNS = /\b(outputs|body|actions|result|items)\(\s*'([^']+)'\s*\)/g;
const MESSAGE = { 1: 'Create', 2: 'Delete', 3: 'Update', 4: 'Create or Update', 5: 'Create or Delete', 6: 'Update or Delete', 7: 'Create, Update or Delete' };

// ---------- loading ----------
function loadFlows(paths) {
  const out = [];
  const visit = (p) => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) visit(path.join(p, f)); return; }
    if (!p.toLowerCase().endsWith('.json')) return;
    let doc; try { doc = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return; }
    const props = doc.properties || doc;
    const def = props.definition || (doc.triggers && doc.actions ? doc : null);
    if (!def || !def.triggers) return;
    out.push({ file: p, name: path.basename(p).replace(/-[0-9A-Fa-f-]{36}\.json$/, '').replace(/\.json$/, ''),
               def, refs: props.connectionReferences || {} });
  };
  paths.forEach(visit);
  return out;
}

// ---------- helpers ----------
function childScopes(act) {
  const scopes = [];
  if (act.actions) scopes.push(act.actions);
  if (act.else && act.else.actions) scopes.push(act.else.actions);
  if (act.cases) for (const c of Object.values(act.cases)) if (c.actions) scopes.push(c.actions);
  if (act.default && act.default.actions) scopes.push(act.default.actions);
  return scopes;
}
function ownJson(act) {
  const copy = { ...act };
  delete copy.actions; delete copy.else; delete copy.cases; delete copy.default;
  return JSON.stringify(copy);
}
function descendants(act, acc = new Set()) {
  for (const s of childScopes(act)) for (const [n, a] of Object.entries(s)) { acc.add(n); descendants(a, acc); }
  return acc;
}
function walk(scope, fn, trail = []) {
  for (const [n, a] of Object.entries(scope || {})) {
    fn(n, a, trail);
    for (const s of childScopes(a)) walk(s, fn, [...trail, { name: n, act: a }]);
  }
}
const stringsIn = (v, acc = []) => {
  if (typeof v === 'string') acc.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, acc));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringsIn(x, acc));
  return acc;
};
const colTokens = (s) => new Set((s.match(/\b[a-z][a-z0-9]{1,8}_[a-z0-9_]+\b/gi) || []).map((x) => x.toLowerCase()));
const sameTable = (logical, set) => {
  if (!logical || !set) return false;
  const l = logical.toLowerCase(), s = set.toLowerCase();
  // Exact plural forms only: a prefix match would treat app_requestlogs as app_request.
  return s === l || s === l + 's' || s === l + 'es' || (l.endsWith('y') && s === l.slice(0, -1) + 'ies');
};

// ---------- checks ----------
function triggerInfo(def) {
  const [tname, trig] = Object.entries(def.triggers)[0] || [];
  if (!trig) return {};
  const p = (trig.inputs && trig.inputs.parameters) || {};
  const op = trig.inputs && trig.inputs.host && trig.inputs.host.operationId;
  const isPowerApps = trig.type === 'Request' && /PowerApp/i.test(trig.kind || '');
  const isDataverse = op === 'SubscribeWebhookTrigger' || p['subscriptionRequest/entityname'] !== undefined;
  return { tname, trig, type: trig.type, op, isPowerApps, isDataverse,
           table: p['subscriptionRequest/entityname'], message: p['subscriptionRequest/message'],
           filtering: p['subscriptionRequest/filteringattributes'], conditions: trig.conditions || [] };
}

function checkRuntimeSource(flow, t, add) {
  for (const [k, r] of Object.entries(flow.refs)) {
    if (r && r.runtimeSource === 'invoker' && !t.isPowerApps) {
      add('error', 'runtime-invoker', `connection '${k}' uses runtimeSource "invoker" but the trigger is ${t.type}${t.isDataverse ? ' (Dataverse)' : ''}, ` +
        `which supplies no X-MS-APIM-Tokens header - every run fails in the trigger (InvokerConnectionOverrideFailed). Use "embedded".`);
    }
  }
}

function checkMessageCode(t, add) {
  if (!t.isDataverse) return;
  const code = Number(t.message);
  const label = MESSAGE[code] || `unknown (${t.message})`;
  add('info', 'trigger-message', `trigger '${t.tname}' on ${t.table} fires on message ${t.message} = ${label} ` +
    `(1 Create, 2 Delete, 3 Update). Prove it from a run payload's SdkMessage.`);
  const n = (t.tname || '').toLowerCase();
  const says = /delet|remov/.test(n) ? 'Delete' : /updat|modif|chang|edit/.test(n) ? 'Update' : /creat|add|new|insert/.test(n) ? 'Create' : null;
  if (says && !label.includes(says)) {
    add('error', 'trigger-message-mismatch', `trigger is named '${t.tname}' (reads as ${says}) but message ${t.message} = ${label}. ` +
      `The codes are 1 Create, 2 DELETE, 3 UPDATE - the natural guess (2 = Update) is wrong.`);
  }
}

// ---------- Workflow Definition Language: a small parser and a three-valued evaluator ----------
// Enough of the expression language to answer one question: after this write, is the condition
// that let the write run FALSE? Anything the evaluator does not understand is UNKNOWN, and an
// unknown never counts as a guard - the check fails safe (it may over-report, never under-report).
const UNKNOWN = Symbol('unknown');      // could be anything, including null
const NONBLANK = Symbol('nonblank');    // a value we cannot name but know is not null and not ''

export function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'") {
      let s = ''; i++;
      for (;;) {
        if (i >= src.length) throw new Error('unterminated string literal');
        if (src[i] === "'") { if (src[i + 1] === "'") { s += "'"; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      toks.push({ k: 'str', v: s }); continue;
    }
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num && (ch !== '-' || !toks.length || ['(', ',', '['].includes(toks[toks.length - 1].k))) {
      toks.push({ k: 'num', v: Number(num[0]) }); i += num[0].length; continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { toks.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    if ('(),[]?.'.includes(ch)) { toks.push({ k: ch }); i++; continue; }
    throw new Error(`unexpected character '${ch}' at ${i}`);
  }
  return toks;
}

export function parseExpression(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = (k) => toks[p] && toks[p].k === k;
  const eat = (k) => { if (!peek(k)) throw new Error(`expected '${k}' at token ${p}`); return toks[p++]; };
  const primary = () => {
    const t = toks[p];
    if (!t) throw new Error('unexpected end of expression');
    if (t.k === 'str' || t.k === 'num') { p++; return { t: 'lit', v: t.v }; }
    if (t.k === 'id') {
      p++;
      if (peek('(')) {
        p++;
        const args = [];
        if (!peek(')')) { args.push(expr()); while (peek(',')) { p++; args.push(expr()); } }
        eat(')');
        return { t: 'call', name: t.v, args };
      }
      const lower = t.v.toLowerCase();
      if (lower === 'true' || lower === 'false') return { t: 'lit', v: lower === 'true' };
      if (lower === 'null') return { t: 'lit', v: null };
      throw new Error(`bare identifier '${t.v}'`);
    }
    throw new Error(`unexpected token '${t.k}'`);
  };
  const expr = () => {
    let node = primary();
    for (;;) {
      const safe = peek('?');
      if (safe && toks[p + 1] && (toks[p + 1].k === '[' || toks[p + 1].k === '.')) p++;
      else if (safe) throw new Error("stray '?'");
      if (peek('[')) { p++; const key = expr(); eat(']'); node = { t: 'idx', obj: node, key }; continue; }
      if (peek('.')) { p++; const name = eat('id').v; node = { t: 'idx', obj: node, key: { t: 'lit', v: name } }; continue; }
      return node;
    }
  };
  const node = expr();
  if (p !== toks.length) throw new Error(`trailing tokens after expression`);
  return node;
}

// A JSON string in a definition is a literal, an "@expression", or text with "@{...}" segments.
export function parseValue(v) {
  if (typeof v !== 'string') return { t: 'lit', v };
  try {
    if (v.startsWith('@@')) return { t: 'lit', v: v.slice(1) };
    if (v.includes('@{')) {
      const parts = [];
      let i = 0;
      while (i < v.length) {
        const s = v.indexOf('@{', i);
        if (s === -1) { parts.push({ t: 'lit', v: v.slice(i) }); break; }
        if (s > i) parts.push({ t: 'lit', v: v.slice(i, s) });
        let j = s + 2, inQ = false;
        for (; j < v.length; j++) {
          if (v[j] === "'") { if (inQ && v[j + 1] === "'") { j++; continue; } inQ = !inQ; continue; }
          if (!inQ && v[j] === '}') break;
        }
        if (j >= v.length) throw new Error('unterminated @{');
        parts.push(parseExpression(v.slice(s + 2, j)));
        i = j + 1;
      }
      return { t: 'interp', parts };
    }
    if (v.startsWith('@')) return parseExpression(v.slice(1));
    return { t: 'lit', v };
  } catch (e) { return { t: 'unknown', why: e.message, src: v }; }
}

// The designer's object form: {"and": [{"equals": ["@...", 2]}, {"not": {"equals": [...]}}]}.
function conditionAst(c) {
  if (typeof c === 'string' || typeof c !== 'object' || c === null) return parseValue(c);
  const keys = Object.keys(c);
  if (keys.length !== 1) return { t: 'unknown', why: 'condition object with ' + keys.length + ' keys' };
  const op = keys[0], arg = c[op];
  if (op === 'and' || op === 'or') return { t: 'call', name: op, args: (Array.isArray(arg) ? arg : [arg]).map(conditionAst) };
  if (op === 'not') return { t: 'call', name: 'not', args: [conditionAst(arg)] };
  if (Array.isArray(arg)) return { t: 'call', name: op, args: arg.map(parseValue) };
  return { t: 'unknown', why: 'condition operator ' + op };
}

const isSym = (v) => v === UNKNOWN || v === NONBLANK;
const isBlank = (v) => v === null || v === '' || (Array.isArray(v) && v.length === 0);

// Three-valued equality. Doubt (type coercion, case) answers UNKNOWN rather than guess.
function eq(a, b) {
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  if (a === NONBLANK || b === NONBLANK) {
    const other = a === NONBLANK ? b : a;
    return other !== NONBLANK && isBlank(other) ? false : UNKNOWN;
  }
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return UNKNOWN;
  if (typeof a === 'string') return a === b ? true : a.toLowerCase() === b.toLowerCase() ? UNKNOWN : false;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b) ? true : UNKNOWN;
  return a === b;
}

// Which row column does this node read? Sources that carry the trigger row on the NEXT pass too:
// triggerOutputs()?['body/col'], triggerBody()?['col'], a GetItem of the trigger table
// (outputs('X')?['body/col'], body('X')?['col']) and items('X') of a loop over that table.
function rowColumn(node, ctx) {
  const keys = [];
  while (node && node.t === 'idx') {
    if (node.key.t !== 'lit' || typeof node.key.v !== 'string') return null;
    keys.unshift(...node.key.v.split('/'));
    node = node.obj;
  }
  if (!node || node.t !== 'call') return null;
  const n = node.name.toLowerCase();
  const arg = node.args[0] && node.args[0].t === 'lit' ? String(node.args[0].v) : null;
  let col = null;
  if (n === 'triggeroutputs' && keys.length === 2 && keys[0] === 'body') col = keys[1];
  else if (n === 'triggerbody' && keys.length === 1) col = keys[0];
  else if (n === 'outputs' && ctx.rowActions.has(arg) && keys.length === 2 && keys[0] === 'body') col = keys[1];
  else if (n === 'body' && ctx.rowActions.has(arg) && keys.length === 1) col = keys[0];
  else if (n === 'items' && ctx.rowLoops.has(arg) && keys.length === 1) col = keys[0];
  return col ? col.toLowerCase() : null;
}

// One level of indirection: outputs('Compose') and variables('v') become the expression they hold.
function substitute(node, ctx, depth = 0) {
  if (!node || typeof node !== 'object') return node;
  if (node.t === 'call') {
    const n = node.name.toLowerCase();
    const arg = node.args[0] && node.args[0].t === 'lit' ? String(node.args[0].v) : null;
    if (depth === 0 && arg !== null && (n === 'outputs' || n === 'body') && ctx.composes.has(arg)) return ctx.composes.get(arg);
    if (depth === 0 && arg !== null && n === 'variables' && ctx.vars.has(arg)) return ctx.vars.get(arg);
    return { ...node, args: node.args.map((a) => substitute(a, ctx, depth)) };
  }
  if (node.t === 'idx') return { ...node, obj: substitute(node.obj, ctx, depth), key: substitute(node.key, ctx, depth) };
  if (node.t === 'interp') return { ...node, parts: node.parts.map((x) => substitute(x, ctx, depth)) };
  return node;
}

function readsColumns(node, ctx, acc = new Set()) {
  if (!node || typeof node !== 'object') return acc;
  if (node.t === 'idx') { const c = rowColumn(node, ctx); if (c) { acc.add(c); return acc; } }
  for (const k of ['obj', 'key']) if (node[k]) readsColumns(node[k], ctx, acc);
  for (const k of ['args', 'parts']) if (node[k]) node[k].forEach((x) => readsColumns(x, ctx, acc));
  return acc;
}

const NONBLANK_FNS = new Set(['utcnow', 'guid', 'workflow', 'adddays', 'addhours', 'addminutes', 'addseconds', 'addtotime', 'converttimezone', 'startofday', 'startofhour', 'startofmonth']);
function evaluate(node, ctx, env) {
  if (!node) return UNKNOWN;
  switch (node.t) {
    case 'lit': return node.v;
    case 'unknown': return UNKNOWN;
    case 'interp': {
      const vals = node.parts.map((x) => evaluate(x, ctx, env));
      if (vals.every((v) => !isSym(v))) return vals.map((v) => (v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join('');
      return vals.some((v) => v === NONBLANK || (typeof v === 'string' && v !== '') || typeof v === 'number' || typeof v === 'boolean') ? NONBLANK : UNKNOWN;
    }
    case 'idx': {
      const col = rowColumn(node, ctx);
      if (col) return env.written.has(col) ? env.written.get(col) : UNKNOWN;
      const obj = evaluate(node.obj, ctx, env), key = evaluate(node.key, ctx, env);
      if (isSym(obj) || isSym(key)) return UNKNOWN;
      if (obj === null) return null;
      if (typeof obj === 'object' && (typeof key === 'string' || typeof key === 'number')) return obj[key] === undefined ? null : obj[key];
      return UNKNOWN;
    }
    case 'call': break;
    default: return UNKNOWN;
  }
  const n = node.name.toLowerCase();
  const args = () => node.args.map((a) => evaluate(a, ctx, env));
  if (NONBLANK_FNS.has(n)) return NONBLANK;
  switch (n) {
    case 'equals': { const [a, b] = args(); return eq(a, b); }
    case 'not': { const [a] = args(); return typeof a === 'boolean' ? !a : UNKNOWN; }
    case 'and': { const v = args(); if (v.some((x) => x === false)) return false; return v.every((x) => x === true) ? true : UNKNOWN; }
    case 'or': { const v = args(); if (v.some((x) => x === true)) return true; return v.every((x) => x === false) ? false : UNKNOWN; }
    case 'coalesce': {
      for (const v of args()) { if (v === null) continue; return v; }
      return null;
    }
    case 'empty': { const [a] = args(); if (a === NONBLANK) return false; if (a === UNKNOWN) return UNKNOWN;
      return isBlank(a) || (a && typeof a === 'object' && Object.keys(a).length === 0); }
    case 'if': { const [c, a, b] = args(); if (c === true) return a; if (c === false) return b; return !isSym(a) && eq(a, b) === true ? a : UNKNOWN; }
    case 'greater': case 'less': case 'greaterorequals': case 'lessorequals': {
      const [a, b] = args();
      if (typeof a !== 'number' || typeof b !== 'number') return UNKNOWN;
      return n === 'greater' ? a > b : n === 'less' ? a < b : n === 'greaterorequals' ? a >= b : a <= b;
    }
    case 'string': { const [a] = args(); if (a === NONBLANK) return NONBLANK; if (a === UNKNOWN) return UNKNOWN;
      return a === null ? '' : typeof a === 'object' ? JSON.stringify(a) : String(a); }
    case 'concat': {
      const v = args();
      if (v.every((x) => !isSym(x))) return v.map((x) => (x === null ? '' : String(x))).join('');
      return v.some((x) => x === NONBLANK || (typeof x === 'string' && x !== '')) ? NONBLANK : UNKNOWN;
    }
    case 'tolower': case 'toupper': { const [a] = args(); if (a === NONBLANK) return NONBLANK;
      return typeof a === 'string' ? (n === 'tolower' ? a.toLowerCase() : a.toUpperCase()) : UNKNOWN; }
    case 'trim': { const [a] = args(); return typeof a === 'string' ? a.trim() : UNKNOWN; }
    case 'length': { const [a] = args(); return typeof a === 'string' || Array.isArray(a) ? a.length : UNKNOWN; }
    case 'int': case 'float': { const [a] = args(); const x = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN;
      return Number.isNaN(x) ? UNKNOWN : n === 'int' ? Math.trunc(x) : x; }
    case 'bool': { const [a] = args(); if (typeof a === 'boolean') return a; if (typeof a === 'number') return a !== 0;
      if (typeof a === 'string' && /^(true|false)$/i.test(a)) return a.toLowerCase() === 'true'; return UNKNOWN; }
    case 'contains': { const [a, b] = args(); if (isSym(a) || isSym(b) || a === null) return UNKNOWN;
      if (typeof a === 'string' && typeof b === 'string') return a.includes(b) ? true : a.toLowerCase().includes(b.toLowerCase()) ? UNKNOWN : false;
      if (Array.isArray(a)) return a.some((x) => eq(x, b) === true) ? true : a.every((x) => eq(x, b) === false) ? false : UNKNOWN;
      return UNKNOWN; }
    default: return UNKNOWN;
  }
}

function flattenAnd(node) {
  if (node && node.t === 'call' && node.name.toLowerCase() === 'and') return node.args.flatMap(flattenAnd);
  return [node];
}
const show = (v) => (v === NONBLANK ? '<a non-blank value>' : v === UNKNOWN ? '<a value read at run time>' : JSON.stringify(v));

// The facts the analysis needs about the flow: which actions re-read the trigger row, which
// loops walk the trigger table, and the expressions held by Compose actions and variables.
function flowContext(flow, t) {
  const ctx = { rowActions: new Set(), rowLoops: new Set(), composes: new Map(), vars: new Map() };
  const sets = new Map();
  const lists = new Set();
  walk(flow.def.actions, (n, a) => {
    const op = a.inputs && a.inputs.host && a.inputs.host.operationId;
    const p = (a.inputs && a.inputs.parameters) || {};
    if (op === 'GetItem' && sameTable(t.table, p.entityName)) ctx.rowActions.add(n);
    if (op === 'ListRecords' && sameTable(t.table, p.entityName)) lists.add(n);
    if (a.type === 'Compose') ctx.composes.set(n, parseValue(a.inputs));
    if (a.type === 'InitializeVariable') for (const v of (a.inputs && a.inputs.variables) || []) {
      const k = String(v.name); const s = sets.get(k) || { init: undefined, n: 0 };
      s.init = 'value' in v ? v.value : undefined; sets.set(k, s);
    }
    if (/^(SetVariable|IncrementVariable|DecrementVariable|AppendToStringVariable|AppendToArrayVariable)$/.test(a.type || '')) {
      const k = String(a.inputs && a.inputs.name); const s = sets.get(k) || { init: undefined, n: 0 };
      s.n++; s.last = a.type === 'SetVariable' ? a.inputs.value : undefined; s.other = s.other || a.type !== 'SetVariable'; sets.set(k, s);
    }
  });
  for (const [k, s] of sets) {
    if (s.other) continue;
    if (s.n === 0 && s.init !== undefined) ctx.vars.set(k, parseValue(s.init));
    else if (s.n === 1 && s.init === undefined && s.last !== undefined) ctx.vars.set(k, parseValue(s.last));
  }
  walk(flow.def.actions, (n, a) => {
    if (a.type !== 'Foreach') return;
    const src = typeof a.foreach === 'string' ? a.foreach : '';
    if ([...lists].some((l) => src.includes(`outputs('${l}')`) || src.includes(`body('${l}')`))) ctx.rowLoops.add(n);
  });
  return ctx;
}

// The conditions that must all have been true for this action to run, as expressions.
function pathConstraints(flow, t, target) {
  const found = [];
  const visit = (scope, path) => {
    for (const [n, a] of Object.entries(scope || {})) {
      if (n === target) { found.push(path); return true; }
      const branches = [];
      if (a.type === 'If') {
        const cond = conditionAst(a.expression);
        if (a.actions) branches.push([a.actions, { ast: cond, from: `If '${n}' (yes branch)` }]);
        if (a.else && a.else.actions) branches.push([a.else.actions, { ast: { t: 'call', name: 'not', args: [cond] }, from: `If '${n}' (no branch)` }]);
      } else if (a.type === 'Switch') {
        const on = parseValue(a.expression);
        const cases = Object.entries(a.cases || {});
        for (const [cn, c] of cases) if (c.actions) branches.push([c.actions, { ast: { t: 'call', name: 'equals', args: [on, { t: 'lit', v: c.case }] }, from: `Switch '${n}' case '${cn}'` }]);
        if (a.default && a.default.actions) branches.push([a.default.actions, { ast: { t: 'call', name: 'and',
          args: cases.map(([, c]) => ({ t: 'call', name: 'not', args: [{ t: 'call', name: 'equals', args: [on, { t: 'lit', v: c.case }] }] })) }, from: `Switch '${n}' default` }]);
      } else if (a.actions) branches.push([a.actions, null]);
      for (const [s, c] of branches) if (visit(s, c ? [...path, c] : path)) return true;
    }
    return false;
  };
  const trig = (t.conditions || []).map((c, i) => ({ ast: parseValue(c && typeof c === 'object' ? c.expression : c), from: `trigger condition ${i + 1}` }));
  visit(flow.def.actions, []);
  return [...trig, ...(found[0] || [])];
}

// Decide whether a self-write is guarded: some condition on its path must read a column the
// write changes AND evaluate to false once the written values are in the row.
function writtenValues(flow, actionName, ctx) {
  let act = null;
  walk(flow.def.actions, (n, a) => { if (n === actionName) act = a; });
  const p = (act && act.inputs && act.inputs.parameters) || {};
  const written = new Map();
  for (const [k, v] of Object.entries(p)) if (k.startsWith('item/')) written.set(k.slice(5).toLowerCase(), evaluate(substitute(parseValue(v), ctx), ctx, { written: new Map() }));
  return written;
}

export function selfWriteVerdict(flow, t, actionName, ctx = flowContext(flow, t)) {
  const written = writtenValues(flow, actionName, ctx);
  const conjuncts = pathConstraints(flow, t, actionName).flatMap((c) => flattenAnd(substitute(c.ast, ctx)).map((ast) => ({ ast, from: c.from })));
  const unparsed = conjuncts.filter((c) => c.ast && c.ast.t === 'unknown');
  const relevant = conjuncts.filter((c) => [...readsColumns(c.ast, ctx)].some((col) => written.has(col)));
  const falseUnder = (env) => relevant.find((c) => evaluate(c.ast, ctx, env) === false);
  const hit = falseUnder({ written });
  if (hit) return { verdict: 'guarded', by: hit.from, written, relevant, unparsed };
  // A value read at run time could be blank; say so if the guard holds only when it is not.
  const assumed = new Map([...written].map(([k, v]) => [k, v === UNKNOWN ? NONBLANK : v]));
  const hit2 = falseUnder({ written: assumed });
  if (hit2) return { verdict: 'assumes-nonblank', by: hit2.from, written, relevant, unparsed };
  return { verdict: relevant.length ? 'stays-true' : 'unread', written, relevant, unparsed };
}

// Which trigger condition, if any, is definitely FALSE once this action's written values are in
// the row? Only a trigger condition stops the retrigger from starting a run; an If inside the
// flow does not (the run starts, then skips). Returns the condition's label, or null.
export function triggerConditionGuard(flow, t, actionName, ctx = flowContext(flow, t)) {
  const written = writtenValues(flow, actionName, ctx);
  const conds = (t.conditions || []).map((c, i) => ({ ast: parseValue(c && typeof c === 'object' ? c.expression : c), from: `trigger condition ${i + 1}` }));
  for (const c of conds) {
    const parts = flattenAnd(substitute(c.ast, ctx));
    if (parts.some((ast) => [...readsColumns(ast, ctx)].some((col) => written.has(col)) && evaluate(ast, ctx, { written }) === false)) return c.from;
  }
  return null;
}

function checkSelfWrite(flow, t, add) {
  if (!t.isDataverse || !t.table) return;
  const ctx = flowContext(flow, t);
  const writes = [];
  walk(flow.def.actions, (n, a) => {
    const op = a.inputs && a.inputs.host && a.inputs.host.operationId;
    const p = (a.inputs && a.inputs.parameters) || {};
    if (op === 'UpdateRecord' && sameTable(t.table, p.entityName)) {
      writes.push({ n, cols: Object.keys(p).filter((k) => k.startsWith('item/')).map((k) => k.slice(5).toLowerCase().replace(/@odata\.bind$/, '')) });
    }
  });
  const filterCols = t.filtering ? String(t.filtering).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean) : null;
  for (const w of writes) {
    // An update cannot start a trigger that does not fire on Update (Create-only, Delete-only) -
    // unless the trigger's NAME says Update, when the message code is the likelier mistake
    // (trigger-message-mismatch) and the write is checked as if it fired.
    const namedUpdate = /updat|modif|chang|edit/.test(String(t.tname || '').toLowerCase());
    if (!FIRES.update.has(Number(t.message)) && !namedUpdate) {
      add('info', 'self-write-not-fired', `'${w.n}' updates the trigger table ${t.table}, but the trigger fires on ` +
        `${MESSAGE[Number(t.message)] || 'message ' + t.message} only, so an update cannot start it.`);
      continue;
    }
    // Dataverse starts a filtered Update trigger only when the update carries a listed column; a
    // write of unlisted columns only (a processed-on stamp, a mirror id) cannot start it.
    if (filterCols && !w.cols.some((c) => filterCols.includes(c))) {
      add('info', 'self-write-outside-filter', `'${w.n}' updates the trigger table ${t.table} (${w.cols.join(', ') || 'no columns'}), ` +
        `none of them in filteringattributes (${filterCols.join(', ')}), so the write cannot start this trigger. Keep those columns out of the list.`);
      continue;
    }
    const v = selfWriteVerdict(flow, t, w.n, ctx);
    const vals = [...v.written].map(([c, x]) => `${c} = ${show(x)}`).join(', ') || 'none';
    const note = v.unparsed.length ? ` (${v.unparsed.length} condition(s) could not be parsed and were treated as unknown: ${v.unparsed[0].from})` : '';
    if (v.verdict === 'unread') {
      add('error', 'self-trigger-loop', `'${w.n}' updates the trigger table ${t.table} (columns: ${w.cols.join(', ') || 'none'}) ` +
        `but no enclosing condition or trigger condition reads any column it writes. The update trigger delivers the WHOLE row, ` +
        `so the same condition is true on the next pass: a runaway loop. Guard on a value this write changes (e.g. locked <> true).` + note);
    } else if (v.verdict === 'stays-true') {
      add('error', 'self-trigger-loop', `'${w.n}' updates the trigger table ${t.table} (${vals}). ${v.relevant.map((c) => c.from).join(', ')} ` +
        `reads a written column, but cannot be shown FALSE once the write lands - it stays true (or depends on something else), so the ` +
        `next pass takes the same path: a runaway loop. Compare the column so the written value fails the test, e.g. ` +
        `not(equals(coalesce(col, false), true)) before setting col = true.` + note);
    } else if (v.verdict === 'assumes-nonblank') {
      add('warn', 'self-write-guard-assumes-value', `'${w.n}' is guarded by ${v.by} only if the value it writes is never blank (${vals}). ` +
        `If that value can be null or '' at run time, the write leaves the guard true and the flow retriggers itself. Make the written ` +
        `value non-blank (coalesce it with a marker), or skip the write when it is blank.`);
    }
    if (t.filtering && w.cols.some((c) => String(t.filtering).toLowerCase().split(',').map((s) => s.trim()).includes(c))) {
      const by = triggerConditionGuard(flow, t, w.n, ctx);
      if (by) add('info', 'writes-filtered-column-guarded', `'${w.n}' writes a column listed in the trigger's filteringattributes, so the ` +
        `trigger still fires on its own write (it counts toward trigger evaluations), but ${by} is false once the written values are ` +
        `in the row, so no run starts.`);
      else add('error', 'writes-filtered-column', `'${w.n}' writes a column listed in the trigger's filteringattributes - it retriggers itself. ` +
        `Only a trigger condition that is false once the write lands stops the run; an If inside the flow does not.`);
    }
  }
  return writes;
}

// An apostrophe inside a single-quoted literal ends it early; the tell is reaching the next
// "@{" while still hunting for this segment's "}" - interpolation cannot nest.
export function unterminatedInterpolations(s) {
  const bad = [];
  let i = s.indexOf('@{');
  while (i !== -1) {
    let j = i + 2, inQ = false, closed = -1;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (ch === "'") { if (inQ && s[j + 1] === "'") { j++; continue; } inQ = !inQ; continue; }
      if (!inQ && s.startsWith('@{', j)) break;
      if (!inQ && ch === '}') { closed = j; break; }
    }
    if (closed === -1) bad.push(s.slice(i, Math.min(s.length, i + 90)));
    i = s.indexOf('@{', closed === -1 ? i + 2 : closed + 1);
  }
  return bad;
}

function checkApostrophes(flow, add) {
  walk(flow.def.actions, (n, a) => {
    for (const s of stringsIn(JSON.parse(ownJson(a)))) {
      for (const seg of unterminatedInterpolations(s)) {
        add('error', 'apostrophe-in-literal', `'${n}': interpolation segment never closes - usually an apostrophe inside a ` +
          `single-quoted literal ("team's"). Reword rather than doubling the quote. Starts: ${seg}`);
      }
    }
  });
}

// An action may read only: its transitive runAfter closure in its own scope, everything nested
// inside those, and what the enclosing scope inherited. Anything else is rejected at activation.
function scopeErrors(scope, inherited, add) {
  const names = Object.keys(scope);
  const visible = {};
  const closure = (n, seen = new Set()) => {
    for (const p of Object.keys((scope[n] && scope[n].runAfter) || {})) {
      if (seen.has(p) || !scope[p]) continue;
      seen.add(p); closure(p, seen);
    }
    return seen;
  };
  for (const n of names) {
    const v = new Set(inherited);
    for (const p of closure(n)) { v.add(p); descendants(scope[p]).forEach((d) => v.add(d)); }
    visible[n] = v;
    for (const m of ownJson(scope[n]).matchAll(READ_FNS)) {
      const target = m[2];
      if (!v.has(target) && target !== n) {
        const own = descendants(scope[n]).has(target);
        add('error', 'not-on-runafter-path', `'${n}' reads ${m[1]}('${target}') but '${target}' is ` +
          (own ? 'nested INSIDE it - circular, it can never run.' : 'not on its runAfter path. Rejected at activation (InvalidTemplate).'));
      }
    }
    // Children may also name the enclosing action itself - items('Loop') inside a Foreach.
    const inner = new Set(v); inner.add(n);
    for (const s of childScopes(scope[n])) scopeErrors(s, inner, add);
  }
}

function checkSends(flow, add) {
  walk(flow.def.actions, (n, a, trail) => {
    const scope = trail.length ? childScopes(trail[trail.length - 1].act).find((s) => s[n]) : flow.def.actions;
    for (const [pred, states] of Object.entries(a.runAfter || {})) {
      const p = scope && scope[pred];
      const op = p && p.inputs && p.inputs.host && p.inputs.host.operationId;
      if (op && SEND_OPS.test(op) && states.map((x) => x.toLowerCase()).includes('failed')) {
        add('warn', 'send-after-failed', `'${n}' runs after '${pred}' (${op}) has Failed - a failed send no longer fails the run, ` +
          `so history stays green. Make independent channels parallel siblings, or surface the failure explicitly.`);
      }
    }
    if (a.type === 'Until') add('warn', 'until-loop', `'${n}' is an Until loop - confirm why it terminates.`);
  });
}

// A leading '@' in a property NAME is evaluated as an expression too. "@odata.type" (GrantAccess,
// PerformBoundAction bodies) passes pack and import and is refused at activation; write "@@odata.type".
function checkAtPropertyNames(flow, add) {
  const visit = (v, where) => {
    if (Array.isArray(v)) { v.forEach((x) => visit(x, where)); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('@') && !k.startsWith('@@')) {
        add('error', 'at-property-name', `${where}: property name "${k}" starts with a single '@', which the runtime evaluates as an ` +
          `expression - activation fails ("Unable to parse template language expression"). Write "@${k}"; it renders as one '@'.`);
      }
      visit(x, where);
    }
  };
  for (const [n, t] of Object.entries(flow.def.triggers || {})) visit(t, `trigger '${n}'`);
  walk(flow.def.actions, (n, a) => visit(JSON.parse(ownJson(a)), `'${n}'`));
}

// A flow built from connector operations may declare exactly one trigger; more is refused at activation.
function checkTriggerCount(flow, add) {
  const names = Object.keys(flow.def.triggers || {});
  if (names.length <= 1) return;
  const usesConnector = /"type"\s*:\s*"OpenApiConnection/.test(JSON.stringify(flow.def));
  add(usesConnector ? 'error' : 'warn', 'multiple-triggers', `the flow declares ${names.length} triggers (${names.join(', ')}). ` +
    (usesConnector ? 'A flow with Open Api Connection operations supports exactly one - it packs and imports, then is refused at activation. Split it.'
                   : 'Confirm the runtime accepts this; a flow using connector operations may have only one.'));
}

// A date-only column reads as midnight: inside ticks()/addMinutes() or compared with utcNow()/modifiedon
// it makes "changed after X" true from the moment X was stamped. Needs the list of date-only columns.
const INSTANT = /\b(ticks|addMinutes|addHours|addSeconds|dateDifference|utcNow)\s*\(|\b(modifiedon|createdon)\b/i;
function checkDateOnly(flow, cols, add) {
  if (!cols || cols.size === 0) return;
  const scan = (strs, where) => {
    for (const s of strs) {
      if (!INSTANT.test(s)) continue;
      const hit = [...colTokens(s)].filter((c) => cols.has(c));
      if (hit.length) add('error', 'date-only-as-instant', `${where}: date-only column ${hit.join(', ')} is used with a time-of-day ` +
        `operation (ticks, add*, utcNow, modifiedon/createdon). A date-only value is midnight, so the comparison is wrong by up to a day. ` +
        `Use a date-time stamp, or the createdon of the row that recorded the event.`);
    }
  };
  for (const [n, t] of Object.entries(flow.def.triggers || {})) scan(stringsIn(t.conditions || []), `trigger '${n}' condition`);
  walk(flow.def.actions, (n, a) => scan(stringsIn(JSON.parse(ownJson(a))), `'${n}'`));
}

// Informational (shown with --verbose): who the sender appears to be, and how many actions start the flow.
function checkShapeNotes(flow, add) {
  walk(flow.def.actions, (n, a) => {
    const op = a.inputs && a.inputs.host && a.inputs.host.operationId;
    if (op && /^SendEmail(V\d)?$/i.test(op)) add('info', 'send-as-owner', `'${n}' (${op}) sends as the connection owner. ` +
      `A shared-mailbox send (SharedMailboxSendEmailV2) with the address read from a setting keeps the sender off a person.`);
  });
  const roots = Object.entries(flow.def.actions || {}).filter(([, a]) => !a.runAfter || Object.keys(a.runAfter).length === 0).map(([n]) => n);
  if (roots.length > 1) add('info', 'multiple-root-actions', `${roots.length} actions start the flow (${roots.join(', ')}). Legal, but ` +
    `"what starts this flow" becomes ambiguous for every later tool; chain them.`);
}

function checkEntitySets(flow, sets, add) {
  if (!sets) return;
  walk(flow.def.actions, (n, a) => {
    const p = (a.inputs && a.inputs.parameters) || {};
    if (typeof p.entityName === 'string' && !p.entityName.startsWith('@') && !sets.has(p.entityName.toLowerCase())) {
      add('error', 'unknown-entity-set', `'${n}' uses entityName '${p.entityName}', which is not a known entity set. Dataverse ` +
        `pluralises irregularly; a guessed name fails at RUN time ("Resource not found for the segment"). Resolve it from metadata.`);
    }
  });
}

// ---------- loop rules across ALL flows: the trigger graph ----------
// A loop is any cycle of "this write starts that flow". A per-flow guard sees only self-writes; a
// cycle through two flows on the same table, a Create-triggered flow that creates its own rows, or
// a scheduled job that flips a row between two values that each start a flow, are all invisible to
// it. So every Dataverse write in every flow is an edge to every flow its write can START, unless
// that flow's TRIGGER CONDITION is provably false for every value the write can put in the row.
// Only a trigger condition counts: an If inside the target still lets the run start.
const FIRES = { create: new Set([1, 4, 5, 7]), update: new Set([3, 4, 6, 7]), delete: new Set([2, 5, 6, 7]) };

// The literal values an expression can produce: if(c, a, b) -> values of a and b; coalesce
// likewise; anything else is evaluated (UNKNOWN when it depends on run time).
function leaves(node, ctx, depth = 0) {
  if (!node || depth > 6) return [UNKNOWN];
  node = substitute(node, ctx);
  if (node.t === 'lit') return [node.v];
  if (node.t === 'call') {
    const n = node.name.toLowerCase();
    if (n === 'if' && node.args.length === 3) return [...leaves(node.args[1], ctx, depth + 1), ...leaves(node.args[2], ctx, depth + 1)];
    if (n === 'coalesce') return node.args.flatMap((a) => leaves(a, ctx, depth + 1));
  }
  return [evaluate(node, ctx, { written: new Map() })];
}
const keyOf = (v) => (v === UNKNOWN ? '<run-time value>' : v === NONBLANK ? '<non-blank>' : JSON.stringify(v));

function writesOf(flow, ctx) {
  const out = [];
  walk(flow.def.actions, (n, a) => {
    const op = a.inputs && a.inputs.host && a.inputs.host.operationId;
    const p = (a.inputs && a.inputs.parameters) || {};
    const kind = op === 'CreateRecord' ? 'create' : (op === 'UpdateRecord' || op === 'UpdateOnlyRecord') ? 'update'
               : op === 'DeleteRecord' ? 'delete' : op === 'UpsertRecord' ? 'upsert' : null;
    if (!kind || typeof p.entityName !== 'string') return;
    const cols = new Map();
    for (const [k, v] of Object.entries(p)) if (k.startsWith('item/')) cols.set(k.slice(5).toLowerCase().replace(/@odata\.bind$/, ''), leaves(parseValue(v), ctx));
    out.push({ action: n, kind, table: p.entityName, cols });
  });
  return out;
}

// Can this write start flow B, and is that start blocked by B's trigger condition for EVERY
// combination of the values the write can land? Returns {fires, blocked, rearming}.
function edge(write, B) {
  const t = B.t;
  if (!t.isDataverse || !t.table || !sameTable(t.table, write.table)) return { fires: false };
  const code = Number(t.message);
  const kinds = write.kind === 'upsert' ? ['create', 'update'] : [write.kind];
  if (!kinds.some((k) => FIRES[k].has(code))) return { fires: false };
  if (write.kind === 'update' && t.filtering) {
    const f = String(t.filtering).toLowerCase().split(',').map((s) => s.trim());
    if (![...write.cols.keys()].some((c) => f.includes(c))) return { fires: false };
  }
  const conds = (t.conditions || []).map((c) => flattenAnd(substitute(parseValue(c && typeof c === 'object' ? c.expression : c), B.ctx)));
  const read = new Set(conds.flat().flatMap((ast) => [...readsColumns(ast, B.ctx)]));
  let combos = [new Map()];
  for (const [c, vals] of write.cols) {
    if (!read.has(c)) continue;
    const next = [];
    for (const m of combos) for (const v of new Set(vals)) { const m2 = new Map(m); m2.set(c, v); next.push(m2); }
    combos = next.slice(0, 256);
  }
  const rearming = combos.filter((env) => !conds.some((parts) => parts.some((ast) => evaluate(ast, B.ctx, { written: env }) === false)));
  return { fires: true, blocked: rearming.length === 0, rearming };
}

function checkTriggerGraph(flows) {
  const nodes = flows.map((f) => { const t = triggerInfo(f.def); const ctx = flowContext(f, t); return { name: f.name, t, ctx, writes: writesOf(f, ctx) }; });
  const findings = [];
  const adj = new Map(nodes.map((n) => [n.name, []]));
  for (const A of nodes) for (const w of A.writes) for (const B of nodes) {
    const e = edge(w, B);
    if (!e.fires) continue;
    // Alternating re-arm: one write that can land TWO different values which each start B. Run
    // again (by a schedule, by B, by anything) it flips the row between them and B starts on every
    // flip, forever, whenever B does not move the row on (B off, a failing run, a lost event).
    const byCol = new Map();
    for (const env of e.rearming) for (const [c, v] of env) {
      if (v === UNKNOWN) continue;
      if (!byCol.has(c)) byCol.set(c, new Set());
      byCol.get(c).add(keyOf(v));
    }
    for (const [c, vals] of byCol) if (vals.size > 1) {
      findings.push({ level: 'error', code: 'alternating-rearm', flow: A.name, msg: `'${w.action}' can write ${c} = ${[...vals].join(' or ')}, and ` +
        `EACH of those values starts '${B.name}'. Writing between two re-arming values is a slow infinite loop whenever '${B.name}' ` +
        `does not move the row out of that state (flow off, a failing run, a lost trigger event). Make the repeat attempt write a ` +
        `TERMINAL value no trigger accepts (e.g. Failed), so a person re-arms it.` });
    }
    if (e.blocked) continue;
    if (A === B && w.kind === 'update') continue; // self-update: checkSelfWrite decides it, with path guards
    adj.get(A.name).push({ to: B.name, via: w.action, kind: w.kind });
  }
  // Cycles (Tarjan SCC): a strongly connected set of 2+ flows, or a flow with an edge to itself.
  let idx = 0; const st = [], on = new Set(), index = new Map(), low = new Map(), sccs = [];
  const strong = (v) => {
    index.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
    for (const e of adj.get(v)) {
      if (!index.has(e.to)) { strong(e.to); low.set(v, Math.min(low.get(v), low.get(e.to))); }
      else if (on.has(e.to)) low.set(v, Math.min(low.get(v), index.get(e.to)));
    }
    if (low.get(v) === index.get(v)) { const c = []; let x; do { x = st.pop(); on.delete(x); c.push(x); } while (x !== v); sccs.push(c); }
  };
  for (const n of adj.keys()) if (!index.has(n)) strong(n);
  for (const c of sccs) {
    const set = new Set(c);
    const inner = c.flatMap((a) => adj.get(a).filter((e) => set.has(e.to)).map((e) => `'${a}' --${e.kind} '${e.via}'--> '${e.to}'`));
    if (c.length > 1 || inner.length) findings.push({ level: 'error', code: 'trigger-cycle', flow: c.join(' + '),
      msg: `these writes can start each other in a cycle: ${inner.join('; ')}. No trigger condition on the cycle is provably false ` +
        `for the values written, so one event can run forever. Break it with a trigger condition the written value fails ` +
        `(a status the write moves past, a processed flag), or narrow filteringattributes so the write does not fire the trigger.` });
  }
  return { findings, edges: [...adj].flatMap(([a, es]) => es.map((e) => ({ from: a, ...e }))) };
}

// Every Update trigger must name its columns. Without filteringattributes the flow starts on ANY
// change to the row - other flows' writes and its own - so every write to that table anywhere is a
// potential loop edge, and every one costs a run.
function checkUpdateFilter(t, add) {
  if (!t.isDataverse || !FIRES.update.has(Number(t.message))) return;
  if (!t.filtering || !String(t.filtering).trim()) add('error', 'update-trigger-unfiltered', `trigger '${t.tname}' fires on Update of ` +
    `${t.table} with no filteringattributes, so ANY write to the row starts it - other flows' writes and its own. List the columns ` +
    `whose change means "do the work" (subscriptionRequest/filteringattributes), and keep a trigger condition as well.`);
}

// --require-safe-recipients: every address a message can go to is the output of a Compose named
// Safe_to_<x>, built as if(outputs('Is_live'), <real>, outputs('Allowlist')) (or '' for a
// channel), and no HTTP action exists (it can reach anything). "In test, only the allowlist is
// ever addressed" becomes a property of the source, not of reviewer attention.
const MESSAGING = /^shared_(office365|office365users|outlook|teams|sendmail|smtp|sendgrid|twilio|approvals|outlookgroups)/i;
const RECIPIENT_KEY = /(^|\/)(to|cc|bcc|replyto|recipient|recipients|assignedto|groupid|channelid|emailaddress|mailto|phonenumber)$/i;
const isOutputs = (n, name) => n && n.t === 'call' && n.name.toLowerCase() === 'outputs' && n.args.length === 1 && n.args[0].t === 'lit' && n.args[0].v === name;
// Every value the test branch can produce is the allowlist or ''; nested if() is followed into both arms.
function testOnly(n) {
  if (n && n.t === 'lit') return n.v === '' || n.v === null;
  if (isOutputs(n, 'Allowlist')) return true;
  if (n && n.t === 'call' && n.name.toLowerCase() === 'if' && n.args.length === 3) return testOnly(n.args[1]) && testOnly(n.args[2]);
  return false;
}
function safeShape(n) {
  return !!n && n.t === 'call' && n.name.toLowerCase() === 'if' && n.args.length === 3 && isOutputs(n.args[0], 'Is_live') && testOnly(n.args[2]);
}
function checkSafeRecipients(flow, add) {
  const composes = new Map();
  walk(flow.def.actions, (n, a) => { if (a.type === 'Compose') composes.set(n, typeof a.inputs === 'string' ? a.inputs : JSON.stringify(a.inputs)); });
  let sends = false;
  walk(flow.def.actions, (n, a) => {
    if (/^Http/i.test(a.type || '')) add('error', 'unsafe-http', `'${n}' is an HTTP action; under --require-safe-recipients nothing may call ` +
      `out except a messaging connector whose recipients are Safe_to_ composes.`);
    const h = (a.inputs && a.inputs.host) || {};
    const conn = String(h.connectionName || h.apiId || '').split('/').pop();
    if (!MESSAGING.test(conn) && !(h.operationId && SEND_OPS.test(h.operationId))) return;
    sends = true;
    const p = (a.inputs && a.inputs.parameters) || {};
    for (const [k, v] of Object.entries(p)) {
      if (!RECIPIENT_KEY.test(k) || v === '' || v === null) continue;
      const m = typeof v === 'string' && /^@outputs\('(Safe_to_[A-Za-z0-9_]+)'\)$/.exec(v.trim());
      if (!m) { add('error', 'unsafe-recipient', `'${n}' parameter ${k} = ${JSON.stringify(v).slice(0, 120)} - a recipient must be exactly ` +
        `@outputs('Safe_to_<x>'), so test mode can only ever address the allowlist.`); continue; }
      const src = composes.get(m[1]);
      if (!src) add('error', 'unsafe-recipient', `'${n}' uses ${m[1]}, which is not a Compose in this flow.`);
      else if (!safeShape(parseValue(src)))
        add('error', 'unsafe-recipient', `${m[1]} is not if(outputs('Is_live'), <real>, <test>) with a test branch that can only be ` +
          `outputs('Allowlist') or '': ${src.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  });
  if (sends && !composes.has('Is_live')) add('error', 'unsafe-recipient', `the flow sends messages but has no Compose named Is_live.`);
}

export function lint(flows, { entitySets = null, dateOnly = null, safeRecipients = false } = {}) {
  const results = [];
  for (const flow of flows) {
    const items = [];
    const add = (level, code, msg) => items.push({ level, code, msg });
    const t = triggerInfo(flow.def);
    checkRuntimeSource(flow, t, add);
    checkMessageCode(t, add);
    checkUpdateFilter(t, add);
    checkSelfWrite(flow, t, add);
    if (safeRecipients) checkSafeRecipients(flow, add);
    checkApostrophes(flow, add);
    scopeErrors(flow.def.actions || {}, new Set(), add);
    checkSends(flow, add);
    checkEntitySets(flow, entitySets, add);
    checkAtPropertyNames(flow, add);
    checkTriggerCount(flow, add);
    checkDateOnly(flow, dateOnly, add);
    checkShapeNotes(flow, add);
    results.push({ file: flow.file, flow: flow.name, items });
  }
  // Loops across flows (and Create and re-arm loops within one): the trigger graph.
  const graph = checkTriggerGraph(flows);
  const cycles = graph.findings.map((f) => `${f.code} [${f.flow}]: ${f.msg}`);
  return { results, cycles, edges: graph.edges };
}

// ---------- self-test ----------
function fixture(bad) {
  const cr = { shared_commondataserviceforapps: { runtimeSource: bad ? 'invoker' : 'embedded', connection: { connectionReferenceLogicalName: 'app_cds' }, api: { name: 'shared_commondataserviceforapps' } } };
  const host = (op) => ({ apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps', connectionName: 'shared_commondataserviceforapps', operationId: op });
  return {
    file: bad ? 'bad.json' : 'good.json', name: bad ? 'bad' : 'good', refs: cr,
    def: {
      triggers: {
        When_a_request_is_updated: { type: 'OpenApiConnectionWebhook', inputs: { host: host('SubscribeWebhookTrigger'),
          parameters: { 'subscriptionRequest/message': bad ? 2 : 3, 'subscriptionRequest/entityname': 'app_request', 'subscriptionRequest/scope': 4,
            ...(bad ? {} : { 'subscriptionRequest/filteringattributes': 'app_status' }) } } },
        ...(bad ? { Every_morning: { type: 'Recurrence', recurrence: { frequency: 'Day', interval: 1 } } } : {}),
      },
      actions: {
        Get_the_request: { type: 'OpenApiConnection', runAfter: {}, inputs: { host: host('GetItem'), parameters: { entityName: 'app_requests', recordId: "@triggerOutputs()?['body/app_requestid']" } } },
        // Date-only column (app_approvedon) used as an instant in bad; a date-time stamp (app_approvedat) in good.
        Minutes_since_approval: { type: 'Compose', runAfter: { Get_the_request: ['Succeeded'] },
          inputs: `@div(sub(ticks(outputs('Get_the_request')?['body/modifiedon']), ticks(outputs('Get_the_request')?['body/${bad ? 'app_approvedon' : 'app_approvedat'}'])), 600000000)` },
        // GrantAccess body: a single-'@' key is refused at activation; '@@' is the escape.
        Share_with_approver: { type: 'OpenApiConnection', runAfter: { Minutes_since_approval: ['Succeeded'] }, inputs: { host: host('PerformBoundAction'),
          parameters: { entityName: 'app_requests', actionName: 'GrantAccess', recordId: "@outputs('Get_the_request')?['body/app_requestid']",
            'item/PrincipalAccess': { [bad ? '@odata.type' : '@@odata.type']: 'Microsoft.Dynamics.CRM.PrincipalAccess', AccessMask: 'ReadAccess',
              Principal: { '@@odata.type': 'Microsoft.Dynamics.CRM.systemuser', systemuserid: "@outputs('Get_the_request')?['body/_app_approver_value']" } } } } },
        Only_when_submitted: {
          type: 'If', runAfter: { Share_with_approver: ['Succeeded'] },
          expression: { and: bad
            ? [{ equals: ["@outputs('Get_the_request')?['body/app_status']", 2] }, { equals: ["@outputs('Lock_it')?['statusCode']", 204] }]
            : [{ equals: ["@outputs('Get_the_request')?['body/app_status']", 2] }, { not: { equals: ["@outputs('Get_the_request')?['body/app_locked']", true] } }] },
          actions: {
            Send_an_email: { type: 'OpenApiConnection', runAfter: {}, inputs: { host: { operationId: bad ? 'SendEmailV2' : 'SharedMailboxSendEmailV2' },
              parameters: { 'emailMessage/Subject': bad ? "@{if(empty(x), 'Nothing is in the team's queue.', 'ok')}" : "@{if(empty(x), 'Nothing is in the queue for the team.', 'ok')}" } } },
            Post_to_Teams: { type: 'OpenApiConnection', runAfter: bad ? { Send_an_email: ['Succeeded', 'Failed'] } : {}, inputs: { host: { operationId: 'PostMessageToConversation' }, parameters: {} } },
            Lock_it: { type: 'OpenApiConnection', runAfter: { Send_an_email: ['Succeeded'] }, inputs: { host: host('UpdateRecord'),
              parameters: { entityName: 'app_requests', recordId: "@outputs('Get_the_request')?['body/app_requestid']", 'item/app_locked': true } } },
          },
        },
      },
    },
  };
}
// Guard shapes: a minimal update-triggered flow whose only self-write is wrapped as described.
function guardFixture(name, { conditions = [], wrap, write = { 'item/app_locked': true }, before = {}, message = 3, filtering = null, tname = 'When_a_request_is_updated' }) {
  const host = (op) => ({ connectionName: 'shared_commondataserviceforapps', operationId: op });
  const Lock_it = { type: 'OpenApiConnection', runAfter: {}, inputs: { host: host('UpdateRecord'),
    parameters: { entityName: 'app_requests', recordId: "@triggerOutputs()?['body/app_requestid']", ...write } } };
  const lastBefore = Object.keys(before).pop();
  const gate = wrap(Lock_it);
  gate.runAfter = lastBefore ? { [lastBefore]: ['Succeeded'] } : {};
  return { file: name + '.json', name, refs: {}, def: {
    triggers: { [tname]: { type: 'OpenApiConnectionWebhook', conditions,
      inputs: { host: host('SubscribeWebhookTrigger'), parameters: { 'subscriptionRequest/message': message, 'subscriptionRequest/entityname': 'app_request', 'subscriptionRequest/scope': 4,
        ...(filtering ? { 'subscriptionRequest/filteringattributes': filtering } : {}) } } } },
    actions: { ...before, Gate: gate } } };
}
const ifYes = (expression) => (w) => ({ type: 'If', expression, actions: { Lock_it: w } });
const GUARD_CASES = [
  // [name, fixture options, expected verdict code or null for "no self-write finding"]
  ['guarded-not-equals', { wrap: ifYes({ not: { equals: ["@triggerOutputs()?['body/app_locked']", true] } }) }, null],
  ['guarded-via-coalesce', { wrap: ifYes("@not(equals(coalesce(triggerOutputs()?['body/app_locked'], false), true))") }, null],
  ['guarded-via-compose', { before: { Is_it_locked: { type: 'Compose', runAfter: {}, inputs: "@coalesce(triggerBody()?['app_locked'], false)" } },
    wrap: ifYes({ equals: ["@outputs('Is_it_locked')", false] }) }, null],
  ['guarded-via-variable', { before: { Locked_now: { type: 'InitializeVariable', runAfter: {}, inputs: { variables: [{ name: 'lockedNow', type: 'boolean', value: "@triggerOutputs()?['body/app_locked']" }] } } },
    wrap: ifYes("@not(equals(variables('lockedNow'), true))") }, null],
  ['guarded-else-branch', { wrap: (w) => ({ type: 'If', expression: { equals: ["@triggerOutputs()?['body/app_locked']", true] }, actions: {}, else: { actions: { Lock_it: w } } }) }, null],
  ['guarded-trigger-condition', { conditions: [{ expression: "@not(equals(triggerBody()?['app_locked'], true))" }], wrap: (w) => ({ type: 'Scope', actions: { Lock_it: w } }) }, null],
  ['guarded-is-blank-interpolated', { write: { 'item/app_processedon': '@{utcNow()}' }, wrap: ifYes("@empty(triggerOutputs()?['body/app_processedon'])") }, null],
  ['guarded-switch-case', { write: { 'item/app_stage': 3 }, wrap: (w) => ({ type: 'Switch', expression: "@triggerOutputs()?['body/app_stage']", cases: { Two: { case: 2, actions: { Lock_it: w } } } }) }, null],
  ['unguarded-different-column', { wrap: ifYes({ not: { equals: ["@triggerOutputs()?['body/app_closed']", true] } }) }, 'self-trigger-loop'],
  ['unguarded-stays-true', { wrap: ifYes({ not: { equals: ["@triggerOutputs()?['body/app_locked']", false] } }) }, 'self-trigger-loop'],
  ['unguarded-or-escape', { wrap: ifYes("@or(not(equals(triggerOutputs()?['body/app_locked'], true)), equals(triggerOutputs()?['body/app_status'], 2))") }, 'self-trigger-loop'],
  ['unguarded-name-only', { wrap: ifYes("@equals(string(triggerOutputs()?['body/app_locked']), toLower(string(triggerOutputs()?['body/app_locked'])))") }, 'self-trigger-loop'],
  // Writes the trigger cannot see (found building a real mirror flow, 2026-10-02).
  ['create-trigger-update-self-write', { message: 1, tname: 'When_a_request_is_created', wrap: (w) => ({ type: 'Scope', actions: { Lock_it: w } }) }, null],
  ['filtered-write-outside-filter', { filtering: 'app_status,app_title', write: { 'item/app_mirroredon': '@{utcNow()}', 'item/app_mirrorid': "@body('Post')?['ID']" },
    wrap: (w) => ({ type: 'Scope', actions: { Lock_it: w } }) }, null],
  ['filtered-bind-outside-filter', { filtering: 'app_status', write: { 'item/app_owner@odata.bind': "app_people(@{body('Find')?['id']})" },
    wrap: (w) => ({ type: 'Scope', actions: { Lock_it: w } }) }, null],
  ['filtered-write-inside-filter', { filtering: 'app_status', write: { 'item/app_status': 2, 'item/app_mirroredon': '@{utcNow()}' },
    wrap: (w) => ({ type: 'Scope', actions: { Lock_it: w } }) }, 'self-trigger-loop'],
  ['create-or-update-trigger-still-checked', { message: 4, tname: 'When_a_request_is_added_or_updated', wrap: (w) => ({ type: 'Scope', actions: { Lock_it: w } }) }, 'self-trigger-loop'],
  ['assumes-nonblank-dynamic', { write: { 'item/app_rate': "@outputs('Find_rate')?['body/amount']" }, wrap: ifYes({ equals: ["@coalesce(triggerOutputs()?['body/app_rate'], '')", ''] }) }, 'self-write-guard-assumes-value'],
];

// Loop shapes across flows. Each case is a set of flows and the graph finding it must (or must not) raise.
function graphFlow(name, { message = 3, filtering, conditions = [], recurrence = false, actions }) {
  const host = (op) => ({ connectionName: 'shared_commondataserviceforapps', operationId: op });
  const trig = recurrence ? { Every_15_minutes: { type: 'Recurrence', recurrence: { frequency: 'Minute', interval: 15 } } }
    : { When_a_request_changes: { type: 'OpenApiConnectionWebhook', conditions, inputs: { host: host('SubscribeWebhookTrigger'), parameters: {
        'subscriptionRequest/message': message, 'subscriptionRequest/entityname': 'app_request', 'subscriptionRequest/scope': 4,
        ...(filtering ? { 'subscriptionRequest/filteringattributes': filtering } : {}) } } } };
  const acts = {};
  for (const [n, a] of Object.entries(actions)) acts[n] = { type: 'OpenApiConnection', runAfter: {}, inputs: { host: host(a.op), parameters: { entityName: 'app_requests', ...a.p } } };
  return { file: name + '.json', name, refs: {}, def: { triggers: trig, actions: acts } };
}
const ROW = "@triggerOutputs()?['body/app_requestid']";
const STATE_IS = (...v) => [{ expression: `@or(${v.map((x) => `equals(triggerOutputs()?['body/app_state'], ${x})`).join(', ')})` }];
const GRAPH_CASES = [
  ['two-flows-feed-each-other', [
    graphFlow('a', { filtering: 'app_a', actions: { Set_b: { op: 'UpdateRecord', p: { recordId: ROW, 'item/app_b': 1 } } } }),
    graphFlow('b', { filtering: 'app_b', actions: { Set_a: { op: 'UpdateRecord', p: { recordId: ROW, 'item/app_a': 1 } } } })], 'trigger-cycle'],
  ['two-flows-broken-by-condition', [
    graphFlow('a', { filtering: 'app_a', conditions: [{ expression: "@equals(triggerOutputs()?['body/app_a'], 1)" }],
      actions: { Set_b: { op: 'UpdateRecord', p: { recordId: ROW, 'item/app_b': 1 } } } }),
    graphFlow('b', { filtering: 'app_b', actions: { Set_a: { op: 'UpdateRecord', p: { recordId: ROW, 'item/app_a': 2 } } } })], null],
  ['create-flow-creates-its-own-rows', [
    graphFlow('a', { message: 1, actions: { Add_one: { op: 'CreateRecord', p: { 'item/app_name': 'x' } } } })], 'trigger-cycle'],
  ['create-flow-condition-excludes-its-rows', [
    graphFlow('a', { message: 1, conditions: [{ expression: "@not(equals(triggerOutputs()?['body/app_generated'], true))" }],
      actions: { Add_one: { op: 'CreateRecord', p: { 'item/app_generated': true } } } })], null],
  ['sweep-alternates-two-rearming-values', [
    graphFlow('sweep', { recurrence: true, actions: { Flip: { op: 'UpdateRecord', p: { recordId: "@items('Each')?['app_requestid']",
      'item/app_state': "@if(equals(items('Each')?['app_state'], 2), 1, 2)" } } } }),
    graphFlow('dispatch', { filtering: 'app_state', conditions: STATE_IS(1, 2), actions: {} })], 'alternating-rearm'],
  ['sweep-ends-in-a-terminal-value', [
    graphFlow('sweep', { recurrence: true, actions: { Flip: { op: 'UpdateRecord', p: { recordId: "@items('Each')?['app_requestid']",
      'item/app_state': "@if(equals(items('Each')?['app_state'], 2), 9, 2)" } } } }),
    graphFlow('dispatch', { filtering: 'app_state', conditions: STATE_IS(1, 2), actions: {} })], null],
];
function recipientFlow(to, compose) {
  return { file: 'r.json', name: 'r', refs: {}, def: {
    triggers: { Every_day: { type: 'Recurrence', recurrence: { frequency: 'Day', interval: 1 } } },
    actions: {
      Is_live: { type: 'Compose', runAfter: {}, inputs: '@false' },
      Allowlist: { type: 'Compose', runAfter: { Is_live: ['Succeeded'] }, inputs: 'test@example.invalid' },
      Safe_to_owner: { type: 'Compose', runAfter: { Allowlist: ['Succeeded'] }, inputs: compose },
      Send: { type: 'OpenApiConnection', runAfter: { Safe_to_owner: ['Succeeded'] }, inputs: { host: { connectionName: 'shared_office365', operationId: 'SendEmailV2' },
        parameters: { 'emailMessage/To': to, 'emailMessage/Subject': 'x' } } } } } };
}
const RECIPIENT_CASES = [
  ['safe', recipientFlow("@outputs('Safe_to_owner')", "@if(outputs('Is_live'), 'owner@example.invalid', outputs('Allowlist'))"), 0],
  ['safe-nested-test-branch', recipientFlow("@outputs('Safe_to_owner')", "@if(outputs('Is_live'), '', if(equals(1, 0), '', outputs('Allowlist')))"), 0],
  ['direct-address', recipientFlow('owner@example.invalid', "@if(outputs('Is_live'), 'x', outputs('Allowlist'))"), 1],
  ['test-branch-leaks', recipientFlow("@outputs('Safe_to_owner')", "@if(outputs('Is_live'), 'owner@example.invalid', if(equals(1, 0), 'owner@example.invalid', outputs('Allowlist')))"), 1],
];

function selftest() {
  const dateOnly = new Set(['app_approvedon']);
  const bad = lint([fixture(true)], { dateOnly }).results[0].items.filter((i) => i.level !== 'info').map((i) => i.code);
  const good = lint([fixture(false)], { dateOnly }).results[0].items.filter((i) => i.level !== 'info');
  const want = ['runtime-invoker', 'trigger-message-mismatch', 'self-trigger-loop', 'apostrophe-in-literal', 'not-on-runafter-path', 'send-after-failed',
                'at-property-name', 'multiple-triggers', 'date-only-as-instant'];
  const graphFails = [];
  for (const [name, flows, expect] of GRAPH_CASES) {
    const codes = lint(flows).cycles.map((c) => c.split(' ')[0]);
    const ok = expect === null ? codes.length === 0 : codes.includes(expect);
    if (!ok) graphFails.push(`${name}: expected ${expect || 'no loop'}, got ${codes.join(', ') || 'no loop'}`);
  }
  for (const [name, flow, expect] of RECIPIENT_CASES) {
    const n = lint([flow], { safeRecipients: true }).results[0].items.filter((i) => /^unsafe-/.test(i.code)).length;
    if ((n > 0) !== (expect > 0)) graphFails.push(`recipients ${name}: expected ${expect ? 'a finding' : 'none'}, got ${n}`);
  }
  const missing = want.filter((w) => !bad.includes(w));
  const guardFails = [];
  for (const [name, opts, expect] of GUARD_CASES) {
    const codes = lint([guardFixture(name, opts)]).results[0].items.filter((i) => /self-trigger-loop|self-write-guard/.test(i.code)).map((i) => i.code);
    const okCase = expect === null ? codes.length === 0 : codes.length === 1 && codes[0] === expect;
    if (!okCase) guardFails.push(`${name}: expected ${expect || 'guarded'}, got ${codes.join(', ') || 'guarded'}`);
  }
  // filteringattributes on a written column: a trigger condition that the write falsifies downgrades
  // the finding to info; the same guard only in an inner If leaves it an error (the run still starts).
  const statusCond = "@and(equals(triggerOutputs()?['body/app_status'], 1), not(equals(coalesce(triggerOutputs()?['body/app_generated'], false), true)))";
  const filtered = (name, conditions, wrap) => {
    const f = guardFixture(name, { conditions, wrap, write: { 'item/app_status': 2, 'item/app_generated': true } });
    f.def.triggers.When_a_request_is_updated.inputs.parameters['subscriptionRequest/filteringattributes'] = 'app_status';
    return lint([f]).results[0].items.filter((i) => /^writes-filtered-column/.test(i.code)).map((i) => `${i.level}:${i.code}`);
  };
  const filterCases = [
    ['filtered-guarded-by-trigger-condition', filtered('a', [{ expression: statusCond }], (w) => ({ type: 'Scope', actions: { Lock_it: w } })), 'info:writes-filtered-column-guarded'],
    ['filtered-guarded-only-by-inner-if', filtered('b', [], ifYes(statusCond)), 'error:writes-filtered-column'],
  ];
  for (const [name, got, expect] of filterCases) if (got.length !== 1 || got[0] !== expect) guardFails.push(`${name}: expected ${expect}, got ${got.join(', ') || 'nothing'}`);
  // The parser itself: doubled quotes, safe navigation, dotted access, interpolation.
  const parsed = [
    ["@equals(triggerOutputs()?['body/app_note'], 'it''s')", (n) => n.t === 'call' && n.args[1].v === "it's"],
    ["@body('Get')?.app_x", (n) => n.t === 'idx' && n.key.v === 'app_x'],
    ['Locked @{utcNow()} by @{workflow()?.run?.name}', (n) => n.t === 'interp' && n.parts.length === 4],
    ["@not(equals(", (n) => n.t === 'unknown'],
  ].filter(([src, okFn]) => !okFn(parseValue(src))).map(([src]) => 'parse: ' + src);
  // The bad fixture fires on Delete, so the unfiltered-Update rule is proven on a guard fixture.
  const unf = lint([guardFixture('unfiltered', { wrap: ifYes({ not: { equals: ["@triggerOutputs()?['body/app_locked']", true] } }) })]).results[0].items.some((i) => i.code === 'update-trigger-unfiltered');
  if (!unf) graphFails.push('update-trigger-unfiltered: not raised on an Update trigger without filteringattributes');
  {
    const os = process.env.TEMP || process.env.TMPDIR || '/tmp';
    const wd = fs.mkdtempSync(path.join(os, 'lint-rec-'));
    const rec = writeRecord(path.join(wd, '.ship-work'), 2, false, ['flows']);
    const back = JSON.parse(fs.readFileSync(path.join(wd, '.ship-work', 'flow-lint.json'), 'utf8'));
    if (!rec || back.count !== 2 || back.clean !== false || !Date.parse(back.at)) graphFails.push('run record: not written as {at, clean, count, paths}');
    fs.rmSync(wd, { recursive: true, force: true });
  }
  const ok = missing.length === 0 && good.length === 0 && guardFails.length === 0 && parsed.length === 0 && graphFails.length === 0;
  console.log(ok ? `selftest ok: bad fixture -> ${bad.length} findings (${[...new Set(bad)].join(', ')}), good fixture -> 0, ` +
                   `${GUARD_CASES.length} guard shapes and 2 filteringattributes cases decided as expected, ${GRAPH_CASES.length} loop-graph ` +
                   `shapes, ${RECIPIENT_CASES.length} recipient shapes and the unfiltered-trigger rule as expected, parser cases ok, run record ok`
                 : `selftest FAILED: missing [${missing.join(', ')}]; good fixture produced: ${good.map((g) => g.code + ': ' + g.msg).join(' | ')}; ` +
                   `guard shapes: [${guardFails.join(' | ')}]; loop graph / recipients: [${graphFails.join(' | ')}]; parser: [${parsed.join(' | ')}]`);
  process.exit(ok ? 0 : 1);
}

// ---------- run record (read by hooks/plugin-gate.mjs before a solution import) ----------
export function writeRecord(workDir, count, clean, paths) {
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const rec = { at: new Date().toISOString(), clean, count, paths };
    fs.writeFileSync(path.join(workDir, 'flow-lint.json'), JSON.stringify(rec, null, 2) + '\n');
    return rec;
  } catch { return null; }
}

// ---------- main ----------
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) selftest();
else if (argv.length === 0 || argv.includes('--help')) {
  console.log('usage: node lint-flows.mjs <file-or-folder>... [--entity-sets sets.json] [--date-only cols.json] [--work-dir dir] [--json] [--verbose] | --selftest');
  process.exit(argv.length === 0 ? 1 : 0);
} else {
  const listArg = (flag) => {
    const k = argv.indexOf(flag);
    return k === -1 ? null : new Set(JSON.parse(fs.readFileSync(argv[k + 1], 'utf8')).map((s) => String(s).toLowerCase()));
  };
  const sets = listArg('--entity-sets');
  const dateOnly = listArg('--date-only');
  const valueIdx = new Set(['--entity-sets', '--date-only', '--work-dir'].map((f) => argv.indexOf(f)).filter((k) => k !== -1).map((k) => k + 1));
  const paths = argv.filter((a, k) => !a.startsWith('--') && !valueIdx.has(k));
  const flows = loadFlows(paths);
  if (flows.length === 0) { console.error('No flow definitions found under: ' + paths.join(', ') + ' - this is NOT a pass.'); process.exit(2); }
  const { results, cycles, edges } = lint(flows, { entitySets: sets, dateOnly, safeRecipients: argv.includes('--require-safe-recipients') });
  if (argv.includes('--json')) { console.log(JSON.stringify({ results, cycles, edges }, null, 2)); }
  else {
    for (const r of results) {
      const shown = r.items.filter((x) => x.level !== 'info' || argv.includes('--verbose'));
      console.log(`${shown.some((x) => x.level === 'error') ? 'FAIL' : 'ok  '}  ${r.flow}`);
      for (const it of shown) console.log(`      ${it.level.toUpperCase().padEnd(5)} ${it.code}: ${it.msg}`);
    }
    for (const c of cycles) console.log('FAIL  ' + c);
    if (argv.includes('--verbose')) for (const e of edges) console.log(`      edge: '${e.from}' --${e.kind} '${e.via}'--> '${e.to}'`);
    console.log(`\n${flows.length} flow(s) read. Activation is still the only compile - turn each flow on once before trusting it.`);
  }
  const errors = results.some((r) => r.items.some((x) => x.level === 'error')) || cycles.length > 0;
  const wk = argv.indexOf('--work-dir');
  writeRecord(wk === -1 ? '.ship-work' : argv[wk + 1], flows.length, !errors, paths);
  process.exit(errors ? 1 : 0);
}
