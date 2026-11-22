// Nested-pi gap (cleanup-permissions-2, PR A): the launch binding names a child's role. The child reads it once and removes it from its env, so a
// pi the child starts has no role: no builder flag, no push, round worktrees read-only. Light rig: the real adapter hooks in this process with a
// fake pi (r11Rig), no session spawn; "a fresh process" is an emptied binding slot, the state a new process starts with.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { BINDINGS_ENV, BINDING_NS, takeBinding } from "../usage.ts";
import { stripChildBindingEnv } from "../childenv.ts";

process.env.PI_OFFLINE = "1"; // pi-subagents looks up the npm root on first skill use; offline returns early (no npm spawn)

type T = Parameters<typeof r11Rig>[0];
type Rig = Awaited<ReturnType<typeof r11Rig>>;
const SLOT = Symbol.for("pi-foreman.childBindings");
const PUSH = "git push -u origin round/x";
const PARENT = "parent-session";

const binding = (role: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ [BINDING_NS]: { foremanSession: PARENT, role, launchId: "l1", kind: "first", workspace: "", ...extra } });
const clearSlot = (): void => void ((globalThis as unknown as Record<symbol, unknown>)[SLOT] = undefined);

/** Env for one test: BINDINGS_ENV (`undefined` = unset), PI_SUBAGENT_PARENT_SESSION and the slot are restored afterwards. */
function withEnv(t: T, value: string | undefined, parent: string | undefined = PARENT): void {
  const prev = { b: process.env[BINDINGS_ENV], p: process.env.PI_SUBAGENT_PARENT_SESSION, s: process.env.FOREMAN_SCRATCH, o: process.env.FOREMAN_OUT };
  clearSlot();
  if (value === undefined) delete process.env[BINDINGS_ENV];
  else process.env[BINDINGS_ENV] = value;
  if (parent === undefined) delete process.env.PI_SUBAGENT_PARENT_SESSION;
  else process.env.PI_SUBAGENT_PARENT_SESSION = parent;
  t.after(() => {
    for (const [k, v] of [[BINDINGS_ENV, prev.b], ["PI_SUBAGENT_PARENT_SESSION", prev.p], ["FOREMAN_SCRATCH", prev.s], ["FOREMAN_OUT", prev.o]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearSlot();
  });
}

const rig = (t: T, child: boolean): Promise<Rig> => r11Rig(t, {}, { ctx: reviewAllowOpts().ctx, config: reviewAllowOpts().config, child });
const pushReason = async (r: Rig): Promise<string> => String((await r.call("bash", { command: PUSH }))?.reason ?? "");
const refusedPush = (reason: string): boolean => /git-push-child|never push/.test(reason);
/** The round worktree is the rig's project; the parent session's manifest names it. */
function registerRound(r: Rig): void {
  const state = path.join(r.agentDir, "pi-foreman", "state", "sessions", PARENT);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "manifest.json"), JSON.stringify({ entries: [{ path: r.project, kind: "worktree" }] }));
}
const writeRound = async (r: Rig): Promise<string> => String((await r.call("write", { path: path.join(r.project, "a.txt"), content: "x" }))?.reason ?? "");

test("(a) a builder from a single launch: the push floor lets its own-branch push through", async (t) => {
  withEnv(t, binding("builder"));
  const r = await rig(t, true);
  assert.ok(!refusedPush(await pushReason(r)));
});

test("(b) a reviewer's push is refused by the child push floor", async (t) => {
  withEnv(t, binding("reviewer"));
  const r = await rig(t, true);
  assert.match(await pushReason(r), /git-push-child|never push/);
});

test("(c) a child with no binding: push refused, a tracked-file write in a round worktree is read-only", async (t) => {
  withEnv(t, undefined);
  const r = await rig(t, true);
  assert.ok(refusedPush(await pushReason(r)));
  registerRound(r);
  assert.match(await writeRound(r), /child-readonly-write/);
});

