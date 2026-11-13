// r42: who a blocked session waits on (owner or parent) in the live file, and the two trace events, with the real sources.
import "./_hermetic-env.mjs";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BlockedTracker, blockedConfirmOn, withBlocked, withBlockedOn } from "../herdr.ts";
import { LiveState, liveDir } from "../livestate.ts";
import { r11Rig } from "./_r11rig.ts";

const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "r42-live-"));
  const l = LiveState.start({ agentDir: d, sessionId: "s", cwd: "/w", mode: "rpc", env: {} }, () => [])!;
  return { d, l, read: () => JSON.parse(fs.readFileSync(path.join(liveDir(d), "s.json"), "utf8")) as Record<string, unknown>, done: () => { l.stop(); fs.rmSync(d, { recursive: true, force: true }); } };
};
const snap = (l: LiveState) => l.snapshot() as unknown as Record<string, unknown>;

// One adapter session for the two trace cases (a session start runs git and python); each case reads the trace from its own start on.
type Rig = Awaited<ReturnType<typeof r11Rig>>;
const cleanups: (() => void | Promise<void>)[] = [];
let shared: Rig;
before(async () => {
  shared = await r11Rig({ after: (fn) => void cleanups.push(fn) });
}, { timeout: 20_000 });
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
}, { timeout: 20_000 });
const traceRig = (): Rig => {
  const start = shared.trace().length;
  return { ...shared, events: (name: string) => shared.trace().slice(start).filter((x) => x.event === name) };
};

test("live state: each owner kind and the parent classes; no fields while nothing is open", (t) => {
  const { l, done } = mk();
  t.after(done);
  const s0 = snap(l);
  for (const k of ["blockedOn", "blockedKind", "ownerBlockedSince"]) assert.equal(k in s0, false, k);
  for (const kind of ["approval", "question", "checkpoint", "script", "confirm"] as const) {
    const rel = l.holdOn({ on: "owner", kind });
    const s = snap(l);
    assert.equal(s.blockedOn, "owner");
    assert.equal(s.blockedKind, kind);
    assert.equal(typeof s.ownerBlockedSince, "string");
    rel();
    assert.equal("blockedOn" in snap(l), false);
  }
  const rel = l.holdOn({ on: "parent", kind: "parent-ask" });
  const s = snap(l);
  assert.equal(s.blockedOn, "parent");
  assert.equal(s.blockedKind, "parent-ask");
  assert.equal(s.state, "blocked", "state is unchanged by the class");
  assert.equal(typeof s.blockedSince, "string");
  assert.equal("ownerBlockedSince" in s, false);
  rel();
  assert.equal(snap(l).state, "idle");
});

test("live state: an unclassed hold and the old hold() count as owner, kind dialog", (t) => {
  const { l, done } = mk();
  t.after(done);
  const r1 = l.hold();
  assert.deepEqual([snap(l).blockedOn, snap(l).blockedKind], ["owner", "dialog"]);
  r1();
  const r2 = l.holdOn();
  assert.deepEqual([snap(l).blockedOn, snap(l).blockedKind], ["owner", "dialog"]);
  r2();
});

test("live state: an owner dialog during a parent ask is timed from its own start; the older closing keeps one episode", async (t) => {
  const { l, done } = mk();
  t.after(done);
  const parent = l.holdOn({ on: "parent", kind: "parent-ask" });
  await new Promise((r) => setTimeout(r, 15));
  const a = l.holdOn({ on: "owner", kind: "approval" });
  const first = snap(l).ownerBlockedSince as string;
  assert.ok(Date.parse(first) > Date.parse(snap(l).blockedSince as string), "not the parent ask's start");
  await new Promise((r) => setTimeout(r, 15));
  const b = l.holdOn({ on: "owner", kind: "question" });
  assert.equal(snap(l).ownerBlockedSince, first, "a second owner source does not restart the episode");
  assert.equal(snap(l).blockedKind, "approval", "the kind of the source that opened it");
  a();
  assert.equal(snap(l).ownerBlockedSince, first, "the older closing keeps the episode");
  assert.equal(snap(l).blockedOn, "owner");
  b();
  assert.equal(snap(l).blockedOn, "parent", "only the parent ask is left");
  assert.equal("ownerBlockedSince" in snap(l), false);
  parent();
});

