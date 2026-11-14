// One wake per child event, through the real adapter: a child notice that reaches the foreman as an intercom message while a run is in progress
// ends the wait with one quiet line (`foreman_wait_note`, no turn) and no `foreman_wake`; with no run in progress the wake is as before.
// The rig feeds every message the adapter sent back through `message_end`, as Pi would, so the turn cause of the run shows a wake if one was sent.
import "./_hermetic-env.mjs";
import { inprocSpawner } from "./_read-clear-inproc.ts"; // first after the preload: the git answers are in place before the adapter loads
import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeRegistry } from "../session.ts";
import { WaitRuntime } from "../wait.ts";
import type { Outcome } from "../wait.ts";
import { r11Rig } from "./_r11rig.ts";

const NOTE_TYPE = "foreman_wait_note";
type Sent = { customType: string; content: string; display?: boolean; details?: unknown };
type Tool = { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details?: Record<string, unknown> }> };
const sent: { m: Sent; opts: Record<string, unknown> | undefined }[] = [];
const tools = new Map<string, Tool>();
const cleanups: (() => void | Promise<void>)[] = [];
const state = { idle: false };
let r: Awaited<ReturnType<typeof r11Rig>>;
before(async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  r = await r11Rig({ after: (fn: () => void) => void cleanups.push(fn) } as never, {}, { ctx: { isIdle: () => state.idle }, deps: { spawner: inprocSpawner }, piExtra: { sendMessage: (m: Sent, opts?: Record<string, unknown>) => void sent.push({ m, opts }), registerTool: (d: { name: string } & Tool) => void tools.set(d.name, d) } } as never);
}, { timeout: 20_000 });
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
  mock.timers.reset();
}, { timeout: 20_000 });

const wait = (params: Record<string, unknown>) => tools.get("foreman_wait")!.execute("w", params, undefined, undefined, r.ctx);
const intercom = (text: string, id: string) => r.fire("message_end", { message: { role: "custom", customType: "intercom_message", content: text, details: { from: { id: "fm-job-1" }, message: { id, content: { text } } } } });
/** What Pi does with the messages the adapter sent: each comes back as a message_end. */
const feedBack = async (from = 0) => {
  for (const s of sent.slice(from)) await r.fire("message_end", { message: { role: "custom", ...s.m } });
};
const settle = () => r.fire("agent_settled", {});
const lastTurn = () => r.events("turn").at(-1) as { cause: string } | undefined;
const until = async (f: () => boolean, ms = 2000): Promise<void> => {
  for (let i = 0; i < ms / 10 && !f(); i++) await new Promise((res) => setTimeout(res, 10));
};

let handoff = "";
async function begin(idle: boolean) {
  state.idle = idle;
  await r.fire("agent_end", {}); // ends a run an earlier case left open
  sent.length = 0;
  handoff = path.join(r.agentDir, "pi-foreman", "handoffs", "20261113-080000-job");
  fs.mkdirSync(handoff, { recursive: true });
  writeRegistry(r.agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: r.sessionId, handoff, status: "open" }] } as never);
  const id = String((await wait({ action: "start", kind: "child", label: "job", note: "wait for the result" })).details?.id);
  return id;
}
let msgSeq = 0;
const result = async () => {
  await intercom(`Result from job: ${handoff}/result.md`, `m${++msgSeq}`);
  await until(() => sent.length > 0);
};
const wakes = () => sent.filter((s) => s.m.customType === "foreman_wake");
const notes = () => sent.filter((s) => s.m.customType === NOTE_TYPE);

test("a: inside a run the intercom message started, the notice sends one quiet line, no wake, and the run's cause stays intercom", async () => {
  const id = await begin(false);
  await r.fire("agent_start", {});
  await result();
  assert.equal(wakes().length, 0, "no foreman_wake");
  assert.equal(notes().length, 1);
  assert.deepEqual(notes()[0].opts, { triggerTurn: false });
  assert.equal(notes()[0].m.display, true);
  assert.match(notes()[0].m.content, new RegExp(`^foreman_wait ${id} \\(child\\) "wait for the result": ended by the notice above: child job: result \\S+result\\.md$`));
  await feedBack();
  await r.fire("agent_end", {});
  assert.equal(lastTurn()!.cause, "intercom", "not wake");
  assert.equal((await wait({ action: "list" })).content[0].text, "No active waits.");
  assert.equal(r.events("wait").some((e) => e.decision === "taken"), true);
});

test("a2: inside a run the owner started, the same quiet line, nothing at settle, cause intercom as before", async () => {
  await begin(false);
  await r.input("interactive", "go on");
  await r.fire("agent_start", {});
  await result();
  assert.equal(wakes().length, 0);
  assert.equal(notes().length, 1);
  assert.deepEqual(notes()[0].opts, { triggerTurn: false });
  await feedBack();
  await r.fire("agent_end", {});
  await settle();
  assert.equal(sent.length, 1, "nothing at settle");
  assert.equal(lastTurn()!.cause, "intercom");
});

test("a3: no run in progress and idle: the wake starts a turn", async () => {
  await begin(true);
  await result();
  assert.equal(notes().length, 0);
  assert.equal(wakes().length, 1);
  assert.deepEqual(wakes()[0].opts, { triggerTurn: true });
});

test("a4: no run in progress and not idle (a compaction): the wake is a follow-up", async () => {
  await begin(false);
  await result();
  assert.equal(notes().length, 0);
  assert.equal(wakes().length, 1);
  assert.deepEqual(wakes()[0].opts, { deliverAs: "followUp" });
});

test("a5: a notice without `carried` (the remote watcher) wakes as before with a run in progress", () => {
  const out: Outcome[][] = [];
  const taken: Outcome[] = [];
  const rt = new WaitRuntime({ timers: { set: () => 1, clear: () => undefined }, now: () => 0, limits: () => ({ batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true }), stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => out.push(o), trace: () => undefined, inRun: () => true, taken: (o) => taken.push(o) });
  rt.start({ kind: "child", label: "demo", note: "n" });
  assert.equal(rt.childNotice("demo", "result", "/p"), true);
  assert.equal(out.length, 1);
  assert.equal(taken.length, 0);
});

test("deduped start: the tool answer for a child wait names the label and that the first wait's note stays", async () => {
  const id = await begin(true);
  const second = await wait({ action: "start", kind: "child", label: "job", note: "again" });
  assert.equal(second.details?.deduped, true);
  assert.equal(second.details?.id, id);
  assert.match(second.content[0].text, new RegExp(`^Wait ${id} \\(child\\) already waits on child job; no second wait started`));
  assert.equal(second.content[0].text.includes("pid"), false);
  assert.match(second.content[0].text, /first wait's note stays/);
});
