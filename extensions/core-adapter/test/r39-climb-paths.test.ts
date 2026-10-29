// R39 item 7: every climb path writes the strong rung into the forwarded input and names it in the receipt;
// a launch that stays on the bottom rung says why (pressure suppression, no strong rung mapped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewAllowOpts } from "./_r11rig.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";
import { pressurePath } from "../pressure.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const NOW = Date.parse("2026-03-01T10:00:00Z");
const ROLES = ["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"];
let rigs = 0;

interface Rig {
  trace(): Record<string, unknown>[];
  setHigh(): void;
  /** One launch: assistant message, tool_call, tool_result; returns the receipt lines. */
  launch(id: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined>;
  receipt(id: string, input: Record<string, unknown>, runId: string): Promise<string>;
  ended(runId: string, agent: string, summary: string): void;
}

async function rig(t: { after(fn: () => void): void }, o: { strong: boolean }): Promise<Rig> {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PRESSURE_FIXTURE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r39-climb-")));
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    try { await shutdown?.(); } catch { /* best effort */ }
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_FOREMAN_PRESSURE_FIXTURE;
  const roles = Object.fromEntries(ROLES.map((r) => [r, r === "builder" ? { model: "fake/bottom", ...(o.strong ? { strong: { model: "fake/strong" } } : {}) } : { model: `fake/${r}` }]));
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ providers: { fake: { review: { model: "m" }, roles } }, trace: { enabled: true }, ceremony: { launchWait: "detach" } }));
  const handlers = new Map<string, Handler>();
  const channels = new Map<string, (d: unknown) => void>();
  const pi = {
    events: { on: (n: string, h: (d: unknown) => void) => void channels.set(n, h), emit: () => undefined },
    on: (n: string, h: Handler) => {
      const prev = handlers.get(n);
      handlers.set(n, prev ? async (e, c) => (await prev(e, c)) ?? (await h(e, c)) : h);
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }, { name: "subagent" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  const clock = { now: NOW };
  const sessionId = `r39-climb-session-${++rigs}`;
  coreAdapter(pi as never, { pressureNow: () => clock.now, pressureRun: async () => ({ ok: true, text: "" }) });
  const ctx = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: reviewAllowOpts().ctx.modelRegistry,
    ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const dir = path.join(agentDir, "pi-foreman", "state");
  const call = async (id: string, input: Record<string, unknown>) => {
    await handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } }, ctx);
    return handlers.get("tool_call")!({ toolName: "subagent", toolCallId: id, input }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;
  };
  return {
    trace() {
      const f = fs.readdirSync(dir).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl"));
      return f ? fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    },
    setHigh() {
      const file = pressurePath(agentDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ level: "high", reasons: ["load"], at: new Date(clock.now).toISOString().replace(/\.\d{3}Z$/, "Z"), host: {} }));
    },
    launch: call,
    async receipt(id, input, runId) {
      const res = (await handlers.get("tool_result")!({ toolName: "subagent", toolCallId: id, input, details: { runId }, content: [{ type: "text", text: "started" }], isError: false }, ctx)) as { content: { text: string }[] } | undefined;
      return (res?.content ?? []).map((c) => c.text).filter((x) => x.startsWith("pi-foreman: launched")).join("\n");
    },
    ended(runId, agent, summary) {
      channels.get("subagent:async-complete")!({ runId, agent, success: true, summary });
    },
  };
}

const events = (a: Rig, name: string): Record<string, unknown>[] => a.trace().filter((r) => r.event === name);

test("(a) explicit strong with a reason launches on the strong rung and the receipt names it", async (t) => {
  const a = await rig(t, { strong: true });
  const input: Record<string, unknown> = { agent: "builder", task: "[[small]] item 1", model: "strong", reason: "bottom rung cannot do it" };
  assert.equal(await a.launch("c1", input), undefined);
  assert.equal(input.model, "fake/strong");
  assert.equal(await a.receipt("c1", input, "run-1"), "pi-foreman: launched builder on fake/strong.");
  assert.deepEqual(events(a, "rung_up").map((r) => [r.to, r.reason]), [["fake/strong", "foreman"]]);
});

test("(b) a RUNG_UP: context completion, then a relaunch with model strong and no reason, climbs", async (t) => {
  const a = await rig(t, { strong: true });
  const first: Record<string, unknown> = { agent: "builder", task: "[[small]] item 1" };
  assert.equal(await a.launch("b1", first), undefined);
  assert.equal(first.model, "fake/bottom");
  await a.receipt("b1", first, "run-b");
  a.ended("run-b", "builder", "RUNG_UP: context\nDone: half\nRemaining: tests");
  const relaunch: Record<string, unknown> = { agent: "builder", task: "continue item 1", model: "strong" };
  assert.equal(await a.launch("b2", relaunch), undefined);
  assert.equal(relaunch.model, "fake/strong");
  assert.equal(await a.receipt("b2", relaunch, "run-b2"), "pi-foreman: launched builder on fake/strong.");
  assert.deepEqual(events(a, "rung_up").map((r) => [r.to, r.reason]), [["fake/strong", "context"]]);
});

