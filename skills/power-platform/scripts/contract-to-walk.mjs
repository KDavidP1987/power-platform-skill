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
// as `todo` (the walk lint refuses them until they are written as steps); an edit form given a
// save-reopen-save walk by default.
//
// Save-reopen-save: every writing action whose success scenario types or selects (an edit form)
// gets a `reopen` walk unless the contract has its own `reopen` scenario for it. It saves, leaves,
// reopens the record, saves again WITHOUT editing, and confirms the row still holds the values. A
// form that reopens blank (a modern input reset to the value from before the edit) passes every
// other walk; its no-change save then writes the blanks over the data.
//
// Usage:
//   node contract-to-walk.mjs <contract.md> [--out <dir>]   check, then write <dir>/<id>-<slug>.json
//   node contract-to-walk.mjs <contract.md> --check         coverage only, write nothing
//   node contract-to-walk.mjs --from-dod <plan.md> [--out-contract <file>]
//                                                  a DOD plan (dod skill) -> an acceptance-contract skeleton:
//                                                  every `manual:` DoD item becomes a requirement, an action
//                                                  and a success scenario to fill in; test/cmd/file items are
//                                                  listed as verified outside the app
//   node contract-to-walk.mjs --selftest
//
// Exit: 0 clean, 1 findings, 2 nothing parsed (no tables found - a check that read nothing).
// Method: references/browser-verification.md, section 18.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const KINDS = new Set(['success', 'refusal', 'invalid', 'boundary', 'twice', 'reopen']);

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
    if (editForm(a, c) && !scen(a.id, 'reopen').length) notes.push(`${a.id} "${a.action}" is an edit form: a save-reopen-save walk is generated by default (write its "leave and reopen" step, or add your own "reopen" scenario)`);
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

// An edit form: it writes, and its success scenario types or selects a value before saving.
export function editForm(a, c) {
  if (!writes(a)) return false;
  return c.scenarios.some((s) => ids(s.covers).includes(a.id) && s.kind.toLowerCase() === 'success'
    && toSteps(s.when).some((st) => 'type' in st || 'select' in st));
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
  // Save-reopen-save, by default, for every edit form without its own reopen scenario.
  for (const a of c.actions) {
    if (!editForm(a, c) || c.scenarios.some((s) => ids(s.covers).includes(a.id) && s.kind.toLowerCase() === 'reopen')) continue;
    const s = c.scenarios.find((x) => ids(x.covers).includes(a.id) && x.kind.toLowerCase() === 'success' && toSteps(x.when).some((st) => 'type' in st || 'select' in st));
    const when = toSteps(s.when), then = toSteps(s.then);
    const clicks = when.filter((st) => st.click && !('type' in st));
    const save = clicks[clicks.length - 1];
    const opener = clicks.length > 1 ? clicks[0] : null;
    const confirm = c.confirms.filter((r) => r.for === a.id).map((r) => {
      const chk = { entitySet: r['entity set'], filter: r.filter };
      const e = parseExpect(r.expect);
      if (Object.keys(e).length) chk.expect = e;
      chk.count = r.count ? Number(r.count) : 1;                       // saved twice, still one row
      return chk;
    });
    out.push({
      name: `${s.id}-reopen-${slug(a.action)}`,
      description: `${s.id}-reopen (save-reopen-save) covers ${a.id}: save, leave, reopen the saved record and save again without editing; the row must still hold the values. Catches a form that reopens blank and saves the blanks. Given: ${s.given}`,
      build: 'TODO: the build stamp this walk must see',
      writes: true,
      restore: 'TODO: the revert scenario that puts this row back, then confirm it',
      steps: [...when, ...then,
        { todo: 'leave the form for another screen (the navigation that unloads it)' },
        ...(opener ? [{ ...opener }] : [{ todo: 'reopen the saved record' }]),
        ...(save ? [{ ...save, note: 'the second save, with nothing edited' }] : [{ todo: 'save again without editing' }]),
        ...then],
      ...(confirm.length ? { confirm } : {}),
    });
  }
  return out;
}

