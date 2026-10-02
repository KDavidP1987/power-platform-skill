// PostToolUse hook (matcher: Write|Edit): output standards for the file just written.
//
// Optional. By default it flags emoji and purple/violet accent colours (including Power Fx
// RGBA(...) values) in UI source and docs, so deliverables read as professional work. Turn
// either rule off in .claude/hooks/standards.config.json. Exempt a line by putting
// `standards-ignore` in a comment on it.
import path from 'node:path';
import { readStdinJson, readFileSafe, hookFilePath, isTextFile, isProse, isHookFile, findEmoji, findPurple, loadConfig } from './lib.mjs';

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
