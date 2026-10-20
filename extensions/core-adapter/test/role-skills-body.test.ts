// roles.<id>.skills: the effective system prompt carries a named skill's name and location only, never the body of its SKILL.md.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearSkillCache, resolveSkills } from "../../../node_modules/pi-subagents/src/agents/skills.js";
import { buildEffectiveSystemPrompt } from "../../../node_modules/pi-subagents/src/runs/shared/effective-system-prompt.js";
import type { AgentConfig } from "../../../node_modules/pi-subagents/src/agents/agents.js";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const ENV_KEYS = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"] as const;
let saved: Record<string, string | undefined> = {};
let tmp = "";

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.realpathSync(mkTestTmp("role-skills-body-"));
  fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "repo"), { recursive: true });
  process.env.HOME = path.join(tmp, "home");
  process.env.USERPROFILE = path.join(tmp, "home");
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

test("the body text of a named skill is absent from the effective system prompt", () => {
  const dir = path.join(tmp, "home", ".agents", "skills", "body-skill");
  fs.mkdirSync(dir, { recursive: true });
  const BODY = "zebra-quartz-marmalade-7731";
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: body-skill\ndescription: Short summary\n---\n\n${BODY}\n`);
  const repo = path.join(tmp, "repo");
  const { resolved } = resolveSkills(["body-skill"], repo);
  assert.equal(resolved.length, 1);
  const prompt = buildEffectiveSystemPrompt({ agent: { name: "builder", systemPrompt: "Base prompt." } as AgentConfig, resolvedSkills: resolved, cwd: repo });
  assert.match(prompt, /<name>body-skill<\/name>/);
  assert.ok(!prompt.includes(BODY), prompt);
});
