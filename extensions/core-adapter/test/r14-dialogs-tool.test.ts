// R14 item 4: the `foreman_dialogs` tool and `foreman dialogs <trace>` give the JSON of `/foreman dialogs --json`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import coreAdapter from "../index.ts";
import { dialogFields, dialogsJson } from "../dialogs.ts";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STATE_USAGE = ["cat ~/.pi/agent/pi-foreman/state/session-1.json", "cat ~/.pi/agent/pi-foreman/usage/usage-2026.jsonl", "tail -n 5 ~/.pi/agent/pi-foreman/state/usage-s1.jsonl"];
const askLine = (command: string) => JSON.stringify({ event: "overlay", toolFamily: "bash", decision: "ask-approved", command, ...dialogFields(command) });

type Tool = { name: string; execute: (id: string, p: Record<string, unknown>, s: undefined, u: undefined, ctx: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> };

test("foreman_dialogs tool text equals the /foreman dialogs --json text on a 3-dialog state/usage trace", async (t) => {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_INTERCOM_SESSION_ID", "PI_INTERCOM_STABLE_ID"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r14-dlg-")));
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
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_SESSION_ID = "r14-dlg";
  delete process.env.PI_INTERCOM_STABLE_ID;
  delete process.env.PI_SUBAGENT_CHILD;
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ trace: { enabled: true } }));
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
  const tools = new Map<string, Tool>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    events: { on: () => undefined, emit: () => undefined },
    on: (n: string, h: (e: unknown, c: unknown) => Promise<unknown>) => {
      const prev = handlers.get(n);
      handlers.set(n, prev ? async (e, c) => (await prev(e, c)) ?? (await h(e, c)) : h);
    },
    registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(n, c),
    registerTool: (x: Tool) => void tools.set(x.name, x),
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }, { name: "subagent" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never, { pressureNow: () => Date.now(), pressureRun: async () => ({ ok: true, text: "" }) });
  const notes: string[] = [];
  const ctx = {
    sessionManager: { getSessionId: () => "r14-dlg", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const dir = path.join(agentDir, "pi-foreman", "state");
  const traceFile = path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl"))!);
  fs.appendFileSync(traceFile, `${STATE_USAGE.map(askLine).join("\n")}\n`);

  const tool = tools.get("foreman_dialogs");
  assert.ok(tool, "foreman_dialogs is registered");
  const viaTool = (await tool.execute("t1", {}, undefined, undefined, ctx)).content[0].text;
  await commands.get("foreman")!.handler("dialogs --json", ctx);
  const viaSlash = notes[notes.length - 1];
  assert.equal(viaTool, viaSlash);
  assert.equal(JSON.parse(viaTool).state_usage_read.count, 3);
  // an explicit trace path reads that file
  assert.equal((await tool.execute("t2", { trace: traceFile }, undefined, undefined, ctx)).content[0].text, dialogsJson({ file: traceFile }));
});

test("foreman dialogs <trace> CLI prints the dialogsJson text of a 3-dialog state/usage fixture trace", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r14-cli-")));
  t.after(() => rmTestTmp(dir));
  const file = path.join(dir, "trace-fixture.jsonl");
  fs.writeFileSync(file, `${STATE_USAGE.map(askLine).join("\n")}\n`);
  // the sh wrapper is POSIX only; on win32 the entry the .cmd/.ps1 wrappers run is spawned directly
  const posix = process.platform !== "win32";
  const r = posix
    ? spawnSync(path.join(pkgRoot, "bin", "foreman"), ["dialogs", file], { encoding: "utf8" })
    : spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", path.join(pkgRoot, "extensions", "core-adapter", "dialogs-cli.ts"), file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${dialogsJson({ file })}\n`);
  assert.equal(JSON.parse(r.stdout).state_usage_read.count, 3);
});

test("foreman dialogs without a trace argument prints usage and exits 2", () => {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", path.join(pkgRoot, "extensions", "core-adapter", "dialogs-cli.ts")], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: foreman dialogs/);
});
