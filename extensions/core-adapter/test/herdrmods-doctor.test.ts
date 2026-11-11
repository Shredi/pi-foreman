// Ledger item 1 and 5: /foreman doctor warns when an installed herdr-app mod differs from the package, and stays silent when it is in step, not installed, or the app home is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const PKG_MOD = path.resolve(import.meta.dirname, "..", "..", "..", "integrations", "herdr-app", "pi-foreman");
const MOD_WARN = "WARN herdr-app mod pi-foreman differs from the package";

/** Runs `/foreman doctor` with HERDR_APP_HOME pointing at `appHome(root)`; `setup` may prepare that folder first. */
async function doctor(t: { after(fn: () => void | Promise<void>): void }, setup: (appHome: string) => void): Promise<string> {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PI_AI_DATA", "HERDR_APP_HOME"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(mkTestTmp("pf-herdrmods-doc-"));
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
  setup(appHome);
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
    sessionManager: { getSessionId: () => "herdrmods-doc-1", getSessionFile: () => undefined },
    cwd: project,
    model: { provider: "fake", id: "main" },
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: (_p: string, id: string) => (id === "m" ? { id } : undefined), getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: (m: string) => void notes.push(m), confirm: async () => false },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdowns.push(async () => handlers.get("session_shutdown")?.({}, ctx));
  await commands.get("foreman")!.handler("doctor", ctx);
  return notes.pop()!;
}

/** Installs the package's pi-foreman mod (test files left out) into the app home. */
function installMod(appHome: string): string {
  const dest = path.join(appHome, "mods", "pi-foreman");
  fs.cpSync(PKG_MOD, dest, { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
  return dest;
}

test("doctor warns with the differing file and the fix command when an installed mod differs from the package", async (t) => {
  const text = await doctor(t, (appHome) => {
    fs.appendFileSync(path.join(installMod(appHome), "model.js"), "// local edit\n");
  });
  assert.ok(text.includes(`${MOD_WARN}: model.js — fix: foreman setup --mods`), text);
});

test("doctor is silent about the mods when the installed mod is in step", async (t) => {
  const text = await doctor(t, (appHome) => {
    installMod(appHome);
  });
  assert.doesNotMatch(text, /herdr-app mod/);
});

test("doctor is silent when no mod is installed", async (t) => {
  const text = await doctor(t, () => undefined);
  assert.doesNotMatch(text, /herdr-app mod/);
});
