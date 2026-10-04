import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { forceUserScope, shadowedRoles } from "../agentscope.ts";

test("every subagent call is rewritten to agentScope user", () => {
  const a: Record<string, unknown> = { agent: "builder", task: "x" };
  assert.equal(forceUserScope(a), false);
  assert.equal(a.agentScope, "user");
  for (const scope of ["both", "project"]) {
    const b: Record<string, unknown> = { agent: "builder", task: "x", agentScope: scope };
    assert.equal(forceUserScope(b), true);
    assert.equal(b.agentScope, "user");
  }
});

test("project agent files and agentOverrides that shadow a role are reported", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-shadow-")));
  const home = path.join(root, "home");
  const proj = path.join(home, "repo");
  const sub = path.join(proj, "pkg");
  fs.mkdirSync(path.join(proj, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".agents"), { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  fs.mkdirSync(path.join(home, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".pi", "agents", "builder.md"), "---\nname: builder\n---\nx\n");
  fs.writeFileSync(path.join(proj, ".pi", "agents", "helper.md"), "---\nname: helper\n---\nx\n");
  fs.writeFileSync(path.join(proj, ".agents", "x.md"), "---\nname: \"reviewer\"\n---\n");
  fs.writeFileSync(path.join(proj, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { explorer: { model: "m" } }, agentOverridesByProvider: { p: { finalizer: {} } } } }));
  fs.writeFileSync(path.join(home, ".pi", "agents", "senior-reviewer.md"), "---\nname: senior-reviewer\n---\n");
  const got = shadowedRoles(sub, ["explorer", "builder", "reviewer", "senior-reviewer", "finalizer"], home).map((l) => l.split(":")[0]).sort();
  assert.deepEqual(got, ["builder", "explorer", "finalizer", "reviewer"]); // the home directory is not a project
  assert.deepEqual(shadowedRoles(path.join(root, "elsewhere"), ["builder"], home), []);
  fs.rmSync(root, { recursive: true, force: true });
});
