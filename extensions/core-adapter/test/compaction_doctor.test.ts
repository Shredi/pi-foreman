// /foreman doctor and the compaction overrides setup wrote: drift per settings file, and the "Pi model data not found" line.
// Temp dirs only; PI_FOREMAN_PI_AI_DATA keeps the discovery hermetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
let sessions = 0;

function harness(t: { after(fn: () => void): void }, dataEnv: string) {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PI_AI_DATA"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const shutdowns: (() => Promise<unknown>)[] = [];
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-cdoc-")));
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
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  process.env.PI_FOREMAN_PI_AI_DATA = dataEnv === "present" ? root : path.join(root, "no-such-dir");
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
  const notes: { text: string; level: string }[] = [];
  const sessionId = `cdoc-session-${++sessions}`;
  const ctx = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    cwd: project,
    model: undefined,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: (m: string, level: string) => void notes.push({ text: m, level }), confirm: async () => false },
  };
  const doctor = async (): Promise<string> => {
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    shutdowns.push(async () => handlers.get("session_shutdown")?.({}, ctx));
    await commands.get("foreman")!.handler("doctor", ctx);
    return notes.pop()!.text;
  };
  return { agentDir, project, doctor };
}

const settingsWith = (file: string, reserve: number): void =>
  fs.writeFileSync(file, JSON.stringify({ compaction: { modelOverrides: { "p/m": { reserveTokens: reserve } } } }));

test("doctor: compaction drift is checked in the global and the project settings file", async (t) => {
  const h = harness(t, "present");
  const globalFile = path.join(h.agentDir, "settings.json");
  const projectFile = path.join(h.project, ".pi", "settings.json");
  settingsWith(globalFile, 1000);
  settingsWith(projectFile, 2000);
  const managed = { entries: { [globalFile]: { compactionDerived: { "p/m": 1000 } }, [projectFile]: { compactionDerived: { "p/m": 2000 } } } };
  fs.writeFileSync(path.join(h.agentDir, "pi-foreman", "managed.json"), JSON.stringify(managed));
  const clean = await h.doctor();
  assert.ok(clean.includes(`compaction overrides written by setup in ${globalFile} are in sync`), clean);
  assert.ok(clean.includes(`compaction overrides written by setup in ${projectFile} are in sync`), clean);
  settingsWith(projectFile, 9999);
  const drifted = await h.doctor();
  assert.ok(drifted.includes(`compaction override in ${projectFile} differs from what setup wrote: p/m`), drifted);
  assert.ok(drifted.includes(`written by setup in ${globalFile} are in sync`), "the global file is still fine");
});

test("doctor: prints a line when Pi model data cannot be found, none when it can", async (t) => {
  const missing = await harness(t, "missing").doctor();
  assert.ok(missing.includes("compaction: Pi model data not found; registry-derived overrides skipped (set PI_FOREMAN_PI_AI_DATA or PI_FOREMAN_PI_BIN)"), missing);
  const present = await harness(t, "present").doctor();
  assert.ok(!present.includes("Pi model data not found"), present);
});
