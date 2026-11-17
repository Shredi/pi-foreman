// The role skills load pi-subagents' resolveSkills from the real installed package: no injected resolver. 0.89 resolves the package
// entry to bundle/index.js, below the package root; a root taken from the entry's dirname made the import fail and every role skill vanish.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { childSkillDirs, childSkillRefs, loadResolveSkills } from "../skilldirs.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

process.env.PI_OFFLINE = "1";

test("loadResolveSkills imports resolveSkills from the installed pi-subagents", async () => {
  assert.equal(typeof (await loadResolveSkills()), "function");
});

test("a role skill resolves through the real package with no injected resolver", async () => {
  const tmp = fs.realpathSync(mkTestTmp("skilldirs-real-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  try {
    const home = path.join(tmp, "home");
    const repo = path.join(tmp, "repo");
    const dir = path.join(repo, ".agents", "skills", "real-skill");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: real-skill\ndescription: the real skill\n---\n\n# real\n");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
    const roles = { builder: { skills: ["real-skill"] } };
    const refs = await childSkillRefs(roles, "builder", repo);
    assert.deepEqual(refs.map((r) => r.name), ["real-skill"]);
    assert.equal(refs[0].description, "the real skill");
    assert.deepEqual(await childSkillDirs(roles, "builder", repo, home), [dir]);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmTestTmp(tmp);
  }
});
