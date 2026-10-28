// R41: a session without a UI (ctx.hasUI false: print / headless) never waits for an answer. A policy ask and an unreachable review
// (no review model, a failing provider) deny at once, with the reason in the trace; a ui.select that never resolves is never reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const never = () => new Promise<never>(() => undefined);
const ASK = JSON.stringify({ verdict: "ask", entry: "package-install", reason: "because package-install" });
let selects = 0;
const ui = { notify: () => undefined, confirm: never, select: () => (selects++, never()), input: never, setStatus: () => undefined, setWidget: () => undefined };
const registry = (reply: string | Error, found = true) => ({
  find: () => (found ? { id: "m" } : undefined),
  getProviderAuthStatus: () => ({ configured: false }),
  complete: async () => {
    if (reply instanceof Error) throw reply;
    return { content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } };
  },
});
const rig = (t: Parameters<typeof r11Rig>[0], modelRegistry: unknown, review: boolean) =>
  r11Rig(t, {}, { ctx: { hasUI: false, mode: "print", ui, modelRegistry }, config: { providers: { fake: { ...(review ? { review: { model: "m" } } : {}), roles: {} } } } });

test("no UI + a review that asks: an immediate deny, no dialog, the rule in the trace", async (t) => {
  const r = await rig(t, registry(ASK), true);
  const t0 = Date.now();
  const res = await r.call("bash", { command: "pip install requests" });
  assert.ok(Date.now() - t0 < 5000, "elapsed");
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /policy ask package-install: because package-install\. This session cannot answer asks; the call is denied/);
  assert.equal(selects, 0);
  assert.ok(r.events("review").some((e) => e.kind === "gate" && e.decision === "ask"), JSON.stringify(r.events("review")));
  const d = r.events("dialog").at(-1)!;
  assert.deepEqual([d.guard, d.cause, d.decision, d.rule], ["gate", "ask", "no-ui", "package-install"]);
  assert.match(String(d.reason), /because package-install/);
});

test("no UI + an unreachable review (failing provider; no review model): an immediate deny that names the cause", async (t) => {
  for (const [reg, review, cause] of [[registry(new Error("provider boom")), true, /provider error/], [registry("{}", false), false, /no review model|no model|not configured/i]] as const) {
    const r = await rig(t, reg, review);
    const t0 = Date.now();
    const res = await r.call("bash", { command: "terraform plan" });
    assert.ok(Date.now() - t0 < 5000, "elapsed");
    assert.equal(res?.block, true);
    assert.match(String(res?.reason), /the permission review is unreachable \(.*\); the call is denied/);
    assert.match(String(res?.reason), cause);
    assert.ok(r.events("review").some((e) => e.kind === "gate" && e.decision === "unreachable"), JSON.stringify(r.events("review")));
    const launch = await r.launch({ agent: "explorer", task: "look around" });
    assert.equal(launch.res?.block, true, "the foreman's own subagent launch");
    assert.match(String(launch.res?.reason), /the permission review is unreachable/);
    const d = r.events("dialog").at(-1)!;
    assert.deepEqual([d.guard, d.cause, d.decision, d.toolFamily], ["gate", "unreachable", "no-ui", "subagent"]);
    assert.match(String(d.reason), cause);
  }
  assert.equal(selects, 0);
});
