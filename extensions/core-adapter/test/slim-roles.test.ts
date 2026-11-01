// roles-slim: three launchable roles; the heavy finish gate needs builder and reviewer only; the finalization window
// opens on a reviewer PASS and on nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { requiredSteps } from "../bound.ts";
import { DEFAULT_READ_LIMITS } from "../budget.ts";
import { LAUNCH_ROLES, toolDefault } from "../defaults.ts";
import { childRoleIds, roleLaunchBlock } from "../roles.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WARN = DEFAULT_READ_LIMITS.before.warn;
const reminds = (a: Awaited<ReturnType<typeof r11Rig>>): number => a.events("read_budget").filter((r) => r.action === "remind").length;

test("LAUNCH_ROLES has three ids; a removed role name is refused by the generic unknown-role path", () => {
  assert.deepEqual([...LAUNCH_ROLES].sort(), ["builder", "explorer", "reviewer"]);
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "foreman.defaults.json"), "utf8"));
  const allowed = childRoleIds(defaults.roles);
  assert.deepEqual(allowed, ["explorer", "builder", "reviewer"]);
  for (const old of ["planner", "finalizer", "senior-reviewer"]) {
    assert.equal(toolDefault("subagent", { agent: old, task: "t" }, { child: false }), undefined, old);
    assert.match(roleLaunchBlock({ agent: old, task: "t" }, allowed) ?? "", new RegExp(`agent '${old}' is not a pi-foreman role`), old);
  }
});

test("the default heavy finish gate needs builder and reviewer only", () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "foreman.defaults.json"), "utf8"));
  assert.deepEqual(requiredSteps(defaults.ceremony.required, "heavy"), ["builder", "reviewer"]);
});

test("the finalization window opens on a reviewer PASS only", async (t) => {
  const a = await r11Rig(t, {}, reviewAllowOpts());
  const run = async (agent: string, runId: string, verdict: string): Promise<void> => {
    const input = { agent, task: "work" };
    const l = await a.launch(input);
    assert.equal(l.res, undefined);
    await a.started(l.id, input, runId);
    a.end({ runId, agent, status: "completed", success: true, summary: verdict });
    if (agent === "reviewer") await a.notice(`Background task completed: **reviewer**\nOverall verdict: ${verdict}`);
  };
  await run("builder", "run-b", "done");
  await run("reviewer", "run-fail", "FAIL");
  for (let i = 0; i < WARN + 2; i++) await a.call("bash", { command: `ls -la a${i}` });
  assert.ok(reminds(a) >= 1, "no window after a builder run or a reviewer FAIL: the read budget applies");
  const b = await r11Rig(t, {}, reviewAllowOpts());
  const input = { agent: "reviewer", task: "review the diff" };
  const l = await b.launch(input);
  await b.started(l.id, input, "run-pass");
  b.end({ runId: "run-pass", agent: "reviewer", status: "completed", success: true, summary: "VERDICT: PASS" });
  await b.notice("Background task completed: **reviewer**\nOverall verdict: PASS");
  for (let i = 0; i < WARN + 2; i++) await b.call("bash", { command: `ls -la b${i}` });
  assert.equal(reminds(b), 0, "a reviewer PASS opens the window: no read reminder");
});