test("(c) a counted reviewer FAIL, then a builder relaunch with no model, climbs with reason review_fail", async (t) => {
  const a = await rig(t, { strong: true });
  const build: Record<string, unknown> = { agent: "builder", task: "[[small]] item 1" };
  assert.equal(await a.launch("b1", build), undefined);
  await a.receipt("b1", build, "run-b");
  a.ended("run-b", "builder", "done");
  const review: Record<string, unknown> = { agent: "reviewer", task: "review item 1" };
  assert.equal(await a.launch("r1", review), undefined);
  await a.receipt("r1", review, "run-r");
  a.ended("run-r", "reviewer", "Verdict: FAIL\n- a finding");
  const rev: Record<string, unknown> = { agent: "builder", task: "fix the finding" };
  assert.equal(await a.launch("b2", rev), undefined);
  assert.equal(rev.model, "fake/strong");
  assert.equal(await a.receipt("b2", rev, "run-b2"), "pi-foreman: launched builder on fake/strong.");
  assert.deepEqual(events(a, "rung_up").map((r) => [r.to, r.reason]), [["fake/strong", "review_fail"]]);
});

test("(d) high pressure keeps an explicit strong climb: strong rung, receipt names it, no climb_suppressed", async (t) => {
  const a = await rig(t, { strong: true });
  a.setHigh();
  const input: Record<string, unknown> = { agent: "builder", task: "[[small]] item 1", model: "strong", reason: "bottom rung cannot do it" };
  assert.equal(await a.launch("c1", input), undefined);
  assert.equal(input.model, "fake/strong");
  assert.equal(await a.receipt("c1", input, "run-1"), "pi-foreman: launched builder on fake/strong.");
  assert.deepEqual(events(a, "climb_suppressed"), []);
  assert.deepEqual(events(a, "rung_up").map((r) => [r.to, r.reason]), [["fake/strong", "foreman"]]);
});

test("(d2) high pressure keeps the RUNG_UP: context relaunch on the strong rung", async (t) => {
  const a = await rig(t, { strong: true });
  a.setHigh();
  const first: Record<string, unknown> = { agent: "builder", task: "[[small]] item 1" };
  assert.equal(await a.launch("b1", first), undefined);
  await a.receipt("b1", first, "run-b");
  a.ended("run-b", "builder", "RUNG_UP: context\nDone: half\nRemaining: tests");
  const relaunch: Record<string, unknown> = { agent: "builder", task: "continue item 1", model: "strong" };
  assert.equal(await a.launch("b2", relaunch), undefined);
  assert.equal(relaunch.model, "fake/strong");
  assert.equal(await a.receipt("b2", relaunch, "run-b2"), "pi-foreman: launched builder on fake/strong.");
  assert.deepEqual(events(a, "rung_up").map((r) => [r.to, r.reason]), [["fake/strong", "context"]]);
  assert.deepEqual(events(a, "climb_suppressed"), []);
});

test("(d3) high pressure keeps the review-FAIL revision climb on the strong rung", async (t) => {
  const a = await rig(t, { strong: true });
  a.setHigh();
  const build: Record<string, unknown> = { agent: "builder", task: "[[small]] item 1" };
  assert.equal(await a.launch("b1", build), undefined);
  await a.receipt("b1", build, "run-b");
  a.ended("run-b", "builder", "done");
  const review: Record<string, unknown> = { agent: "reviewer", task: "review item 1" };
  assert.equal(await a.launch("r1", review), undefined);
  await a.receipt("r1", review, "run-r");
  a.ended("run-r", "reviewer", "Verdict: FAIL\n- a finding");
  const rev: Record<string, unknown> = { agent: "builder", task: "fix the finding" };
  assert.equal(await a.launch("b2", rev), undefined);
  assert.equal(rev.model, "fake/strong");
  assert.equal(await a.receipt("b2", rev, "run-b2"), "pi-foreman: launched builder on fake/strong.");
  assert.deepEqual(events(a, "rung_up").map((r) => [r.to, r.reason]), [["fake/strong", "review_fail"]]);
  assert.deepEqual(events(a, "climb_suppressed"), []);
});

test("(e) no strong rung mapped: a revision stays on the bottom rung, revision_no_strong is traced and the receipt says so", async (t) => {
  const a = await rig(t, { strong: false });
  const build: Record<string, unknown> = { agent: "builder", task: "[[small]] item 1" };
  assert.equal(await a.launch("b1", build), undefined);
  await a.receipt("b1", build, "run-b");
  a.ended("run-b", "builder", "done");
  const review: Record<string, unknown> = { agent: "reviewer", task: "review item 1" };
  assert.equal(await a.launch("r1", review), undefined);
  await a.receipt("r1", review, "run-r");
  a.ended("run-r", "reviewer", "Verdict: FAIL\n- a finding");
  const rev: Record<string, unknown> = { agent: "builder", task: "fix the finding" };
  assert.equal(await a.launch("b2", rev), undefined);
  assert.equal(rev.model, "fake/bottom");
  assert.deepEqual(events(a, "revision_no_strong").map((r) => r.role), ["builder"]);
  assert.equal(await a.receipt("b2", rev, "run-b2"), "pi-foreman: launched builder on fake/bottom (bottom rung: no strong rung mapped).");
  assert.deepEqual(events(a, "rung_up"), []);
});

test("an unmapped explicit strong keeps the receipt note and the bottom model", async (t) => {
  const a = await rig(t, { strong: false });
  const input: Record<string, unknown> = { agent: "builder", task: "[[small]] item 1", model: "strong", reason: "why" };
  assert.equal(await a.launch("c1", input), undefined);
  assert.equal(input.model, "fake/bottom");
  assert.equal(await a.receipt("c1", input, "run-1"), "pi-foreman: launched builder on fake/bottom (bottom rung: no strong rung mapped).");
});
