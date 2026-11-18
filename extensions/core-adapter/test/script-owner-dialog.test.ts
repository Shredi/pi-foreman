// The owner-script dialog in the owner-dialog shape (index.ts, ownerdialog.ts): the first line is still scriptSelectTitle's, the
// description, risk and undo text are shown whole, the script's path is plain text (never a link), the choices are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { SCRIPT_CHOICES } from "../scriptapproval.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ details?: Record<string, unknown>; content: { text: string }[] }> };

const SCRIPT = ".workflow/scratch/set-key.sh";
const LONG = "Sets one key in the user config. ".repeat(14).trim();
const TEXTS = { description: LONG, risk: "A wrong value in the user config.", undo: "Run the script again with the old value." };
const skipWin = { skip: process.platform === "win32" };

async function rig(t: import("node:test").TestContext, mode: "rpc" | "tui") {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "HERDR_ENV", "HERDR_PANE_ID"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-scriptdlg-")));
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
  fs.writeFileSync(path.join(project, SCRIPT), `# honours --dry-run\necho "would set the key ($1)"\n`);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  for (const k of ["PI_SUBAGENT_CHILD", "HERDR_PANE_ID"]) delete process.env[k];
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ presence: { enabled: false }, radar: { openPrs: { enabled: false } } }));
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
  const seen = { titles: [] as string[], choices: [] as string[][], drawn: [] as string[], blocked: [] as { kind: string; message: string }[] };
  const theme = { fg: (_t: string, s: string) => s, underline: (s: string) => s };
  const ui: Record<string, unknown> = {
    notify: () => undefined,
    confirm: async () => false,
    select: async (title: string, choices: string[]) => {
      if (!title.startsWith("Run the owner script")) return undefined;
      seen.titles.push(title);
      seen.choices.push(choices);
      return "reject";
    },
    input: async () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  if (mode === "tui") {
    initTheme("dark");
    ui.theme = theme;
    ui.custom = async (factory: (...a: unknown[]) => { render(w: number): string[] }, options: { blocked: { kind: string; message: string } }) => {
      seen.blocked.push(options.blocked);
      seen.drawn.push(...factory({ requestRender: () => undefined }, theme, {}, () => undefined).render(1000));
      return "reject";
    };
  }
  const ctx = {
    sessionManager: { getSessionId: () => "scriptdlg", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode,
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui,
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const propose = () => tools.get("foreman_script")!.execute("c1", { action: "propose", path: SCRIPT, ...TEXTS }, undefined, undefined, ctx);
  return { seen, propose, script: path.join(project, SCRIPT) };
}

test("owner script dialog (plain): the first line is the unchanged title; description, risk and undo are whole; the path is plain; choices unchanged", skipWin, async (t) => {
  const r = await rig(t, "rpc");
  const out = await r.propose();
  assert.equal(out.details?.decision, "reject");
  assert.equal(r.seen.titles.length, 1);
  const title = r.seen.titles[0];
  const [first, ...rest] = title.split("\n");
  assert.match(first, /^Run the owner script set-key\.sh \(sha256 [0-9a-f]{8,}\)\?$/);
  const body = rest.join("\n");
  assert.ok(body.includes(LONG), "the description is whole");
  assert.match(body, /Risk: +A wrong value in the user config\./);
  assert.match(body, /Undo: +Run the script again with the old value\./);
  assert.match(body, /Path: \.workflow\/scratch\/set-key\.sh \(2 lines\)/);
  assert.match(body, /Undo through the tool: no/);
  assert.match(body, /approve: the dry run runs first +revise: you say what to change +reject: nothing runs\s*$/);
  assert.doesNotMatch(title, /\x1b/);
  assert.deepEqual(r.seen.choices, [[...SCRIPT_CHOICES]]);
  assert.deepEqual(r.seen.choices[0], ["approve", "revise", "reject"]);
});

test("owner script dialog (TUI): drawn through custom with the plain title as the blocked label; the script path is never a link", skipWin, async (t) => {
  const r = await rig(t, "tui");
  await r.propose();
  assert.equal(r.seen.titles.length, 0, "no plain select in the TUI");
  assert.equal(r.seen.blocked.length, 1);
  assert.equal(r.seen.blocked[0].kind, "question");
  assert.match(r.seen.blocked[0].message, /^Run the owner script set-key\.sh \(sha256 [0-9a-f]{8,}\)\?$/);
  const text = r.seen.drawn.join("\n");
  assert.ok(text.includes("Sets one key in the user config."));
  assert.match(text, /Path: \.workflow\/scratch\/set-key\.sh/);
  assert.doesNotMatch(text, /\x1b\]8/);
});
