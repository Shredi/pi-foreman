import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedConfirm, bridgePermissionBlocked, withBlocked } from "../herdr.ts";

function bus() {
  const handlers = new Map<string, ((d: unknown) => void)[]>();
  const sent: { active: boolean; label: string }[] = [];
  return {
    sent,
    emit(ch: string, d: unknown) {
      if (ch === "herdr:blocked") sent.push(d as { active: boolean; label: string });
      for (const h of handlers.get(ch) ?? []) h(d);
    },
    on(ch: string, h: (d: unknown) => void) {
      handlers.set(ch, [...(handlers.get(ch) ?? []), h]);
      return () => handlers.set(ch, []);
    },
  };
}

test("withBlocked is balanced on success and on throw", async () => {
  const b = bus();
  assert.equal(await withBlocked(b, "ask", async () => 7), 7);
  await assert.rejects(withBlocked(b, "ask", async () => { throw new Error("x"); }), /x/);
  assert.deepEqual(b.sent.map((s) => s.active), [true, false, true, false]);
  await withBlocked(undefined, "ask", async () => 1);
});

test("blockedConfirm passes title/message and the answer through", async () => {
  const b = bus();
  const c = blockedConfirm(b, async (t, m) => t === "T" && m === "M");
  assert.equal(await c("T", "M"), true);
  assert.deepEqual(b.sent.map((s) => s.label), ["T", "T"]);
});

test("permission-system prompt/decision map to blocked, balanced per requestId", () => {
  const b = bus();
  const { off } = bridgePermissionBlocked(b);
  b.emit("permissions:decision", { requestId: "nope" });
  b.emit("permissions:ui_prompt", { requestId: "r1", surface: "bash" });
  b.emit("permissions:ui_prompt", { requestId: "r1", surface: "bash" });
  b.emit("permissions:decision", { requestId: "r1" });
  b.emit("permissions:decision", { requestId: "r1" });
  assert.deepEqual(b.sent.map((s) => s.active), [true, false]);
  assert.equal(b.sent[0].label, "permission: bash");
  off();
  b.emit("permissions:ui_prompt", { requestId: "r2" });
  assert.equal(b.sent.length, 2);
});

test("clear releases prompts that never got a decision", () => {
  const b = bus();
  const { clear } = bridgePermissionBlocked(b);
  b.emit("permissions:ui_prompt", { requestId: "a" });
  b.emit("permissions:ui_prompt", { requestId: "b" });
  clear();
  clear();
  assert.deepEqual(b.sent.map((s) => s.active), [true, true, false, false]);
  b.emit("permissions:decision", { requestId: "a" });
  assert.equal(b.sent.length, 4);
});
