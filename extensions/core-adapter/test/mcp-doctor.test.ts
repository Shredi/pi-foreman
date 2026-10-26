// r68 item 9 (TS half): a managed settings.json subagents block that still grants `mcp:fx` to a role's tools (the pre-r68
// layout) differs from what generate-subagents writes now, so /foreman doctor fails it until `foreman setup` is re-run.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

test("doctor fails a subagents block whose builder tools still carry mcp:fx", async (t) => {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PI_AI_DATA"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-mcpdoc-")));
  const shutdowns: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const s of shutdowns) try { await s(); } catch { /* best effort */ }
    await waitQuiet(path.join(root, "x", "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "x", "agent");
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "pi-foreman"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_FOREMAN_PI_AI_DATA = path.join(root, "no-such-dir");
  delete process.env.PI_SUBAGENT_CHILD;
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { agentOverrides: { builder: { tools: ["read", "bash", "mcp:fx"] } }, forceTopLevelAsync: true } }));
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on: (n: string, h: Handler) => void handlers.set(n, h),
    registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(n, c),
    registerTool: () => undefined,
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never, { piVersion: async () => "1.2.0" });
  const notes: string[] = [];
  const ctx = {
    sessionManager: { getSessionId: () => "mcpdoc-1", getSessionFile: () => undefined },
    cwd: project,
    model: undefined,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: (m: string) => void notes.push(m), confirm: async () => false },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdowns.push(async () => handlers.get("session_shutdown")?.({}, ctx));
  await commands.get("foreman")!.handler("doctor", ctx);
  const text = notes.pop()!;
  assert.match(text, /subagents block in settings\.json differs from generate-subagents/);
  assert.doesNotMatch(text, /generated subagents block in settings\.json is in sync/);
});