// --- from a DOD plan ----------------------------------------------------------------------------
// The dod skill's plan file holds "## Definition of Done" lines:
//   - [ ] D4 · **One-click export** <statement> · manual: <steps a person performs and what they observe>
// Separator " · " (U+00B7); type is test | cmd | file | manual; "[x]" is checked. Only `manual` items
// are performed in the running product, so only they become walks; the rest are proved by their own
// test, command or file and are listed, not dropped.
const SEP = ' \u00b7 ';
export function parseDod(text) {
  const items = [];
  let inDod = false;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (/^##\s/.test(line)) { inDod = /^##\s+Definition of Done\s*$/i.test(line); continue; }
    if (!inDod) continue;
    const m = /^- \[( |x|X)\] (D\d+)(.*)$/.exec(line);
    if (!m) continue;
    const parts = m[3].split(SEP).map((x) => x.trim());
    parts.shift();                                                     // the empty field before the first " · "
    const last = parts.length > 1 ? parts.pop() : '';
    const tm = /^(test|cmd|file|manual):\s*(.*)$/.exec(last);
    const body = tm ? parts.join(SEP) : [...parts, last].filter(Boolean).join(SEP);
    const tt = /^\*\*([^*]{1,40})\*\*\s*(.*)$/.exec(body);
    items.push({ id: m[2], checked: m[1].toLowerCase() === 'x', title: tt ? tt[1].trim() : '', statement: (tt ? tt[2] : body).trim(),
      type: tm ? tm[1] : '', detail: tm ? tm[2].trim() : '' });
  }
  return items;
}

