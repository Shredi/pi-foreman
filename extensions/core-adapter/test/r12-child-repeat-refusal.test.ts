// R12 P1 item 4: the second identical overlay deny reason (exact string) within one child run stops that run: the child marks the run
// failed with `run failed: repeated guarded-token probe` (stderr, exit code 1, block reason), aborts its turn and traces
// `child_repeat_refusal`; every later tool call is blocked (no third attempt). The parent's runEndOf reads the marker as repeatRefusal
// (the R11 policy_block family): failed, not paused, no retry, no climb, no relaunch hint.
// Only probe-class reasons (launchwait.ts REPEAT_STOP_REASONS) are stop-eligible; a repeated cd outside the workspace never stops a run.
// Probe lines: `HOME=/x; ls ~` binds HOME and uses it (a stop-eligible rebinding deny); `git worktree add|prune` are foreman-only
// worktree ops and `cd /` leaves the workspace (denied for a child, not stop-eligible) (permoverlay.ts checkShell).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { LadderState } from "../ladder.ts";
import { launchWaitText, REPEAT_REFUSAL_ERROR, REPEAT_REFUSAL_LINE, REPEAT_STOP_REASONS, runEndOf } from "../launchwait.ts";
import { r11Rig } from "./_r11rig.ts";
import { rmTestTmp } from "./_tmpbase.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Block = { block?: boolean; reason?: string } | undefined;

let rigs = 0;

async function childRig(t: { after(fn: () => void | Promise<void>): void }) {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PRESSURE_FIXTURE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const savedExit = process.exitCode;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r12-repeat-")));
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    try { await shutdown?.(); } catch { /* best effort */ }
    await new Promise((r) => setTimeout(r, 300));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    // the child's stop sets exit code 1 for its process; the test process keeps its own
    process.exitCode = savedExit;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_CHILD = "1";
  delete process.env.PI_FOREMAN_PRESSURE_FIXTURE;
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ trace: { enabled: true } }));
  const handlers = new Map<string, Handler>();
  const pi = {
    events: { on: () => undefined, emit: () => undefined },
    on: (n: string, h: Handler) => {
      const prev = handlers.get(n);
      handlers.set(n, !prev ? h : n === "tool_call" ? async (e, c) => (await prev(e, c)) ?? (await h(e, c)) : async (e, c) => { const r = await prev(e, c); const r2 = await h(e, c); return r ?? r2; });
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never, { pressureNow: () => Date.now(), pressureRun: async () => ({ ok: true, text: "" }) });
  let aborts = 0;
  const sessionId = `r12-repeat-${++rigs}`;
  const ctx = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    cwd: project,
    model: { provider: "fake", id: "builder" },
    mode: "json",
    hasUI: false,
    abort: () => void aborts++,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: () => undefined, confirm: async () => false, select: async () => undefined, setStatus: () => undefined, setWidget: () => undefined },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  let calls = 0;
  const trace = (): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    const walk = (d: string): void => {
      if (!fs.existsSync(d)) return;
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (n.startsWith("trace-") && n.endsWith(".jsonl")) out.push(...fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
      }
    };
    walk(agentDir);
    return out;
  };
  return {
    aborts: () => aborts,
    events: (name: string) => trace().filter((r) => r.event === name),
    bash: async (command: string): Promise<Block> => (await handlers.get("tool_call")!({ toolName: "bash", toolCallId: `b${++calls}`, input: { command } }, ctx)) as Block,
  };
}

test("child_second_identical_deny_stops_run", async (t) => {
  const c = await childRig(t);
  const first = await c.bash("HOME=/x; ls ~");
  assert.equal(first?.block, true);
  assert.match(first?.reason ?? "", /the line binds HOME and uses it/);
  assert.doesNotMatch(first?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR));
  assert.equal(c.aborts(), 0);
  assert.equal(c.events("child_repeat_refusal").length, 0);
  const second = await c.bash("HOME=/x; ls ~");
  assert.equal(second?.block, true);
  assert.match(second?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR));
  assert.ok((second?.reason ?? "").includes(first!.reason!), "the stop names the refusal");
  assert.equal(c.aborts(), 1);
  assert.equal(process.exitCode, 1, "the child's run is marked failed (exit code 1), not only aborted");
  const stops = c.events("child_repeat_refusal");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].decision, "stopped");
  assert.ok(typeof stops[0].runId === "string" && typeof stops[0].role === "string" && typeof stops[0].reason === "string", JSON.stringify(stops[0]));
  // no third attempt: every later tool call of the run is blocked with the stop text, also a harmless one
  const third = await c.bash("ls");
  assert.equal(third?.block, true);
  assert.match(third?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR));
  assert.equal(c.events("child_repeat_refusal").length, 1);
});

