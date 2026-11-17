// roles.<id>.skills: the role→names→dirs step gives the dirs of the skills a role names.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearSkillCache } from "../../../node_modules/pi-subagents/src/agents/skills.js";
import { childSkillDirs } from "../skilldirs.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

// pi-subagents resolves the global npm root with `npm root -g` on the first skill lookup, cached per module with no seam; PI_OFFLINE makes
// that lookup return null without starting npm.
process.env.PI_OFFLINE = "1";

const ENV_KEYS = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"] as const;
let saved: Record<string, string | undefined> = {};
let tmp = "";
let home = "";
let repo = "";
let agentDir = "";

const skillsDir = (): string => path.join(home, ".agents", "skills");
const writeSkill = (name: string): string => {
  const dir = path.join(skillsDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: the ${name} skill\n---\n\n# ${name}\n`);
  return dir;
};
const roles = (...skills: string[]): unknown => ({ builder: { skills } });
const dirsFor = (...skills: string[]): Promise<string[]> => childSkillDirs(roles(...skills), "builder", repo, home);

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.realpathSync(mkTestTmp("role-skills-ov-"));
  home = path.join(tmp, "home");
  repo = path.join(tmp, "repo");
  agentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
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

test("the role→names→dirs step gives the realpath of a named skill's dir only", async () => {
  const named = writeSkill("named");
  writeSkill("other");
  assert.deepEqual(await dirsFor("named"), [named]);
  assert.deepEqual(await dirsFor(), []);
  assert.deepEqual(await childSkillDirs(roles("named"), "other-role", repo, home), []);
  assert.deepEqual(await childSkillDirs(undefined, "builder", repo, home), []);
});

test("an absolute or ../x name, or a missing skill, gives no dir", async () => {
  writeSkill("named");
  assert.deepEqual(await dirsFor(path.join(skillsDir(), "named"), "../skills/named", "..", "a/b", "missing"), []);
});

test("a flat-file skill gives only the file", async () => {
  fs.mkdirSync(skillsDir(), { recursive: true });
  const file = path.join(skillsDir(), "flat.md");
  fs.writeFileSync(file, "---\nname: flat\ndescription: flat skill\n---\n\n# flat\n");
  assert.deepEqual(await dirsFor("flat"), [file]);
});

test("a dir that is home, a filesystem root or above home is dropped", async () => {
  const fake = (p: string) => () => ({ resolved: [{ path: p }] });
  assert.deepEqual(await childSkillDirs(roles("x"), "builder", repo, home, fake(path.join(home, "SKILL.md"))), []);
  assert.deepEqual(await childSkillDirs(roles("x"), "builder", repo, home, fake(path.join(tmp, "SKILL.md"))), []);
  assert.deepEqual(await childSkillDirs(roles("x"), "builder", repo, home, fake(path.join(path.parse(tmp).root, "SKILL.md"))), []);
  assert.deepEqual(await childSkillDirs(roles("x"), "builder", repo, home, () => { throw new Error("boom"); }), []);
});
