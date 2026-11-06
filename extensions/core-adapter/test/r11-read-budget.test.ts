// R11 item 5 (P2): a ruling line never changes the read budget, but a parent-written ruling-<n>.md or brief-<x>.md
// resets it (R18 item 1, r18-caps-reset.test.ts); the read budget never denies.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { DEFAULT_READ_LIMITS } from "../budget.ts";
import { r11Rig, reviewAllowOpts, writeAt } from "./_r11rig.ts";

const WARN = DEFAULT_READ_LIMITS.before.warn; // 8, the same for both phases
const readDenied = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[read_budget_exceeded\]/.test(r.reason ?? "");

type Rig = Awaited<ReturnType<typeof r11Rig>>;
/** `n` plain reads; returns the results. */
async function reads(a: Rig, n: number): Promise<({ block?: boolean; reason?: string } | undefined)[]> {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await a.call("bash", { command: `ls -la src${i}` }));
  return out;
}

const reminds = (a: Rig): number => a.events("read_budget").filter((r) => r.action === "remind").length;

test("ruling_read_budget_line_has_no_effect_but_ruling_file_resets", async (t) => {
  const a = await r11Rig(t, {}, reviewAllowOpts());
  const dir = a.handoff("round", "child");
  const now = Date.now();
  writeAt(path.join(dir, "ask.md"), "ask: more reads?\n", now - 60_000);
  const out = await reads(a, WARN + 1);
  assert.ok(!out.some(readDenied), "a read is never denied");
  assert.equal(reminds(a), 1);
  // a parent-written ruling.md with the line, newer than the ask: nothing changes (no text parser, ruling.md is no reset file)
  writeAt(path.join(dir, "ruling.md"), "APPROVED\nread-budget: +3\n", now - 1000);
  assert.ok(!(await reads(a, 2)).some(readDenied));
  assert.equal(reminds(a), 1, "the ruling line changes nothing");
  // a parent-written ruling-2.md resets the read budget: the count restarts, so WARN - 1 further reads raise no reminder
  writeAt(path.join(dir, "ruling-2.md"), "go on\n", Date.now());
  await a.turnStart(); // the reads above were tool_calls only: none is in flight on the next turn
  await reads(a, WARN - 1);
  assert.equal(reminds(a), 1, "a parent ruling-<n>.md resets the read count");
  assert.equal(a.events("cap_reset").length, 1);
});
