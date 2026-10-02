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
// Self-test:  node check-pa-yaml.mjs --selftest
import path from 'node:path';
import fs from 'node:fs';
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

    // 2. A YAML comment. These files are machine-serialised and round-tripped; comments vanish.
    if (/^\s+#/.test(line)) {
      problems.push(`${n}: comment inside a .pa.yaml - the authoring service round-trips these files ` +
        `and drops comments. Put the reasoning in the commit message or the decisions log.`);
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
    '            # explain the total',
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
  const want = ['colon-space', 'comment', 'Tooltip', 'indented', 'ceiling'];
  const missing = want.filter((w) => !pb.some((p) => p.includes(w)));
  const ok = missing.length === 0 && pg.length === 0;
  console.log(ok ? `selftest ok: bad fixture -> ${pb.length} findings, good fixture -> 0`
                 : `selftest FAILED: missing [${missing.join(', ')}] on bad; ${pg.length} false finding(s) on good:\n  ${pg.join('\n  ')}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--selftest')) selftest();
else {
  const file = hookFilePath(readStdinJson());
  if (!file || !file.endsWith('.pa.yaml')) process.exit(0);
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
