#!/usr/bin/env node
// Does --check-versions actually catch a version somebody forgot to bump?
//
//   node scripts/tests/check-versions.test.mjs
//
// Builds a throwaway repository in the system temp directory for each case, so
// nothing here depends on the real repository's current version numbers. Every
// "drift" case must be caught; every "agree" case must pass. No dependencies.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const { checkVersions } = await import(
  new URL("../validate-skills.mjs", import.meta.url).href + "?test=1"
);

const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

// Build a minimal repository. Each argument overrides one written version.
function fixture({ plugin = "0.3.0", entry = "0.3.0", badge = "0.3.0", skill = "0.1.4", skillReadme = "0.1.4", omitBadge = false, omitSkillReadme = false, pkg, changelog } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cv-"));
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x", version: plugin }));
  writeFileSync(join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "x", plugins: [{ name: "x", source: "./", version: entry }] }));
  writeFileSync(join(dir, "README.md"), omitBadge
    ? "# demo\n\nno badge here\n"
    : `# demo\n\n[![plugin ${badge}](https://img.shields.io/badge/plugin-${badge}-1F3A5F)](.claude-plugin/plugin.json)\n`);
  writeFileSync(join(dir, "skills", "demo", "SKILL.md"),
    `---\nname: demo\ndescription: x\nmetadata:\n  version: "${skill}"\n---\n\n# Demo\n`);
  if (pkg !== undefined) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: pkg }));
  if (changelog !== undefined) writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  if (!omitSkillReadme) {
    writeFileSync(join(dir, "skills", "demo", "README.md"),
      `# demo\n\nVersion ${skillReadme} · MIT · an Agent Skill\n`);
  }
  return dir;
}

// Run one case with stdout captured, so a drift message does not look like a failure.
function run(args, dir) {
  const said = [];
  const real = console.log;
  console.log = (...a) => said.push(a.join(" "));
  let code;
  try { code = checkVersions(args, dir); } finally { console.log = real; }
  return { code, out: said.join("\n") };
}

const cases = [
  // [name, fixture overrides, args, must it fail?, the text the message must name]
  ["everything agrees", {}, [], false, null],
  ["package.json agrees", { pkg: "0.3.0" }, [], false, null],
  ["package.json stale", { pkg: "0.2.4" }, [], true, "package.json"],
  ["changelog agrees, Unreleased skipped", { changelog: "# Changelog\n\n## [Unreleased]\n\n## [0.3.0] - 2026-01-01\n" }, [], false, null],
  ["changelog stale", { changelog: "# Changelog\n\n## [0.2.4] - 2026-01-01\n" }, [], true, "CHANGELOG.md newest release"],
  ["changelog with no release", { changelog: "# Changelog\n\n## [Unreleased]\n" }, [], true, "no released version heading"],
  ["marketplace entry stale", { entry: "0.2.4" }, [], true, "marketplace.json"],
  ["README badge stale", { badge: "0.2.4" }, [], true, "README.md plugin badge"],
  ["badge label and url disagree", { badge: "0.3.0" }, [], false, null],
  ["skill README stale", { skillReadme: "0.1.3" }, [], true, "skills/demo/README.md"],
  ["a skill version differing from the plugin version is fine", { skill: "0.1.4", skillReadme: "0.1.4" }, [], false, null],
  ["no badge at all is reported", { omitBadge: true }, [], true, "no plugin version badge"],
  ["a skill without a README is allowed", { omitSkillReadme: true }, [], false, null],
  // the optional exact-assertion mode, which D20 of alignment-v0-1 depends on
  ["--plugin matching", {}, ["--plugin", "0.3.0"], false, null],
  ["--plugin not matching", {}, ["--plugin", "0.9.9"], true, "plugin.json version"],
  ["--skill matching", {}, ["--skill", "demo=0.1.4"], false, null],
  ["--skill not matching", {}, ["--skill", "demo=9.9.9"], true, "metadata.version"],
  ["--skill naming a skill that is not there", {}, ["--skill", "ghost=1.0.0"], true, "missing"],
];

for (const [name, overrides, args, mustFail, needle] of cases) {
  const dir = fixture(overrides);
  try {
    const { code, out } = run(args, dir);
    if (mustFail) {
      ok(code === 1, `${name}: expected exit 1, got ${code}`);
      ok(needle === null || out.includes(needle), `${name}: message did not name ${needle} — got: ${out}`);
    } else {
      ok(code === 0, `${name}: expected exit 0, got ${code} — ${out}`);
      ok(out.includes("versions ok"), `${name}: expected "versions ok" — got: ${out}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The badge holds the number twice. A checker that read only one of them would pass
// a half-updated badge, which is exactly the shape of the bug this guards.
{
  const dir = mkdtempSync(join(tmpdir(), "cv-half-"));
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.3.0" }));
  writeFileSync(join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ plugins: [{ source: "./", version: "0.3.0" }] }));
  writeFileSync(join(dir, "README.md"),
    "[![plugin 0.3.0](https://img.shields.io/badge/plugin-0.2.4-1F3A5F)](x)\n");
  const { code, out } = run([], dir);
  ok(code === 1 && out.includes("0.3.0/0.2.4"),
    `half-updated badge must be caught, naming both halves — got ${code}: ${out}`);
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  for (const f of failures) process.stdout.write(`FAIL ${f}\n`);
  process.stdout.write(`check-versions: ${failures.length} failure(s)\n`);
  process.exit(1);
}
process.stdout.write(`check-versions: ok (${cases.length + 1} cases)\n`);
