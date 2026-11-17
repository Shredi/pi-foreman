// foreman_checkpoint and the plan page (index.ts + show.ts): the dialog line, the state after each answer, the already-approved early return.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";
import type { PagesIndex } from "../pages.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ details?: { decision?: string }; content: { text: string }[] }> };

const PLAN = "# Widget\n\n## For the owner\nWe ship the widget.\n```mermaid\ngraph TD\nA-->B\n```\n\n## Goal\nShip it.\n";

async function rig(t: { after(fn: () => void | Promise<void>): void }, answers: string[]) {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-pagesck-")));
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
  fs.writeFileSync(path.join(project, ".workflow", "scratch", "plan-ck.md"), PLAN);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ trace: { enabled: true }, presence: { enabled: false }, radar: { openPrs: { enabled: false } } }));
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
  const notes: string[] = [];
  const ctx = {
    sessionManager: { getSessionId: () => "pages-session", getSessionFile: () => undefined },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: (x: string) => void notes.push(x), confirm: async () => false, select: async () => answers.shift(), input: async () => "change it", setStatus: () => undefined, setWidget: () => undefined },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const call = () => tools.get("foreman_checkpoint")!.execute("c", { path: ".workflow/scratch/plan-ck.md" }, undefined, undefined, ctx);
  const pages = () => path.join(project, ".workflow", "scratch", "show", "pages-session", "pages");
  const index = () => JSON.parse(fs.readFileSync(path.join(pages(), "pages.json"), "utf8")) as PagesIndex;
  const settle = async (ms = 400) => new Promise((r) => setTimeout(r, ms));
  return { call, notes, pages, index, settle };
}

test("foreman_checkpoint: the dialog links the plan page, the answer sets its state, the diagram is a pointer in the dialog", async (t) => {
  const r = await rig(t, ["approve"]);
  const first = await r.call();
  assert.equal(first.details?.decision, "approve", first.content[0]?.text);
  const dialog = r.notes.find((n) => n.includes("For the owner"))!;
  assert.match(dialog, new RegExp(`Plan page: ${pathToFileURL(path.join(r.pages(), "plan.html")).href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(a path on this session's machine\\)`));
  assert.match(dialog, /\(diagram: see the plan page\)/);
  assert.doesNotMatch(dialog, /graph TD/);
  await r.settle();
  const idx = r.index();
  assert.equal(idx.pages.find((p) => p.id === "plan")?.state, "approved");
  assert.ok(idx.events.some((e) => e.kind === "checkpoint" && /approved/.test(e.text)));
  assert.match(fs.readFileSync(path.join(r.pages(), "plan.html"), "utf8"), /approved/);
  // the already-approved early return writes the approved state again
  fs.rmSync(path.join(r.pages(), "plan.html"));
  const again = await r.call();
  assert.equal(again.details?.decision, "approve");
  await r.settle();
  assert.match(fs.readFileSync(path.join(r.pages(), "plan.html"), "utf8"), /approved/);
});

test("foreman_checkpoint: revise and reject set the plan page state", async (t) => {
  const r = await rig(t, ["revise"]);
  assert.equal((await r.call()).details?.decision, "revise");
  await r.settle();
  assert.equal(r.index().pages.find((p) => p.id === "plan")?.state, "revise");
  const q = await rig(t, ["reject"]);
  assert.equal((await q.call()).details?.decision, "reject");
  await q.settle();
  assert.equal(q.index().pages.find((p) => p.id === "plan")?.state, "rejected");
});
