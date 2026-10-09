// PostToolUse hook (matcher: Write|Edit) for canvas .pa.yaml source.
//
// A canvas compile is all-or-nothing across every file in Src: one bad character fails the
// whole app, and the error text rarely points at the responsible line. Each fault below has
// broken a real compile. Catching it when the file is written turns a ten-minute round trip
// into a correction in the same turn.
//
// Deliberately narrow: only things KNOWN to break, never style. A hook that fires on style
// gets ignored, and then it is not there when it matters.
//
// Two tiers. Faults block (exit 2): the compile killers, and a zero guard on an aggregate, which
// compiles and cannot catch the case it was written for. Notes do not block (formulaNotes): a
// pattern that is wrong in the shapes seen so far but right in others - a Yes/No read through
// Coalesce, two queued Select() calls. The hook passes them back as context; a direct run prints WARN.
//
// --fix (direct mode) rewrites each single-line formula that contains ": " (rule 1) into a block
// scalar, which is lossless: `Text: ="a: b"` becomes `Text: |-` with `="a: b"` on the next line.
// A line that also holds " #" is left alone and reported - the # may be a YAML comment.
//
// Hook:       PostToolUse, file path from the stdin JSON (exit 2 with findings on stderr). The plugin
//             runs it with --plugin, which stands down where the project's harness copy runs it.
// Direct:     node check-pa-yaml.mjs [--fix] <file.pa.yaml | Src folder>...   - for a project without
//             the hooks wired: exit 0 clean, 1 findings, 2 no .pa.yaml found (not a pass).
// Self-test:  node check-pa-yaml.mjs --selftest
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStdinJson, readFileSafe, hookFilePath, loadConfig } from './lib.mjs';

