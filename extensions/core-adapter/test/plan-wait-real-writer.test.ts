// Plan-wait stall: planWait over the round-state.json the real adapter writes (index.ts persistRounds), not handwritten JSON:
// the plan-review flag must be right before any checkpoint (s.plan unset), at heavy and below.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { probeSpawner } from "./_probe-memo.ts";
import { ROUND_STATE_FILE, planWait } from "../roundstate.ts";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { KEYS } from "./_r46world.ts";
import { writeFromReport } from "./_verdict-rig.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Fn = (...a: unknown[]) => Promise<unknown>;

const HEAVY_ASK = "waits for: its own plan review and the owner's approval at its pane; nothing from you";
const OWNER = "waits for: the owner's approval at its pane; nothing from you";
const BUILD = "waits for: nothing; it goes on to build";
const BELOW = "waits for: its own plan review, then it goes on to build; nothing from you";
const UNKNOWN = "waits for: unknown (no state); nothing from you is required";
const PLAN = "# Widget\n\n## For the owner\n\nGoal: ship the widget.\n\n## Goal\nShip it.\n";
const tick = () => new Promise((r) => setTimeout(r, 25));
let n = 0;

/** One real adapter instance of a session opened by another session, at `tier`. */
async function world(t: { after(fn: () => void | Promise<void>): void }, tier: string) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-plan-wait-")));
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  for (const d of [".git", ".workflow/scratch"]) fs.mkdirSync(path.join(project, d), { recursive: true });
  const roles = ["explorer", "builder", "reviewer"];
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(roles.map((r) => [r, { model: `fake/${r}` }])) } }, trace: { enabled: true }, radar: { openPrs: { enabled: false } }, ceremony: { launchWait: "detach", default: tier } }));
  const sessionId = `plan-wait-${++n}`;
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "round");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "child"), `${sessionId}\n`);
  fs.writeFileSync(path.join(handoff, "parent"), "parent-session\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_SESSION_ID = sessionId;
  delete process.env.PI_INTERCOM_STABLE_ID;
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_FOREMAN_PRESSURE_FIXTURE;
  delete process.env.PI_FOREMAN_PLAN_PHASE;
  process.env.PI_FOREMAN_HANDOFF_DIR = handoff;
  fs.writeFileSync(path.join(project, ".workflow", "scratch", "plan-widget.md"), PLAN);
  const entries: unknown[] = [];
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, { execute: Fn }>();
  const channels = new Map<string, (d: unknown) => void>();
  const pi = {
    events: { on: (c: string, h: (d: unknown) => void) => void channels.set(c, h), emit: () => undefined },
    on: (name: string, h: Handler) => {
      const prev = handlers.get(name);
      handlers.set(name, !prev ? h : name === "tool_call" ? async (e, c) => (await prev(e, c)) ?? (await h(e, c)) : async (e, c) => { const r = await prev(e, c); const r2 = await h(e, c); return r ?? r2; });
    },
    registerCommand: () => undefined,
    registerTool: (d: { name: string; execute: Fn }) => void tools.set(d.name, d),
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }, { name: "subagent" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
    appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }),
  };
  coreAdapter(pi as never, { pressureNow: () => Date.now(), pressureRun: async () => ({ ok: true, text: "" }), worktreeSnapshot: async () => null, spawner: probeSpawner() });
  const ctx = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getEntries: () => entries, getBranch: () => entries },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: {
      find: () => ({ id: "m" }),
      getProviderAuthStatus: () => ({ configured: false }),
      complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ verdict: "allow", entry: "read-only-inspection", reason: "stub" }) }], stopReason: "stop", usage: { input: 1, output: 1 } }),
    },
    ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  await handlers.get("input")!({ source: "interactive", text: "start" }, ctx); // the session's first prompt writes the file
  t.after(async () => {
    try { await handlers.get("session_shutdown")?.({}, ctx); } catch { /* best effort */ }
    await waitQuiet(path.join(agentDir, "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  let calls = 0;
  return {
    handoff,
    /** A `[plan-review]` reviewer run on the plan that ends with the verdict. */
    async review(verdict: "PASS" | "FAIL"): Promise<void> {
      const id = `c${++calls}`;
      const input = { agent: "reviewer", task: "[plan-review] review .workflow/scratch/plan-widget.md" };
      await handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } }, ctx);
      const blocked = (await handlers.get("tool_call")!({ toolName: "subagent", toolCallId: id, input }, ctx)) as { reason?: string } | undefined;
      assert.equal(blocked, undefined, `plan review launch: ${blocked?.reason}`);
      await handlers.get("tool_result")!({ toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false }, ctx);
      assert.ok(writeFromReport(input, `Overall verdict: ${verdict}`), "the launch binding names a record folder"); // the verdict is the reviewer's review_verdict record, not report text (#291)
      channels.get("subagent:async-complete")!({ runId: `run-${id}`, agent: "reviewer", success: true, status: "completed", results: [{ agent: "reviewer", status: "completed", success: true, output: `Overall verdict: ${verdict}` }] });
      await tick();
    },
    async checkpoint(): Promise<string> {
      const r = (await tools.get("foreman_checkpoint")!.execute("ck", { path: ".workflow/scratch/plan-widget.md" }, undefined, undefined, ctx)) as { details: { decision: string } };
      return r.details.decision;
    },
    wait: () => planWait(handoff).text,
    stateFile: path.join(handoff, ROUND_STATE_FILE),
  };
}

test("real round-state: below heavy, before and after the review PASS", async (t) => {
  const w = await world(t, "standard");
  assert.equal(w.wait(), BELOW, "no review yet");
  await w.review("FAIL");
  assert.equal(w.wait(), BELOW, "a FAIL is no PASS");
  await w.review("PASS");
  assert.equal(w.wait(), BUILD, "PASS, no checkpoint (below heavy has none)");
});

test("real round-state: heavy before any review (the incident), after the PASS before the checkpoint, and approved", async (t) => {
  const w = await world(t, "heavy");
  assert.equal(w.wait(), HEAVY_ASK, "no review, no checkpoint");
  await w.review("PASS");
  assert.equal(w.wait(), OWNER, "PASS before the checkpoint");
  assert.equal(await w.checkpoint(), "approve");
  assert.equal(w.wait(), BUILD, "approved");
});

test("real round-state: no file is unknown", async (t) => {
  const w = await world(t, "heavy");
  fs.rmSync(w.stateFile);
  assert.equal(w.wait(), UNKNOWN);
});
