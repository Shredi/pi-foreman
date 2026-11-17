// D27: a turn end with open ledger items and no builder run and no foreman project edit since the last owner prompt is a pause:
// the finish gate refuses nothing. Unreviewed work from an earlier prompt gets one reminder with the next turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world } from "./_r46world.ts";

const items = (n: number, mark = " ") => Array.from({ length: n }, (_, i) => `- [${mark}] ${i + 1}. item ${i + 1}`).join("\n");
const OPEN = `# Ledger: x\nTier: standard\n\n${items(7)}\n- [ ] V. fresh-eyes verification passed\n`;
const CLOSED = `# Ledger: x\nTier: standard\n\n${items(2, "x")}\n- [x] V. fresh-eyes verification passed\n`;
type R = { continue?: boolean; entries?: { customType?: string }[] } | undefined;
type World = ReturnType<typeof world>;
type Adapter = Awaited<ReturnType<World["adapter"]>>;

const settle = async (a: Adapter): Promise<R> => (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
const types = (r: R) => (r?.entries ?? []).map((e) => e.customType);
const events = async (w: World, event: string) => (await w.traceEvents()).filter((e) => e.event === event);
/** The turn end after the ledger stop hold (it fires once per session and ledger): the finish gate's answer. */
async function finishAnswer(a: Adapter): Promise<R> {
  const r = await settle(a);
  return types(r).includes("pi-foreman-stop-gate") ? await settle(a) : r;
}
async function built(a: Adapter) {
  const b = await a.agentLaunch("builder", "build it");
  assert.equal(b.blocked, null);
  a.endRunAs(b.id, "builder", "done", undefined, "built");
  await new Promise((r) => setTimeout(r, 50));
}

test("standard, open items, no builder, no edit: the turn end is a pause, nothing is refused", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter();
  await a.writeLedger(OPEN);
  await a.ownerPrompt();
  assert.equal(await finishAnswer(a), undefined);
  assert.equal(await settle(a), undefined);
  assert.equal((await events(w, "finish_refused")).length, 0);
  assert.equal((await events(w, "ceremony_gate")).filter((e) => e.reason === "pause").length, 2);
});

test("a builder ran in this prompt: the finish is refused as before", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter();
  await a.writeLedger(OPEN);
  await a.ownerPrompt();
  await built(a);
  const r = await finishAnswer(a);
  assert.equal(r?.continue, true);
  assert.deepEqual(types(r), ["pi-foreman-ceremony-gate"]);
  assert.equal((await events(w, "finish_refused")).length, 1);
  assert.equal((await events(w, "ceremony_gate")).filter((e) => e.reason === "pause").length, 0);
});

test("a foreman edit of a project file in this prompt (trivial tier, then escalated to standard): refused as before", async (t) => {
  const w = world(t, { ceremony: { default: "trivial", foremanEdits: "bounded" } });
  const a = await w.adapter();
  await a.writeLedger(`# Ledger: x\nTier: trivial\n\n${items(3)}\n- [ ] V. fresh-eyes verification passed\n`);
  await a.ownerPrompt();
  fs.writeFileSync(path.join(w.project, "src.txt"), "one\n");
  const small = await a.call("write", { path: path.join(w.project, "src.txt"), content: "two\n" });
  assert.equal(small.block, undefined, "a small edit at trivial passes");
  const big = await a.call("write", { path: path.join(w.project, "more.txt"), content: "x\n".repeat(80) });
  assert.match(String(big.block?.reason), /tier|bound/i, "the edit over the bound escalates the tier and is refused");
  const r = await finishAnswer(a);
  assert.equal(r?.continue, true, JSON.stringify(await events(w, "ceremony_gate")));
  assert.deepEqual(types(r), ["pi-foreman-ceremony-gate"]);
  assert.equal((await events(w, "ceremony_gate")).filter((e) => e.reason === "pause").length, 0);
});

test("work in an earlier prompt, a new owner prompt, no work: pause, and the next turn gets one reminder", async (t) => {
  const sent: { message: { customType: string; content: string }; options: unknown }[] = [];
  const w = world(t, { ceremony: { default: "standard" }, sent });
  const a = await w.adapter();
  await a.writeLedger(OPEN);
  await a.ownerPrompt();
  await built(a);
  await a.ownerPrompt(); // the owner's next message: a new pause window
  assert.equal(await finishAnswer(a), undefined);
  const reminders = () => sent.filter((m) => m.message.customType === "pi-foreman-review-reminder");
  assert.equal(reminders().length, 1);
  assert.match(reminders()[0].message.content, /unreviewed work: a reviewer PASS is still missing before finish or PR/);
  assert.deepEqual(reminders()[0].options, { deliverAs: "nextTurn" });
  assert.equal(await settle(a), undefined);
  assert.equal(reminders().length, 1, "queued once until a turn starts");
  await a.fire("agent_start", {});
  assert.equal(await settle(a), undefined);
  assert.equal(reminders().length, 2, "one per pause");
  assert.equal((await events(w, "finish_refused")).length, 0);
});

test("a pause with no work at all sends no reminder", async (t) => {
  const sent: { message: { customType: string; content: string }; options: unknown }[] = [];
  const w = world(t, { ceremony: { default: "standard" }, sent });
  const a = await w.adapter();
  await a.writeLedger(OPEN);
  await a.ownerPrompt();
  assert.equal(await finishAnswer(a), undefined);
  assert.deepEqual(sent.filter((m) => m.message.customType === "pi-foreman-review-reminder"), []);
});

test("no open ledger item and no work: the finish is refused as before", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter();
  await a.writeLedger(CLOSED);
  await a.ownerPrompt();
  const r = await settle(a);
  assert.equal(r?.continue, true);
  assert.deepEqual(types(r), ["pi-foreman-ceremony-gate"]);
  assert.equal((await events(w, "ceremony_gate")).filter((e) => e.reason === "pause").length, 0);
});

test("resume: work in the prompt, the session restored, no new owner prompt: not a pause", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter();
  await a.writeLedger(OPEN);
  await a.ownerPrompt();
  await built(a);
  const first = await finishAnswer(a);
  assert.equal(first?.continue, true);
  const b = await w.adapter("resume");
  const r = await finishAnswer(b);
  assert.equal(r?.continue, true);
  assert.deepEqual(types(r), ["pi-foreman-ceremony-gate"]);
  assert.equal((await events(w, "ceremony_gate")).filter((e) => e.reason === "pause").length, 0);
});
