// roles.<id>.skills: a child reads the skills its role names through a read-only shell word; nothing else under .agents opens.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { clearSkillCache } from "../../../node_modules/pi-subagents/src/agents/skills.js";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { childSkillDirs } from "../skilldirs.ts";
import { bashPath } from "./_bashpath.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const ENV_KEYS = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"] as const;
let saved: Record<string, string | undefined> = {};
let tmp = "";
let home = "";
let repo = "";
let agentDir = "";
let rules: OverlayRules;

const skillsDir = (): string => path.join(home, ".agents", "skills");
const writeSkill = (name: string): string => {
  const dir = path.join(skillsDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: the ${name} skill\n---\n\n# ${name}\n`);
  return dir;
};
const roles = (...skills: string[]): unknown => ({ builder: { skills } });
const dirsFor = (...skills: string[]): Promise<string[]> => childSkillDirs(roles(...skills), "builder", repo, home);
const ctxOf = (role: "main" | "child", skillDirs: string[]): MatchCtx => ({ cwd: repo, home, platform: process.platform, role, ...(skillDirs.length ? { skillDirs } : {}) });
const sh = (c: MatchCtx, command: string): string => checkToolCall(rules, "bash", { command }, c)?.kind ?? "pass";
const tool = (c: MatchCtx, name: string, input: Record<string, unknown>): string => checkToolCall(rules, name, input, c)?.kind ?? "pass";

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
  rules = buildOverlayRules(baseline, {}, {}, agentDir, PKG);
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

test("a child reads the named skill by shell; an unnamed sibling and an in-repo .agents path stay denied", async () => {
  const named = writeSkill("named");
  const other = writeSkill("other");
  fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".agents", "x"), "x\n");
  const c = ctxOf("child", await dirsFor("named"));
  assert.equal(sh(c, `cat ${bashPath(path.join(named, "SKILL.md"))}`), "pass");
  assert.equal(sh(c, `grep -n name ${bashPath(named)}/SKILL.md`), "pass");
  assert.equal(sh(c, `cat ${bashPath(path.join(other, "SKILL.md"))}`), "deny");
  assert.equal(sh(c, "cat .agents/x"), "deny");
  // without the list the named skill is denied as before
  assert.equal(sh(ctxOf("child", []), `cat ${bashPath(path.join(named, "SKILL.md"))}`), "deny");
  // the main session is not a child: no carve-out is read for it
  assert.equal(sh(ctxOf("main", await dirsFor("named")), `cat ${bashPath(path.join(other, "SKILL.md"))}`), sh(ctxOf("main", []), `cat ${bashPath(path.join(other, "SKILL.md"))}`));
});

test("a write into the named skill dir stays denied", async () => {
  const named = writeSkill("named");
  const c = ctxOf("child", await dirsFor("named"));
  assert.equal(sh(c, `echo x > ${bashPath(named)}/f`), "deny");
  assert.equal(sh(c, `cat ${bashPath(named)}/SKILL.md > ${bashPath(named)}/f`), "deny");
  assert.equal(sh(c, `cp ${bashPath(named)}/SKILL.md ${bashPath(named)}/g`), "deny");
  assert.equal(tool(c, "write", { path: path.join(named, "f"), content: "x" }), "deny");
  assert.equal(tool(c, "edit", { path: path.join(named, "SKILL.md"), oldText: "a", newText: "b" }), "deny");
});

test("a link inside the named dir pointing outside, and a .. escape, stay denied", async (t) => {
  const named = writeSkill("named");
  const other = writeSkill("other");
  const c = ctxOf("child", await dirsFor("named"));
  assert.equal(sh(c, `cat ${bashPath(named)}/../other/SKILL.md`), "deny");
  assert.equal(sh(c, `cat ${bashPath(named)}/../other/SKILL.md ${bashPath(named)}/SKILL.md`), "deny");
  try {
    fs.symlinkSync(path.join(other, "SKILL.md"), path.join(named, "link.md"));
  } catch {
    t.diagnostic("no symlink privilege: link case skipped");
    return;
  }
  assert.equal(sh(c, `cat ${bashPath(named)}/link.md`), "deny");
});

test("protect.deny still applies inside the named skill dir", async () => {
  const named = writeSkill("named");
  fs.mkdirSync(path.join(named, ".git"), { recursive: true });
  fs.writeFileSync(path.join(named, ".git", "config"), "[core]\n");
  const c = ctxOf("child", await dirsFor("named"));
  assert.equal(sh(c, `cat ${bashPath(named)}/.git/config`), "deny");
  assert.equal(sh(c, `cat ${bashPath(named)}/SKILL.md ${bashPath(named)}/.git/config`), "deny");
});

test("the read, grep and ls tools of a child get no overlay decision on the named skill", async () => {
  const named = writeSkill("named");
  const c = ctxOf("child", await dirsFor("named"));
  assert.equal(tool(c, "read", { path: path.join(named, "SKILL.md") }), "pass");
  assert.equal(tool(c, "grep", { pattern: "name", path: named }), "pass");
  assert.equal(tool(c, "ls", { path: named }), "pass");
});