test("live state: the ui key follows the single-key rule; extension input and a turn end keep it, typed input and a prompt end clear it", (t) => {
  const { l, done } = mk();
  t.after(done);
  assert.equal(l.uiKey("prompt_start").opened, true);
  assert.equal(l.uiKey("prompt_start").opened, undefined, "one key, not a counter");
  assert.equal(snap(l).blockedOn, "owner");
  assert.equal(snap(l).blockedKind, "dialog");
  l.uiKey("input", "extension");
  l.uiKey("agent_end");
  assert.equal(snap(l).blockedOn, "owner", "kept across extension input and a turn end");
  assert.equal(typeof l.uiKey("input", "interactive").waitedMs, "number");
  assert.equal("blockedOn" in snap(l), false);
  l.uiKey("prompt_start");
  assert.equal(typeof l.uiKey("prompt_end").waitedMs, "number");
  assert.equal("blockedOn" in snap(l), false);
  // the existing state/blockedSince clearing stays on its own rule
  l.setBlocked(true);
  assert.equal(snap(l).state, "blocked");
  l.setBlocked(false);
  assert.equal(snap(l).state, "idle");
});

test("herdr: the class travels to the hook; the old functions pass none; every hook sees the same class", async () => {
  const seen: unknown[] = [];
  const events = { on: () => undefined, emit: () => undefined };
  const tr = new BlockedTracker(events as never, () => false);
  tr.onOwnOn((label, cls) => {
    seen.push([label, cls]);
    return () => undefined;
  });
  tr.own("plain");
  tr.ownOn("classed", { on: "parent", kind: "parent-ask" });
  assert.deepEqual(seen, [["plain", undefined], ["classed", { on: "parent", kind: "parent-ask" }]]);
  assert.equal(typeof withBlocked, "function");
  assert.equal(typeof withBlockedOn, "function");
  assert.equal(typeof blockedConfirmOn, "function");
  assert.equal(await withBlockedOn(undefined, { on: "owner", kind: "confirm" }, "t", async () => 7), 7);
  assert.equal(await blockedConfirmOn(undefined, { on: "owner", kind: "confirm" }, async () => true)("a", "b"), true);
});

test("trace: blocked_open and blocked_closed for a ui dialog and an owner question carry on, kind, label and waitedMs", async () => {
  const rig = traceRig();
  await rig.fire("ui_prompt_start", { title: "Allow tool?", kind: "select" });
  await rig.fire("ui_prompt_end", {});
  const q = { toolName: "ask_user_question", toolCallId: "q1", input: { questions: [{ header: "Pick one", question: "x" }] } };
  await rig.fire("tool_call", q);
  await rig.fire("tool_execution_end", { toolName: "ask_user_question", toolCallId: "q1" });
  const open = rig.events("blocked_open");
  const closed = rig.events("blocked_closed");
  assert.deepEqual(open.map((x) => [x.on, x.kind, x.label]), [["owner", "dialog", "Allow tool?"], ["owner", "question", "Pick one"]]);
  assert.equal(closed.length, 2);
  for (const c of closed) assert.equal(typeof c.waitedMs, "number", "waitedMs survives the ALLOWED filter");
  assert.deepEqual(closed.map((x) => [x.on, x.kind]), [["owner", "dialog"], ["owner", "question"]]);
});

test("trace: a dropped dialog (no end event) is cleared by a later interactive input; an extension input keeps it", async () => {
  const rig = traceRig();
  await rig.fire("ui_prompt_start", { title: "Stuck", kind: "confirm" });
  await rig.input("extension", "x");
  assert.equal(rig.events("blocked_closed").length, 0);
  await rig.input("interactive", "y");
  const c = rig.events("blocked_closed");
  assert.equal(c.length, 1);
  assert.equal(c[0].label, "Stuck");
});
