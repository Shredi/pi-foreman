// R15 item 9: foreman_checkpoint takes its verdict from the parent-written `ruling-plan.md` in the handoff dir when ceremony.checkpoint is
// `parent` (the default for a session opened with a parent); the dialog only runs for `human` + attended; unattended with no file stays pending.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { checkpointMode, readPlanVerdict } from "../checkpoint.ts";
import { selfRulingRefusal } from "../ruling.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Result = { details?: { decision?: string; by?: string | null }; content: { text: string }[] };
type Tool = { name: string; execute: (...a: unknown[]) => Promise<Result> };

const KEYS = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_PARENT_INTERCOM"];
const PLAN = ".workflow/scratch/plan-ck.md";

interface Rig {
  tool: Tool;
  project: string;
  handoff: string;
  counts: { select: number; confirm: number; input: number };
  verdict: (text: string) => void;
}

async function rig(t: import("node:test").TestContext, o: { config?: unknown; parent: boolean; ui: boolean }): Promise<Rig> {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-cpverdict-")));
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
  const handoff = path.join(root, "handoff");
  for (const d of [path.join(project, ".workflow", "scratch"), path.join(project, ".git"), agentDir, handoff]) fs.mkdirSync(d, { recursive: true });
  const plan = path.join(project, PLAN);
  fs.writeFileSync(plan, "# Widget\n\n## Goal\nShip it.\n\n## Approach\nOne builder.\n");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(plan, past, past);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_FOREMAN_HANDOFF_DIR;
  delete process.env.PI_FOREMAN_PARENT_INTERCOM;
  if (o.parent) {
    process.env.PI_FOREMAN_HANDOFF_DIR = handoff;
    process.env.PI_FOREMAN_PARENT_INTERCOM = "parent-1";
  }
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify(o.config ?? {}));
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const pi = {
    events: { on: () => undefined, emit: () => undefined },
    on: (n: string, h: Handler) => void handlers.set(n, h),
    registerCommand: () => undefined,
    registerTool: (x: Tool) => void tools.set(x.name, x),
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }, { name: "subagent" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never);
  const counts = { select: 0, confirm: 0, input: 0 };
  const ctx = {
    sessionManager: { getSessionId: () => "cpverdict-session", getSessionFile: () => undefined },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: o.ui ? "tui" : "print",
    hasUI: o.ui,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: {
      notify: () => undefined,
      confirm: async () => (counts.confirm++, false),
      select: async () => (counts.select++, "approve"),
      input: async () => (counts.input++, "dialog note"),
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const run = tools.get("foreman_checkpoint")!;
  const tool: Tool = { name: run.name, execute: (id: unknown, p: unknown) => run.execute(id, p, undefined, undefined, ctx) };
  return { tool, project, handoff, counts, verdict: (text) => fs.writeFileSync(path.join(handoff, "ruling-plan.md"), text) };
}

test("parent mode (default with a parent): APPROVED in ruling-plan.md approves with no dialog", async (t) => {
  const r = await rig(t, { parent: true, ui: true });
  r.verdict("APPROVED\n");
  const out = await r.tool.execute("c1", { path: PLAN });
  assert.equal(out.details?.decision, "approve", out.content[0]?.text);
  assert.equal(out.details?.by, "rig");
  assert.deepEqual(r.counts, { select: 0, confirm: 0, input: 0 });
});

test("parent mode: REVISE <text> and REJECT by file", async (t) => {
  const r = await rig(t, { parent: true, ui: true });
  r.verdict("REVISE split step 2\nand add tests\n");
  const rev = await r.tool.execute("c1", { path: PLAN });
  assert.equal(rev.details?.decision, "revise");
  assert.match(rev.content[0].text, /split step 2\nand add tests/);
  r.verdict("REJECT\n");
  const rej = await r.tool.execute("c2", { path: PLAN });
  assert.equal(rej.details?.decision, "reject");
  assert.deepEqual(r.counts, { select: 0, confirm: 0, input: 0 });
});

test("parent mode: no file is pending, names the file to wait on, and shows no dialog even when attended", async (t) => {
  const r = await rig(t, { parent: true, ui: true });
  const out = await r.tool.execute("c1", { path: PLAN });
  assert.equal(out.details?.decision, "pending");
  assert.match(out.content[0].text, /foreman_wait kind file/);
  assert.ok(out.content[0].text.includes(path.join(r.handoff, "ruling-plan.md")));
  assert.deepEqual(r.counts, { select: 0, confirm: 0, input: 0 });
});

test("parent mode: a plan edit after the verdict makes it stale (pending), a verdict written after the edit approves", async (t) => {
  const r = await rig(t, { parent: true, ui: false });
  r.verdict("APPROVED\n");
  const plan = path.join(r.project, PLAN);
  fs.appendFileSync(plan, "More.\n");
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(plan, future, future);
  assert.equal((await r.tool.execute("c1", { path: PLAN })).details?.decision, "pending");
  await new Promise((res) => setTimeout(res, 20));
  r.verdict("APPROVED\n");
  assert.equal((await r.tool.execute("c2", { path: PLAN })).details?.decision, "approve");
});

test("parent mode: a plan edited after the verdict with its mtime backdated is still pending", async (t) => {
  const r = await rig(t, { parent: true, ui: false });
  r.verdict("APPROVED\n");
  await new Promise((res) => setTimeout(res, 20));
  const plan = path.join(r.project, PLAN);
  fs.appendFileSync(plan, "Sneaky.\n");
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(plan, past, past);
  assert.equal((await r.tool.execute("c1", { path: PLAN })).details?.decision, "pending");
});

test("human mode, attended: the dialog still runs and a ruling-plan.md is not read", async (t) => {
  const r = await rig(t, { config: { ceremony: { checkpoint: "human" } }, parent: true, ui: true });
  r.verdict("REJECT\n");
  const out = await r.tool.execute("c1", { path: PLAN });
  assert.equal(out.details?.decision, "approve");
  assert.equal(out.details?.by, "user");
  assert.equal(r.counts.select, 1);
});

test("human mode (default without a parent), unattended: pending, no dialog", async (t) => {
  const r = await rig(t, { parent: false, ui: false });
  const out = await r.tool.execute("c1", { path: PLAN });
  assert.equal(out.details?.decision, "pending");
  assert.deepEqual(r.counts, { select: 0, confirm: 0, input: 0 });
});

test("checkpointMode: configured value wins; the default follows the parent env", () => {
  assert.equal(checkpointMode("human", { PI_FOREMAN_HANDOFF_DIR: "/h", PI_FOREMAN_PARENT_INTERCOM: "p" }), "human");
  assert.equal(checkpointMode("parent", {}), "parent");
  assert.equal(checkpointMode(undefined, { PI_FOREMAN_HANDOFF_DIR: "/h", PI_FOREMAN_PARENT_INTERCOM: "p" }), "parent");
  assert.equal(checkpointMode(undefined, { PI_FOREMAN_HANDOFF_DIR: "/h" }), "human");
  assert.equal(checkpointMode(undefined, {}), "human");
});

const await_ = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test("readPlanVerdict: first line only, other first lines and a stale file are no verdict", (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-cpv-")));
  t.after(() => rmTestTmp(d));
  const plan = path.join(d, "plan-x.md");
  fs.writeFileSync(plan, "p");
  fs.utimesSync(plan, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const v = (s: string) => { fs.writeFileSync(path.join(d, "ruling-plan.md"), s); return readPlanVerdict(d, plan); };
  await_(20);
  assert.deepEqual(v("APPROVED"), { kind: "approve" });
  assert.deepEqual(v("REVISE fix it"), { kind: "revise", note: "fix it" });
  assert.deepEqual(v("REJECT"), { kind: "reject" });
  assert.equal(v("SHIP"), null);
  assert.equal(v("\nAPPROVED"), null);
  assert.equal(v("REVISEfix"), null);
  v("APPROVED");
  await_(20);
  fs.utimesSync(plan, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(readPlanVerdict(d, plan), null);
});

test("a session cannot write its own ruling-plan.md in a dir where it is the child", (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-cpself-")));
  t.after(() => rmTestTmp(d));
  assert.ok(selfRulingRefusal("write", { path: path.join(d, "ruling-plan.md") }, d, [d]));
  assert.equal(selfRulingRefusal("write", { path: path.join(d, "notes.md") }, d, [d]), undefined);
});
