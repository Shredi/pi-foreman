// R14 item 6 (P2): reload-safe round state. `<handoff>/round-state.json` keeps the plan hash and the review counters;
// the checkpoint approval is never stored: after /reload it comes back only from the parent's ruling.md, newer (ctime)
// than both plan files. Each case runs the real adapter twice over the same dirs (a fresh instance = a reload).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { planVersionHash } from "../checkpoint.ts";
import { restoreRoundState, ROUND_STATE_FILE } from "../roundstate.ts";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { KEYS } from "./_r46world.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Fn = (...a: unknown[]) => Promise<unknown>;
type Block = { block?: boolean; reason?: string } | undefined;

const PLAN = "# Widget\n\n## Goal\nShip it.\n";
const tick = () => new Promise((r) => setTimeout(r, 25)); // ctime steps apart
let n = 0;

/** The dirs of one session opened by another session: project with a plan, agent dir, and the handoff dir where this session is the child. */
function world(t: { after(fn: () => void | Promise<void>): void }, env = true) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k]; // a Pi session's own variables (parent intercom, herdr pane) must not reach the fixture
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r14-rs-")));
  const shutdowns: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const s of shutdowns) {
      try { await s(); } catch { /* best effort */ }
    }
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  for (const d of [".git", ".workflow/scratch"]) fs.mkdirSync(path.join(project, d), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const roles = ["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"];
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(roles.map((r) => [r, { model: `fake/${r}` }])) } }, trace: { enabled: true }, ceremony: { launchWait: "detach", default: "heavy", revisionRounds: { heavy: 2 } } }));
  const sessionId = `r14-rs-${++n}`;
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "round");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "child"), `${sessionId}\n`);
  fs.writeFileSync(path.join(handoff, "parent"), "parent-session\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_SESSION_ID = sessionId;
  delete process.env.PI_INTERCOM_STABLE_ID;
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_FOREMAN_PRESSURE_FIXTURE;
  delete process.env.PI_FOREMAN_PLAN_PHASE; // a plan-phase session running the suite would refuse builders as plan_phase, not plan_required
  if (env) process.env.PI_FOREMAN_HANDOFF_DIR = handoff;
  else delete process.env.PI_FOREMAN_HANDOFF_DIR;
  const planFile = path.join(project, ".workflow", "scratch", "plan-widget.md");
  fs.writeFileSync(planFile, PLAN);
  fs.writeFileSync(path.join(handoff, "plan.md"), PLAN);
  const stateFile = path.join(handoff, ROUND_STATE_FILE);

  /**
   * Until the clock is past every file the session will read. steerwatch.ts baseline counts a file as seen only when its mtime is
   * before the session start (an integer ms): a ruling written in the same ms as the start would be delivered as new.
   */
  async function clockPastWorld() {
    const newest = Math.max(...[planFile, ...fs.readdirSync(handoff).map((n) => path.join(handoff, n))].map((f) => fs.statSync(f).mtimeMs));
    while (Date.now() <= Math.ceil(newest)) await new Promise((r) => setTimeout(r, 1));
  }

  /** One adapter instance (a session start; a second call over the same world is the reload). `settle: false` starts it without the clock wait. */
  async function adapter(settle = true) {
    if (settle) await clockPastWorld();
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
    };
    coreAdapter(pi as never, { pressureNow: () => Date.now(), pressureRun: async () => ({ ok: true, text: "" }) });
    const ctx = {
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
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
    await handlers.get("session_start")!({ reason: "reload" }, ctx);
    const down = async () => handlers.get("session_shutdown")?.({}, ctx);
    shutdowns.push(down);
    let calls = 0;
    return {
      down,
      /** A `[plan-review]` reviewer run on the plan that ends with PASS, then the owner's checkpoint approval. */
      async checkpoint(): Promise<string> {
        const id = `c${++calls}`;
        const input = { agent: "reviewer", task: "[plan-review] review .workflow/scratch/plan-widget.md" };
        await handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } }, ctx);
        const blocked = (await handlers.get("tool_call")!({ toolName: "subagent", toolCallId: id, input }, ctx)) as Block;
        if (blocked) return `plan review refused: ${blocked.reason}`;
        await handlers.get("tool_result")!({ toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false }, ctx);
        channels.get("subagent:async-complete")!({ runId: `run-${id}`, agent: "reviewer", success: true, status: "completed", results: [{ agent: "reviewer", status: "completed", success: true, output: "Overall verdict: PASS" }] });
        await tick();
        return this.recheck();
      },
      /** foreman_checkpoint alone. */
      async recheck(): Promise<string> {
        const r = (await tools.get("foreman_checkpoint")!.execute("ck", { path: ".workflow/scratch/plan-widget.md" }, undefined, undefined, ctx)) as { details: { decision: string }; content: { text: string }[] };
        return r.details.decision === "refused" ? `refused: ${r.content[0].text}` : r.details.decision;
      },
      async launch(agent: string): Promise<Block> {
        const id = `c${++calls}`;
        const input = { agent, task: `${agent} the widget` };
        await handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } }, ctx);
        return (await handlers.get("tool_call")!({ toolName: "subagent", toolCallId: id, input }, ctx)) as Block;
      },
      ownerPrompt: () => handlers.get("input")!({ source: "interactive", text: "next" }, ctx),
    };
  }
  /** Writes a ruling; a ruling.md ctime must be strictly newer than both plan files (roundstate.ts): rewrite until the clock moved past them. */
  const rule = (name: string, text: string) => {
    const f = path.join(handoff, name);
    const planCtime = Math.max(...[planFile, path.join(handoff, "plan.md")].map((p) => fs.statSync(p).ctimeMs));
    fs.writeFileSync(f, text);
    while (fs.statSync(f).ctimeMs <= planCtime) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      fs.writeFileSync(f, text);
    }
  };
  /** Waits on the event itself: until a file written now has a ctime strictly greater than both plan files' (ctime cannot be set back), no fixed sleep. */
  const pastPlans = () => {
    const planCtime = Math.max(...[planFile, path.join(handoff, "plan.md")].map((p) => fs.statSync(p).ctimeMs));
    const probe = path.join(handoff, ".ctime-probe");
    try {
      do fs.writeFileSync(probe, "x"); while (fs.statSync(probe).ctimeMs <= planCtime);
    } finally {
      fs.rmSync(probe, { force: true });
    }
  };
  const stored = () => JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  const forge = (data: Record<string, unknown>) => fs.writeFileSync(stateFile, JSON.stringify(data));
  const hash = () => planVersionHash(fs.readFileSync(planFile));
  return { adapter, rule, pastPlans, stored, forge, hash, handoff, planFile, stateFile };
}

