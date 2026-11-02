// roles.<id>.searchable (ledger item 6): the allowlist it adds is part of the generated subagents block, so a managed settings.json
// that no longer matches the config (a `searchable` change without re-running setup) is reported by /foreman doctor like a `tools` drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("doctor reports a searchable change that settings.json does not carry, and is in sync once regenerated", async (t) => {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PI_AI_DATA"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-searchdoc-")));
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

  const generate = (): Record<string, unknown> => {
    const r = spawnSync("python3", ["-E", "-s", path.join(PKG_ROOT, "scripts", "foreman_config.py"), "generate-subagents", "--json", "--agent-dir", agentDir, "--project-dir", project], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
    return (JSON.parse(r.stdout) as { subagents: Record<string, unknown> }).subagents;
  };
  const doctor = async (): Promise<string> => {
    const handlers = new Map<string, Handler>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = { on: (n: string, h: Handler) => void handlers.set(n, h), registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(n, c), registerTool: () => undefined, getActiveTools: () => [] as string[], getAllTools: () => [{ name: "bash" }], setActiveTools: () => undefined, setModel: async () => true, setThinkingLevel: () => undefined, sendMessage: () => undefined };
    coreAdapter(pi as never, { piVersion: async () => "1.2.0" });
    const notes: string[] = [];
    const ctx = { sessionManager: { getSessionId: () => "searchdoc-1", getSessionFile: () => undefined }, cwd: project, model: undefined, mode: "tui", hasUI: true, isProjectTrusted: () => false, isIdle: () => true, modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) }, ui: { notify: (m: string) => void notes.push(m), confirm: async () => false } };
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    shutdowns.push(async () => handlers.get("session_shutdown")?.({}, ctx));
    await commands.get("foreman")!.handler("doctor", ctx);
    return notes.pop()!;
  };

  // settings.json carries the block generated for the defaults (builder: searchable foreman_move, foreman_copy)
  const defaults = generate();
  assert.ok((defaults.agentOverrides as Record<string, { tools: string[] }>).builder.tools.includes("foreman_copy"));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: defaults }));
  assert.match(await doctor(), /generated subagents block in settings\.json is in sync/);

  // the user narrows searchable; settings.json is stale until it is regenerated
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ roles: { builder: { searchable: ["foreman_move"] } } }));
  const text = await doctor();
  assert.match(text, /subagents block in settings\.json differs from generate-subagents/);
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: generate() }));
  assert.match(await doctor(), /generated subagents block in settings\.json is in sync/);
});