test("child_two_different_denies_do_not_stop", async (t) => {
  const c = await childRig(t);
  const a = await c.bash("git worktree add ../x");
  const b = await c.bash("git worktree prune");
  assert.equal(a?.block, true);
  assert.equal(b?.block, true);
  assert.notEqual(a?.reason, b?.reason);
  for (const r of [a, b]) assert.doesNotMatch(r?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR));
  assert.equal(c.aborts(), 0);
  assert.equal(c.events("child_repeat_refusal").length, 0);
  assert.doesNotMatch((await c.bash("ls"))?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR));
});

test("child_repeated_cd_outside_workspace_does_not_stop", async (t) => {
  const c = await childRig(t);
  for (let i = 0; i < 5; i++) {
    const r = await c.bash("cd /");
    assert.equal(r?.block, true, `cd ${i}`);
    assert.match(r?.reason ?? "", /children may cd only inside the workspace/);
    assert.doesNotMatch(r?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR));
  }
  // a repeated worktree-op deny is no probe either
  for (let i = 0; i < 3; i++) assert.doesNotMatch((await c.bash("git worktree add ../x"))?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR));
  assert.equal(c.aborts(), 0);
  assert.equal(c.events("child_repeat_refusal").length, 0);
  // the run goes on: a harmless call passes
  assert.equal((await c.bash("ls"))?.block, undefined);
});

test("repeat_stop_reasons_eligible_and_not", () => {
  const hit = (r: string): boolean => REPEAT_STOP_REASONS.some((re) => re.test(r));
  const eligible = [
    "pi-foreman: 'x.py' denied for a child: the script spells a guarded token from pieces (split literal reassembles a guarded token). No split, concatenated or encoded guarded tokens; a probe that needs one runs through the test suite's fixtures.",
    "pi-foreman: denied by the permission policy (the line binds HOME and uses it; a rebound HOME is never trusted as a path). Use the literal path.",
    "pi-foreman: denied by the permission policy (the line binds FOREMAN_SCRATCH and uses it; a rebound FOREMAN_SCRATCH is never trusted as a path). Use the literal path.",
    "pi-foreman: denied by the permission policy ('$S/x' uses a variable this line rebinds; only an unbound $S / $FOREMAN_SCRATCH names your scratch dir). Use the literal path or S=$FOREMAN_SCRATCH alone.",
    "pi-foreman: denied by the permission policy (write target '$D/x' uses a variable this line binds, and the line is outside the resolvable grammar). Use the literal path.",
    "pi-foreman: a session cannot write its own parent's ruling.",
    "pi-foreman: denied by the permission policy (path rule '~/.ssh/*' matched '~/.ssh/id_rsa'). Secret and policy paths are off limits to the agent, also through shell commands.",
    "pi-foreman: denied by the permission policy (path rule '/a/agent/foreman.json' matched '/a/agent/foreman.json'). The foreman's handoff, artifact and configuration paths are not for subagents; ask the foreman.",
    "pi-foreman: denied by the permission policy (path rule '**/.env' matched '.env' for read).",
    "pi-foreman: denied by the write protection (rule '.git/hooks/*' matches in a bash write). Git internals, agent and harness configuration are off limits to subagents; ask the foreman.",
  ];
  const not = [
    "pi-foreman: denied by the permission policy (children may cd only inside the workspace). Use a path below the workspace root, or work with relative paths from it.",
    "pi-foreman: denied by the permission policy (path rule '*.worktrees/*' matched '../repo.worktrees/r2/x'). The foreman's handoff, artifact and configuration paths are not for subagents; ask the foreman.",
    "pi-foreman: denied by the permission policy (path rule '/v/T/pi-foreman-scratch/s1' matched '/v/T/pi-foreman-scratch/s1/x'). The foreman's handoff, artifact and configuration paths are not for subagents; ask the foreman.",
    "pi-foreman: denied by the permission policy (git worktree add is the foreman's; children may only list worktrees). Ask the foreman.",
    "pi-foreman: write to /tmp/x denied for a child: use FOREMAN_SCRATCH (/s), not /tmp.",
    "pi-foreman: npm install needs approval (it may rewrite node_modules).",
    "pi-foreman: [child_read_budget_exceeded] 40 read calls (limit 40). Stop reading: return your report now.",
    "pi-foreman: [recheck_budget_exceeded] the reviewer passed; finish now.",
    "pi-foreman: review launch refused [review_cap]: 3 reviewer run(s) already ran for this prompt (ceremony.reviewRuns 3).",
  ];
  for (const r of eligible) assert.ok(hit(r), r);
  for (const r of not) assert.ok(!hit(r), r);
});

