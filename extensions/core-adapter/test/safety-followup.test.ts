// Ledger 49 follow-ups: a session-start warning when pi-claude-bridge loads before pi-foreman,
// and remove/rename protection of the agent dir's parent (`~/.pi` by default). Temp dirs only;
// guard tests pass command strings, nothing is executed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import coreAdapter from "../index.ts";
import { LOAD_ORDER_NOTICE } from "../bridgeiso.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function tmp(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

test("session_start warns in the main session when pi-claude-bridge loads before pi-foreman", async (t) => {
  const keys = ["PATH", "Path", "PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "CLAUDE_CONFIG_DIR", "GIT_CONFIG_COUNT"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (let i = 0; i < 8; i++) saved[`GIT_CONFIG_KEY_${i}`] = process.env[`GIT_CONFIG_KEY_${i}`], saved[`GIT_CONFIG_VALUE_${i}`] = process.env[`GIT_CONFIG_VALUE_${i}`];
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const root = tmp(t, "pf-lo-");
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

test("remove/rename of the agent dir's parent is asked in the foreman, denied in children; reads pass", (t) => {
  const root = tmp(t, "pf-adp-");
  const cwd = path.join(root, "proj");
  const home = path.join(root, "home");
  const dotPi = path.join(home, ".pi");
  const agentDir = path.join(dotPi, "agent");
  fs.mkdirSync(path.join(agentDir, "pi-foreman", "state"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const r = buildOverlayRules(readBaseline(PKG)!, {}, {}, agentDir, path.join(root, "pkg"));
  const kind = (tool: string, input: Record<string, unknown>, role: "main" | "child"): string => checkToolCall(r, tool, input, { cwd, home, platform: process.platform, role })?.kind ?? "pass";
  for (const [tool, input] of [
    ["bash", { command: "trash ~/.pi" }],
    ["bash", { command: "mv ~/.pi ~/.pi-old" }],
    ["bash", { command: `rm -r "$HOME/.pi/"` }],
    ["bash", { command: `rmdir ${dotPi}` }],
    ["bash", { command: `python3 -c "import shutil; shutil.rmtree('${dotPi}')"` }],
    ["foreman_move", { src: dotPi, dst: path.join(root, "pi-old") }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert.equal(kind(tool, input, "main"), "ask", `main ${tool} ${JSON.stringify(input)}`);
    assert.equal(kind(tool, input, "child"), "deny", `child ${tool} ${JSON.stringify(input)}`);
  }
  for (const [tool, input] of [
    ["bash", { command: "ls ~/.pi" }],
    ["bash", { command: `ls -la ${dotPi}` }],
    ["ls", { path: dotPi }],
    ["bash", { command: "trash ~/.pi/other-file" }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert.equal(kind(tool, input, "main"), "pass", `main ${tool} ${JSON.stringify(input)}`);
    assert.equal(kind(tool, input, "child"), "pass", `child ${tool} ${JSON.stringify(input)}`);
  }
  // Derived from the agent dir, not hard-coded: another agent dir protects its own parent.
  const other = path.join(root, "custom", "agent-x");
  const r2 = buildOverlayRules(readBaseline(PKG)!, {}, {}, other, path.join(root, "pkg"));
  assert.equal(checkToolCall(r2, "bash", { command: `trash ${path.join(root, "custom")}` }, { cwd, home, platform: process.platform, role: "child" })?.kind, "deny");
  assert.equal(checkToolCall(r2, "bash", { command: "trash ~/.pi" }, { cwd, home, platform: process.platform, role: "child" })?.kind ?? "pass", "pass");
});
