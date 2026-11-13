// r42: the real blocked sources through the adapter rig: what each opens in the live file (`blockedOn`, `blockedKind`) and the one
// `blocked_open` / `blocked_closed` pair per dialog (the classed source emits; Pi's prompt events add one only for a dialog nobody classed).
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveDir } from "../livestate.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { writeChildAsk } from "../childask.ts";
import { r11Rig } from "./_r11rig.ts";

type T = Parameters<typeof r11Rig>[0];
type Rig = Awaited<ReturnType<typeof r11Rig>>;
const ROLES = ["explorer", "builder", "reviewer"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<X>(f: () => X | undefined | false, ms = 4000): Promise<X> {
  for (let i = 0; i < ms / 10; i++) {
    const v = f();
    if (v) return v;
    await sleep(10);
  }
  throw new Error("timed out");
}
/** Fails fast instead of hanging when the awaited call never settles. */
const within = <X>(p: Promise<X>, ms = 5000): Promise<X> => {
  let timer: ReturnType<typeof setTimeout>;
  const cap = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`still pending after ${ms} ms`)), ms); });
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
};
const V = (verdict: string, entry: string): string => JSON.stringify({ verdict, entry, reason: `because ${entry}` });
const registry = (reply: string) => ({ find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }) });
const config = { providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } }, presence: { enabled: false } };
const ASK_FIELDS = { tool: "bash", payload: "pip install requests", cwd: "/w", session: "child-s", role: "builder", run: "L9" };

/** A ui whose confirm / select stay open until the test answers them. */
function holdUi() {
  const confirms: ((v: boolean) => void)[] = [];
  const selects: ((v: string) => void)[] = [];
  const ui = {
    notify: () => undefined,
    confirm: () => new Promise<boolean>((res) => confirms.push(res)),
    select: () => new Promise<string>((res) => selects.push(res)),
    input: async () => "",
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  return { ui, confirms, selects };
}
const liveOf = (r: Rig): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(liveDir(r.agentDir), `${r.sessionId}.json`), "utf8")) as Record<string, unknown>;
/** The live file once it shows (`on`) or stops showing (undefined) a blocked class. */
const liveBlocked = (r: Rig, on: string | undefined) => until(() => {
  try {
    const f = liveOf(r);
    return f.blockedOn === on ? f : false;
  } catch {
    return false;
  }
});
const pairs = (r: Rig) => [r.events("blocked_open").length, r.events("blocked_closed").length];

async function ownerRig(t: T, reply = V("ask", "package-install")) {
  const h = holdUi();
  const r = await r11Rig(t, {}, { ctx: { ui: h.ui, modelRegistry: registry(reply) }, config });
  return { ...r, ...h };
}

test("guard approval dialog (askOwner path): owner/approval in the live file, one open and one closed event", async (t) => {
  const r = await ownerRig(t);
  const p = r.call("bash", { command: "pip install requests" });
  await until(() => r.selects.length === 1);
  const f = await liveBlocked(r, "owner");
  assert.equal(f.blockedKind, "approval");
  assert.equal(typeof f.ownerBlockedSince, "string");
  r.selects[0]("allow once");
  await p;
  await liveBlocked(r, undefined);
  assert.deepEqual(r.events("blocked_open").map((x) => [x.on, x.kind]), [["owner", "approval"]]);
  assert.deepEqual(pairs(r), [1, 1]);
  assert.equal(typeof r.events("blocked_closed")[0].waitedMs, "number");
});

test("guard approval dialog (resolveDecision path): a self-ruling ask opens owner/approval, one pair", async (t) => {
  const r = await ownerRig(t, V("allow", "read-only-inspection"));
  const dir = r.handoff("up", "child");
  // names a ruling and the handoff dir, and writes (a scratch file): the self-ruling ask, judged in overlayBlock
  const p = r.call("bash", { command: `cp ${r.project}/.workflow/x ${r.project}/.workflow/scratch/y.md # ruling ${dir}` });
  await until(() => r.confirms.length === 1);
  const f = await liveBlocked(r, "owner");
  assert.equal(f.blockedKind, "approval");
  r.confirms[0](true);
  assert.equal(await p, undefined);
  await liveBlocked(r, undefined);
  assert.deepEqual(pairs(r), [1, 1]);
});

test("one event per dialog: Pi's prompt events around a classed dialog add no second pair", async (t) => {
  const r = await ownerRig(t);
  const p = r.call("bash", { command: "pip install requests" });
  await until(() => r.selects.length === 1);
  await r.fire("ui_prompt_start", { title: "pi-foreman: bash asks", kind: "select" });
  r.selects[0]("allow once");
  await r.fire("ui_prompt_end", {});
  await p;
  await liveBlocked(r, undefined);
  assert.deepEqual(pairs(r), [1, 1]);
  assert.equal(r.events("blocked_open")[0].kind, "approval", "the classed source's record");
  assert.equal(r.events("blocked_closed")[0].kind, "approval");
});

