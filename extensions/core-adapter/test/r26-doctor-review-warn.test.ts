// Ledger item 26: /foreman doctor warns when no review model is configured (the text of reviewwarn.ts), and prints the model line when one is.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";
import { noReviewModelText } from "../reviewwarn.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

async function doctor(t: { after(fn: () => void | Promise<void>): void }, config: Record<string, unknown>): Promise<string> {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PI_AI_DATA"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(mkTestTmp("pf-r26-doc-"));
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
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "pi-foreman"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_FOREMAN_PI_AI_DATA = path.join(root, "no-such-dir");
  delete process.env.PI_SUBAGENT_CHILD;
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ version: 1, ...config }));
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
    sessionManager: { getSessionId: () => "r26doc-1", getSessionFile: () => undefined },
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

test("doctor warns with the reviewwarn text and names the config key when no review model is configured", async (t) => {
  const text = await doctor(t, { providers: { fake: { roles: {} } } });
  assert.ok(text.includes(`WARN ${noReviewModelText("fake")}`), text);
  assert.match(text, /providers\.<p>\.roles\.review\.model/);
});

test("doctor prints the model line and no warning when a review model is configured", async (t) => {
  const text = await doctor(t, { providers: { fake: { roles: { review: { model: "fake/m" } } } } });
  assert.match(text, /model review: fake\/m /);
  assert.doesNotMatch(text, /no review model for provider/);
});
