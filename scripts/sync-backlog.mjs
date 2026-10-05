#!/usr/bin/env node
// sync-backlog.mjs - keep the 1.0 backlog identical in ROADMAP.md, README.md and docs/index.html.
//
// ROADMAP.md is the single source: the markdown table between <!-- backlog:start --> and
// <!-- backlog:end -->. This copies it, unchanged, between the same markers in README.md, and as an
// HTML table between the same markers in docs/index.html (inline markdown: `code`, **bold** and
// [text](url) links are converted; everything else is escaped).
//
//   node scripts/sync-backlog.mjs            write README.md and docs/index.html
//   node scripts/sync-backlog.mjs --check    exit 1 when either differs from ROADMAP.md (CI)
//   node scripts/sync-backlog.mjs --selftest
//
// Exit: 0 in sync (or written); 1 out of sync (--check); 2 nothing to sync (a marker or the table is
// missing) - never a pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '<!-- backlog:start -->';
const END = '<!-- backlog:end -->';

export function between(text, file) {
  const a = text.indexOf(START), b = text.indexOf(END);
  if (a < 0 || b < a) throw new SyncError(`${file}: the ${START} ... ${END} markers are missing`);
  return { before: text.slice(0, a + START.length), body: text.slice(a + START.length, b), after: text.slice(b) };
}

class SyncError extends Error {}

export function parseTable(md) {
  const rows = md.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (rows.length < 3) throw new SyncError('ROADMAP.md: the backlog table has no rows');
  const cells = (l) => l.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  for (const r of body) if (r.length !== head.length) throw new SyncError(`ROADMAP.md: a backlog row has ${r.length} cells, the header ${head.length}: ${r.join(' | ')}`);
  return { head, body };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function inline(s) {
  // Split out code spans first so nothing inside them is formatted.
  return s.split(/(`[^`]*`)/).map((part) => {
    if (/^`[^`]*`$/.test(part)) return '<code>' + esc(part.slice(1, -1)) + '</code>';
    let h = esc(part);
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => `<a href="${u.replace(/^(?!https?:|#|\.\.\/)/, '../')}">${t}</a>`);
    return h;
  }).join('');
}

export function toHtml({ head, body }) {
  const th = head.map((h) => `<th scope="col">${inline(h)}</th>`).join('');
  // data-label carries the column name so a phone layout can show each row as a labelled card.
  const label = head.map((h) => esc(h.replace(/[`*]/g, '')));
  const trs = body.map((r) => '<tr>' + r.map((c, i) => `<td${i === 0 ? ' class="n"' : ''} data-label="${label[i]}">${inline(c)}</td>`).join('') + '</tr>');
  return `\n<table class="backlog">\n<thead><tr>${th}</tr></thead>\n<tbody>\n${trs.join('\n')}\n</tbody>\n</table>\n`;
}

export function sync(root, { check = false } = {}) {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const src = between(read('ROADMAP.md'), 'ROADMAP.md');
  const table = parseTable(src.body);
  const md = '\n' + src.body.trim() + '\n';
  const html = toHtml(table);
  const out = [];
  for (const [file, want] of [['README.md', md], ['docs/index.html', html]]) {
    const text = read(file);
    const cur = between(text, file);
    const same = cur.body.replace(/\r\n/g, '\n') === want;
    if (!same && !check) fs.writeFileSync(path.join(root, file), cur.before + want + cur.after);
    out.push({ file, same });
  }
  return { rows: table.body.length, files: out };
}

function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-backlog-'));
  fs.mkdirSync(path.join(dir, 'docs'));
  const w = (f, t) => fs.writeFileSync(path.join(dir, f), t);
  const roadmap = `# R\n\n${START}\n| # | Item | Status |\n|---|---|---|\n| 1 | A \`code-ish\` item & **bold** | [done](CHANGELOG.md) |\n| 2 | <script> | Open |\n${END}\n`;
  w('ROADMAP.md', roadmap);
  w('README.md', `top\n${START}\nold\n${END}\nbottom\n`);
  w('docs/index.html', `<p>x</p>${START}${END}<p>y</p>`);
  let fail = 0;
  const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
  ok(sync(dir, { check: true }).files.every((f) => !f.same), 'check reports both copies out of date');
  const r = sync(dir);
  ok(r.rows === 2, 'two rows read');
  ok(sync(dir, { check: true }).files.every((f) => f.same), 'after a write, check is clean');
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  ok(readme.startsWith('top\n') && readme.endsWith('bottom\n') && readme.includes('| 2 | <script> | Open |'), 'README keeps its surroundings and gets the markdown');
  const html = fs.readFileSync(path.join(dir, 'docs/index.html'), 'utf8');
  ok(html.includes('&lt;script&gt;') && !html.includes('<script>'), 'HTML escapes raw markup');
  ok(html.includes("<code>code-ish</code>"), 'code spans become <code>');
  ok(html.includes('<strong>bold</strong>') && html.includes('href="../CHANGELOG.md"'), 'bold and relative links converted');
  w('ROADMAP.md', roadmap.replace('| 2 | <script> | Open |', '| 2 | missing a cell |'));
  let threw = false; try { sync(dir, { check: true }); } catch (e) { threw = e instanceof SyncError; }
  ok(threw, 'a malformed row is refused');
  w('ROADMAP.md', '# no markers\n');
  threw = false; try { sync(dir, { check: true }); } catch (e) { threw = e instanceof SyncError; }
  ok(threw, 'missing markers: nothing to sync is an error, not a pass');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail ? `${fail} failed` : 'selftest passed');
  return fail ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('usage: node scripts/sync-backlog.mjs [--check | --selftest]'); process.exit(0); }
  if (args.includes('--selftest')) process.exit(selftest());
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const r = sync(root, { check: args.includes('--check') });
    for (const f of r.files) console.log(`${f.same ? 'in sync ' : args.includes('--check') ? 'DIFFERS ' : 'written '} ${f.file} (${r.rows} rows)`);
    process.exit(args.includes('--check') && r.files.some((f) => !f.same) ? 1 : 0);
  } catch (e) {
    if (e instanceof SyncError) { console.error(e.message); process.exit(2); }
    throw e;
  }
}
