// r42: mixed blocked sources: a wait on the parent does not mute Pi's prompt events, an owner-classed dialog does.
// Exactly one `blocked_open` / `blocked_closed` per dialog in every combination.
import "./_hermetic-env.mjs";
import { inprocSpawner } from "./_read-clear-inproc.ts"; // first after the preload: the git answers are in place before the adapter loads
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { r11Rig } from "./_r11rig.ts";

type T = Parameters<typeof r11Rig>[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Fails fast instead of hanging when the awaited call never settles. */
const within = <X>(p: Promise<X>, ms = 5000): Promise<X> => {
  let timer: ReturnType<typeof setTimeout>;
  const cap = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`still pending after ${ms} ms`)), ms); });
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
};
async function until(f: () => boolean, ms = 4000): Promise<void> {
  for (let i = 0; i < ms / 10; i++) {
    if (f()) return;
    await sleep(10);
  }
  throw new Error("timed out");
}
const config = { providers: { fake: { review: { model: "m" }, roles: {} } }, presence: { enabled: false } };
const ui = { notify: () => undefined, confirm: async () => true, select: async () => "", input: async () => "", setStatus: () => undefined, setWidget: () => undefined };
type Rig = Awaited<ReturnType<typeof r11Rig>>;
// One adapter session for the whole file (a session start runs git and python); each case reads the trace from its own start on.
const cleanups: (() => void | Promise<void>)[] = [];
let shared: Rig;
before(async () => {
  shared = await r11Rig({ after: (fn) => void cleanups.push(fn) }, {}, { ctx: { ui }, config, deps: { spawner: inprocSpawner } });
}, { timeout: 20_000 });
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
}, { timeout: 20_000 });
const rig = async (_t: T): Promise<Rig> => {
  const start = shared.trace().length;
  return { ...shared, events: (name: string) => shared.trace().slice(start).filter((x) => x.event === name) };
};
const shape = (r: Rig, ev: string) => r.events(ev).map((x) => `${x.on}/${x.kind}`).sort();

/** Opens a wait on the parent (ask.md) and returns a closer for it. */
async function parentWait(r: Rig): Promise<() => Promise<void>> {
  const dir = r.handoff("up", "child");
  fs.writeFileSync(path.join(dir, "ask.md"), "# Ask 1: q\nneeds_ruling: yes\n");
  await within(r.wrote(path.join(dir, "ask.md")));
  await until(() => r.events("blocked_open").length === 1);
  return async () => {
    fs.writeFileSync(path.join(dir, "ruling-1.md"), "A\n");
    await within(r.fire("tool_result", { toolName: "read", toolCallId: "r1", input: { path: path.join(dir, "ruling-1.md") }, content: [{ type: "text", text: "A" }], isError: false }));
    await until(() => r.events("blocked_closed").length >= 1);
  };
}

test("parent wait open, then an unclassed Pi dialog: one owner pair for the dialog, one parent pair for the wait", async (t) => {
  const r = await rig(t);
  const closeWait = await parentWait(r);
  await within(r.fire("ui_prompt_start", { title: "Pick a model", kind: "select" }));
  await within(r.fire("ui_prompt_end", {}));
  assert.deepEqual(shape(r, "blocked_open"), ["owner/dialog", "parent/parent-ask"]);
  assert.deepEqual(shape(r, "blocked_closed"), ["owner/dialog"]);
  await closeWait();
  assert.deepEqual(shape(r, "blocked_closed"), ["owner/dialog", "parent/parent-ask"]);
});

test("parent wait open, then a classed owner dialog with Pi's prompt events around it: one owner pair, not two", async (t) => {
  const r = await rig(t);
  const closeWait = await parentWait(r);
  const q = { toolName: "ask_user_question", toolCallId: "q1", input: { questions: [{ header: "Which?" }] } };
  await within(r.fire("tool_call", q));
  await within(r.fire("ui_prompt_start", { title: "Which?", kind: "select" }));
  await within(r.fire("ui_prompt_end", {}));
  await within(r.fire("tool_execution_end", { toolName: "ask_user_question", toolCallId: "q1" }));
  assert.deepEqual(shape(r, "blocked_open"), ["owner/question", "parent/parent-ask"]);
  assert.deepEqual(shape(r, "blocked_closed"), ["owner/question"]);
  await closeWait();
  assert.deepEqual(shape(r, "blocked_closed"), ["owner/question", "parent/parent-ask"]);
});

test("owner-classed dialog open, an unclassed Pi prompt event inside it: still one pair", async (t) => {
  const r = await rig(t);
  const q = { toolName: "ask_user_question", toolCallId: "q1", input: { questions: [{ header: "Which?" }] } };
  await within(r.fire("tool_call", q));
  await within(r.fire("ui_prompt_start", { title: "Other", kind: "confirm" }));
  await within(r.fire("ui_prompt_end", {}));
  await within(r.fire("tool_execution_end", { toolName: "ask_user_question", toolCallId: "q1" }));
  assert.deepEqual(shape(r, "blocked_open"), ["owner/question"]);
  assert.deepEqual(shape(r, "blocked_closed"), ["owner/question"]);
});