const planRequired = (r: Block): boolean => r?.block === true && /\[launch_refused:plan_required\]/.test(r.reason ?? "");
const limitReached = (r: Block): boolean => r?.block === true && /revision limit for heavy reached/.test(r.reason ?? "");

test("approve -> persist -> fresh adapter instance over the same handoff dir -> heavy builder launch allowed, counters intact", async (t) => {
  const w = world(t);
  const a = await w.adapter();
  assert.ok(planRequired(await a.launch("builder")), "heavy: no approval yet");
  assert.equal(await a.checkpoint(), "approve");
  assert.equal(await a.launch("builder"), undefined);
  assert.equal(await a.launch("reviewer"), undefined);
  assert.equal(await a.launch("builder"), undefined, "revision 1 of 2");
  assert.equal(await a.launch("reviewer"), undefined);
  const s = w.stored();
  assert.deepEqual(s.chains, { main: { revisions: 1, exempt: 0, built: true, reviewOpen: true, revisionAnswered: true } });
  assert.equal(s.reviewCount, 2);
  assert.equal((s.plan as { hash: string }).hash, w.hash());
  assert.equal("approved" in s || JSON.stringify(s).includes("approved"), false, "no approval is stored");
  await tick();
  w.rule("ruling.md", "APPROVED\n");
  await a.down();
  const b = await w.adapter();
  assert.equal(await b.recheck(), "approve", "the plan-review verdict came back with the approval: no plan_review_required");
  assert.equal(await b.launch("builder"), undefined, "approval from the parent's ruling.md; revision 2 of 2");
  assert.equal(await b.launch("reviewer"), undefined);
  assert.ok(limitReached(await b.launch("builder")), "the count carried over the reload: a third revision is over the limit");
  assert.equal(w.stored().reviewCount, 3);
});

