// r79 items 5, 11 (was R41): a session without a UI (ctx.hasUI false: print / headless) never waits for an answer. Every owner ask (an ask-kind
// floor, a judge that is unsure, an unreachable or missing judge model) is denied at once with the no-pane text; ui.select is never reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const never = () => new Promise<never>(() => undefined);
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
const ESCALATE = JSON.stringify({ verdict: "unsure", reason: "not covered" });
const JUDGE_FIRST_LINE = "git branch -D old-branch";
async function rig(t: Parameters<typeof r11Rig>[0], modelRegistry: unknown) {
  return r11Rig(t, {}, { ctx: { hasUI: false, mode: "print", ui, modelRegistry }, config: { providers: { fake: { roles: { review: { model: "m" } } } } } });
}

test("no UI + a judge that is unsure: an immediate deny with the no-pane text, no dialog", async (t) => {
  const r = await rig(t, registry(ESCALATE));
  const t0 = Date.now();
  const res = await r.call("bash", { command: JUDGE_FIRST_LINE });
  assert.ok(Date.now() - t0 < 5000, "elapsed");
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /nobody is at this session \(no pane\)/);
  assert.equal(selects, 0);
});

test("no UI + an ask-kind floor and a pattern ask rule: an immediate deny, no dialog", async (t) => {
  const r = await rig(t, registry(ESCALATE));
  const res = await r.call("bash", { command: "$(echo git) push origin main" });
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /nobody is at this session/);
  assert.equal(selects, 0);
});

test("no UI + an unreachable classifier (failing provider; no model): an immediate deny, no dialog", async (t) => {
  for (const reg of [registry(new Error("provider boom")), registry("{}", false)]) {
    const r = await rig(t, reg);
    const res = await r.call("bash", { command: JUDGE_FIRST_LINE });
    assert.equal(res?.block, true);
    assert.match(String(res?.reason), /nobody is at this session/);
  }
  assert.equal(selects, 0);
});