export function checkPaYaml(text, { fileCount = null, ceiling = 50, warnAt = 45 } = {}) {
  const problems = [];
  const lines = text.split(/\r?\n/);
  let block = null; // { keyIndent, baseIndent } while inside a block scalar

  lines.forEach((line, i) => {
    const n = i + 1;
    const indent = line.match(/^ */)[0].length;
    const blank = line.trim() === '';

    // Block-scalar tracking: a continuation line indented LESS than the block's base ends the
    // block, and YAML then reports "found invalid mapping" far BELOW the real fault.
    if (block) {
      if (blank) return;
      if (/^\s*#/.test(line)) {
        // A comment at the key's indent or shallower ends the block as a key does (section banners
        // between controls compile). One at the formula's indent IS formula text, and # is not a
        // Power Fx comment: the compile fails. In between, skip it and keep scanning.
        const base = block.baseIndent === null ? indent : block.baseIndent;
        if (indent > block.keyIndent && indent >= base) {
          problems.push(`${n}: a # comment inside a block scalar is part of the formula, and # is not a Power Fx comment - ` +
            `the compile fails. Use // inside a formula, or move the note out of it.`);
          if (block.baseIndent === null) block.baseIndent = indent;
        }
        if (indent <= block.keyIndent) block = null;
        return;
      }
      if (block.baseIndent === null) block.baseIndent = indent;
      if (indent > block.keyIndent && indent < block.baseIndent) {
        problems.push(`${n}: line is indented ${indent} but its block scalar started at ${block.baseIndent} - ` +
          `this ends the formula early and the parser will report "invalid mapping" somewhere below. ` +
          `Derive indentation from the neighbouring line, never a literal.`);
      }
      if (indent > block.keyIndent) return; // still inside the formula
      block = null;
    }

    // 1. Colon-space inside a single-line Power Fx value - breaks the YAML scanner even inside
    //    a quoted string. Fine inside a block scalar (`OnSelect: |`), fatal after `=`.
    const m = line.match(/^\s+[A-Za-z0-9_]+: =(.*)$/);
    if (m && m[1].includes(': ')) {
      problems.push(`${n}: colon-space inside a single-line Power Fx value breaks the YAML scanner, ` +
        `even inside a quoted string. Build it as & ":" & " " or move the formula into a block scalar (| ).\n` +
        `     ${m[1].slice(0, 90)}`);
    }

    // 2. " #" in a single-line value starts a YAML comment and silently cuts the formula there
    //    ("Order #" lost the rest of its formula). Full-line comments between controls and properties
    //    are NOT compile faults - a 33-screen app full of section banners compiled with 0 errors - so
    //    they pass (a round trip may drop them; keep reasoning in the commit or the decisions log).
    const sv = line.match(/^\s+[A-Za-z0-9_]+: (=.*)$/);
    if (sv && /\s#/.test(sv[1])) {
      problems.push(`${n}: " #" in a single-line value starts a YAML comment and cuts the formula there. ` +
        `Write "No." (or Char(35) for the #), or move the formula into a block scalar (| ).\n     ${sv[1].slice(0, 90)}`);
    }

    // 3. Tooltip on a modern (Fluent) Button: a hard bind error. Labels and some classic
    //    controls do take Tooltip, which is why it looks legal.
    if (/^\s+Tooltip: =/.test(line) && /^Button(@|$)/.test(controlAbove(lines, i) || '')) {
      problems.push(`${n}: the modern Button has no Tooltip property - a bind error, not a warning. Use AccessibleLabel.`);
    }

    // 5. AccessibleLabel on a classic Label: "Unknown property", a compile error, although the
    //    same Label takes Tooltip. Its Text is its name; a clickable tab is better built as a Button.
    if (/^\s+AccessibleLabel: /.test(line) && /^(Classic\/)?Label(@|$)/.test(controlAbove(lines, i) || '')) {
      problems.push(`${n}: a classic Label has no AccessibleLabel property - "Unknown property", a compile error. ` +
        `Its Text is its accessible name; build a clickable tab or link as a Button, which takes AccessibleLabel.`);
    }

    // Enter a block scalar: `Key: |`, `|-`, `|+`, `>`, `>-` ...
    const b = line.match(/^(\s*)[A-Za-z0-9_]+:\s*[|>][-+]?\s*$/);
    if (b) block = { keyIndent: b[1].length, baseIndent: null };
  });

  // 6. A zero guard on an aggregate. Sum, Average, Min and Max over an empty (or not yet loaded)
  //    table return Blank, and Blank = 0 is false while Blank <> 0 is true: If(Sum(t, x) = 0, "-",
  //    y / Sum(t, x)) still divides by zero (the player shows the error banner), and
  //    If(Sum(t, x) <> 0, a, b) takes the wrong branch. CountRows and CountIf return 0 and pass.
  for (const f of propertyFormulas(lines)) {
    const code = codeOf(f.src);
    for (const g of zeroGuards(f.src)) {
      problems.push(`${lineAt(f, code, g.at)}: ${f.key} compares ${g.call.slice(0, 60)} with ${g.op} 0, but ${g.fn} over an empty or loading table is Blank, ` +
        `and Blank ${g.op} 0 is ${g.op === '=' ? 'false - the guard falls through' : 'true - the wrong branch runs'}. Write Coalesce(${g.fn}(...), 0) ${g.op} 0.`);
    }
  }

  // 4. File ceiling: over it the compile is refused, and a subset compile EVICTS the excluded
  //    screens from the session, so publishing ships an app with screens missing.
  if (fileCount !== null) {
    if (fileCount > ceiling) {
      problems.push(`Src holds ${fileCount} .pa.yaml files - over the ${ceiling}-file ceiling. The compile will be ` +
        `refused. Fold a screen into a full-screen overlay before adding another.`);
    } else if (fileCount >= warnAt) {
      problems.push(`Src holds ${fileCount} .pa.yaml files - approaching the ${ceiling}-file ceiling. Fold an ` +
        `admin/config screen into an overlay before adding more.`);
    }
  }
  return problems;
}

// The control a property line belongs to: the nearest `Control:` line above it.
function controlAbove(lines, i) {
  for (let j = i; j >= 0 && j > i - 40; j--) {
    const c = lines[j].match(/^\s+Control: ([\w/@.]+)/);
    if (c) return c[1];
  }
  return null;
}

// Every property formula, single-line or block scalar: { key, line, first, src } (first: the line the
// formula text starts on).
export function propertyFormulas(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const one = lines[i].match(/^(\s+)([A-Za-z0-9_]+): (=.*)$/);
    if (one) { out.push({ key: one[2], line: i + 1, first: i + 1, src: one[3] }); continue; }
    const b = lines[i].match(/^(\s+)([A-Za-z0-9_]+):\s*[|>][-+]?\s*$/);
    if (!b) continue;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() !== '' && l.match(/^ */)[0].length <= b[1].length) break;
      body.push(l);
    }
    out.push({ key: b[2], line: i + 1, first: i + 2, src: body.join('\n') });
    i = j - 1;
  }
  return out;
}

