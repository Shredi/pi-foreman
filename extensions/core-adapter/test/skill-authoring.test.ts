// The skill-authoring skill ships with the package: pi.skills lists ./skills and Pi's loader accepts it cleanly.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENV_KEYS = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR"] as const;
let saved: Record<string, string | undefined> = {};
let tmp = "";

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.realpathSync(mkTestTmp("skill-authoring-"));
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

test("package.json pi.skills lists ./skills", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.ok(pkg.pi.skills.includes("./skills"), JSON.stringify(pkg.pi.skills));
});

test("the skills/ dir loads skill-authoring through Pi's loadSkills with zero diagnostics", () => {
  const result = loadSkills({ cwd: tmp, agentDir: process.env.PI_CODING_AGENT_DIR as string, skillPaths: [path.join(REPO, "skills")], includeDefaults: false });
  assert.deepEqual(result.diagnostics, []);
  const skill = result.skills.find((s) => s.name === "skill-authoring");
  assert.ok(skill, JSON.stringify(result.skills.map((s) => s.name)));
  assert.ok(skill.description.length > 0 && skill.description.length <= 1024);
  const guides = result.skills.find((s) => s.name === "prompting-guides");
  assert.ok(guides, JSON.stringify(result.skills.map((s) => s.name)));
  assert.ok(guides.description.length > 0 && guides.description.length <= 1024);
});
