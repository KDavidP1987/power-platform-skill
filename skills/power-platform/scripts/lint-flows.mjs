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
//
// Accepts a solution flow file ({properties:{definition, connectionReferences}}), a bare
// {definition: ...}, or a bare definition ({triggers, actions}).
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

function checkSelfWrite(flow, t, add) {
  if (!t.isDataverse || !t.table) return;
  const guards = new Set();
  for (const c of t.conditions) for (const s of stringsIn(c)) colTokens(s).forEach((x) => guards.add(x));
  const writes = [];
  walk(flow.def.actions, (n, a, trail) => {
    const op = a.inputs && a.inputs.host && a.inputs.host.operationId;
    const p = (a.inputs && a.inputs.parameters) || {};
    if (op === 'UpdateRecord' && sameTable(t.table, p.entityName)) {
      const cols = Object.keys(p).filter((k) => k.startsWith('item/')).map((k) => k.slice(5).toLowerCase());
      const local = new Set(guards);
      for (const anc of trail) if (anc.act.type === 'If' || anc.act.type === 'Switch') stringsIn(anc.act.expression).forEach((s) => colTokens(s).forEach((x) => local.add(x)));
      writes.push({ n, cols, local });
    }
  });
  for (const w of writes) {
    const hit = w.cols.filter((c) => w.local.has(c));
    if (hit.length === 0) {
      add('error', 'self-trigger-loop', `'${w.n}' updates the trigger table ${t.table} (columns: ${w.cols.join(', ') || 'none'}) ` +
        `but no enclosing condition or trigger condition reads any column it writes. The update trigger delivers the WHOLE row, ` +
        `so the same condition is true on the next pass: a runaway loop. Guard on a value this write changes (e.g. locked <> true).`);
    }
    if (t.filtering && w.cols.some((c) => String(t.filtering).toLowerCase().split(',').map((s) => s.trim()).includes(c))) {
      add('error', 'writes-filtered-column', `'${w.n}' writes a column listed in the trigger's filteringattributes - it retriggers itself.`);
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

export function lint(flows, { entitySets = null, dateOnly = null } = {}) {
  const results = [];
  const graph = [];
  for (const flow of flows) {
    const items = [];
    const add = (level, code, msg) => items.push({ level, code, msg });
    const t = triggerInfo(flow.def);
    checkRuntimeSource(flow, t, add);
    checkMessageCode(t, add);
    checkSelfWrite(flow, t, add);
    checkApostrophes(flow, add);
    scopeErrors(flow.def.actions || {}, new Set(), add);
    checkSends(flow, add);
    checkEntitySets(flow, entitySets, add);
    checkAtPropertyNames(flow, add);
    checkTriggerCount(flow, add);
    checkDateOnly(flow, dateOnly, add);
    checkShapeNotes(flow, add);
    const written = new Set();
    walk(flow.def.actions, (n, a) => {
      const op = a.inputs && a.inputs.host && a.inputs.host.operationId;
      const p = (a.inputs && a.inputs.parameters) || {};
      if (/^(UpdateRecord|CreateRecord|DeleteRecord)$/.test(op || '') && p.entityName) written.add(String(p.entityName).toLowerCase());
    });
    graph.push({ flow: flow.name, trigger: t.isDataverse ? String(t.table).toLowerCase() : null, written: [...written] });
    results.push({ file: flow.file, flow: flow.name, items });
  }
  // Cross-flow cycles: A fires on X and writes Y; B fires on Y and writes X.
  const cycles = [];
  for (const a of graph) for (const b of graph) {
    if (a === b || !a.trigger || !b.trigger || a.trigger === b.trigger) continue; // same table: per-flow guard covers it
    if (a.written.some((w) => sameTable(b.trigger, w)) && b.written.some((w) => sameTable(a.trigger, w)) && a.flow < b.flow) {
      cycles.push(`'${a.flow}' (on ${a.trigger}) writes what '${b.flow}' triggers on, and vice versa - a loop no per-flow guard can see.`);
    }
  }
  return { results, cycles };
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
          parameters: { 'subscriptionRequest/message': bad ? 2 : 3, 'subscriptionRequest/entityname': 'app_request', 'subscriptionRequest/scope': 4 } } },
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
function selftest() {
  const dateOnly = new Set(['app_approvedon']);
  const bad = lint([fixture(true)], { dateOnly }).results[0].items.filter((i) => i.level !== 'info').map((i) => i.code);
  const good = lint([fixture(false)], { dateOnly }).results[0].items.filter((i) => i.level !== 'info');
  const want = ['runtime-invoker', 'trigger-message-mismatch', 'self-trigger-loop', 'apostrophe-in-literal', 'not-on-runafter-path', 'send-after-failed',
                'at-property-name', 'multiple-triggers', 'date-only-as-instant'];
  const missing = want.filter((w) => !bad.includes(w));
  const ok = missing.length === 0 && good.length === 0;
  console.log(ok ? `selftest ok: bad fixture -> ${bad.length} findings (${[...new Set(bad)].join(', ')}), good fixture -> 0`
                 : `selftest FAILED: missing [${missing.join(', ')}]; good fixture produced: ${good.map((g) => g.code + ': ' + g.msg).join(' | ')}`);
  process.exit(ok ? 0 : 1);
}

// ---------- main ----------
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) selftest();
else if (argv.length === 0 || argv.includes('--help')) {
  console.log('usage: node lint-flows.mjs <file-or-folder>... [--entity-sets sets.json] [--date-only cols.json] [--json] [--verbose] | --selftest');
  process.exit(argv.length === 0 ? 1 : 0);
} else {
  const listArg = (flag) => {
    const k = argv.indexOf(flag);
    return k === -1 ? null : new Set(JSON.parse(fs.readFileSync(argv[k + 1], 'utf8')).map((s) => String(s).toLowerCase()));
  };
  const sets = listArg('--entity-sets');
  const dateOnly = listArg('--date-only');
  const valueIdx = new Set(['--entity-sets', '--date-only'].map((f) => argv.indexOf(f)).filter((k) => k !== -1).map((k) => k + 1));
  const paths = argv.filter((a, k) => !a.startsWith('--') && !valueIdx.has(k));
  const flows = loadFlows(paths);
  if (flows.length === 0) { console.error('No flow definitions found under: ' + paths.join(', ') + ' - this is NOT a pass.'); process.exit(2); }
  const { results, cycles } = lint(flows, { entitySets: sets, dateOnly });
  if (argv.includes('--json')) { console.log(JSON.stringify({ results, cycles }, null, 2)); }
  else {
    for (const r of results) {
      const shown = r.items.filter((x) => x.level !== 'info' || argv.includes('--verbose'));
      console.log(`${shown.some((x) => x.level === 'error') ? 'FAIL' : 'ok  '}  ${r.flow}`);
      for (const it of shown) console.log(`      ${it.level.toUpperCase().padEnd(5)} ${it.code}: ${it.msg}`);
    }
    for (const c of cycles) console.log('FAIL  cross-flow cycle: ' + c);
    console.log(`\n${flows.length} flow(s) read. Activation is still the only compile - turn each flow on once before trusting it.`);
  }
  const errors = results.some((r) => r.items.some((x) => x.level === 'error')) || cycles.length > 0;
  process.exit(errors ? 1 : 0);
}