test("one event per dialog: a Pi dialog nobody classed gets one pair from the prompt events, and an input clears it once", async (t) => {
  const r = await ownerRig(t);
  await r.fire("ui_prompt_start", { title: "Pick a model", kind: "select" });
  assert.equal((await liveBlocked(r, "owner")).blockedKind, "dialog");
  await r.fire("ui_prompt_start", { title: "Pick a model", kind: "select" });
  await r.fire("ui_prompt_end", {});
  await r.fire("ui_prompt_end", {});
  assert.deepEqual(pairs(r), [1, 1]);
  assert.deepEqual(r.events("blocked_open").map((x) => [x.on, x.kind, x.label]), [["owner", "dialog", "Pick a model"]]);
  // a classed dialog opening after an unclassed one closed is its own pair
  const q = { toolName: "ask_user_question", toolCallId: "q1", input: { questions: [{ header: "Which?" }] } };
  await r.fire("tool_call", q);
  await r.fire("tool_execution_end", { toolName: "ask_user_question", toolCallId: "q1" });
  assert.deepEqual(pairs(r), [2, 2]);
});

test("an owner question: owner/question in the live file, one pair even with Pi's prompt events around it", async (t) => {
  const r = await ownerRig(t);
  const q = { toolName: "ask_user_question", toolCallId: "q1", input: { questions: [{ header: "Which?" }] } };
  await r.fire("tool_call", q);
  await r.fire("ui_prompt_start", { title: "Which?", kind: "select" });
  const f = await liveBlocked(r, "owner");
  assert.equal(f.blockedKind, "question");
  await r.fire("ui_prompt_end", {});
  await r.fire("tool_execution_end", { toolName: "ask_user_question", toolCallId: "q1" });
  await liveBlocked(r, undefined);
  assert.deepEqual(pairs(r), [1, 1]);
  assert.equal(r.events("blocked_open")[0].kind, "question");
});

test("an unclassed Pi dialog behaves as before: it blocks, and counts as an owner wait of kind dialog", async (t) => {
  const r = await ownerRig(t);
  await r.fire("ui_prompt_start", { title: "Any dialog", kind: "confirm" });
  const f = await liveBlocked(r, "owner");
  assert.equal(f.state, "blocked");
  assert.equal(f.blockedKind, "dialog");
  await r.fire("ui_prompt_end", {});
  await liveBlocked(r, undefined);
  assert.equal(liveOf(r).state, "idle");
});

test("the parent's dialog about a child's ask is an owner wait (approval)", async (t) => {
  const r = await ownerRig(t, V("allow", "read-only-inspection"));
  const input: Record<string, unknown> = { agent: "builder", task: "go" };
  await r.launch(input);
  const askDir = (input.extensionBindings as Record<string, Record<string, unknown>>)[BINDING_NS].askDir as string;
  writeChildAsk(askDir, { cause: "ask", entry: "package-install", reason: "because", ...ASK_FIELDS });
  await until(() => r.selects.length === 1);
  const f = await liveBlocked(r, "owner");
  assert.equal(f.blockedKind, "approval");
  r.selects[0]("allow once");
  await until(() => fs.existsSync(path.join(askDir, "ruling-1.md")));
  await liveBlocked(r, undefined);
  assert.deepEqual(pairs(r), [1, 1]);
});

test("a session waiting on its parent through ask.md (the ask contract) is a parent wait: blockedOn parent, no owner fields", async (t) => {
  const r = await ownerRig(t);
  const dir = r.handoff("up", "child");
  fs.writeFileSync(path.join(dir, "ask.md"), "# Ask 1: q\nneeds_ruling: yes\n");
  await r.wrote(path.join(dir, "ask.md"));
  const f = await liveBlocked(r, "parent");
  assert.equal(f.blockedKind, "parent-ask");
  assert.equal("ownerBlockedSince" in f, false);
  assert.equal(f.state, "blocked", "the sidebar state is unchanged");
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "A\n");
  await r.fire("tool_result", { toolName: "read", toolCallId: "r1", input: { path: path.join(dir, "ruling-1.md") }, content: [{ type: "text", text: "A" }], isError: false });
  await liveBlocked(r, undefined);
  assert.deepEqual(r.events("blocked_open").map((x) => [x.on, x.kind]), [["parent", "parent-ask"]]);
  assert.deepEqual(pairs(r), [1, 1]);
});

test("a subagent child's gate ask that waits on its parent is classed parent (trace); a subagent child writes no live file, so none is read", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-r42-ask-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role: "builder", launchId: "L9", kind: "first", model: null, askDir: dir } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry(V("ask", "package-install")) }, config, child: true });
  const p = r.call("bash", { command: "pip install requests" });
  await until(() => fs.existsSync(path.join(dir, "ask.md")));
  assert.deepEqual(r.events("blocked_open").map((x) => [x.on, x.kind]), [["parent", "parent-ask"]]);
  assert.equal(fs.existsSync(liveDir(r.agentDir)), false, "no live file for a subagent child");
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "ALLOW\n");
  assert.equal(await within(p), undefined);
  assert.deepEqual(pairs(r), [1, 1]);
});
