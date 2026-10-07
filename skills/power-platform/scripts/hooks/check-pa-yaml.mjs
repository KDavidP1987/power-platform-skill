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
// Hook:       PostToolUse, file path from the stdin JSON (exit 2 with findings on stderr). The plugin
//             runs it with --plugin, which stands down where the project's harness copy runs it.
// Direct:     node check-pa-yaml.mjs <file.pa.yaml | Src folder>...   - for a project without the
//             hooks wired: exit 0 clean, 1 findings, 2 no .pa.yaml found (not a pass).
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
    if (/^\s+Tooltip: =/.test(line)) {
      for (let j = i; j >= 0 && j > i - 30; j--) {
        const c = lines[j].match(/^\s+Control: ([\w/@.]+)/);
        if (c) {
          if (/^Button(@|$)/.test(c[1])) {
            problems.push(`${n}: the modern Button has no Tooltip property - a bind error, not a warning. Use AccessibleLabel.`);
          }
          break;
        }
      }
    }

    // Enter a block scalar: `Key: |`, `|-`, `|+`, `>`, `>-` ...
    const b = line.match(/^(\s*)[A-Za-z0-9_]+:\s*[|>][-+]?\s*$/);
    if (b) block = { keyIndent: b[1].length, baseIndent: null };
  });

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
  ].join('\n');
  const pb = checkPaYaml(bad, { fileCount: 51 });
  const pg = checkPaYaml(good, { fileCount: 12 });
  const want = ['colon-space', 'starts a YAML comment', 'not a Power Fx comment', 'Tooltip', 'indented', 'ceiling'];
  const missing = want.filter((w) => !pb.some((p) => p.includes(w)));
  // Plugin mode: runs where the session's folder has no harness copy, stands down where it has one.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-yaml-plugin-'));
  fs.mkdirSync(path.join(tmp, 'Src'));
  const f = path.join(tmp, 'Src', 'Screen1.pa.yaml');
  fs.writeFileSync(f, bad);
  const run = () => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--plugin'],
    { input: JSON.stringify({ cwd: tmp, tool_input: { file_path: f } }), encoding: 'utf8' }).status;
  const bare = run();
  fs.mkdirSync(path.join(tmp, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude', 'hooks', 'check-pa-yaml.mjs'), '');
  const withHarness = run();
  fs.rmSync(tmp, { recursive: true, force: true });
  const pluginOk = bare === 2 && withHarness === 0;
  const ok = missing.length === 0 && pg.length === 0 && pluginOk;
  console.log(ok ? `selftest ok: bad fixture -> ${pb.length} findings, good fixture -> 0, plugin mode runs without a harness and stands down with one`
                 : `selftest FAILED: missing [${missing.join(', ')}] on bad; ${pg.length} false finding(s) on good:\n  ${pg.join('\n  ')}` +
                   (pluginOk ? '' : `\n  plugin mode: exit ${bare} without a harness (want 2), ${withHarness} with one (want 0)`));
  process.exit(ok ? 0 : 1);
}

function direct(paths) {
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
    const problems = checkPaYaml(readFileSafe(f) || '', { fileCount, ceiling: cfg.canvasFileCeiling, warnAt: cfg.canvasFileWarnAt });
    if (problems.length) { bad++; console.log(`FAIL  ${f}\n  ` + problems.join('\n  ')); }
  }
  console.log(`${files.length} .pa.yaml file(s) checked, ${bad} with faults that break a compile.`);
  process.exit(bad ? 1 : 0);
}

export function harnessRuns(cwd) {
  return fs.existsSync(path.join(cwd, '.claude', 'hooks', 'check-pa-yaml.mjs'));
}

const pathArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (process.argv.includes('--selftest')) selftest();
else if (pathArgs.length) direct(pathArgs);
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
  if (problems.length === 0) process.exit(0);
  console.error(`pa.yaml check failed for ${path.basename(file)} - each of these breaks a real compile:\n\n  ` +
    problems.join('\n  ') + `\n\nFix before compiling: the compile is all-or-nothing across every file.`);
  process.exit(2);
}
