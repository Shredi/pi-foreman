// PR 2 of the intercom round, child side: a delivered intercom `send` to the parent lets the turn end without the finish checks
// (`waitingForParent`); the next inbound message, a wake or typed input ends that. In memory only. The real adapter over the r46 world.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world } from "./_r46world.ts";

// A closed ledger at standard: only the finish gate (builder and reviewer missing) can hold the turn.
const LEDGER = "# Ledger: x\nTier: standard\n\n- [x] 1. done\n- [x] V. fresh-eyes verification passed\n";
type R = { continue?: boolean } | undefined;
type Rig = Awaited<ReturnType<typeof rig>>;

async function rig(t: { after(fn: () => void | Promise<void>): void }, o: { noParent?: boolean } = {}) {
  const w = world(t, { ceremony: { default: "standard" }, handoff: true, parent: true });
  if (o.noParent) fs.rmSync(path.join(w.handoff, "parent"));
  const a = await w.adapter();
  await a.writeLedger(LEDGER);
  const id = { n: 0 };
  const send = async (to: string, result: { details?: unknown; text?: string; isError?: boolean } = {}) => {
    const input = { action: "send", to, message: "Question: which one?" };
    const call = await a.checkCall("intercom", input);
    assert.equal(call, undefined, "the guard lets a send to the parent through");
    return a.fire("tool_result", { toolName: "intercom", toolCallId: `s${++id.n}`, input, details: result.details ?? { delivered: true }, content: [{ type: "text", text: result.text ?? `Message sent to ${to}` }], isError: result.isError ?? false });
  };
  const inbound = (customType: string, from = { id: "parent-session", name: "main" }) => a.fire("message_end", { message: { role: "custom", customType, details: { from, bodyText: "Answer: A", message: { content: { text: "**From main**\n\nAnswer: A" } } }, content: "Answer: A" } });
  const settle = async (): Promise<R> => (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
  const gateSkips = async () => (await w.traceEvents()).filter((e) => e.event === "ceremony_gate" && e.reason === "waiting_for_parent").length;
  return { w, a, send, inbound, settle, gateSkips };
}

const held = async (r: Rig): Promise<boolean> => (await r.settle())?.continue === true;

test("without a send the finish checks hold (the baseline of the cases below)", async (t) => {
  const r = await rig(t);
  assert.equal(await held(r), true);
});

test("a delivered send to the parent id: the turn ends without the finish checks, traced, no refusal spent", async (t) => {
  const r = await rig(t);
  await r.send("parent-session");
  assert.equal(await r.settle(), undefined);
  assert.equal(await r.gateSkips(), 1);
  const ev = await r.w.traceEvents();
  assert.ok(ev.some((e) => e.event === "waiting_for_parent" && e.decision === "set" && e.toolFamily === "intercom"));
  assert.equal(ev.filter((e) => e.event === "finish_refused").length, 0);
});

test("a send whose answer is 'waiting in the broker mailbox' counts as delivered", async (t) => {
  const r = await rig(t);
  await r.send("parent-session", { details: { delivered: true, delivery: "queued" }, text: "Message waiting in the broker mailbox for parent-session" });
  assert.equal(await r.settle(), undefined);
});

test("a send by the parent's name (seen on its message) and by an id prefix counts; names resolve against the parent id only", async (t) => {
  const r = await rig(t);
  await r.inbound("intercom_message");
  await r.send("MAIN");
  assert.equal(await r.settle(), undefined, "by name");
  await r.inbound("intercom_message");
  assert.equal(await held(r), true);
  await r.send("parent-s");
  assert.equal(await r.settle(), undefined, "by a prefix of the id");
  // a name a stranger used is not the parent's
  await r.inbound("intercom_message");
  await r.inbound("intercom_message", { id: "stranger-1", name: "buddy" });
  await r.send("buddy");
  assert.equal(await held(r), true);
});

test("a send to another session, a failed send and a send with no parent set no flag", async (t) => {
  const r = await rig(t);
  await r.send("some-other-session");
  assert.equal(await held(r), true, "another session");
  await r.a.ownerPrompt(); // a refusal is spent per prompt: two, then the finish goes through
  await r.send("parent-session", { details: { error: "Session not found" }, text: "Session not found" });
  assert.equal(await held(r), true, "Session not found");
  await r.a.ownerPrompt();
  await r.send("parent-session", { isError: true, text: "boom" });
  assert.equal(await held(r), true, "an error result");
  await r.a.ownerPrompt();
  await r.send("parent-session", { details: { delivered: false }, text: "Message sent to parent-session" });
  assert.equal(await held(r), true, "delivered false");

  const none = await rig(t, { noParent: true });
  await none.send("parent-session");
  assert.equal(await held(none), true, "no parent file: the send is to nobody's parent");
});

test("an inbound intercom message clears the flag and the checks run again", async (t) => {
  const r = await rig(t);
  await r.send("parent-session");
  assert.equal(await r.settle(), undefined);
  await r.inbound("intercom_message");
  assert.equal(await held(r), true);
});

test("a wake clears the flag and the checks run again", async (t) => {
  const r = await rig(t);
  await r.send("parent-session");
  assert.equal(await r.settle(), undefined);
  await r.inbound("foreman_wake");
  assert.equal(await held(r), true);
});

test("typed input clears the flag (Pi fires the `input` event with source interactive)", async (t) => {
  const r = await rig(t);
  await r.send("parent-session");
  assert.equal(await r.settle(), undefined);
  await r.a.ownerPrompt();
  assert.equal(await held(r), true);
});

test("an inbound message in the same turn, before the turn ends, clears the flag: the order decides", async (t) => {
  const r = await rig(t);
  await r.send("parent-session");
  await r.inbound("intercom_message");
  assert.equal(await held(r), true, "the answer arrived in the same turn");
  await r.inbound("intercom_message");
  await r.send("parent-session");
  assert.equal(await r.settle(), undefined, "a later send sets it again");
});

test("the flag is in memory only: gone after a reload", async (t) => {
  const r = await rig(t);
  await r.send("parent-session");
  assert.equal(await r.settle(), undefined);
  const again = await r.w.adapter("reload");
  await again.writeLedger(LEDGER);
  const res = (await again.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
  assert.equal(res?.continue, true);
  assert.equal(r.w.entries.some((e) => JSON.stringify(e.data).includes("waitingForParent")), false, "nothing written to the session file");
});

test("a send to the parent starts no blocked source: no blocked trace event, no sent-message type", async (t) => {
  const r = await rig(t);
  await r.send("parent-session");
  const names = (await r.w.traceEvents()).map((e) => String(e.event));
  assert.deepEqual(names.filter((n) => /blocked|parent_ask|child_ask/.test(n)), []);
});
