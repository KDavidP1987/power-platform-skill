#!/usr/bin/env node
// Validate every skill under skills/ against the Agent Skills conventions.
//
//   npm run validate            exit 1 on any error, prints warnings
//   npm run validate -- --table print the README table and exit
//   node scripts/validate-skills.mjs --check-versions [--plugin 0.3.0] [--skill dod=0.1.4 ...]
//                               compare the declared versions in .claude-plugin/plugin.json, the marketplace
//                               plugin entry, package.json, the README badge and Version line, the newest CHANGELOG.md
//                               release and each skill's SKILL.md metadata.version; print `versions ok` or the
//                               mismatches and exit 1
//
// No dependencies. The frontmatter parser handles the subset of YAML a SKILL.md
// actually uses: `key: value`, quoted strings, and `>-` / `|` block scalars.
// Helper scripts under skills/<name>/scripts/ that support --selftest are run with it; a failing selftest fails the skill.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");
const wantTable = process.argv.includes("--table");

if (process.argv.includes("--check-versions")) process.exit(checkVersions(process.argv.slice(2)));

// Each version has exactly one source of truth: .claude-plugin/plugin.json for the
// plugin version, and each skill's SKILL.md for its own. Everywhere else that number
// appears is checked against its source, so no version is ever typed twice. Run bare
// (what CI does) this needs no arguments and so cannot itself drift. The optional
// --plugin / --skill arguments additionally assert exact numbers, for a release script
// that knows what it is releasing.
export function checkVersions(args, base = root) {
  const opt = (name) => { const k = args.indexOf(name); return k === -1 ? undefined : args[k + 1]; };
  const want = { plugin: opt("--plugin"), skills: args.flatMap((a, i) => (a === "--skill" ? [args[i + 1]] : [])).map((x) => x.split("=")) };
  if (want.skills.some((x) => x.length !== 2)) { console.error("usage: --check-versions [--plugin <v>] [--skill <name>=<v> ...]"); return 1; }
  const mismatches = [];
  const read = (p) => readFileSync(join(base, p), "utf8");
  const has = (p) => existsSync(join(base, p));

  // --- the plugin version, and everywhere it is repeated ------------------
  const plugin = JSON.parse(read(join(".claude-plugin", "plugin.json"))).version;
  const entry = JSON.parse(read(join(".claude-plugin", "marketplace.json"))).plugins?.find((p) => p.source === "./")?.version;
  if (entry !== plugin) mismatches.push(`.claude-plugin/marketplace.json plugin entry version ${entry ?? "(none)"} ≠ plugin.json ${plugin}`);
  if (has("README.md")) {
    // [![plugin 0.3.0](https://img.shields.io/badge/plugin-0.3.0-1F3A5F)](...) — the
    // number appears twice in one line, and both must agree with plugin.json.
    const badge = read("README.md").match(/\[!\[plugin ([^\]]+)\]\(https:\/\/img\.shields\.io\/badge\/plugin-([^-]+)-/);
    if (!badge) mismatches.push("README.md has no plugin version badge to check");
    else if (badge[1] !== plugin || badge[2] !== plugin) {
      mismatches.push(`README.md plugin badge ${badge[1]}/${badge[2]} ≠ plugin.json ${plugin}`);
    }
  }
  if (has("README.md")) {
    // The prose line under the title: "Version 0.3.0 · MIT · an Agent Skill by ...".
    const line = read("README.md").match(/^Version\s+(\S+)/m);
    if (line && line[1] !== plugin) mismatches.push(`README.md Version ${line[1]} ≠ plugin.json ${plugin}`);
  }
  if (has("package.json")) {
    const pkg = JSON.parse(read("package.json")).version;
    if (pkg !== undefined && pkg !== plugin) mismatches.push(`package.json version ${pkg} ≠ plugin.json ${plugin}`);
  }
  if (has("CHANGELOG.md")) {
    // Keep a Changelog: the newest released heading is "## [0.3.0] - 2026-01-01"; [Unreleased] is skipped.
    const top = [...read("CHANGELOG.md").matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]).find((v) => !/^unreleased$/i.test(v));
    if (!top) mismatches.push("CHANGELOG.md has no released version heading to check");
    else if (top !== plugin) mismatches.push(`CHANGELOG.md newest release ${top} ≠ plugin.json ${plugin}`);
  }
  if (want.plugin !== undefined && plugin !== want.plugin) {
    mismatches.push(`.claude-plugin/plugin.json version ${plugin} ≠ ${want.plugin}`);
  }

  // --- each skill's own version, and its README line ----------------------
  const skills = has("skills")
    ? readdirSync(join(base, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  const skillVersion = (name) => {
    const p = `skills/${name}/SKILL.md`;
    if (!has(p)) return null;
    return read(p).match(/^ {2}version:\s*"?([^"\r\n]+)"?\s*$/m)?.[1] ?? null;
  };
  for (const name of skills) {
    const have = skillVersion(name);
    if (have === null) continue;                    // no SKILL.md version; the main validator reports that
    const rp = `skills/${name}/README.md`;
    if (!has(rp)) continue;                          // a skill need not ship a README
    // "Version 0.1.0 · MIT · an Agent Skill by …" — the first such line in the file.
    const line = read(rp).match(/^Version\s+(\S+)/m);
    if (!line) mismatches.push(`${rp} has no "Version <v>" line to check`);
    else if (line[1] !== have) mismatches.push(`${rp} Version ${line[1]} ≠ ${name}/SKILL.md ${have}`);
  }
  for (const [name, v] of want.skills) {
    const p = `skills/${name}/SKILL.md`;
    if (!has(p)) { mismatches.push(`${p} missing`); continue; }
    const have = skillVersion(name);
    if (have !== v) mismatches.push(`${p} metadata.version ${have ?? "(none)"} ≠ ${v}`);
  }

  for (const m of mismatches) console.log(m);
  if (!mismatches.length) console.log("versions ok");
  return mismatches.length ? 1 : 0;
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESC = 1024;
const SOFT_MAX_LINES = 500;
const TEMPLATE_MARKERS = ["__NAME__", "__TITLE__", "__DESCRIPTION__", "__TRIGGER__", "<the words a user would actually type>"];

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { error: "SKILL.md must start with a `---` frontmatter block" };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { error: "frontmatter block is not closed with `---`" };
  const block = text.slice(text.indexOf("\n") + 1, end);
  const body = text.slice(end + 4);
  const data = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue; // nested keys (metadata:) — ignored, but allowed
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) return { error: `cannot parse frontmatter line ${i + 1}: ${line}` };
    const [, key, rawVal] = m;
    let val = rawVal.trim();
    if (val === ">-" || val === ">" || val === "|" || val === "|-") {
      const parts = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        parts.push(lines[++i].trim());
      }
      val = val.startsWith(">") ? parts.join(" ").trim() : parts.join("\n").trim();
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    data[key] = val;
  }
  return { data, body };
}

