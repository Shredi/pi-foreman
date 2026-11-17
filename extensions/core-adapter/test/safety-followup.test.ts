// Ledger 49 follow-ups: a session-start warning when pi-claude-bridge loads before pi-foreman,
// and remove/rename protection of the agent dir's parent (`~/.pi` by default). Temp dirs only;
// guard tests pass command strings, nothing is executed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import coreAdapter from "../index.ts";
import { LOAD_ORDER_NOTICE } from "../bridgeiso.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

test("session_start warns in the main session when pi-claude-bridge loads before pi-foreman", async (t) => {
  const keys = ["PATH", "Path", "PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "CLAUDE_CONFIG_DIR", "GIT_CONFIG_COUNT"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (let i = 0; i < 8; i++) saved[`GIT_CONFIG_KEY_${i}`] = process.env[`GIT_CONFIG_KEY_${i}`], saved[`GIT_CONFIG_VALUE_${i}`] = process.env[`GIT_CONFIG_VALUE_${i}`];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-lo-")));
  t.after(async () => {
    // One hook, in order: quiescence wait (the test already awaited session_shutdown), removal, env restore.
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(project);
  fs.mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Handler>();
  const pi = { on: (n: string, h: Handler) => void handlers.set(n, h), registerCommand: () => undefined, registerTool: () => undefined, getActiveTools: () => [] as string[], setActiveTools: () => undefined, setModel: async () => true, setThinkingLevel: () => undefined };
  coreAdapter(pi as never);
  const run = async (id: string, packages: string[]): Promise<Array<[string, string]>> => {
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages }));
    const notes: Array<[string, string]> = [];
    const ctx = {
      sessionManager: { getSessionId: () => id, getSessionFile: () => undefined },
      cwd: project,
      model: undefined,
      mode: "print",
      hasUI: false,
      isProjectTrusted: () => false,
      modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
      ui: { notify: (m: string, level: string) => void notes.push([m, level]), confirm: async () => false },
    };
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    await handlers.get("session_shutdown")!({}, ctx);
    return notes;
  };
  const bridgeFirst = await run("lo-1", ["npm:pi-claude-bridge@0.9.1", PKG]);
  assert.ok(bridgeFirst.some(([m, l]) => m === LOAD_ORDER_NOTICE && l === "warning"), JSON.stringify(bridgeFirst));
  assert.match(LOAD_ORDER_NOTICE, /re-run the installer \(node setup\.mjs\), which moves pi-foreman first/);
  const foremanFirst = await run("lo-2", [PKG, "npm:pi-claude-bridge@0.9.1"]);
  assert.ok(!foremanFirst.some(([m]) => m === LOAD_ORDER_NOTICE), "foreman first: no warning");
});
