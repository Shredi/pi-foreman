// The creating-verify-skills skill ships with the package: Pi's loader accepts it, it is model-invoked, its frontmatter marks it searchable, it names its trigger phrases and its boundary, it links its three files and docs/roles.md names it.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { parseFrontmatter, readVisibility } from "../skillvisibility.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIR = path.join(REPO, "skills", "creating-verify-skills");
const ENV_KEYS = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"] as const;
let saved: Record<string, string | undefined> = {};
let tmp = "";

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.realpathSync(mkTestTmp("creating-verify-skills-"));
  fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
  process.env.HOME = path.join(tmp, "home");
  process.env.USERPROFILE = path.join(tmp, "home");
  process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmTestTmp(tmp);
});

test("the skills/ dir loads creating-verify-skills through Pi's loadSkills with zero diagnostics and keeps model invocation on", () => {
  const result = loadSkills({ cwd: tmp, agentDir: process.env.PI_CODING_AGENT_DIR as string, skillPaths: [path.join(REPO, "skills")], includeDefaults: false });
  assert.deepEqual(result.diagnostics, []);
  const skill = result.skills.find((s) => s.name === "creating-verify-skills");
  assert.ok(skill, JSON.stringify(result.skills.map((s) => s.name)));
  assert.ok(skill.description.length > 0 && skill.description.length <= 1024);
  assert.equal(skill.disableModelInvocation, false);
  for (const phrase of ["'model-check this'", "'prove this invariant'", "'write a property test for the gate'", "'tests cannot reach this'", "'create a verify skill'"]) {
    assert.ok(skill.description.includes(phrase), phrase);
  }
  assert.ok(skill.description.includes("Not for ordinary unit tests"));
  assert.ok(skill.description.includes("security review of a diff"));
});

test("creating-verify-skills names its directory, is searchable, stays within 200 lines and links its three files", () => {
  const file = path.join(DIR, "SKILL.md");
  const text = fs.readFileSync(file, "utf8");
  const fm = parseFrontmatter(text);
  assert.equal(fm.name, "creating-verify-skills");
  assert.equal(fm.metadata.visibility, "search");
  assert.equal(readVisibility(file), "search");
  assert.ok(text.split("\n").length <= 200, "the body stays under about 200 lines");
  for (const rel of ["references/generator-tests.md", "references/state-flow.md", "assets/verify-skill-template.md"]) {
    assert.ok(fs.existsSync(path.join(DIR, rel)), `${rel} exists`);
    assert.ok(text.includes(`\`${rel}\``), `${rel} is linked from the body`);
  }
});

test("docs/roles.md names the creating-verify-skills skill", () => {
  assert.ok(fs.readFileSync(path.join(REPO, "docs", "roles.md"), "utf8").includes("skills/creating-verify-skills"));
});

test("the project-local verifying-permission-gate skill loads and names files that exist", () => {
  const dir = path.join(REPO, ".agents", "skills", "verifying-permission-gate");
  const result = loadSkills({ cwd: tmp, agentDir: process.env.PI_CODING_AGENT_DIR as string, skillPaths: [path.join(REPO, ".agents", "skills")], includeDefaults: false });
  assert.deepEqual(result.diagnostics, []);
  const skill = result.skills.find((s) => s.name === "verifying-permission-gate");
  assert.ok(skill, JSON.stringify(result.skills.map((s) => s.name)));
  assert.ok(skill.description.length > 0 && skill.description.length <= 1024);
  for (const phrase of ["'verify the permission gate'", "'rerun the gate check'", "'sweep the gate seeds'"]) assert.ok(skill.description.includes(phrase), phrase);
  const text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  assert.equal(parseFrontmatter(text).name, "verifying-permission-gate");
  const named = new Set([...text.matchAll(/`((?:extensions|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|mjs))`/g)].map((m) => m[1]));
  for (const rel of ["extensions/core-adapter/test/gate-generator.test.ts", "extensions/core-adapter/test/_gate-gen.ts", "scripts/gate_sweep.mjs", "extensions/core-adapter/shellast.ts", "extensions/core-adapter/gate.ts", "extensions/core-adapter/index.ts"]) assert.ok(named.has(rel), `${rel} is named`);
  for (const rel of named) assert.ok(fs.existsSync(path.join(REPO, rel)), `${rel} exists`);
  assert.match(text, /Last confirmed at: `[0-9a-f]{40}`/);
});
