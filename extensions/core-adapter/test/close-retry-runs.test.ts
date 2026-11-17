// A `pr-merged` close refused for active child runs is tried once more when the last run ends (CloseFlow.onRunsDone, registerClose's onRunsDone).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseFlow, registerClose } from "../close.ts";
import type { CloseDeps, CloseRequest } from "../close.ts";

const FILE = "/x/handoff/result.md";
const merged: CloseRequest = { source: "pr-merged", file: FILE, shown: FILE, prompt: "MERGED-PROMPT", pr: { n: 7, parent: "parent-1", label: "child" } };
const parent: CloseRequest = { source: "intercom-parent", file: "/x/.workflow/r.md", replyTo: "parent-1" };
const AGAIN = /tried again once they end/;

function rig(runs: number[]) {
  const log: string[] = [];
  const queue = [...runs];
  const deps = {
    activeWaits: () => [],
    activeRuns: () => (queue.length > 1 ? queue.shift()! : queue[0]),
    sendUserMessage: (t: string) => void log.push(`prompt:${t}`),
    runSync: async () => ({ text: "sync", ok: true }),
    retro: async () => "",
    reply: (to: string, t: string) => void log.push(`reply:${to}:${t}`),
    notify: (t: string) => void log.push(`notify:${t}`),
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: () => undefined,
    exists: () => true,
    setTimer: () => () => undefined,
  } as unknown as CloseDeps;
  const flow = new CloseFlow(deps);
  const prompts = () => log.filter((l) => l.startsWith("prompt:")).length;
  const refusals = () => log.filter((l) => l.startsWith("notify:pi-foreman: close refused"));
  return { log, flow, prompts, refusals, set: (...v: number[]) => void queue.splice(0, queue.length, ...v) };
}

test("refused at begin: the retry runs when the runs end and the close proceeds once", async () => {
  const r = rig([1]);
  await r.flow.request(merged, { isIdle: () => true });
  assert.match(r.refusals()[0], AGAIN);
  assert.equal(r.prompts(), 0);
  r.set(1);
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.prompts(), 0, "a run is still active: nothing yet");
  r.set(0);
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.prompts(), 1);
  assert.equal(r.log.filter((l) => l === "prompt:MERGED-PROMPT").length, 1);
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.prompts(), 1, "the retry is spent");
});

test("refused at closeTurn after idle-wait: the retry closes once the runs end", async () => {
  const r = rig([0]);
  await r.flow.request(merged, { isIdle: () => false });
  assert.equal(r.flow.active, true, "idle-wait");
  r.set(1);
  await r.flow.onSettled({ isIdle: () => true, shutdown: () => undefined });
  assert.match(r.refusals()[0], AGAIN);
  assert.equal(r.flow.active, false);
  r.set(0);
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.prompts(), 1);
});

test("refused at finishing: the retry closes once the runs end", async () => {
  const r = rig([0]);
  await r.flow.request(merged, { isIdle: () => true });
  assert.equal(r.prompts(), 1);
  assert.equal(r.flow.onInput("MERGED-PROMPT", "extension"), false);
  r.flow.onModelReply("stop");
  r.set(1);
  await r.flow.onSettled({ isIdle: () => true, shutdown: () => undefined });
  assert.match(r.refusals()[0], AGAIN);
  assert.equal(r.flow.active, false);
  r.set(0);
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.prompts(), 2, "the close prompt goes out again");
});

test("a second refusal is final: its text does not say tried again and nothing is armed", async () => {
  const r = rig([1, 0, 1]);
  await r.flow.request(merged, { isIdle: () => true });
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.refusals().length, 2);
  assert.match(r.refusals()[0], AGAIN);
  assert.doesNotMatch(r.refusals()[1], AGAIN);
  assert.match(r.refusals()[1], /child run\(s\) still active/);
  r.set(0);
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.prompts(), 0);
});

test("a close the parent sent is refused with today's text and not retried", async () => {
  const r = rig([1]);
  await r.flow.request(parent, { isIdle: () => true });
  assert.doesNotMatch(r.refusals()[0], AGAIN);
  assert.match(r.refusals()[0], /then close again/);
  r.set(0);
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.prompts(), 0);
});

test("a close accepted meanwhile clears the armed retry", async () => {
  const r = rig([1]);
  await r.flow.request(merged, { isIdle: () => true });
  r.set(0);
  await r.flow.request(parent, { isIdle: () => false });
  assert.equal(r.flow.active, true, "the parent's close is accepted (idle-wait)");
  r.flow.reset();
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.prompts(), 0);
});

// ---------------------------------------------------------------- registerClose wiring

function wired(runs: { n: number }) {
  const sent: string[] = [];
  const pi = { on: () => undefined, sendUserMessage: (t: string) => void sent.push(t), events: { emit: () => undefined, on: () => () => undefined } };
  const close = registerClose(pi as never, {
    platform: process.platform,
    activeWaits: () => [],
    activeRuns: () => runs.n,
    session: async () => ({ id: "s1", isChild: false, cwd: "/x", config: () => ({}), trace: () => undefined, markCause: () => undefined, runSync: async () => ({ text: "", ok: true }), retro: async () => "" }),
  } as never);
  const ctx = { hasUI: true, isIdle: () => true, shutdown: () => undefined, ui: { notify: () => undefined }, sessionManager: { getSessionId: () => "s1", getBranch: () => [] } };
  return { sent, close, ctx };
}

test("registerClose: a refused pr-merged start is retried by onRunsDone(id) and sends the close prompt", async () => {
  const runs = { n: 1 };
  const w = wired(runs);
  await w.close.start(w.ctx as never, merged);
  assert.deepEqual(w.sent, []);
  runs.n = 0;
  await w.close.onRunsDone("s1");
  assert.deepEqual(w.sent, ["MERGED-PROMPT"]);
});

test("registerClose: onRunsDone with an unknown id does nothing and does not throw", async () => {
  const runs = { n: 1 };
  const w = wired(runs);
  await w.close.start(w.ctx as never, merged);
  runs.n = 0;
  assert.doesNotThrow(() => w.close.onRunsDone("nope"));
  await w.close.onRunsDone("nope");
  assert.deepEqual(w.sent, []);
});

test("a retry accepted after idle-wait and refused at closeTurn is final: no tried-again text, nothing re-armed", async () => {
  const r = rig([1]);
  await r.flow.request(merged, { isIdle: () => true });
  r.set(0);
  await r.flow.onRunsDone({ isIdle: () => false });
  assert.equal(r.flow.active, true, "the retry is accepted (idle-wait)");
  r.set(1);
  await r.flow.onSettled({ isIdle: () => true, shutdown: () => undefined });
  assert.equal(r.refusals().length, 2);
  assert.doesNotMatch(r.refusals()[1], AGAIN);
  r.set(0);
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.prompts(), 0);
  assert.equal(r.refusals().length, 2);
});

test("a retry accepted and refused at finishing is final: no tried-again text, nothing re-armed", async () => {
  const r = rig([1]);
  await r.flow.request(merged, { isIdle: () => true });
  r.set(0);
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.prompts(), 1);
  assert.equal(r.flow.onInput("MERGED-PROMPT", "extension"), false);
  r.flow.onModelReply("stop");
  r.set(1);
  await r.flow.onSettled({ isIdle: () => true, shutdown: () => undefined });
  assert.equal(r.refusals().length, 2);
  assert.doesNotMatch(r.refusals()[1], AGAIN);
  r.set(0);
  await r.flow.onRunsDone({ isIdle: () => true });
  assert.equal(r.prompts(), 1);
});
