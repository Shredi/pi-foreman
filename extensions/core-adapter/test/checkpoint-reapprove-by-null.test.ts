// Residual 43: a re-approve of an unchanged, already-approved plan runs no dialog and records by: null.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ details?: { decision?: string; by?: string | null }; content: { text: string }[] }> };

test("foreman_checkpoint on an unchanged approved plan: no dialog, decision approve, by: null (trace and details)", async (t) => {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-reapprove-")));
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
  fs.mkdirSync(path.join(project, ".workflow", "scratch"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(project, ".workflow", "scratch", "plan-ck.md"), "# Widget\n\n## Goal\nShip it.\n\n## Approach\nOne builder.\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ trace: { enabled: true } }));
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
  let dialogs = 0;
  const ctx = {
    sessionManager: { getSessionId: () => "reapprove-session", getSessionFile: () => undefined },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: () => undefined, confirm: async () => false, select: async () => (dialogs++, "approve"), setStatus: () => undefined, setWidget: () => undefined },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const tool = tools.get("foreman_checkpoint")!;
  const first = await tool.execute("c1", { path: ".workflow/scratch/plan-ck.md" }, undefined, undefined, ctx);
  assert.equal(first.details?.decision, "approve", first.content[0]?.text);
  assert.equal(first.details?.by, "user");
  assert.equal(dialogs, 1);
  const again = await tool.execute("c2", { path: ".workflow/scratch/plan-ck.md" }, undefined, undefined, ctx);
  assert.equal(dialogs, 1, "no second dialog");
  assert.equal(again.details?.decision, "approve");
  assert.equal(again.details?.by, null);
  assert.match(again.content[0].text, /already approved/);
  const dir = path.join(agentDir, "pi-foreman", "state");
  const f = fs.readdirSync(dir).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl"))!;
  const cps = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.event === "checkpoint");
  assert.deepEqual(cps.map((c) => [c.decision, c.by]), [["approve", "user"], ["approve", null]]);
});