const STOPPED = `pi-foreman: ${REPEAT_REFUSAL_ERROR}: the same refusal twice in this run, so the run is stopped and not retried.`;

test("parent_run_end_repeat_refusal_no_retry", async (t) => {
  // classification, no climb (STATUS: stuck ignored), report text with the stop line and no relaunch hint
  const end = runEndOf({ runId: "r1", agent: "builder", success: false, summary: "STATUS: stuck", error: STOPPED, asyncDir: "/runs/r1" });
  assert.equal(end?.repeatRefusal, true);
  assert.equal(end?.status, "failed");
  const l = new LadderState();
  l.onLaunch("c1", "builder", true);
  l.onLaunched("c1", "r1");
  assert.equal(l.onRunEnd(end), null);
  assert.equal(l.eligible.size, 0);
  const text = launchWaitText({ outcome: "done", runId: "r1", role: "builder", ms: 1000, maxSeconds: 60, end: end! });
  assert.ok(text.includes(REPEAT_REFUSAL_LINE));
  assert.match(text, /not retried/);
  assert.doesNotMatch(text, /Relaunch it with model "strong"/);
  // a completed run that quotes the marker, or a failure without it, is no repeat_refusal
  assert.equal(runEndOf({ runId: "a", agent: "reviewer", success: true, summary: `VERDICT: PASS\n${STOPPED}` })?.repeatRefusal, undefined);
  assert.equal(runEndOf({ runId: "b", agent: "builder", success: false, summary: "STATUS: stuck" })?.repeatRefusal, undefined);
  // through the adapter: the parent's stop record, one launch, nothing relaunched or made climb-eligible
  const a = await r11Rig(t);
  const input = { agent: "builder", task: "fix item 4" };
  const { id } = await a.launch(input);
  await a.started(id, input, "run-r");
  a.end({ runId: "run-r", agent: "builder", success: false, summary: "STATUS: stuck", results: [{ agent: "builder", error: STOPPED }] });
  assert.deepEqual(a.events("child_repeat_refusal").map((r) => [r.role, r.runId, r.kind, r.outcome, r.exit, r.decision]), [["builder", "run-r", "repeat_refusal", "failed", 1, "stopped"]]);
  assert.equal(a.events("role_launch").length, 1);
  assert.deepEqual(a.events("rung_up"), []);
});

test("parent_run_end_repeat_refusal_failed_not_paused", () => {
  // the child aborts its turn as it stops; pi-subagents may report that as paused/interrupted: the marker makes it failed
  for (const data of [
    { runId: "p1", agent: "builder", success: false, interrupted: true, summary: "", error: STOPPED },
    { runId: "p2", agent: "builder", success: false, state: "paused", summary: STOPPED },
    { runId: "p3", agent: "builder", success: false, interrupted: true, results: [{ agent: "builder", error: STOPPED }] },
  ]) {
    const end = runEndOf(data);
    assert.equal(end?.status, "failed", data.runId);
    assert.equal(end?.repeatRefusal, true, data.runId);
  }
  // without the marker an interrupted run stays paused
  assert.equal(runEndOf({ runId: "p4", agent: "builder", success: false, interrupted: true, summary: "" })?.status, "paused");
});
