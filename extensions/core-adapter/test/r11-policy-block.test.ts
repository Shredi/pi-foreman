// R11 item 3 (P1c): a child run that ends with no verdict, exit 1 and a usage-policy block marker is policy_block:
// stopped, never climb-eligible, never relaunched by the harness; trace `child_policy_block` is the stop record; the report says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { LadderState } from "../ladder.ts";
import { launchWaitText, POLICY_BLOCK_LINE, runEndOf } from "../launchwait.ts";
import { rmTestTmp } from "./_tmpbase.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

// A generic marker, as a provider refusal names it.
const BLOCKED = "STATUS: stuck\nThe provider declined this request under its usage policy.";
let rigs = 0;

async function rig(t: { after(fn: () => void | Promise<void>): void }) {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PRESSURE_FIXTURE"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r11-policy-")));
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    try { await shutdown?.(); } catch { /* best effort */ }
    await new Promise((r) => setTimeout(r, 300));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  // a resolvable permission-system package (permsys.ts resolvePermissionSystem), so a checkout without node_modules can launch
  const ps = path.join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system");
  fs.mkdirSync(path.join(ps, "src"), { recursive: true });
  fs.writeFileSync(path.join(ps, "package.json"), JSON.stringify({ name: "@gotgenes/pi-permission-system" }));
  fs.writeFileSync(path.join(ps, "src", "index.ts"), "export default () => undefined;\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_FOREMAN_PRESSURE_FIXTURE;
  const roles = ["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"];
  const l2 = {
    providers: { fake: { roles: Object.fromEntries(roles.map((r) => [r, { model: `fake/${r}`, ...(r === "builder" ? { strong: { model: "fake/senior-reviewer" } } : {}) }])) } },
    trace: { enabled: true },
    ceremony: { launchWait: "detach" },
  };
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify(l2));
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
  const sessionId = `r11-policy-${++rigs}`;
  coreAdapter(pi as never, { pressureNow: () => Date.now(), pressureRun: async () => ({ ok: true, text: "" }) });
  const ctx = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const trace = (): Record<string, unknown>[] => {
    const dir = path.join(agentDir, "pi-foreman", "state");
    const f = fs.readdirSync(dir).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl"));
    return f ? fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  return {
    trace,
    events: (name: string) => trace().filter((r) => r.event === name),
    assistant: (id: string, input: Record<string, unknown>) => handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } }, ctx),
    launch: (id: string, input: Record<string, unknown>) => handlers.get("tool_call")!({ toolName: "subagent", toolCallId: id, input }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>,
    started: (id: string, input: Record<string, unknown>, runId: string) => handlers.get("tool_result")!({ toolName: "subagent", toolCallId: id, input, details: { runId }, content: [{ type: "text", text: "started" }], isError: false }, ctx),
    end: (data: Record<string, unknown>) => channels.get("subagent:async-complete")!(data),
  };
}

test("policy_block_run_no_relaunch_stop_record", async (t) => {
  const a = await rig(t);
  const first = { agent: "builder", task: "fix item 1" };
  await a.assistant("b1", first);
  assert.equal(await a.launch("b1", first), undefined);
  await a.started("b1", first, "run-p");
  a.end({ runId: "run-p", agent: "builder", success: false, summary: BLOCKED });
  // the stop record, and the run's exit 1
  assert.deepEqual(a.events("child_policy_block").map((r) => [r.role, r.runId, r.kind, r.outcome, r.exit, r.decision]), [["builder", "run-p", "policy_block", "failed", 1, "stopped"]]);
  assert.deepEqual(a.events("role_result").map((r) => [r.role, r.exit]), [["builder", 1]]);
  // no second launch: nothing relaunched by the harness, and the run did not make a strong relaunch eligible (STATUS: stuck is ignored)
  assert.equal(a.events("role_launch").length, 1);
  assert.deepEqual(a.events("rung_up"), []);
  const strong = { agent: "builder", task: "fix item 1", model: "strong" };
  await a.assistant("b2", strong);
  const refused = await a.launch("b2", strong);
  assert.equal(refused?.block, true);
  assert.match(refused?.reason ?? "", /strong_no_reason/);
  assert.equal(a.events("role_launch").length, 1);
});

test("policy_block: classification, no climb, report text without a relaunch hint", () => {
  const end = runEndOf({ runId: "r1", agent: "builder", success: false, summary: BLOCKED, asyncDir: "/runs/r1" });
  assert.equal(end?.policyBlock, true);
  assert.equal(runEndOf({ runId: "r2", agent: "builder", success: false, summary: "failed", results: [{ agent: "builder", error: "Usage Policy refusal" }] })?.policyBlock, true, "marker in a result error");
  const l = new LadderState();
  l.onLaunch("c1", "builder", true);
  l.onLaunched("c1", "r1");
  assert.equal(l.onRunEnd(end), null);
  assert.equal(l.eligible.size, 0);
  const text = launchWaitText({ outcome: "done", runId: "r1", role: "builder", ms: 1000, maxSeconds: 60, end: end! });
  assert.ok(text.includes(POLICY_BLOCK_LINE));
  assert.match(text, /stopped for a usage-policy block/);
  assert.match(text, /not retried/);
  assert.doesNotMatch(text, /Relaunch it with model "strong"/);
});

test("policy_block: not a completed run, not a run with a verdict, not a failure without the marker", () => {
  assert.equal(runEndOf({ runId: "a", agent: "builder", success: true, summary: BLOCKED })?.policyBlock, undefined, "completed (exit 0)");
  assert.equal(runEndOf({ runId: "b", agent: "reviewer", success: false, summary: `VERDICT: FAIL\n${BLOCKED}` })?.policyBlock, undefined, "has a verdict");
  assert.equal(runEndOf({ runId: "c", agent: "builder", success: false, summary: "STATUS: stuck" })?.policyBlock, undefined, "no marker");
  // a plain failure with STATUS: stuck stays climb-eligible
  const l = new LadderState();
  l.onLaunch("c1", "builder", true);
  l.onLaunched("c1", "c");
  assert.equal(l.onRunEnd(runEndOf({ runId: "c", agent: "builder", success: false, summary: "STATUS: stuck" }))?.cause, "stuck");
  const text = launchWaitText({ outcome: "done", runId: "c", role: "builder", ms: 1000, maxSeconds: 60, end: runEndOf({ runId: "c", success: false, summary: "x" })! });
  assert.ok(!text.includes(POLICY_BLOCK_LINE));
});
