// Ledger 10: the live line. A builder child whose role names a skill under ~/.agents reads it with `cat ~/.agents/skills/x/SKILL.md | head -3`.
// Driven as index.ts drives it: childSkillDirs(user-layer roles, launch-binding role, cwd, home) → checkToolCall with role "child" and skillDirs.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { clearSkillCache } from "../../../node_modules/pi-subagents/src/agents/skills.js";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { childSkillDirs } from "../skilldirs.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const ENV_KEYS = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"] as const;
let saved: Record<string, string | undefined> = {};
let tmp = "";
let home = "";
let repo = "";
let rules: OverlayRules;

const writeSkill = (name: string): void => {
  const dir = path.join(home, ".agents", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: the ${name} skill\n---\n\n# ${name}\n`);
};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.realpathSync(mkTestTmp("role-skills-live-"));
  home = path.join(tmp, "home");
  repo = path.join(tmp, "repo");
  const agentDir = path.join(home, ".pi", "agent");
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

test("live line: tilde and absolute shell reads of the named skill pass, a write and an unnamed skill stay denied", async () => {
  writeSkill("x");
  writeSkill("other");
  const skillDirs = await childSkillDirs({ builder: { skills: ["x"] } }, "builder", repo, home);
  assert.equal(skillDirs.length, 1);
  const c: MatchCtx = { cwd: repo, home, platform: process.platform, role: "child", skillDirs };
  const sh = (command: string): string => checkToolCall(rules, "bash", { command }, c)?.kind ?? "pass";
  assert.equal(sh("cat ~/.agents/skills/x/SKILL.md | head -3"), "pass");
  assert.equal(sh("cat ~/.agents/skills/x/SKILL.md"), "pass");
  assert.equal(sh(`cat ${home}/.agents/skills/x/SKILL.md | head -3`), "pass");
  assert.equal(sh("cat $HOME/.agents/skills/x/SKILL.md | head -3"), "pass");
  assert.equal(sh("echo y >> ~/.agents/skills/x/SKILL.md"), "deny");
  assert.equal(sh("cat ~/.agents/skills/other/SKILL.md"), "deny");
  assert.equal(sh("cat ~/.agents/skills/x/SKILL.md ~/.agents/skills/other/SKILL.md"), "deny");
});

// The skill dir as users keep it: `~/.agents/skills/x` a link to a checkout elsewhere. The shell word names the link, its realpath lies outside `.agents`.
test("live line: a named skill dir that is a link to a dir outside .agents is read by its link spelling", async (t) => {
  const store = path.join(tmp, "store", "x");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "SKILL.md"), "---\nname: x\ndescription: the x skill\n---\n\n# x\n");
  fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
  try {
    fs.symlinkSync(store, path.join(home, ".agents", "skills", "x"), "dir");
  } catch {
    t.diagnostic("no symlink privilege: skipped");
    return;
  }
  writeSkill("other");
  const skillDirs = await childSkillDirs({ builder: { skills: ["x"] } }, "builder", repo, home);
  const c: MatchCtx = { cwd: repo, home, platform: process.platform, role: "child", skillDirs };
  const sh = (command: string): string => checkToolCall(rules, "bash", { command }, c)?.kind ?? "pass";
  assert.equal(sh("cat ~/.agents/skills/x/SKILL.md | head -3"), "pass");
  assert.equal(sh(`cat ${home}/.agents/skills/x/SKILL.md`), "pass");
  assert.equal(sh("echo y >> ~/.agents/skills/x/SKILL.md"), "deny");
  assert.equal(sh("cat ~/.agents/skills/other/SKILL.md"), "deny");
});