test("stale plan hash -> discarded, re-ceremony (builder refused plan_required)", async (t) => {
  const w = world(t);
  const a = await w.adapter();
  assert.equal(await a.checkpoint(), "approve");
  assert.equal(await a.launch("builder"), undefined);
  await a.down();
  fs.appendFileSync(w.planFile, "\nOne more step.\n");
  fs.appendFileSync(path.join(w.handoff, "plan.md"), "\nOne more step.\n");
  await tick();
  w.rule("ruling.md", "APPROVED\n");
  await tick();
  const b = await w.adapter();
  assert.ok(planRequired(await b.launch("builder")));
  assert.equal(w.stored().plan, null, "the stale file is not brought back");
});

test("plan rewritten after the ruling (plan ctime newer than ruling.md) -> re-ceremony", async (t) => {
  const w = world(t);
  const a = await w.adapter();
  assert.equal(await a.checkpoint(), "approve");
  assert.equal(await a.launch("builder"), undefined);
  assert.equal(await a.launch("reviewer"), undefined);
  await tick();
  w.rule("ruling.md", "APPROVED\n");
  await a.down();
  await tick();
  fs.writeFileSync(w.planFile, PLAN); // same bytes, same hash: only the ctime moved past the ruling
  const b = await w.adapter();
  assert.ok(planRequired(await b.launch("builder")));
  assert.deepEqual(w.stored().chains, { main: { revisions: 0, exempt: 0, built: true, reviewOpen: true } }, "dir and hash match: the counters come back, the approval does not");
});

test("handoff plan.md rewritten after the ruling -> re-ceremony", async (t) => {
  const w = world(t);
  const a = await w.adapter();
  assert.equal(await a.checkpoint(), "approve");
  await tick();
  w.rule("ruling.md", "APPROVED\n");
  await a.down();
  await tick();
  fs.writeFileSync(path.join(w.handoff, "plan.md"), PLAN + "changed\n");
  const b = await w.adapter();
  assert.ok(planRequired(await b.launch("builder")));
});

test("old APPROVED ruling -> plan edited -> session rewrites matching hash -> fresh adapter -> nothing granted", async (t) => {
  const w = world(t);
  const a = await w.adapter();
  assert.equal(await a.checkpoint(), "approve");
  await tick();
  w.rule("ruling.md", "APPROVED\n");
  await a.down();
  await tick();
  fs.appendFileSync(w.planFile, "\nA step the parent never saw.\n");
  w.forge({ ...w.stored(), plan: { topic: "widget", hash: w.hash() }, approved: true });
  const b = await w.adapter();
  assert.ok(planRequired(await b.launch("builder")));
});

test("session-written round-state.json with approved: true and matching hash but NO parent APPROVED ruling -> nothing granted", async (t) => {
  const w = world(t);
  w.forge({ handoffDir: w.handoff, plan: { topic: "widget", hash: w.hash() }, approved: true, status: "approved", planReview: null, chain: "main", chains: {}, reviewCount: 0, planReviewCount: 0 });
  const b = await w.adapter();
  assert.ok(planRequired(await b.launch("builder")));
});

test("ruling-<n>.md APPROVED only (no ruling.md APPROVED) -> nothing granted", async (t) => {
  const w = world(t);
  const a = await w.adapter();
  assert.equal(await a.checkpoint(), "approve");
  w.pastPlans();
  w.rule("ruling-2.md", "APPROVED\n");
  w.rule("ruling.md", "SHIP\n");
  await a.down();
  const b = await w.adapter();
  assert.ok(planRequired(await b.launch("builder")));
});

test("scratch plan differs from the handoff plan.md the parent approved -> nothing granted", async (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.handoff, "plan.md"), PLAN + "\nThe version the parent read.\n");
  const a = await w.adapter();
  assert.equal(await a.checkpoint(), "approve");
  w.pastPlans();
  w.rule("ruling.md", "APPROVED\n"); // newer than both plan files: only the hashes differ
  await a.down();
  assert.equal((w.stored().plan as { hash: string }).hash, w.hash(), "dir and scratch hash match");
  const b = await w.adapter();
  assert.ok(planRequired(await b.launch("builder")));
});

