// /foreman doctor names a folder where an installed herdr-app mod file belongs as a differing file instead of aborting.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const PKG_MOD = path.resolve(import.meta.dirname, "..", "..", "..", "integrations", "herdr-app", "pi-foreman");

test("doctor lists a folder in place of a mod file as differing and still prints the report", async (t) => {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PI_AI_DATA", "HERDR_APP_HOME"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(mkTestTmp("pf-herdrmods-dir-"));
  const shutdowns: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const s of shutdowns) try { await s(); } catch { /* best effort */ }
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const appHome = path.join(root, "app-home");
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "pi-foreman"), { recursive: true });
  const dest = path.join(appHome, "mods", "pi-foreman");
  fs.cpSync(PKG_MOD, dest, { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
  fs.rmSync(path.join(dest, "model.js"));
  fs.mkdirSync(path.join(dest, "model.js"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_FOREMAN_PI_AI_DATA = path.join(root, "no-such-dir");
  process.env.HERDR_APP_HOME = appHome;
  delete process.env.PI_SUBAGENT_CHILD;
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ version: 1, providers: { fake: { roles: { review: { model: "fake/m" } } } } }));
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
    sessionManager: { getSessionId: () => "herdrmods-dir-1", getSessionFile: () => undefined },
    cwd: project,
    model: { provider: "fake", id: "main" },
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    modelRegistry: { find: (_p: string, id: string) => (id === "m" ? { id } : undefined), getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: (m: string) => void notes.push(m), confirm: async () => false },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdowns.push(async () => handlers.get("session_shutdown")?.({}, ctx));
  await commands.get("foreman")!.handler("doctor", ctx);
  const text = notes.pop()!;
  assert.ok(text.includes("WARN herdr-app mod pi-foreman differs from the package: model.js — fix: foreman setup --mods"), text);
});
