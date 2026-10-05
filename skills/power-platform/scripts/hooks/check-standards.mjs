// PostToolUse hook (matcher: Write|Edit): output standards for the file just written.
//
// Optional. By default it flags emoji and purple/violet accent colours (including Power Fx
// RGBA(...) values) in UI source and docs, so deliverables read as professional work. Turn
// either rule off in .claude/hooks/standards.config.json. Exempt a line by putting
// `standards-ignore` in a comment on it.
//
// Self-test: node check-standards.mjs --selftest (runs the hook on fixtures in a temp folder).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readStdinJson, readFileSafe, hookFilePath, isTextFile, isProse, isHookFile, findEmoji, findPurple, loadConfig } from './lib.mjs';

if (process.argv.includes('--selftest')) selftest();

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-standards-'));
  const self = fileURLToPath(import.meta.url);
  // Fixture values are built, not written literally, so this file passes its own check.
  const rocket = String.fromCodePoint(0x1f680);
  const violet = '#' + '7c3aed';
  const cases = [
    // [name, relative file, content, want blocked, config or null]
    ['emoji in a doc', 'docs/guide.md', `Ship it ${rocket}\n`, true, null],
    ['purple hex in CSS', 'site/theme.css', `.btn { color: ${violet}; }\n`, true, null],
    ['purple RGBA in Power Fx', 'canvas/app/Src/S.pa.yaml', 'Fill: =RGBA(124, 58, 237, 1)\n', true, null],
    ['named purple in code', 'site/app.js', "const c = 'rebeccapurple';\n", true, null],
    ['clean CSS', 'site/ok.css', '.btn { color: #0066b3; }\n', false, null],
    ['named colour word in prose is fine', 'docs/notes.md', 'The violet line in the old chart is gone.\n', false, null],
    ['standards-ignore exempts the line', 'docs/x.md', `${rocket} standards-ignore\n`, false, null],
    ['hook files are skipped', '.claude/hooks/h.mjs', `// ${rocket}\n`, false, null],
    ['binary extension skipped', 'img/a.png', rocket, false, null],
    ['emoji rule turned off', 'docs/off.md', `x ${rocket}\n`, false, { emoji: false }],
  ];
  const fails = [];
  let ran = 0;
  try {
    for (const [name, rel, content, wantBlock, cfg] of cases) {
      const file = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      const cfgFile = path.join(tmp, '.claude', 'hooks', 'standards.config.json');
      if (cfg) { fs.mkdirSync(path.dirname(cfgFile), { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify(cfg)); }
      else fs.rmSync(cfgFile, { force: true });
      const r = spawnSync(process.execPath, [self], { cwd: tmp, input: JSON.stringify({ tool_input: { file_path: file } }), encoding: 'utf8' });
      ran++;
      const blocked = /"decision":"block"/.test(r.stdout || '');
      if (r.status !== 0 || blocked !== wantBlock) fails.push(`${name}: exit ${r.status}, blocked ${blocked}, want ${wantBlock}`);
    }
    // No file in the event: the hook has nothing to check and must not block.
    const none = spawnSync(process.execPath, [self], { cwd: tmp, input: '{}', encoding: 'utf8' });
    ran++;
    if (none.status !== 0 || none.stdout) fails.push('no file in the event: should exit 0 silently');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (!ran) { console.log('selftest examined nothing - NOT a pass'); process.exit(2); }
  console.log(fails.length ? 'selftest FAILED:\n  ' + fails.join('\n  ') : `selftest ok: ${ran} case(s) (emoji, purple hex, RGBA, named colour, clean, prose, ignore marker, hook file, binary, rule off, no file)`);
  process.exit(fails.length ? 1 : 0);
}

const file = hookFilePath(readStdinJson());
if (!file || !isTextFile(file) || isHookFile(file)) process.exit(0);

const cfg = loadConfig();
const text = readFileSafe(file);
const emoji = cfg.emoji ? findEmoji(text) : [];
const purple = cfg.purpleAccents ? findPurple(text, { checkNamed: !isProse(file) }) : [];
if (emoji.length === 0 && purple.length === 0) process.exit(0);

const rel = path.relative(process.cwd(), file);
const lines = [`Standards check flagged ${rel}:`];
if (emoji.length) {
  lines.push(`- ${emoji.length} emoji (${emoji.slice(0, 8).map((e) => `line ${e.line}: ${e.code}`).join('; ')}). ` +
    `Use a named icon or SVG asset instead.`);
}
if (purple.length) {
  lines.push(`- ${purple.length} purple/violet colour(s) (${purple.slice(0, 8).map((p) => `line ${p.line}: ${p.value}`).join('; ')}). ` +
    `Use the project palette (blue, slate, teal and semantic colours).`);
}
const reason = lines.join('\n');
process.stdout.write(JSON.stringify({ decision: 'block', reason,
  hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reason } }));
process.exit(0);
