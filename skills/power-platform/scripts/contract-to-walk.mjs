#!/usr/bin/env node
// contract-to-walk.mjs - from an acceptance contract to walk scenarios that can fail.
//
// A plan that traces every requirement through the source proves the source; it does not prove
// the published app does it. This script reads an acceptance contract (assets/templates/
// acceptance-contract.md: Requirements, Actions, Refusals, Confirms and Scenarios tables), checks
// that nothing in it is unprovable, and writes one canvas-browser.mjs `walk` scenario skeleton per
// scenario row, with the Dataverse `confirm` checks filled in from the Confirms table.
//
// Coverage findings (exit 1):
//   NO-ACTION        a requirement names no action, or an action id that does not exist
//   NO-SCENARIO      an action with no success scenario, or a refusal with no scenario
//   NO-CONFIRM       an action that writes (Writes is not "none") with no Confirms row, or a
//                    refusal with no Confirms row naming the values that must stay unchanged
//   UNKNOWN-ID       a scenario, refusal or confirm row that points at an id nobody defined
//   NO-THEN          a scenario whose Then asserts nothing
// Notes (printed, not failing): a writing action with no `twice` scenario; generated steps left
// as `todo` (the walk lint refuses them until they are written as steps).
//
// Usage:
//   node contract-to-walk.mjs <contract.md> [--out <dir>]   check, then write <dir>/<id>-<slug>.json
//   node contract-to-walk.mjs <contract.md> --check         coverage only, write nothing
//   node contract-to-walk.mjs --selftest
//
// Exit: 0 clean, 1 findings, 2 nothing parsed (no tables found - a check that read nothing).
// Method: references/browser-verification.md, section 18.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const KINDS = new Set(['success', 'refusal', 'invalid', 'boundary', 'twice']);

// --- parsing ------------------------------------------------------------------------------------
// Markdown tables under "## <Heading>"; the first row is the header, the second the rule.
export function parseContract(text) {
  const tables = {};
  let heading = null, rows = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { heading = h[1].toLowerCase(); rows = null; continue; }
    if (!heading || !line.startsWith('|')) { rows = null; continue; }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;          // the rule row
    if (!rows) { rows = []; tables[heading] = { header: cells.map((c) => c.toLowerCase()), rows }; continue; }
    rows.push(cells);
  }
  const get = (name, cols) => {
    const t = tables[name];
    if (!t) return [];
    const idx = cols.map((c) => t.header.findIndex((h) => h.startsWith(c)));
    return t.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, idx[i] >= 0 ? (r[idx[i]] || '').trim() : ''])));
  };
  return {
    requirements: get('requirements', ['id', 'requirement', 'actions']),
    actions: get('actions', ['id', 'action', 'precondition', 'trigger', 'writes', 'observable']),
    refusals: get('refusals', ['id', 'action', 'refused', 'message']),
    confirms: get('confirms', ['for', 'entity set', 'filter', 'expect', 'count']),
    scenarios: get('scenarios', ['id', 'covers', 'kind', 'given', 'when', 'then']),
  };
}

