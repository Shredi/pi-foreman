// The config-change check keeps its own trigger after the git guard's removal: a main-session shell line that names git or a forge tool
// (`mainNeedsGitGuard`) meets the drift gate in the adapter's real tool_call handler; other lines and a child's lines are not checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

type T = Parameters<typeof r11Rig>[0];
type Rig = Awaited<ReturnType<typeof r11Rig>>;

/** A rig whose project is a git repository with the session's baseline snapshot taken (the session start the rig runs again once the repository exists). */
async function repoRig(t: T, opts: Parameters<typeof r11Rig>[2] = {}): Promise<Rig> {
  const c = await r11Rig(t, {}, opts);
  execFileSync("git", ["init", "-q"], { cwd: c.project });
  await c.restart();
  return c;
}

/** A change after the snapshot: a key in the repository's own config (stands for a child-planted setting). */
const plant = (c: Rig): void => fs.appendFileSync(path.join(c.project, ".git", "config"), "[triggerdrift]\n\tmarker = planted-value\n");
const drift = (c: Rig): Record<string, unknown>[] => c.events("git_config_drift");

test("main session: bash `git status` after a planted config change is stopped by the drift gate", async (t: T) => {
  const c = await repoRig(t);
  assert.equal(await c.call("bash", { command: "git status" }), undefined, "no change yet: runs");
  plant(c);
  const res = await c.call("bash", { command: "git status" });
  assert.ok(res?.block, "stopped");
  assert.match(String(res.reason), /^Denied by the user/);
  assert.deepEqual(drift(c).map((r) => r.decision), ["denied"]);
});

test("main session: a bash line that does not name git is not checked", async (t: T) => {
  const c = await repoRig(t);
  plant(c);
  const res = await c.call("bash", { command: "echo hello" });
  assert.ok(!res?.block, JSON.stringify(res));
  assert.deepEqual(drift(c), []);
});

test("main session: bg_run `git status` after a planted config change is stopped the same way", async (t: T) => {
  const c = await repoRig(t);
  plant(c);
  const res = await c.call("bg_run", { command: "git status" });
  assert.ok(res?.block, "stopped");
  assert.match(String(res.reason), /^Denied by the user/);
  assert.deepEqual(drift(c).map((r) => r.decision), ["denied"]);
});

test("a child's `git status` is not checked (a child takes no snapshot and never meets the drift gate)", async (t: T) => {
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "builder", launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  const c = await repoRig(t, { child: true });
  plant(c);
  await c.call("bash", { command: "git status" });
  assert.deepEqual(drift(c), []);
});
