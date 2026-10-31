// r79 item 2 (revision): the child deny set. A child's write outside its worktree and scratch, and its PR creation, are denied before the allow rules,
// the built-in allows and the classifier, in mode auto with an allow-everything classifier. The foreman is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

type T = Parameters<typeof r11Rig>[0];
const ALLOW = JSON.stringify({ verdict: "allow", entry: "A1", reason: "stub" });
const registry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: ALLOW }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
const ROLES = ["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"];
const config = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } } };
const perms = { mode: "auto", allow: ["Bash(*)", "Write", "Edit", "pr_create"], classifier: { allow: ["Anything at all."] } };

async function child(t: T) {
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "builder", launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  return r11Rig(t, {}, { ctx: { modelRegistry: registry, [RIG_PERMISSIONS]: perms }, config, child: true });
}

test("a child's write into the parent's .workflow is denied under auto with an allow-everything classifier", async (t: T) => {
  const c = await child(t);
  const parentWf = path.join(c.project, "..", "parent", ".workflow", "x.md");
  for (const [tool, input] of [["write", { path: parentWf, content: "x" }], ["bash", { command: `echo x > ${parentWf}` }], ["bash", { command: `sed -i s/a/b/ ${parentWf}` }]] as const) {
    const res = await c.call(tool, { ...input });
    assert.ok(res?.block, `${tool} ${JSON.stringify(input)}`);
    assert.match(String(res.reason), /child-write-outside/);
  }
});

test("a child never creates a pull request, however the call is spelled", async (t: T) => {
  const c = await child(t);
  for (const [tool, input] of [["pr_create", { title: "t" }], ["bash", { command: "gh pr create --title t --body b" }], ["bash", { command: "glab mr create --title t" }]] as const) {
    const res = await c.call(tool, { ...input });
    assert.ok(res?.block, tool);
    assert.match(String(res.reason), /child-pr-create/);
  }
});

test("the foreman is unchanged: its write outside is not the child deny set", async (t: T) => {
  const f = await r11Rig(t, {}, { ctx: { modelRegistry: registry, [RIG_PERMISSIONS]: perms }, config });
  const res = await f.call("pr_create", { title: "t" });
  assert.ok(!res?.block || !/child-pr-create/.test(String(res.reason)));
});
