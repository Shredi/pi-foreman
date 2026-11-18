// The repo-audit skill ships with the package: Pi's loader accepts it, it is model-invoked, its frontmatter marks it searchable and it names its trigger phrases and its boundary.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { isHiddenSkill, parseFrontmatter, readVisibility } from "../skillvisibility.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENV_KEYS = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"] as const;
let saved: Record<string, string | undefined> = {};
let tmp = "";

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.realpathSync(mkTestTmp("repo-audit-skill-"));
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

test("the skills/ dir loads repo-audit through Pi's loadSkills with zero diagnostics and keeps model invocation on", () => {
  const result = loadSkills({ cwd: tmp, agentDir: process.env.PI_CODING_AGENT_DIR as string, skillPaths: [path.join(REPO, "skills")], includeDefaults: false });
  assert.deepEqual(result.diagnostics, []);
  const skill = result.skills.find((s) => s.name === "repo-audit");
  assert.ok(skill, JSON.stringify(result.skills.map((s) => s.name)));
  assert.ok(skill.description.length > 0 && skill.description.length <= 1024);
  assert.equal(skill.disableModelInvocation, false);
  const body = fs.readFileSync(path.join(REPO, "skills", "repo-audit", "SKILL.md"), "utf8");
  assert.ok(body.includes("'audit the repo'"));
  assert.ok(skill.description.includes("'which review findings keep coming back'"));
  assert.ok(skill.description.includes("Not for security audits"));
  assert.ok(body.split("\n").length <= 200, "the body stays under about 200 lines");
});

test("repo-audit names its directory and its frontmatter marks it searchable", () => {
  const file = path.join(REPO, "skills", "repo-audit", "SKILL.md");
  const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
  assert.equal(fm.name, "repo-audit");
  assert.equal(fm.metadata.visibility, "search");
  assert.equal(readVisibility(file), "search");
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "config", "foreman.defaults.json"), "utf8"));
  assert.ok(isHiddenSkill("repo-audit", { visible: cfg.skills.visible, hidden: cfg.skills.hidden }, "search"));
});
