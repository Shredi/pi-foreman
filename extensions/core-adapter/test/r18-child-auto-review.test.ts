// R18 item 1: a child's overlay ask (kind ask, no selfMod, no self-ruling) goes to the auto reviewer too, headless (mode json, no UI).
// The child rig is r12-child-repeat-refusal.test.ts' (PI_SUBAGENT_CHILD=1 and the launch binding before the adapter loads); the stubbed
// reviewer and the probe line are r16's (test/fixtures/r16-auto-review.json `reviewable[0]`, rule toolchain-probe).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import coreAdapter from "../index.ts";
import { BINDING_NS, BINDINGS_ENV } from "../usage.ts";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Block = { block?: boolean; reason?: string } | undefined;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "r16-auto-review.json"), "utf8")) as { reviewable: { name: string; line: string }[] };
const PROBE = FX.reviewable[0].line;
const OTHER_STATE = FX.reviewable[2].line;
const ROLE = "explorer";

let rigs = 0;

async function childRig(t: { after(fn: () => void | Promise<void>): void }, reply: string) {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PRESSURE_FIXTURE", "PI_INTERCOM_SESSION_ID", "PI_INTERCOM_STABLE_ID", BINDINGS_ENV];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r18-child-ar-")));
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
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const sessionId = `r18-child-${++rigs}`;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_SESSION_ID = sessionId;
  delete process.env.PI_INTERCOM_STABLE_ID;
  delete process.env.PI_FOREMAN_PRESSURE_FIXTURE;
  process.env.PI_SUBAGENT_CHILD = "1";
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "r18-foreman", workspace: project, role: ROLE, launchId: "r18-launch", kind: "first" } });
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ trace: { enabled: true }, providers: { fake: { review: { model: "fake/small", timeoutMs: 2000 } } } }));
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
  // the stubbed reviewer: every model call is counted and its prompt kept
  const sent: string[] = [];
  const modelRegistry = {
    find: () => ({ cost: { input: 1 } }),
    getProviderAuthStatus: () => ({ configured: true }),
    complete: async (_m: unknown, context: unknown) => {
      sent.push((context as { messages: { content: string }[] }).messages[0].content);
      return { content: [{ type: "text", text: reply }], stopReason: "stop" };
    },
  };
  const ctx = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    cwd: project,
    model: { provider: "fake", id: "explorer" },
    mode: "json",
    hasUI: false,
    abort: () => undefined,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry,
    ui: { notify: () => undefined, confirm: async () => false, select: async () => undefined, setStatus: () => undefined, setWidget: () => undefined },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  let calls = 0;
  const trace = (): Record<string, unknown>[] => {
    const dir = path.join(agentDir, "pi-foreman", "state");
    return fs.readdirSync(dir).filter((n) => n.startsWith("trace-") && n.endsWith(".jsonl")).flatMap((n) => fs.readFileSync(path.join(dir, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
  };
  return {
    agentDir,
    project,
    sent,
    events: (name: string) => trace().filter((r) => r.event === name),
    /** This session is the child side of a handoff dir (its parent rules there). */
    handoff(name: string): string {
      const dir = path.join(agentDir, "pi-foreman", "handoffs", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "child"), `${sessionId}\n`);
      fs.writeFileSync(path.join(dir, "parent"), "other-session\n");
      fs.writeFileSync(path.join(dir, "ask.md"), "ask\n");
      return dir;
    },
    bash: async (command: string): Promise<Block> => (await handlers.get("tool_call")!({ toolName: "bash", toolCallId: `b${++calls}`, input: { command } }, ctx)) as Block,
  };
}

const V = (verdict: string, entry: string, reason = "stub"): string => JSON.stringify({ verdict, entry, reason });
const gate = (c: { events: (n: string) => Record<string, unknown>[] }): string[] => c.events("guard").filter((x) => x.guard === "gate").map((x) => `${x.decision}:${x.rule}`);

test("r18 child: a toolchain-probe line goes to the gate's review; allow -> a gate allow record with the child role and session kind child", async (t) => {
  const c = await childRig(t, V("allow", "read-only-inspection"));
  const r = await c.bash(PROBE);
  assert.equal(r, undefined, JSON.stringify(r));
  assert.deepEqual(gate(c), ["allowed:review:read-only-inspection"]);
  assert.equal(c.events("auto_review_allow").length + c.events("overlay").length, 0);
  assert.equal(c.sent.length, 1);
  assert.ok(c.sent[0].includes(`role: ${ROLE}`), c.sent[0]);
  assert.ok(c.sent[0].includes("session kind: child"), c.sent[0]);
});

// R41: the selfmod-state-read rule (selfmod.ts) denies a child's read of another session's state dir; no model call.
test("r18 child: a read of another session's state dir is denied by the selfmod-state-read rule, no review", async (t) => {
  const c = await childRig(t, V("deny", "secret-access", "another session's state"));
  const r = await c.bash(OTHER_STATE.replace(/~\/\.pi\/agent(?=\/)/g, c.agentDir).replace(/\{agentDir\}/g, c.agentDir).replace(/\{other\}/g, "01a16999-other"));
  assert.equal(r?.block, true);
  assert.match(r?.reason ?? "", /selfmod-state-read.*report this line to the foreman/);
  assert.equal(c.sent.length, 0);
  assert.deepEqual(gate(c), ["blocked:selfmod-state-read"]);
});

test("r18 child: an asking reviewer is a child deny that names the entry and tells the child to report it (no dialog)", async (t) => {
  const c = await childRig(t, V("ask", "tool-config-edit", "unsure"));
  const r = await c.bash(PROBE);
  assert.equal(r?.block, true);
  assert.match(r?.reason ?? "", /policy ask tool-config-edit: unsure. Children cannot answer asks; report this line to the foreman/);
  assert.equal(c.sent.length, 1);
  const d = c.events("dialog");
  assert.equal(d.length, 0);
});

test("r18 child: a review deny is final and blocks with the policy entry and the reviewer's reason", async (t) => {
  const c = await childRig(t, V("deny", "secret-access", "no way"));
  const r = await c.bash(PROBE);
  assert.deepEqual(r, { block: true, reason: "pi-foreman: policy secret-access: no way" });
  assert.equal(c.sent.length, 1);
  assert.deepEqual(gate(c), ["blocked:review:secret-access"]);
});

test("r18 child: the old verdict shape (defer, riskLevel) is an invalid verdict: unreachable, a child deny with code policy_invalid_verdict (Addendum 3 F1)", async (t) => {
  const c = await childRig(t, '{"verdict":"defer"}');
  const r = await c.bash(PROBE);
  assert.equal(r?.block, true);
  assert.match(r?.reason ?? "", /policy_invalid_verdict/);
  assert.deepEqual(gate(c), []);
});

test("r18 child: its self-ruling ask never reaches the reviewer", async (t) => {
  const c = await childRig(t, V("allow", "read-only-inspection"));
  const dir = c.handoff("r18-own");
  const r = await c.bash(`echo "handoffs/${path.basename(dir)} ruling" > notes.txt`);
  assert.equal(r?.block, true, JSON.stringify(r));
  // the self-ruling ask still resolves through the old path (index.ts overlayBlock): a child deny that says to ask the foreman
  assert.match(r?.reason ?? "", /this line writes, names a ruling and a handoff dir/);
  assert.match(r?.reason ?? "", /ask the foreman/);
});
