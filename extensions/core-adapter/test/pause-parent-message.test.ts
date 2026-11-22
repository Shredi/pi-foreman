// D27 addendum: a message of the parent recorded at spawn counts as a prompt: after builder work, an open ledger is a pause, not a refused finish.
import { test } from "node:test";
import assert from "node:assert/strict";
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
const message = (from: string, text: string, crossMachine?: boolean) => ({
  role: "custom",
  customType: "intercom_message",
  content: `**From ${from}**\n\n${text}`,
  details: { from: { id: from, name: from }, bodyText: text, message: { content: { text }, ...(crossMachine ? { crossMachine: true } : {}) } },
});
const refused = (r: R) => r?.continue === true && types(r).includes("pi-foreman-ceremony-gate");

async function start(t: Parameters<typeof world>[0], ledger = OPEN) {
  const w = world(t, { ceremony: { default: "standard" }, parent: true });
  const a = await w.adapter();
  await a.writeLedger(OPEN);
  await a.ownerPrompt();
  await built(a);
  if (ledger !== OPEN) await a.writeLedger(ledger);
  return { w, a };
}

test("control: builder work and no message: the finish is refused", async (t) => {
  const { a } = await start(t);
  assert.ok(refused(await finishAnswer(a)));
});

test("a message of the parent after builder work: a pause, no refusal", async (t) => {
  const { w, a } = await start(t);
  await a.fire("message_end", { message: message("parent-session", "please pause") });
  assert.equal(await finishAnswer(a), undefined);
  assert.equal((await events(w, "finish_refused")).length, 0);
  assert.ok((await events(w, "ceremony_gate")).some((e) => e.reason === "pause"));
});

test("a message of another sender: refused as before", async (t) => {
  const { a } = await start(t);
  await a.fire("message_end", { message: message("someone-else", "please pause") });
  assert.ok(refused(await finishAnswer(a)));
});

test("a cross-machine message carrying the parent id: refused as before", async (t) => {
  const { a } = await start(t);
  await a.fire("message_end", { message: message("parent-session", "please pause", true) });
  assert.ok(refused(await finishAnswer(a)));
});

test("a closed ledger after a parent message: refused as before", async (t) => {
  const { a } = await start(t, CLOSED);
  await a.fire("message_end", { message: message("parent-session", "please pause") });
  assert.ok(refused(await finishAnswer(a)));
});

test("a parent message handled again after a reload does not move the baseline", async (t) => {
  const { w, a } = await start(t);
  const m = message("parent-session", "please pause");
  await a.fire("message_end", { message: m });
  assert.equal(await finishAnswer(a), undefined);
  await built(a); // builder work after the parent's message
  await settle(a); // the settle writes the work into the session entry the reload restores
  await a.down();
  w.entries.push({ type: "custom_message", id: "cm1", customType: m.customType, content: m.content, details: m.details } as never);
  const b = await w.adapter("reload");
  // the trailing entry is caught up with the next custom message_end: it must not open a new pause window
  await b.fire("message_end", { message: { role: "custom", customType: "other-note", content: "x", details: {} } });
  assert.ok(refused(await finishAnswer(b)));
});
