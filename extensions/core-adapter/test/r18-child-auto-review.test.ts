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

test("r18 child: a toolchain-probe ask goes to the reviewer; allow -> auto_review_allow with the child role, requester: subagent <role>", async (t) => {
  const c = await childRig(t, '{"verdict":"allow"}');
  const r = await c.bash(PROBE);
  assert.equal(r, undefined, JSON.stringify(r));
  const rec = c.events("auto_review_allow");
  assert.equal(rec.length, 1);
  assert.deepEqual([rec[0].role, rec[0].rule, rec[0].toolFamily], [ROLE, "toolchain-probe", "bash"]);
  assert.equal(c.events("overlay").length, 0);
  assert.equal(c.sent.length, 1);
  assert.ok(c.sent[0].includes(`requester: subagent ${ROLE}`), c.sent[0]);
  assert.ok(!c.sent[0].includes("requester: main session"));
});

test("r18 child: a childDeny read (another session's state dir) is a deny and never reaches the reviewer", async (t) => {
  const c = await childRig(t, '{"verdict":"allow"}');
  const r = await c.bash(OTHER_STATE.replace(/~\/\.pi\/agent(?=\/)/g, c.agentDir).replace(/\{agentDir\}/g, c.agentDir).replace(/\{other\}/g, "01a16999-other"));
  assert.equal(r?.block, true);
  assert.equal(c.sent.length, 0);
  assert.equal(c.events("auto_review_allow").length, 0);
});

test("r18 child: a deferring reviewer leaves today's child block", async (t) => {
  const c = await childRig(t, '{"verdict":"defer"}');
  const r = await c.bash(PROBE);
  assert.equal(r?.block, true);
  assert.match(r?.reason ?? "", /ask the foreman/);
  assert.equal(c.sent.length, 1);
  assert.equal(c.events("auto_review_allow").length, 0);
});

test("r18 child: a high-risk reviewer deny blocks with the reviewer's reason", async (t) => {
  const c = await childRig(t, '{"verdict":"deny","reason":"no way","riskLevel":"high"}');
  const r = await c.bash(PROBE);
  assert.deepEqual(r, { block: true, reason: "model review: no way" });
  assert.equal(c.sent.length, 1);
  const ov = c.events("overlay");
  assert.deepEqual([ov[0]?.decision, ov[0]?.by], ["deny", "auto"]);
});

test("r18 child: its self-ruling ask never reaches the reviewer", async (t) => {
  const c = await childRig(t, '{"verdict":"allow"}');
  const dir = c.handoff("r18-own");
  const r = await c.bash(`echo "handoffs/${path.basename(dir)} ruling" > notes.txt`);
  assert.equal(r?.block, true, JSON.stringify(r));
  assert.equal(c.sent.length, 0);
  assert.equal(c.events("auto_review_allow").length, 0);
  // the self-ruling ask itself (not the child handoff deny): its reason is in the block
  assert.match(r?.reason ?? "", /this line writes, names a ruling and a handoff dir/);
});
