// Ledger 9 defect: in a real child session (PI_FOREMAN_HANDOFF_DIR and PI_FOREMAN_PARENT_INTERCOM both set) the checkpoint is in parent
// mode, and the parent's `ruling.md` APPROVED (the older contract, also the persisted restore path) still counts next to `ruling-plan.md`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { planVersionHash, readPlanVerdict } from "../checkpoint.ts";
import { SelfRulings } from "../ruling.ts";
import { ROUND_STATE_FILE } from "../roundstate.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Result = { details?: { decision?: string; by?: string | null }; content: { text: string }[] };

const KEYS = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_PARENT_INTERCOM", "PI_INTERCOM_SESSION_ID", "PI_INTERCOM_STABLE_ID"];
const PLAN = ".workflow/scratch/plan-ck.md";
const BODY = "# Widget\n\n## Goal\nShip it.\n\n## Approach\nOne builder.\n";
const tick = () => new Promise((r) => setTimeout(r, 25)); // ctime steps apart

/** A parent-mode session (both env vars set explicitly); `restore` starts it as a reload over a forged round-state.json. */
async function rig(t: import("node:test").TestContext, restore: boolean) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-cpmd-")));
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
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "round");
  for (const d of [path.join(project, ".workflow", "scratch"), path.join(project, ".git"), handoff]) fs.mkdirSync(d, { recursive: true });
  const plan = path.join(project, PLAN);
  fs.writeFileSync(plan, BODY);
  fs.writeFileSync(path.join(handoff, "plan.md"), BODY);
  fs.writeFileSync(path.join(handoff, "child"), "cpmd-session\n");
  fs.writeFileSync(path.join(handoff, "parent"), "parent-session\n");
  fs.writeFileSync(path.join(agentDir, "foreman.json"), "{}");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_SESSION_ID = "cpmd-session";
  delete process.env.PI_INTERCOM_STABLE_ID;
  delete process.env.PI_SUBAGENT_CHILD;
  process.env.PI_FOREMAN_HANDOFF_DIR = handoff;
  process.env.PI_FOREMAN_PARENT_INTERCOM = "parent-1";
  const ruling = (name: string, text = "APPROVED\n") => fs.writeFileSync(path.join(handoff, name), text);
  await tick();
  if (restore) {
    const state = { handoffDir: handoff, plan: { topic: "ck", hash: planVersionHash(fs.readFileSync(plan)) }, chain: "main", chains: {}, reviewCount: 0, planReviewCount: 0 };
    fs.writeFileSync(path.join(handoff, ROUND_STATE_FILE), JSON.stringify(state));
    ruling("ruling.md");
  }
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<Result> }>();
  const pi = {
    events: { on: () => undefined, emit: () => undefined },
    on: (n: string, h: Handler) => void handlers.set(n, h),
    registerCommand: () => undefined,
    registerTool: (x: { name: string; execute: (...a: unknown[]) => Promise<Result> }) => void tools.set(x.name, x),
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
    sessionManager: { getSessionId: () => "cpmd-session", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: "tui",
    hasUI: true,
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
  await handlers.get("session_start")!({ reason: restore ? "reload" : "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const run = tools.get("foreman_checkpoint")!;
  return { handoff, plan, counts, ruling, check: (id: string) => run.execute(id, { path: PLAN }, undefined, undefined, ctx) };
}

test("parent mode, both env vars set: a parent ruling.md APPROVED newer than the plan approves with no dialog", async (t) => {
  const r = await rig(t, false);
  r.ruling("ruling.md");
  await r.check("c0"); // the steer watch names a ruling that arrived mid-session once, then the call goes on
  const out = await r.check("c1");
  assert.equal(out.details?.decision, "approve", out.content[0]?.text);
  assert.equal(out.details?.by, "rig");
  assert.deepEqual(r.counts, { select: 0, confirm: 0, input: 0 });
});

test("parent mode, both env vars set: ruling-plan.md still decides; ruling.md written before the plan edit is stale", async (t) => {
  const r = await rig(t, false);
  r.ruling("ruling.md");
  await tick();
  fs.appendFileSync(r.plan, "More.\n");
  await r.check("c0"); // steer notice
  const stale = await r.check("c1");
  assert.equal(stale.details?.decision, "pending", stale.content[0]?.text);
  await tick();
  r.ruling("ruling-plan.md", "REVISE split step 2\n");
  assert.equal((await r.check("c2")).details?.decision, "revise");
  r.ruling("ruling-plan.md");
  assert.equal((await r.check("c3")).details?.decision, "approve");
  assert.deepEqual(r.counts, { select: 0, confirm: 0, input: 0 });
});

test("parent mode, both env vars set: a ruling.md the session wrote itself is no verdict (readPlanVerdict)", async (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-cpmd-self-")));
  t.after(() => rmTestTmp(d));
  const plan = path.join(d, "plan-x.md");
  fs.writeFileSync(plan, "p");
  await tick();
  const file = path.join(d, "ruling.md");
  fs.writeFileSync(file, "APPROVED\n");
  assert.deepEqual(readPlanVerdict(d, plan), { kind: "approve" });
  const self = new SelfRulings();
  self.mark(file);
  assert.equal(readPlanVerdict(d, plan, self), null);
  assert.equal(readPlanVerdict(d, plan, new SelfRulings()) !== null, true, "another session's SelfRulings does not know the file");
  fs.writeFileSync(file, "SHIP\n");
  assert.equal(readPlanVerdict(d, plan), null, "only APPROVED, never SHIP");
});

test("parent mode, both env vars set: the restore path brings the approval back from ruling.md", async (t) => {
  const r = await rig(t, true);
  fs.rmSync(path.join(r.handoff, "ruling.md")); // only the restored approval can answer now
  const out = await r.check("c1");
  assert.equal(out.details?.decision, "approve", out.content[0]?.text);
  assert.match(out.content[0].text, /already approved/);
  assert.deepEqual(r.counts, { select: 0, confirm: 0, input: 0 });
});