// Split a table row on pipes outside quotes and backticks (a filter can hold `|`? rarely; quotes can).
function splitRow(line) {
  const s = line.replace(/^\|/, '').replace(/\|$/, '');
  const out = []; let cur = '', q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '`') { q = ch; cur += ch; continue; }
    if (ch === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const ids = (cell) => (cell || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
const writes = (a) => !/^(none|-|n\/a|)$/i.test(a.writes.trim());

// --- coverage -----------------------------------------------------------------------------------
export function check(c) {
  const f = [], notes = [];
  const A = new Map(c.actions.map((a) => [a.id, a]));
  const X = new Map(c.refusals.map((x) => [x.id, x]));
  const confirmsFor = (id) => c.confirms.filter((r) => r.for === id);
  const scen = (id, kind) => c.scenarios.filter((s) => ids(s.covers).includes(id) && (!kind || s.kind.toLowerCase() === kind));

  for (const r of c.requirements) {
    const acts = ids(r.actions);
    if (!acts.length) f.push(`NO-ACTION ${r.id}: "${r.requirement}" names no action`);
    for (const a of acts) if (!A.has(a)) f.push(`NO-ACTION ${r.id}: action ${a} is not in the Actions table`);
  }
  const named = new Set(c.requirements.flatMap((r) => ids(r.actions)));
  for (const a of c.actions) {
    if (!named.has(a.id)) notes.push(`${a.id} "${a.action}" serves no requirement - drop it or name the requirement`);
    if (!scen(a.id, 'success').length) f.push(`NO-SCENARIO ${a.id}: "${a.action}" has no success scenario`);
    if (writes(a) && !confirmsFor(a.id).length) f.push(`NO-CONFIRM ${a.id}: "${a.action}" writes ${a.writes} but no Confirms row says where the write lands`);
    if (writes(a) && !scen(a.id, 'twice').length) notes.push(`${a.id} "${a.action}" writes and has no "twice" scenario (press it twice; one row, one log line)`);
  }
  for (const x of c.refusals) {
    if (!A.has(x.action)) f.push(`UNKNOWN-ID ${x.id}: refuses action ${x.action}, which is not in the Actions table`);
    if (!scen(x.id).length) f.push(`NO-SCENARIO ${x.id}: the refusal "${x.refused}" is never attempted`);
    if (!confirmsFor(x.id).length) f.push(`NO-CONFIRM ${x.id}: no Confirms row names what must be unchanged after the refusal`);
  }
  for (const r of c.confirms) {
    if (!A.has(r.for) && !X.has(r.for)) f.push(`UNKNOWN-ID confirm for ${r.for}: no such action or refusal`);
    if (!r['entity set'] || !r.filter) f.push(`NO-CONFIRM ${r.for}: a Confirms row needs an entity set and a filter`);
    if (!Object.keys(parseExpect(r.expect)).length && !r.count) f.push(`NO-CONFIRM ${r.for}: a Confirms row asserts nothing (give Expect or Count)`);
  }
  for (const s of c.scenarios) {
    for (const id of ids(s.covers)) if (!A.has(id) && !X.has(id)) f.push(`UNKNOWN-ID ${s.id}: covers ${id}, which is not an action or refusal`);
    if (!KINDS.has(s.kind.toLowerCase())) f.push(`UNKNOWN-ID ${s.id}: kind "${s.kind}" (use ${[...KINDS].join(', ')})`);
    if (!toSteps(s.then).some((st) => st.expect || st.absent)) f.push(`NO-THEN ${s.id}: Then has no expect "..." or absent "..." - the walk would pass vacuously`);
  }
  return { findings: f, notes };
}

// --- generation ---------------------------------------------------------------------------------
export function parseExpect(cell) {
  const out = {};
  for (const part of (cell || '').split(';')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_@.]*)\s*=\s*(.*?)\s*$/.exec(part);
    if (!m) continue;
    const v = m[2].replace(/^['"](.*)['"]$/, '$1');
    out[m[1]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : v;
  }
  return out;
}

const Q = String.raw`"([^"]*)"`;
export function toSteps(text) {
  const steps = [];
  for (const part of (text || '').split(';').map((p) => p.trim()).filter(Boolean)) {
    let m;
    if ((m = new RegExp(`^click ${Q}(?:\\s+nth\\s+(\\d+))?$`, 'i').exec(part))) steps.push(m[2] ? { click: m[1], nth: Number(m[2]) } : { click: m[1] });
    else if ((m = new RegExp(`^type ${Q} into ${Q}$`, 'i').exec(part))) steps.push({ type: m[1], into: m[2] });
    else if ((m = new RegExp(`^select ${Q}(?:\\s+nth\\s+(\\d+))?$`, 'i').exec(part))) steps.push(m[2] ? { select: m[1], nth: Number(m[2]) } : { select: m[1] });
    else if ((m = new RegExp(`^expect ${Q}$`, 'i').exec(part))) steps.push({ expect: m[1] });
    else if ((m = new RegExp(`^absent ${Q}$`, 'i').exec(part))) steps.push({ absent: m[1] });
    else steps.push({ todo: part });
  }
  return steps;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function generate(c) {
  const A = new Map(c.actions.map((a) => [a.id, a]));
  const X = new Map(c.refusals.map((x) => [x.id, x]));
  const out = [];
  for (const s of c.scenarios) {
    const kind = s.kind.toLowerCase();
    const covered = ids(s.covers);
    const acts = covered.map((id) => A.get(id) || A.get((X.get(id) || {}).action)).filter(Boolean);
    const writing = kind !== 'refusal' && kind !== 'invalid' && acts.some(writes);
    const confirm = covered.flatMap((id) => c.confirms.filter((r) => r.for === id)).map((r) => {
      const chk = { entitySet: r['entity set'], filter: r.filter };
      const e = parseExpect(r.expect);
      if (Object.keys(e).length) chk.expect = e;
      if (r.count) chk.count = Number(r.count);
      if (kind === 'twice') chk.count = chk.count ?? 1;                // pressed twice, still one row
      if (!writing) chk.changedThisRun = false;                       // a refusal leaves the row as it was
      return chk;
    });
    const sc = {
      name: `${s.id}-${slug(s.when ? `${kind} ${acts.map((a) => a.action).join(' ')}` : s.id)}`,
      description: `${s.id} (${kind}) covers ${covered.join(', ')}. Given: ${s.given}`,
      build: 'TODO: the build stamp this walk must see',
      writes: writing,
      ...(writing ? { restore: 'TODO: the revert scenario that puts this row back, then confirm it' } : {}),
      steps: [...toSteps(s.when), ...toSteps(s.then)],
      ...(confirm.length ? { confirm } : {}),
    };
    // A refused action must leave the screen usable: sweep the screen the action is triggered on.
    const screen = acts.length ? slug(acts[0].trigger.split('>')[0]) : '';
    if ((kind === 'refusal' || kind === 'invalid') && screen) sc.steps.push({ deadclick: screen });
    out.push(sc);
  }
  return out;
}

// --- CLI ----------------------------------------------------------------------------------------
function run(argv) {
  if (argv.includes('--selftest')) return selftest();
  const file = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out');
  if (!file) { console.log('usage: contract-to-walk.mjs <contract.md> [--out <dir>] [--check] | --selftest'); return 1; }
  const c = parseContract(readFileSync(resolve(file), 'utf8'));
  const n = c.requirements.length + c.actions.length + c.scenarios.length;
  if (!n) { console.log('NOTHING PARSED: no Requirements, Actions or Scenarios table in ' + file); return 2; }
  const { findings, notes } = check(c);
  console.log(`read ${c.requirements.length} requirements, ${c.actions.length} actions, ${c.refusals.length} refusals, ${c.confirms.length} confirms, ${c.scenarios.length} scenarios`);
  for (const x of findings) console.log('FIND ' + x);
  for (const x of notes) console.log('note ' + x);
  if (!argv.includes('--check')) {
    const oi = argv.indexOf('--out');
    const dir = resolve(oi >= 0 ? argv[oi + 1] : 'scenarios-from-contract');
    mkdirSync(dir, { recursive: true });
    const scs = generate(c);
    let todo = 0;
    for (const sc of scs) {
      todo += sc.steps.filter((st) => st.todo).length;
      writeFileSync(join(dir, sc.name + '.json'), JSON.stringify(sc, null, 2) + '\n', 'utf8');
    }
    console.log(`wrote ${scs.length} scenario skeletons to ${dir}` + (todo ? ` (${todo} "todo" steps to write as walk steps; the walk lint refuses them until then)` : ''));
    console.log('each still needs: the build stamp, the restore for writing scenarios, and a real run of `canvas-browser.mjs walk` in the published app.');
  }
  return findings.length ? 1 : 0;
}

function selftest() {
  const good = readFileSync(new URL('../assets/templates/acceptance-contract.md', import.meta.url), 'utf8');
  const fails = [];
  const g = parseContract(good), gc = check(g);
  if (gc.findings.length) fails.push('template should be clean: ' + gc.findings.join('; '));
  const gs = generate(g);
  if (gs.length !== g.scenarios.length) fails.push('one scenario per row');
  const s5 = gs.find((s) => s.name.startsWith('S5'));
  if (!s5 || !s5.writes || !s5.restore || !s5.confirm || s5.confirm[0].expect.app_reason !== 'Wrong vendor') fails.push('S5 confirm/expect not carried');
  if (!s5 || !s5.steps.some((st) => st.type === 'Wrong vendor' && st.into === 'Reason')) fails.push('type ... into ... not parsed');
  const s2 = gs.find((s) => s.name.startsWith('S2'));
  if (!s2 || s2.writes || s2.confirm[0].changedThisRun !== false) fails.push('refusal must not write and must check the row is unchanged');
  if (!s2 || !s2.steps.some((st) => st.deadclick === 'order')) fails.push('refusal sweeps the trigger screen for dead clicks');
  const s3 = gs.find((s) => s.name.startsWith('S3'));
  if (!s3 || s3.confirm[0].count !== 1) fails.push('twice scenario must confirm exactly one row');

  // Bad contract: each defect must be found by name.
  const bad = `## Requirements
| Id | Requirement | Actions |
|---|---|---|
| R1 | Do a thing | |
| R2 | Do another | A9 |
## Actions
| Id | Action | Precondition | Trigger | Writes | Observable |
|---|---|---|---|---|---|
| A1 | Save | x | S > Save | app_x: app_a | saved |
| A2 | Look | x | S > Open | none | shown |
## Refusals
| Id | Action | Refused when | Message |
|---|---|---|---|
| X1 | A1 | empty | Fill it in |
## Confirms
| For | Entity set | Filter | Expect | Count |
|---|---|---|---|---|
| A7 | app_xs | app_a eq 1 | app_a=1 | |
## Scenarios
| Id | Covers | Kind | Given | When | Then |
|---|---|---|---|---|---|
| S1 | A2 | success | x | click "Open" | look at it |
| S2 | A5 | maybe | x | click "A" | expect "B" |
`;
  const bc = check(parseContract(bad));
  const want = ['NO-ACTION R1', 'NO-ACTION R2', 'NO-SCENARIO A1', 'NO-CONFIRM A1', 'NO-SCENARIO X1', 'NO-CONFIRM X1', 'UNKNOWN-ID confirm for A7', 'NO-THEN S1', 'UNKNOWN-ID S2'];
  const missing = want.filter((w) => !bc.findings.some((x) => x.startsWith(w)));
  if (missing.length) fails.push('bad contract missed: ' + missing.join(', '));
  if (!toSteps('wave at it').every((st) => st.todo)) fails.push('free text must become todo');
  if (parseContract('no tables here').scenarios.length) fails.push('empty input parsed something');

  console.log(fails.length ? 'selftest FAILED:\n  ' + fails.join('\n  ')
    : `selftest ok: template clean (${g.scenarios.length} scenarios generated with confirms), bad contract -> ${bc.findings.length} findings covering all ${want.length} classes, free text -> todo, empty input -> nothing parsed`);
  return fails.length ? 1 : 0;
}

process.exitCode = run(process.argv.slice(2));
