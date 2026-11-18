// The kept cases of the former checkpoint-parent-verdict test (PR 4, the child owns its plan): `human` is the only checkpoint mode. In a
// session with a parent the dialog runs while attended and a ruling-plan.md is not read; unattended the checkpoint stays pending; the value
// `parent` is refused (checkpointConfigRefusal); a session still cannot write its own ruling into a dir where it is the child.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { checkpointConfigRefusal } from "../checkpoint.ts";
import { selfRulingRefusal } from "../ruling.ts";
import coreAdapter from "../index.ts";
import { probeSpawner } from "./_probe-memo.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Result = { details?: { decision?: string; by?: string | null }; content: { text: string }[] };
type Tool = { name: string; execute: (...a: unknown[]) => Promise<Result> };

const KEYS = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_PARENT_INTERCOM"];
const PLAN = ".workflow/scratch/plan-ck.md";

async function rig(t: import("node:test").TestContext, o: { config?: unknown; parent: boolean; ui: boolean }) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-cphuman-")));
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
  coreAdapter(pi as never, { spawner: probeSpawner() });
  const counts = { select: 0, confirm: 0, input: 0 };
  const ctx = {
    sessionManager: { getSessionId: () => "cphuman-session", getSessionFile: () => undefined },
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
  return { check: (id: string) => run.execute(id, { path: PLAN }, undefined, undefined, ctx), handoff, counts };
}

test("human mode with a parent, attended: the dialog runs and a ruling-plan.md is not read", async (t) => {
  const r = await rig(t, { config: { ceremony: { checkpoint: "human" } }, parent: true, ui: true });
  fs.writeFileSync(path.join(r.handoff, "ruling-plan.md"), "REJECT\n");
  // the press first picks the parent's file up as a note (steer watch), then the call goes on to the dialog
  const note = await r.check("c0");
  assert.equal(note.details?.decision, "pending");
  assert.match(note.content[0].text, /newer ruling arrived/);
  assert.equal(r.counts.select, 0);
  const out = await r.check("c1");
  assert.equal(out.details?.decision, "approve");
  assert.equal(out.details?.by, "user");
  assert.equal(r.counts.select, 1);
});

test("human mode (the only mode), unattended: pending, no dialog", async (t) => {
  const r = await rig(t, { parent: false, ui: false });
  const out = await r.check("c1");
  assert.equal(out.details?.decision, "pending");
  assert.deepEqual(r.counts, { select: 0, confirm: 0, input: 0 });
});

test("checkpointConfigRefusal: only the value parent is refused, with its code; human, unset and other values are the dialog", () => {
  assert.match(checkpointConfigRefusal("parent") ?? "", /\[checkpoint_parent\].*no longer supported/);
  for (const v of ["human", undefined, null, "", "PARENT", 1]) assert.equal(checkpointConfigRefusal(v), null, String(v));
});

test("a session cannot write its own ruling.md in a dir where it is the child", (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-cpself-")));
  t.after(() => rmTestTmp(d));
  assert.ok(selfRulingRefusal("write", { path: path.join(d, "ruling.md") }, d, [d]));
  assert.equal(selfRulingRefusal("write", { path: path.join(d, "notes.md") }, d, [d]), undefined);
});
