// PostToolUse hook (matcher: Write|Edit): a reminder when an edit touches something another app
// shares - a table with a shared prefix (a reference layer several apps read) - so the change is
// recorded where the other apps' owners will see it. Non-blocking; silent for every other edit.
//
// Configure in .claude/hooks/standards.config.json:
//   "shared": { "prefixes": ["core_"], "registry": "docs/shared-registry.md", "syncLog": "docs/sync-log.md" }
// With no prefixes configured the hook does nothing. shared-environments.md has the protocol.
import { readStdinJson, hookFilePath, loadConfig } from './lib.mjs';

export function sharedHit(input, shared) {
  const prefixes = (shared && shared.prefixes) || [];
  if (!prefixes.length) return null;
  const ti = (input && input.tool_input) || {};
  const slash = (s) => s.split(String.fromCharCode(92)).join('/');
  const file = slash(hookFilePath(input) || '');
  const own = [shared.registry, shared.syncLog].filter(Boolean).map(slash);
  if (own.some((p) => file.endsWith(p))) return null;          // editing the registry is the remedy
  const text = [file, ti.content, ti.new_string].filter(Boolean).join('\n');
  const lower = text.toLowerCase();
  // A prefix counts when it starts a word and is followed by a name character (core_people).
  const hits = prefixes.filter((p) => {
    const q = p.toLowerCase();
    for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + 1)) {
      const before = i === 0 ? '' : lower[i - 1];
      const after = lower[i + q.length] || '';
      if (!/[a-z0-9_]/.test(before) && /[a-z0-9]/.test(after)) return true;
    }
    return false;
  });
  return hits.length ? hits : null;
}

function selftest() {
  const shared = { prefixes: ['core_'], registry: 'docs/shared-registry.md', syncLog: 'docs/sync-log.md' };
  const cases = [
    ['edit naming a shared table', { tool_input: { file_path: 'scripts/x.ps1', new_string: "GET core_people" } }, true],
    ['unrelated edit', { tool_input: { file_path: 'scripts/x.ps1', new_string: "GET app_orders" } }, false],
    ['editing the registry itself', { tool_input: { file_path: 'docs/shared-registry.md', new_string: 'core_people' } }, false],
    ['no prefixes configured', { tool_input: { file_path: 'a', new_string: 'core_people' } }, false, {}],
  ];
  let bad = 0;
  for (const [name, input, want, cfg] of cases) {
    const got = !!sharedHit(input, cfg || shared);
    if (got !== want) bad++;
    console.log(`${got === want ? 'ok  ' : 'FAIL'}  ${name}`);
  }
  console.log(`selftest: ${cases.length} case(s), ${bad} failed`);
  process.exit(bad ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else {
  const input = readStdinJson();
  const shared = loadConfig().shared;
  const hits = sharedHit(input, shared);
  if (hits) {
    const msg = `Shared-resource reminder: this edit references ${hits.join(', ')} (shared with other apps). ` +
      `If you changed a shared table, column, choice or contract, record it in ${shared.registry || 'the shared registry'}` +
      `${shared.syncLog ? ' and append to ' + shared.syncLog : ''}, naming the affected apps. Reading shared data needs no entry; ` +
      `never write to a shared table from this app without its owner's agreement.`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }));
  }
  process.exit(0);
}
