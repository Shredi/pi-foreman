// D27: a turn end with open ledger items and no builder run and no foreman project edit since the last owner prompt is a pause:
// the finish gate refuses nothing. Unreviewed work from an earlier prompt gets one reminder with the next turn.
// One world per case group: the cases of a group continue one session.
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
type Sent = { message: { customType: string; content: string }; options: unknown }[];

const settle = async (a: Adapter): Promise<R> => (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
const types = (r: R) => (r?.entries ?? []).map((e) => e.customType);
const events = async (w: World, event: string) => (await w.traceEvents()).filter((e) => e.event === event);
const pauses = async (w: World) => (await events(w, "ceremony_gate")).filter((e) => e.reason === "pause").length;
const reminders = (sent: Sent) => sent.filter((m) => m.message.customType === "pi-foreman-review-reminder");
/** The turn end after the ledger stop hold (it fires once per session and ledger): the finish gate's answer. */
async function finishAnswer(a: Adapter): Promise<R> {
  const r = await settle(a);
  return types(r).includes("pi-foreman-stop-gate") ? settle(a) : r;
}
async function built(a: Adapter) {
  const b = await a.agentLaunch("builder", "build it");
  assert.equal(b.blocked, null);
  a.endRunAs(b.id, "builder", "done", undefined, "built");
  await new Promise((r) => setTimeout(r, 50));
}

test("standard: open items and no work are a pause with no reminder; a closed ledger and a builder run are refused as before, also after a restore; a new owner prompt without work is a pause with one reminder", async (t) => {
  const sent: Sent = [];
  const w = world(t, { ceremony: { default: "standard" }, sent });
  const a = await w.adapter();
  await a.writeLedger(OPEN);
  await a.ownerPrompt();
  assert.equal(await finishAnswer(a), undefined);
  assert.equal(await settle(a), undefined);
  assert.equal((await events(w, "finish_refused")).length, 0);
  assert.equal(await pauses(w), 2);
  assert.deepEqual(reminders(sent), [], "a pause with no work at all sends no reminder");

  await a.writeLedger(CLOSED); // no open ledger item and no work: the finish is refused as before
  await a.ownerPrompt();
  const r = await finishAnswer(a);
  assert.equal(r?.continue, true);
  assert.deepEqual(types(r), ["pi-foreman-ceremony-gate"]);
  assert.equal(await pauses(w), 2);

  // a builder ran in this prompt: refused as before
  await a.writeLedger(OPEN);
  await a.ownerPrompt();
  await built(a);
  const refused = await finishAnswer(a);
  assert.equal(refused?.continue, true);
  assert.deepEqual(types(refused), ["pi-foreman-ceremony-gate"]);
  assert.equal((await events(w, "finish_refused")).length, 2);
  assert.equal(await pauses(w), 2);

  // resume: work in the prompt, the session restored, no new owner prompt: not a pause
  const b = await w.adapter("resume");
  const again = await finishAnswer(b);
  assert.equal(again?.continue, true);
  assert.deepEqual(types(again), ["pi-foreman-ceremony-gate"]);
  assert.equal(await pauses(w), 2);

  await b.ownerPrompt(); // the owner's next message: a new pause window; the work of the earlier prompt is unreviewed
  assert.equal(await finishAnswer(b), undefined);
  assert.equal(reminders(sent).length, 1);
  assert.match(reminders(sent)[0].message.content, /unreviewed work: a reviewer PASS is still missing before finish or PR/);
  assert.deepEqual(reminders(sent)[0].options, { deliverAs: "nextTurn" });
  assert.equal(await settle(b), undefined);
  assert.equal(reminders(sent).length, 1, "queued once until a turn starts");
  await b.fire("agent_start", {});
  assert.equal(await settle(b), undefined);
  assert.equal(reminders(sent).length, 2, "one per pause");
  assert.equal((await events(w, "finish_refused")).length, 3, "the pause refuses nothing");
  assert.equal(await pauses(w), 5, "three more pauses: the new prompt's three turn ends");
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
  assert.equal(await pauses(w), 0);

  // a builder launched before an owner prompt that ends after it is work of that prompt: the turn end is refused, not a pause
  await a.ownerPrompt();
  const run = await a.agentLaunch("builder", "build more");
  assert.equal(run.blocked, null);
  await a.ownerPrompt(); // the owner types while the builder runs
  const refusedBefore = (await events(w, "finish_refused")).length;
  assert.equal(await finishAnswer(a), undefined, "waiting for the run is not a refusal");
  assert.equal((await events(w, "finish_refused")).length, refusedBefore);
  a.endRunAs(run.id, "builder", "done", undefined, "built");
  await new Promise((x) => setTimeout(x, 50));
  const ended = await finishAnswer(a);
  assert.equal(ended?.continue, true);
  assert.deepEqual(types(ended), ["pi-foreman-ceremony-gate"]);
  assert.equal((await events(w, "finish_refused")).length, refusedBefore + 1);
});