function checkSkill(name) {
  const dir = join(skillsDir, name);
  const errors = [];
  const warnings = [];
  const skillFile = join(dir, "SKILL.md");

  if (!existsSync(skillFile)) return { name, errors: ["missing SKILL.md"], warnings, description: "" };
  const text = readFileSync(skillFile, "utf8");
  const fm = parseFrontmatter(text);
  if (fm.error) return { name, errors: [fm.error], warnings, description: "" };
  const { data, body } = fm;

  if (!NAME_RE.test(name) || name.length > MAX_NAME) errors.push(`folder name must be kebab-case, ≤ ${MAX_NAME} chars`);
  if (!data.name) errors.push("frontmatter is missing `name:`");
  else if (data.name !== name) errors.push(`frontmatter name "${data.name}" ≠ folder name "${name}"`);
  if (!data.description) errors.push("frontmatter is missing `description:`");
  else {
    if (data.description.length > MAX_DESC) errors.push(`description is ${data.description.length} chars (max ${MAX_DESC})`);
    if (data.description.length < 40) warnings.push("description is very short — say what it does AND when to use it");
    if (/^(I|You|We)\b/.test(data.description)) warnings.push("description should be third person (\"Generates…\", not \"I generate…\")");
  }
  for (const marker of TEMPLATE_MARKERS) {
    if (text.includes(marker)) errors.push(`template placeholder still present: ${marker}`);
  }
  const bodyLines = body.split(/\r?\n/).length;
  if (bodyLines > SOFT_MAX_LINES) warnings.push(`SKILL.md body is ${bodyLines} lines (aim for < ${SOFT_MAX_LINES}; move detail to references/)`);
  if (!existsSync(join(dir, "tests", "prompts.md"))) warnings.push("no tests/prompts.md — add should/should-not trigger prompts");
  for (const sub of ["scripts", "references", "assets"]) {
    const p = join(dir, sub);
    if (existsSync(p) && readdirSync(p).length === 0) warnings.push(`${sub}/ is empty — delete it or use it`);
  }
  if (/(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(text)) errors.push("looks like a secret in SKILL.md");

  // Any helper script that advertises --selftest must pass it. A script with no selftest is only warned about.
  const scriptsDir = join(dir, "scripts");
  if (existsSync(scriptsDir)) {
    for (const f of readdirSync(scriptsDir).filter((f) => /\.(mjs|js|cjs)$/.test(f))) {
      const p = join(scriptsDir, f);
      if (!readFileSync(p, "utf8").includes("--selftest")) { warnings.push(`scripts/${f} has no --selftest — add one so CI can prove it works`); continue; }
      const r = spawnSync(process.execPath, [p, "--selftest"], { encoding: "utf8", timeout: 60_000 });
      const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim().split(/\r?\n/).at(-1) ?? "";
      if (r.status !== 0) errors.push(`scripts/${f} --selftest failed (exit ${r.status}): ${out}`);
    }
  }

  return { name, errors, warnings, description: data.description || "" };
}

// Everything below runs only when this file is the program. Imported (by
// scripts/tests/check-versions.test.mjs) it is just a module, so importing it does
// not validate the repository as a side effect.
const invokedDirectly = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (!invokedDirectly) { /* imported for its exports */ } else {

if (!existsSync(skillsDir)) {
  console.error("no skills/ directory");
  process.exit(1);
}
const names = readdirSync(skillsDir).filter((n) => !n.startsWith(".") && !n.startsWith("_") && statSync(join(skillsDir, n)).isDirectory()).sort();
const results = names.map(checkSkill);

if (wantTable) {
  console.log("| Skill | What it does |");
  console.log("|---|---|");
  for (const r of results) console.log(`| \`${r.name}\` | ${r.description.split(/\.\s|\. Use when/)[0].replace(/\|/g, "\\|")}. |`);
  process.exit(0);
}

let failed = 0;
for (const r of results) {
  const status = r.errors.length ? "FAIL" : r.warnings.length ? "warn" : "ok  ";
  console.log(`${status}  ${r.name}`);
  for (const e of r.errors) console.log(`        error: ${e}`);
  for (const w of r.warnings) console.log(`        warn:  ${w}`);
  if (r.errors.length) failed++;
}
console.log(`\n${results.length} skill(s), ${failed} failing`);
process.exit(failed ? 1 : 0);

}
