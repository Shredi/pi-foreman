// roles.<id>.skills: pi-subagents resolves the named skills only, and a repo skill wins over a user skill of the same name.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildSkillInjection, clearSkillCache, resolveSkills } from "../../../node_modules/pi-subagents/src/agents/skills.js";
import { buildEffectiveSystemPrompt } from "../../../node_modules/pi-subagents/src/runs/shared/effective-system-prompt.js";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const ENV_KEYS = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"] as const;
let saved: Record<string, string | undefined> = {};
let tmp = "";
let home = "";
let repo = "";

const writeSkill = (root: string, name: string, description: string, extra = ""): string => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`);
  return file;
};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.realpathSync(mkTestTmp("role-skills-"));
  home = path.join(tmp, "home");
  repo = path.join(tmp, "repo");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");
  clearSkillCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  clearSkillCache();
  rmTestTmp(tmp);
});

test("a named skill is injected with its name and absolute location; an unnamed one is absent", () => {
  const named = writeSkill(path.join(home, ".agents", "skills"), "named-skill", "Does the named thing");
  writeSkill(path.join(home, ".agents", "skills"), "other-skill", "Does the other thing");
  const { resolved, missing } = resolveSkills(["named-skill"], repo);
  assert.deepEqual(missing, []);
  const injection = buildSkillInjection(resolved);
  assert.match(injection, /<name>named-skill<\/name>/);
  assert.ok(injection.includes(`<location>${named}</location>`), injection);
  assert.ok(!injection.includes("other-skill"), injection);
});

test("the same skill name in the repo and in the home dir resolves to the repo path", () => {
  const repoFile = writeSkill(path.join(repo, ".agents", "skills"), "dup-skill", "repo copy");
  const homeFile = writeSkill(path.join(home, ".agents", "skills"), "dup-skill", "home copy");
  const { resolved } = resolveSkills(["dup-skill"], repo);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].path, repoFile);
  assert.notEqual(resolved[0].path, homeFile);
  assert.ok(buildSkillInjection(resolved).includes(`<location>${repoFile}</location>`));
});

test("the effective system prompt of an agent with one named skill lists no unnamed skill", () => {
  writeSkill(path.join(home, ".agents", "skills"), "named-skill", "Does the named thing");
  writeSkill(path.join(home, ".agents", "skills"), "other-skill", "Does the other thing");
  const { resolved } = resolveSkills(["named-skill"], repo);
  const prompt = buildEffectiveSystemPrompt({ agent: { name: "builder", systemPrompt: "Base prompt." }, resolvedSkills: resolved, cwd: repo });
  assert.match(prompt, /^Base prompt\./);
  assert.match(prompt, /<name>named-skill<\/name>/);
  assert.ok(!prompt.includes("other-skill"), prompt);
});