test("(d) after the load the child's env holds no binding, and the role still comes from the read", async (t) => {
  withEnv(t, binding("builder"));
  const r = await rig(t, true);
  const left = process.env[BINDINGS_ENV];
  assert.ok(left === undefined || (left.startsWith("consumed:") && !left.includes(BINDING_NS) && !left.includes("builder")), String(left));
  assert.ok(!refusedPush(await pushReason(r)), "the builder flag is kept");
});

test("(e) a foreman keeps its env untouched", async (t) => {
  const v = binding("builder");
  withEnv(t, v);
  await rig(t, false);
  assert.equal(process.env[BINDINGS_ENV], v);
});

test("(f) a second load in the same process (reload) keeps the role, scratch, out dir and MCP scope from the slot", async (t) => {
  const scratch = path.join(fs.realpathSync(process.cwd()), "s");
  const extra = { scratch, out: path.join(scratch, "out"), mcp: ["fx/echo"] };
  withEnv(t, binding("builder", extra));
  const first = takeBinding(process.env);
  assert.equal(first?.role, "builder");
  assert.match(String(process.env[BINDINGS_ENV]), /^consumed:[0-9a-f]+$/);
  const again = takeBinding(process.env);
  assert.deepEqual(again, first);
  assert.deepEqual([again?.scratch, again?.out, again?.mcp], [extra.scratch, extra.out, extra.mcp]);
  // the adapter itself: a rig loaded on the marker (a reload) still has the builder flag and the scratch dir
  const r = await rig(t, true);
  assert.ok(!refusedPush(await pushReason(r)));
  assert.equal(process.env.FOREMAN_SCRATCH, scratch);
});

test("(g) a nested pi (fresh process: empty slot) with the marker or no variable has role child", async (t) => {
  withEnv(t, binding("builder"));
  assert.equal(takeBinding(process.env)?.role, "builder");
  const marker = process.env[BINDINGS_ENV] as string;
  for (const value of [marker, undefined]) {
    withEnv(t, value);
    assert.equal(takeBinding(process.env), null);
    const r = await rig(t, true);
    assert.ok(refusedPush(await pushReason(r)), String(value));
  }
});

test("(h) after a bound child, the next launch in the same process is unbound (variable deleted): role child", async (t) => {
  withEnv(t, binding("builder"));
  assert.equal(takeBinding(process.env)?.role, "builder");
  delete process.env[BINDINGS_ENV]; // pi-subagents applyProcessEnv for a launch without a binding
  assert.equal(takeBinding(process.env), null);
  const r = await rig(t, true);
  assert.ok(refusedPush(await pushReason(r)));
});

test("(i) a single launch carries the binding, a group launch (tasks, chain) none", async (t) => {
  withEnv(t, undefined);
  const r = await rig(t, false);
  const bound = (i: Record<string, unknown>): unknown => (i.extensionBindings as Record<string, unknown> | undefined)?.[BINDING_NS];
  const single: Record<string, unknown> = { agent: "builder", task: "go" };
  await r.launch(single);
  assert.ok(bound(single), "single launch");
  const tasks: Record<string, unknown> = { tasks: [{ agent: "builder", task: "a" }] };
  const chain: Record<string, unknown> = { chain: [{ agent: "builder", task: "a" }] };
  await r.launch(tasks);
  await r.launch(chain);
  assert.equal(JSON.stringify(tasks).includes(BINDING_NS), false);
  assert.equal(JSON.stringify(chain).includes(BINDING_NS), false);
});

test("stripChildBindingEnv deletes the variable (any case) or replaces it by the marker", () => {
  const env: Record<string, string | undefined> = { pi_subagent_extension_bindings: "x", A: "1" };
  stripChildBindingEnv(env);
  assert.deepEqual(env, { A: "1" });
  Object.assign(env, { [BINDINGS_ENV]: "y" });
  stripChildBindingEnv(env, "consumed:t");
  assert.deepEqual(env, { A: "1", PI_SUBAGENT_EXTENSION_BINDINGS: "consumed:t" });
});