test("different handoff dir -> discarded", async (t) => {
  const w = world(t);
  const a = await w.adapter();
  assert.equal(await a.checkpoint(), "approve");
  assert.equal(await a.launch("builder"), undefined);
  assert.equal(await a.launch("reviewer"), undefined);
  await a.down();
  w.forge({ ...w.stored(), handoffDir: path.join(path.dirname(w.handoff), "other") });
  await tick();
  w.rule("ruling.md", "APPROVED\n");
  await tick();
  const b = await w.adapter();
  const r = await b.launch("builder");
  assert.ok(planRequired(r), JSON.stringify(r));
  assert.equal(w.stored().handoffDir, w.handoff);
  assert.deepEqual(w.stored().chains, { main: { revisions: 0, exempt: 0, built: false, reviewOpen: false } }, "no counter came back");
});

test("no PI_FOREMAN_HANDOFF_DIR -> no file written", async (t) => {
  const w = world(t, false);
  const a = await w.adapter();
  assert.equal(await a.checkpoint(), "approve");
  assert.equal(await a.launch("builder"), undefined);
  assert.equal(await a.launch("reviewer"), undefined);
  await a.ownerPrompt();
  assert.equal(fs.existsSync(w.stateFile), false);
  assert.deepEqual(fs.readdirSync(w.handoff).filter((f) => f.includes("round-state")), []);
});

test("RoundChains.clear -> file counters cleared", async (t) => {
  const w = world(t);
  const a = await w.adapter();
  assert.equal(await a.checkpoint(), "approve");
  for (const r of ["builder", "reviewer", "builder"]) assert.equal(await a.launch(r), undefined);
  assert.deepEqual(w.stored().chains, { main: { revisions: 1, exempt: 0, built: true, reviewOpen: false, revisionAnswered: true } });
  assert.equal(w.stored().reviewCount, 1);
  await a.ownerPrompt();
  assert.deepEqual(w.stored().chains, { main: { revisions: 0, exempt: 0, built: false, reviewOpen: false } });
  assert.equal(w.stored().reviewCount, 0);
  await tick();
  w.rule("ruling.md", "APPROVED\n");
  await a.down();
  const b = await w.adapter();
  assert.equal(await b.launch("builder"), undefined, "approval restored from the ruling");
  assert.equal(await b.launch("reviewer"), undefined);
  assert.equal(await b.launch("builder"), undefined, "revision 1: the cleared count did not come back");
});

test("negative / non-integer counters -> discarded", async (t) => {
  const w = world(t);
  const chains = { main: { revisions: -1, exempt: 0, built: true, reviewOpen: true }, P2: { revisions: 1.5, exempt: 0 }, P3: { revisions: 2, exempt: "1" }, P4: { revisions: 2, exempt: 1, built: "yes", reviewOpen: true, used: 9, secOpen: true }, bad: { revisions: 1, exempt: 0 } };
  w.forge({ handoffDir: w.handoff, plan: null, chain: "P4", chains, reviewCount: -3, planReviewCount: 1.2, refusal: { key: "P4", at: 1 } });
  const r = restoreRoundState(w.handoff, () => null);
  assert.ok(r);
  assert.deepEqual([...r.chains], [["P4", { built: false, reviewOpen: true, used: 2, exempt: 1 }]], "only the valid chain, no security flag");
  assert.equal(r.chain, "P4");
  assert.equal(r.reviewCount, 0);
  assert.equal(r.planReviewCount, 0);
  assert.equal(r.approval, null);
  // through the adapter: the bad chains start fresh, the valid one is the active chain
  const b = await w.adapter();
  assert.equal(await b.launch("reviewer"), undefined);
  assert.deepEqual(w.stored().chains, { P4: { revisions: 2, exempt: 1, built: false, reviewOpen: true } });
  assert.equal(w.stored().reviewCount, 1);
});

test("a ruling whose mtime is not before the session start is delivered before the launch, not as plan_required (flake cause)", async (t) => {
  const w = world(t);
  const a = await w.adapter();
  assert.equal(await a.checkpoint(), "approve");
  await a.down();
  w.rule("ruling.md", "APPROVED\n");
  const future = (Date.now() + 60_000) / 1000;
  fs.utimesSync(path.join(w.handoff, "ruling.md"), future, future);
  const b = await w.adapter(false);
  const r = await b.launch("builder");
  assert.ok(r?.block && /a newer ruling arrived before this launch/.test(r.reason ?? ""), JSON.stringify(r));
  assert.equal(planRequired(r), false);
});