// Formula text with string contents and comments removed, so a match never lands inside "...".
export function codeOf(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      for (; j < src.length; j++) { if (src[j] === '"') { if (src[j + 1] === '"') { j++; continue; } break; } }
      out += '""'; i = j; continue;
    }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; out += ' '; continue; }
    out += ch;
  }
  return out;
}

// The file line of a position in codeOf(f.src) (newlines are kept, except inside a multi-line string).
const lineAt = (f, code, at) => f.first + (code.slice(0, at).match(/\n/g) || []).length;

// Index of the parenthesis closing the one at `open`, skipping 'quoted names' (they hold parentheses).
function closeOf(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === "'") { const e = code.indexOf("'", i + 1); if (e < 0) return -1; i = e; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

// Split at a top-level separator: ',' between arguments, ';' between statements.
function splitTop(code, sep) {
  const parts = []; let depth = 0, cur = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "'") { const e = code.indexOf("'", i + 1); const end = e < 0 ? code.length - 1 : e; cur += code.slice(i, end + 1); i = end; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// Aggregates compared with = 0 or <> 0 that are not wrapped in Coalesce (or tested with IsBlank).
export function zeroGuards(src) {
  const code = codeOf(src);
  const found = [];
  for (const m of code.matchAll(/(^|[^A-Za-z0-9_.'])(Sum|Average|Min|Max)\s*\(/g)) {
    const start = m.index + m[1].length;
    const open = code.indexOf('(', start);
    const close = closeOf(code, open);
    if (close < 0) continue;
    const call = code.slice(start, close + 1);
    if (code.includes('IsBlank(' + call)) continue;
    const after = code.slice(close + 1).match(/^\s*(<>|=)\s*0(?![\d.])/);
    const before = code.slice(0, start).match(/(?<![\d.])0\s*(<>|(?<![<>!])=)\s*$/);
    const op = after ? after[1] : before ? before[1] : null;
    if (op) found.push({ fn: m[2], call, op, at: start });
  }
  return found;
}

// Notes: wrong in the shapes seen, right in others, so they inform and do not block.
const CONTROL_OUTPUTS = /^(Value|Checked|Selected|SelectedDate|Pressed|IsSelected|Default|Visible|Text)$/i;
export function formulaNotes(text) {
  const notes = [];
  for (const f of propertyFormulas(text.split(/\r?\n/))) {
    const code = codeOf(f.src);
    // a. Coalesce(<row>.'Yes/No column', false) compiles and always reads false: a Dataverse Yes/No
    //    column surfaces as a two-option set, so a saved Yes shows unticked and the next save writes No.
    for (const m of code.matchAll(/(^|[^A-Za-z0-9_.'])Coalesce\s*\(/g)) {
      const open = code.indexOf('(', m.index + m[1].length);
      const close = closeOf(code, open);
      if (close < 0) continue;
      const args = splitTop(code.slice(open + 1, close), ',').map((a) => a.trim());
      if (args.length !== 2 || !/^(true|false)$/i.test(args[1])) continue;
      // Only <record>.'Quoted Column': a Dataverse display name. A bare name is usually a collection
      // column the app built as a real boolean, and LookUp(...).Flag with a fallback is the right
      // spelling for a row that may be missing - both measured as false alarms on a real app.
      const col = args[0].match(/^[A-Za-z_][A-Za-z0-9_]*\s*\.\s*'([^']+)'$/);
      if (!col || CONTROL_OUTPUTS.test(col[1])) continue;
      notes.push(`${lineAt(f, code, m.index + m[1].length)}: ${f.key} reads ${args[0].slice(0, 50)} through Coalesce(..., ${args[1]}). On a Dataverse Yes/No column this ` +
        `compiles and always reads ${args[1].toLowerCase()} (the column is a two-option set, not a boolean). Compare with the option: ` +
        `<row>.'Flag' = 'Flag (Table)'.Yes, and patch If(x, 'Flag (Table)'.Yes, 'Flag (Table)'.No). A boolean column you built yourself is fine.`);
    }
    // b. Two Select() statements in one behaviour formula: Select queues, so the second runs before
    //    the first's data lands - a build selected after a load ran on empty collections.
    if (/^On[A-Z]/.test(f.key)) {
      const sel = splitTop(code.replace(/^\s*=/, ''), ';').filter((st) => /^\s*=?\s*Select\s*\(/.test(st));
      if (sel.length >= 2) {
        notes.push(`${f.first}: ${f.key} queues ${sel.length} Select() calls. Each runs after this formula and does not wait for the one ` +
          `before: if a later one reads what an earlier one loads, it runs on empty data. Run the load inline here, then one Select.`);
      }
    }
  }
  return [...new Set(notes)];
}

// --fix for rule 1: a single-line formula holding ": " becomes a block scalar. Lossless: the value
// of `Key: =x` and of `Key: |-` followed by an indented `=x` is the same string.
export function fixColons(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let fixed = 0; const skipped = [];
  const out = text.split(/\r?\n/).flatMap((line, i) => {
    const m = line.match(/^(\s+)([A-Za-z0-9_]+): (=.*)$/);
    if (!m || !m[3].includes(': ')) return [line];
    if (/\s#/.test(m[3])) { skipped.push(i + 1); return [line]; }
    fixed++;
    return [`${m[1]}${m[2]}: |-`, `${m[1]}  ${m[3].trimEnd()}`];
  });
  return { text: out.join(eol), fixed, skipped };
}

function selftest() {
  const bad = [
    'Screens:',
    '  Home:',
    '    Children:',
    '      - lblTotal:',
    '          Control: Label',
    '          Properties:',
    '            Text: ="Total: " & gblTotal',
    '            Tooltip: ="Order #" & gblNo',
    '            AccessibleLabel: ="Total"',
    '            OnVisible: |',
    '              =Set(a, 1);',
    '              # load the rows',
    '              Set(b, 2)',
    '      - btnSave:',
    '          Control: Button',
    '          Properties:',
    '            Tooltip: ="Save"',
    '            OnSelect: |',
    '              =Set(a, 1);',
    '             Set(b, 2);',
    '              Set(c, 3)',
    '      - lblShare:',
    '          Control: Label',
    '          Properties:',
    '            Text: =If(Sum(colLines, Amount) = 0, "-", Text(gblSpend / Sum(colLines, Amount)))',
    '            Visible: |-',
    '              =If(Sum(Filter(colLines, Kind = "Budget"), Amount) <> 0, true, false)',
  ].join('\n');
  const good = [
    'Screens:',
    '  Home:',
    '    Children:',
    '      - lblTotal:',
    '          Control: Label',
    '          Properties:',
    '            Text: ="Total:" & " " & gblTotal',
    '            Tooltip: ="Running total"',
    '            OnVisible: |',
    '              =Set(a, 1);',
    '              // a Power Fx comment is fine',
    '              Set(b, 2)',
    '      # ---------- Shared app shell ----------',
    '      - recBand:',
    '          Control: Rectangle',
    '          Properties:',
    '            # the band behind the header',
    '            Fill: =ColorValue("#1F3A5F")',
    '      - btnSave:',
    '          Control: Button',
    '          Properties:',
    '            AccessibleLabel: ="Save"',
    '            OnSelect: |-',
    '              =Patch(T, r, {locOpen: true});',
    '              Set(b, 2)',
    '      - lblShare:',
    '          Control: Label',
    '          Properties:',
    '            Tooltip: ="Share of the budget"',
    '            Text: =If(Coalesce(Sum(colLines, Amount), 0) = 0, "-", Text(gblSpend / Sum(colLines, Amount)))',
    '            Visible: |-',
    '              =If(IsBlank(Sum(colLines, Amount)) || Sum(colLines, Amount) = 0, false, CountRows(colLines) <> 0 && Sum(colLines, Amount) > 0)',
    '      - icoInfo:',
    '          Control: Classic/Icon',
    '          Properties:',
    '            AccessibleLabel: ="Information"',
    '            OnSelect: |-',
    '              =Select(btnLoad)',
    '            Visible: =CountIf(colLines, Amount = 0) = 0 && Sum(colLines, Amount) >= 0',
  ].join('\n');
  const pb = checkPaYaml(bad, { fileCount: 51 });
  const pg = checkPaYaml(good, { fileCount: 12 });
  const want = ['colon-space', 'starts a YAML comment', 'not a Power Fx comment', 'Tooltip', 'indented', 'ceiling', 'classic Label has no AccessibleLabel',
    'with = 0', 'with <> 0'];
  const missing = want.filter((w) => !pb.some((p) => p.includes(w)));
  // Notes: a Yes/No read through Coalesce, and two queued Selects. Green: the option comparison, a
  // control's own value, one Select after an inline load, and Selects on exclusive branches.
  const noteBad = [
    '          Properties:',
    "            Default: =Coalesce(gblProject.'Is Active', false)",
    '            OnVisible: |-',
    '              =Select(btnLoad);',
    '              Select(btnBuild)',
  ].join('\n');
  const noteGood = [
    '          Properties:',
    "            Default: =gblProject.'Is Active' = 'Is Active (Projects)'.Yes",
    '            Visible: =Coalesce(tglShowAll.Value, false)',
    '            Text: =Coalesce(gblProject.Name, "")',
    '            OnVisible: |-',
    '              =ClearCollect(colLines, Filter(Lines, Project = gblProject));',
    '              Select(btnBuild)',
    '            OnSelect: =If(gblFull, Select(btnFull), Select(btnQuick))',
    '            Fill: =If(Coalesce(LookUp(colLocks, Period = ThisItem.Name).Locked, false), clrMuted, clrSurface)',
    '            Color: =If(Coalesce(ThisItem.Locked, false), clrMuted, clrText)',
  ].join('\n');
  const nb = formulaNotes(noteBad), ng = formulaNotes(noteGood);
  const notesOk = nb.length === 2 && nb.some((x) => x.includes('Coalesce')) && nb.some((x) => x.includes('Select()')) && ng.length === 0;
  // --fix: the colon line becomes a block scalar that passes rule 1; a line with " #" is left alone.
  const fx = fixColons(['    Children:', '          Properties:', '            Text: ="Total: " & gblTotal', '            Tooltip: ="No: " & " #" & n'].join('\r\n'));
  const fixOk = fx.fixed === 1 && fx.skipped.length === 1 && fx.skipped[0] === 4 &&
    fx.text.includes('            Text: |-\r\n              ="Total: " & gblTotal') && !checkPaYaml(fx.text).some((p) => p.startsWith('3:'));
  // Plugin mode: runs where the session's folder has no harness copy, stands down where it has one.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-yaml-plugin-'));
  fs.mkdirSync(path.join(tmp, 'Src'));
  const f = path.join(tmp, 'Src', 'Screen1.pa.yaml');
  fs.writeFileSync(f, bad);
  const run = () => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--plugin'],
    { input: JSON.stringify({ cwd: tmp, tool_input: { file_path: f } }), encoding: 'utf8' }).status;
  const bare = run();
  fs.mkdirSync(path.join(tmp, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude', 'hooks', 'check-pa-yaml.mjs'), "// a project's own, older hook");
  const withOwnHook = run();
  fs.writeFileSync(path.join(tmp, '.claude', 'hooks', 'check-pa-yaml.mjs'), fs.readFileSync(fileURLToPath(import.meta.url)));
  const withHarness = run();
  // A file with notes only does not block: exit 0 with the notes as context.
  fs.writeFileSync(f, ['Screens:', '  Home:', '    Children:', '      - conMain:', '          Control: GroupContainer', noteBad].join('\n'));
  const noteRun = spawnSync(process.execPath, [fileURLToPath(import.meta.url)],
    { input: JSON.stringify({ cwd: tmp, tool_input: { file_path: f } }), encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  const pluginOk = bare === 2 && withOwnHook === 2 && withHarness === 0;
  const noteHookOk = noteRun.status === 0 && /additionalContext/.test(noteRun.stdout) && /Select\(\)/.test(noteRun.stdout);
  const ok = missing.length === 0 && pg.length === 0 && pluginOk && notesOk && fixOk && noteHookOk;
  console.log(ok ? `selftest ok: bad fixture -> ${pb.length} findings, good fixture -> 0, notes 2 on bad and 0 on good, --fix converts and skips " #", ` +
                   `plugin mode runs without a harness or beside a project's own hook and stands down only for its harness copy, notes do not block the hook`
                 : `selftest FAILED: missing [${missing.join(', ')}] on bad; ${pg.length} false finding(s) on good:\n  ${pg.join('\n  ')}` +
                   (notesOk ? '' : `\n  notes: ${nb.length} on bad (want 2), ${ng.length} on good (want 0):\n  ${[...nb, ...ng].join('\n  ')}`) +
                   (fixOk ? '' : `\n  --fix: fixed ${fx.fixed}, skipped [${fx.skipped}]:\n${fx.text}`) +
                   (noteHookOk ? '' : `\n  notes in hook mode: exit ${noteRun.status}, stdout ${noteRun.stdout.slice(0, 200)}`) +
                   (pluginOk ? '' : `\n  plugin mode: exit ${bare} without a harness (want 2), ${withOwnHook} beside a project's own hook (want 2), ${withHarness} with the harness copy (want 0)`));
  process.exit(ok ? 0 : 1);
}

function direct(paths, { fix = false } = {}) {
  const files = [];
  const visit = (p) => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) visit(path.join(p, f)); return; }
    if (p.endsWith('.pa.yaml') && !/(^|[\\/])_EditorState\.pa\.yaml$/.test(p)) files.push(p);
  };
  paths.forEach(visit);
  if (!files.length) { console.error('No .pa.yaml files found under: ' + paths.join(', ') + ' - this is NOT a pass.'); process.exit(2); }
  const cfg = loadConfig();
  let bad = 0;
  for (const f of files) {
    const dir = path.dirname(f);
    const fileCount = path.basename(dir) === 'Src' ? fs.readdirSync(dir).filter((x) => x.endsWith('.pa.yaml')).length : null;
    let text = readFileSafe(f) || '';
    if (fix) {
      const r = fixColons(text);
      if (r.fixed) { fs.writeFileSync(f, r.text); text = r.text; console.log(`FIXED ${f}: ${r.fixed} single-line formula(s) with ": " moved into a block scalar`); }
      if (r.skipped.length) console.log(`WARN  ${f}: line(s) ${r.skipped.join(', ')} hold ": " and " #" - not rewritten (the # may be a YAML comment); fix by hand`);
    }
    const problems = checkPaYaml(text, { fileCount, ceiling: cfg.canvasFileCeiling, warnAt: cfg.canvasFileWarnAt });
    if (problems.length) { bad++; console.log(`FAIL  ${f}\n  ` + problems.join('\n  ')); }
    for (const w of formulaNotes(text)) console.log(`WARN  ${path.basename(f)}:${w}`);
  }
  console.log(`${files.length} .pa.yaml file(s) checked, ${bad} with faults that break a compile or a zero guard.`);
  process.exit(bad ? 1 : 0);
}

// The harness copy runs this same check, so the plugin stands down - but only for THIS script. A project
// whose own, older hook has the same name would otherwise silence every newer check here.
export function harnessRuns(cwd) {
  const norm = (t) => String(t || '').replace(/\r\n/g, '\n');
  const copy = readFileSafe(path.join(cwd, '.claude', 'hooks', 'check-pa-yaml.mjs'));
  return !!copy && norm(copy) === norm(readFileSafe(fileURLToPath(import.meta.url)));
}

const pathArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (process.argv.includes('--selftest')) selftest();
else if (pathArgs.length) direct(pathArgs, { fix: process.argv.includes('--fix') });
else {
  const input = readStdinJson();
  const file = hookFilePath(input);
  if (!file || !file.endsWith('.pa.yaml')) process.exit(0);
  // From the plugin (--plugin): stand down where the session's folder has the harness copy, which runs
  // the same check; otherwise run it, so a session opened at a parent folder is still covered.
  if (process.argv.includes('--plugin') && harnessRuns(input.cwd || process.cwd())) process.exit(0);
  const text = readFileSafe(file);
  if (!text) process.exit(0);
  const cfg = loadConfig();
  let fileCount = null;
  try {
    const dir = path.dirname(file);
    if (path.basename(dir) === 'Src') fileCount = fs.readdirSync(dir).filter((f) => f.endsWith('.pa.yaml')).length;
  } catch { /* unreadable directory - not this hook's problem */ }
  const problems = checkPaYaml(text, { fileCount, ceiling: cfg.canvasFileCeiling, warnAt: cfg.canvasFileWarnAt });
  const notes = formulaNotes(text);
  const noteText = notes.length ? `\n\nAlso worth a look (not blocking):\n  ` + notes.join('\n  ') : '';
  if (problems.length === 0) {
    if (notes.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext:
      `pa.yaml notes for ${path.basename(file)} (not blocking; references/power-fx-and-pa-yaml.md):\n  ` + notes.join('\n  ') } }));
    process.exit(0);
  }
  console.error(`pa.yaml check failed for ${path.basename(file)} - each of these breaks a real compile or a real guard:\n\n  ` +
    problems.join('\n  ') + `\n\nFix before compiling: the compile is all-or-nothing across every file. ` +
    `A colon-space line can be rewritten for you: node check-pa-yaml.mjs --fix <file>.` + noteText);
  process.exit(2);
}