const cell = (s) => String(s || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
export function dodToContract(items, title = 'from a DOD plan') {
  const manual = items.filter((i) => i.type === 'manual');
  const other = items.filter((i) => i.type !== 'manual');
  const n = (i) => i.id.slice(1);
  const L = [`# Acceptance contract (${title})`, '',
    'Generated by contract-to-walk.mjs --from-dod. Fill every TODO, then run contract-to-walk.mjs on this file.', '',
    '## Requirements', '| Id | Requirement | Actions |', '|---|---|---|',
    ...manual.map((i) => `| R${n(i)} | ${cell((i.title ? i.title + ': ' : '') + i.statement)} | A${n(i)} |`), '',
    '## Actions', '| Id | Action | Precondition | Trigger | Writes | Observable |', '|---|---|---|---|---|---|',
    ...manual.map((i) => `| A${n(i)} | ${cell(i.title || i.statement)} | TODO | TODO screen > control | TODO table: columns, or none | ${cell(i.statement)} |`), '',
    '## Refusals', '| Id | Action | Refused when | Message |', '|---|---|---|---|', '',
    '## Confirms', '| For | Entity set | Filter | Expect | Count |', '|---|---|---|---|---|', '',
    '## Scenarios', '| Id | Covers | Kind | Given | When | Then |', '|---|---|---|---|---|---|',
    ...manual.map((i) => `| S${n(i)} | A${n(i)} | success | TODO | ${cell(i.detail)} | TODO: what must be seen |`), '',
    '## Verified outside the app (not walks)', '',
    ...other.map((i) => `- ${i.id}${i.title ? ' ' + i.title : ''}: ${i.statement} (${i.type ? i.type + ': ' + i.detail : 'no verification field'})`), ''];
  return L.join('\n');
}

// --- CLI ----------------------------------------------------------------------------------------
function run(argv) {
  if (argv.includes('--selftest')) return selftest();
  const di = argv.indexOf('--from-dod');
  if (di >= 0) {
    const plan = argv[di + 1];
    if (!plan) { console.log('usage: contract-to-walk.mjs --from-dod <plan.md> [--out-contract <file>]'); return 1; }
    const items = parseDod(readFileSync(resolve(plan), 'utf8'));
    if (!items.length) { console.log('NOTHING PARSED: no "## Definition of Done" items in ' + plan); return 2; }
    const by = items.reduce((o, i) => ((o[i.type || 'untyped'] = (o[i.type || 'untyped'] || 0) + 1), o), {});
    const oc = argv.indexOf('--out-contract');
    const out = resolve(oc >= 0 ? argv[oc + 1] : 'acceptance-contract.from-dod.md');
    writeFileSync(out, dodToContract(items, plan.replace(/^.*[\\/]/, '')), 'utf8');
    console.log(`read ${items.length} DoD items (${Object.entries(by).map(([k, v]) => k + ' ' + v).join(', ')})`);
    console.log(`wrote ${out}: ${by.manual || 0} manual item(s) as requirement + action + scenario to fill; the rest listed as verified outside the app`);
    const untyped = items.filter((i) => !i.type);
    for (const i of untyped) console.log(`FIND NO-TYPE ${i.id}: no "test:|cmd:|file:|manual:" field - DOD cannot verify it either`);
    return untyped.length ? 1 : 0;
  }
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
  const reopen = gs.filter((s) => /-reopen-/.test(s.name));
  if (gs.length !== g.scenarios.length + reopen.length) fails.push('one scenario per row, plus the generated reopen walks');
  // Save-reopen-save: A3 types a reason before saving (an edit form); A1 and A2 only press a button.
  const r3 = reopen.find((s) => s.name.startsWith('S5-reopen'));
  if (reopen.length !== 1 || !r3) fails.push('exactly one reopen walk (for the edit form A3), got ' + reopen.map((s) => s.name).join(', '));
  else {
    const clicks = r3.steps.filter((st) => st.click).map((st) => st.click);
    if (clicks.join() !== 'ORD-0044,Reject,ORD-0044,Reject') fails.push('reopen walk: open, save, reopen, save again - got ' + clicks.join());
    if (r3.steps.filter((st) => st.type).length !== 1) fails.push('reopen walk must not type again before the second save');
    if (!r3.steps.some((st) => st.todo) || !r3.writes || !r3.restore) fails.push('reopen walk: a todo for the leave step, writes and restore');
    if (!r3.confirm || r3.confirm[0].expect.app_reason !== 'Wrong vendor' || r3.confirm[0].count !== 1) fails.push('reopen walk confirms the values held and one row');
  }
  if (!gc.notes.some((n) => n.startsWith('A3') && /save-reopen-save/.test(n))) fails.push('note for the edit form');
  const own = good.replace('| S6 | X2 |', '| S7 | A3 | reopen | ORD-0044 was rejected | click "ORD-0044"; click "Reject" | expect "Rejected" |\n| S6 | X2 |');
  const og = parseContract(own);
  if (generate(og).some((s) => s.description.includes('(save-reopen-save)')) || check(og).findings.length) fails.push('a contract with its own reopen scenario gets no generated one and stays clean');
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

  // A DOD plan: manual items become walks; others are listed; the title and the type are read.
  const D = ' \u00b7 ';
  const plan = ['# DoD: Equipment loans', '', '## Definition of Done',
    `- [ ] D1${D}**Lend refused when on loan** Lending an asset that is on loan is refused and writes nothing${D}manual: open an On Loan asset, press Lend, see "This asset is on loan"`,
    `- [x] D2${D}**Lint clean** flows pass the linter${D}cmd: node lint-flows.mjs flows -> 0 findings`,
    `- [ ] D3${D}Untitled statement with a test${D}test: loans.test`,
    `- [ ] D4${D}**No type** a statement with no verification field`,
    '', '## Purpose & typical use', `- [ ] D9${D}**not an item here**${D}manual: x`].join('\n');
  const items = parseDod(plan);
  if (items.length !== 4) fails.push('DOD: 4 items under Definition of Done only, got ' + items.length);
  const d1 = items.find((i) => i.id === 'D1') || {};
  if (d1.title !== 'Lend refused when on loan' || d1.type !== 'manual' || !d1.detail.startsWith('open an On Loan')) fails.push('DOD: D1 title/type/detail');
  if (!(items.find((i) => i.id === 'D2') || {}).checked) fails.push('DOD: [x] read as checked');
  if ((items.find((i) => i.id === 'D3') || {}).title !== '') fails.push('DOD: untitled item');
  const d4 = items.find((i) => i.id === 'D4') || {};
  if (d4.type !== '' || d4.title !== 'No type') fails.push('DOD: missing type stays empty, title kept');
  const dc = parseContract(dodToContract(items));
  if (dc.requirements.length !== 1 || dc.actions[0].id !== 'A1' || dc.scenarios[0].covers !== 'A1') fails.push('DOD: manual item -> R1/A1/S1');
  if (!check(dc).findings.some((x) => x.startsWith('NO-THEN S1'))) fails.push('DOD: an unfilled Then must be flagged');

  console.log(fails.length ? 'selftest FAILED:\n  ' + fails.join('\n  ')
    : `selftest ok: template clean (${g.scenarios.length} scenarios generated with confirms, plus ${reopen.length} save-reopen-save walk), DOD plan -> contract skeleton, bad contract -> ${bc.findings.length} findings covering all ${want.length} classes, free text -> todo, empty input -> nothing parsed`);
  return fails.length ? 1 : 0;
}

process.exitCode = run(process.argv.slice(2));
