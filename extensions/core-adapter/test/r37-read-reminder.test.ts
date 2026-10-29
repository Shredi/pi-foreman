// R37 items 1 and 2: the foreman's read budget only reminds (at warn, then every K further reads), never denies, and
// coordination calls (foreman session shell commands, the pr_* tools, the ledger, handoff-dir reads) do not count.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { DEFAULT_READ_LIMITS } from "../budget.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const WARN = DEFAULT_READ_LIMITS.before.warn;
const EVERY = DEFAULT_READ_LIMITS.before.every;
type Rig = Awaited<ReturnType<typeof r11Rig>>;
const reminds = (a: Rig) => a.events("read_budget").filter((r) => r.action === "remind");
/** `n` plain reads, each run to its tool_result; returns the blocks. */
async function reads(a: Rig, n: number, tag = "src") {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await a.toolDoing("bash", { command: `ls -la ${tag}${i}` }, () => undefined));
  return out;
}

test("r37: 50 reads are never denied", async (t) => {
  const a = await r11Rig(t);
  const out = await reads(a, 50);
  assert.ok(out.every((r) => r === undefined), "no read is blocked");
  assert.equal(a.events("read_budget").filter((r) => r.action === "deny").length, 0);
});

test("r37: reminders exactly at warn, warn+K, warn+2K, one trace event each", async (t) => {
  const a = await r11Rig(t);
  await reads(a, WARN - 1);
  assert.equal(reminds(a).length, 0, "none before warn");
  await reads(a, 1, "w");
  assert.deepEqual(reminds(a).map((r) => r.count), [WARN]);
  await reads(a, EVERY - 1, "k");
  assert.equal(reminds(a).length, 1, "none between reminders");
  await reads(a, 1, "k2");
  await reads(a, EVERY, "k3");
  assert.deepEqual(reminds(a).map((r) => [r.count, r.phase]), [[WARN, "before"], [WARN + EVERY, "before"], [WARN + 2 * EVERY, "before"]]);
});

test("r37: a started launch restarts the count", async (t) => {
  const a = await r11Rig(t);
  await reads(a, WARN);
  assert.equal(reminds(a).length, 1);
  const explorer = { agent: "explorer", task: "look around" };
  const l = await a.launch(explorer);
  await a.started(l.id, explorer, "run-exp");
  await reads(a, WARN - 1, "after");
  assert.equal(reminds(a).length, 1, "the count restarted");
  await reads(a, 1, "after-last");
  assert.deepEqual(reminds(a).map((r) => r.phase), ["before", "after"]);
});

test("r37: coordination calls do not count and never remind", async (t) => {
  const a = await r11Rig(t, {}, reviewAllowOpts());
  const dir = a.handoff("round", "child");
  const calls: [string, Record<string, unknown>][] = [];
  for (let i = 0; i < 6; i++) {
    calls.push(["bash", { command: "foreman session list" }]);
    calls.push(["bash", { command: `cd ${a.project} && bin/foreman session brief x` }]);
    calls.push(["bash", { command: "ledger status" }]);
    calls.push(["pr_status", {}], ["pr_checks", {}], ["pr_comments", {}]);
    calls.push(["foreman_ledger", { action: "status" }]);
    calls.push(["read", { path: path.join(dir, "ask.md") }]);
  }
  for (const [name, input] of calls) assert.equal(await a.toolDoing(name, input, () => undefined), undefined, name);
  assert.equal(a.events("read_budget").length, 0, "nothing counted, nothing reminded");
  await reads(a, WARN - 1);
  assert.equal(reminds(a).length, 0, "the count starts at zero");
  await reads(a, 1, "last");
  assert.deepEqual(reminds(a).map((r) => r.count), [WARN]);
});

test("r37: a foreman session command chained with a read still counts", async (t) => {
  const a = await r11Rig(t, {}, reviewAllowOpts());
  for (let i = 0; i < WARN; i++) await a.toolDoing("bash", { command: `foreman session list; cat x${i}` }, () => undefined);
  assert.deepEqual(reminds(a).map((r) => r.count), [WARN]);
});
