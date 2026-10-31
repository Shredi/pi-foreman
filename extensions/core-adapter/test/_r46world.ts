// Shared rig of the R46 slice A tests: the real adapter over one temp world (project, agent dir, optional handoff dir)
// and a fake session file (`entries`, written by pi.appendEntry and read back through getBranch). A second `adapter()`
// call over the same world is a /reload (or a resume, or a fork: `reason`).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { planVersionHash } from "../checkpoint.ts";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Fn = (...a: unknown[]) => Promise<unknown>;
export type Block = { block?: boolean; reason?: string } | undefined;
type Entry = { type: "custom"; customType: string; data: unknown };

export const PLAN = "# Widget\n\n## Goal\nShip it.\n";
// The session variables are the shared list (session-env.json); PI_FOREMAN_PYTHON is added here, the preload keeps it.
const SESSION = JSON.parse(fs.readFileSync(new URL("./session-env.json", import.meta.url), "utf8")) as { keys: string[] };
export const KEYS = [...SESSION.keys, "PI_FOREMAN_PYTHON"];
export const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
let n = 0;

export interface WorldOpts {
  /** PI_FOREMAN_HANDOFF_DIR set (a round session). */
  handoff?: boolean;
  /** Also PI_FOREMAN_PARENT_INTERCOM: checkpoint mode `parent` (the verdict comes from ruling-plan.md). */
  parent?: boolean;
  ceremony?: Record<string, unknown>;
}

export function world(t: { after(fn: () => void | Promise<void>): void }, o: WorldOpts = {}) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r46-")));
  const shutdowns: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const s of shutdowns) {
      try { await s(); } catch { /* best effort */ }
    }
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  for (const d of [".git", ".workflow/scratch"]) fs.mkdirSync(path.join(project, d), { recursive: true });
  const ps = path.join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system");
  fs.mkdirSync(path.join(ps, "src"), { recursive: true });
  fs.writeFileSync(path.join(ps, "package.json"), JSON.stringify({ name: "@gotgenes/pi-permission-system" }));
  fs.writeFileSync(path.join(ps, "src", "index.ts"), "export default () => undefined;\n");
  const roles = ["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"];
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ providers: { fake: { review: { model: "fake/review" }, roles: Object.fromEntries(roles.map((r) => [r, { model: `fake/${r}` }])) } }, trace: { enabled: true }, radar: { openPrs: { enabled: false } }, ceremony: { launchWait: "detach", default: "heavy", ...o.ceremony } }));
  const sessionId = `r46-${++n}`;
  const sessionFile = path.join(agentDir, "sessions", "--project--", `2026_${sessionId}.jsonl`);
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "round");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "child"), `${sessionId}\n`);
  fs.writeFileSync(path.join(handoff, "parent"), "parent-session\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_SESSION_ID = sessionId;
  for (const k of ["PI_INTERCOM_STABLE_ID", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PRESSURE_FIXTURE", "HERDR_PANE_ID", "HERDR_ENV"]) delete process.env[k];
  if (o.handoff) process.env.PI_FOREMAN_HANDOFF_DIR = handoff;
  else delete process.env.PI_FOREMAN_HANDOFF_DIR;
  if (o.parent) process.env.PI_FOREMAN_PARENT_INTERCOM = "parent-session";
  else delete process.env.PI_FOREMAN_PARENT_INTERCOM;
  const planFile = path.join(project, ".workflow", "scratch", "plan-widget.md");
  fs.writeFileSync(planFile, PLAN);
  fs.writeFileSync(path.join(handoff, "plan.md"), PLAN);
  /** The fake session file: custom entries appended by the adapter. */
  const entries: Entry[] = [];
  const notes: string[] = [];
  const state = { answer: "approve" as string | undefined };

  async function clockPastWorld() {
    const newest = Math.max(...[planFile, ...fs.readdirSync(handoff).map((f) => path.join(handoff, f))].map((f) => fs.statSync(f).mtimeMs));
    while (Date.now() <= Math.ceil(newest)) await tick(1);
  }

  async function adapter(reason = "reload") {
    await clockPastWorld();
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, { execute: Fn }>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const channels = new Map<string, (d: unknown) => void>();
    const pi = {
      events: { on: (c: string, h: (d: unknown) => void) => void channels.set(c, h), emit: () => undefined },
      on: (name: string, h: Handler) => {
        const prev = handlers.get(name);
        handlers.set(name, !prev ? h : name === "tool_call" ? async (e, c) => (await prev(e, c)) ?? (await h(e, c)) : async (e, c) => { const r = await prev(e, c); const r2 = await h(e, c); return r ?? r2; });
      },
      registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(name, def),
      registerTool: (d: { name: string; execute: Fn }) => void tools.set(d.name, d),
      appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }),
      getActiveTools: () => [] as string[],
      getAllTools: () => [{ name: "bash" }, { name: "subagent" }],
      setActiveTools: () => undefined,
      setModel: async () => true,
      setThinkingLevel: () => undefined,
      sendMessage: () => undefined,
    };
    coreAdapter(pi as never, { pressureNow: () => Date.now(), pressureRun: async () => ({ ok: true, text: "" }) });
    const ctx = {
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getEntries: () => entries, getBranch: () => entries },
      cwd: project,
      model: { provider: "fake", id: "foreman" },
      mode: "tui",
      hasUI: true,
      isProjectTrusted: () => false,
      isIdle: () => true,
      // the gate reviews the foreman's own subagent launches: the review model answers allow (no review model is a dialog)
      modelRegistry: { find: (_p: string, id: string) => (id === "review" ? { id } : undefined), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: '{"verdict":"allow","entry":"read-only-inspection","reason":"stub"}' }], stopReason: "stop" }) },
      ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => state.answer, input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    };
    await handlers.get("session_start")!({ reason }, ctx);
    const down = async () => handlers.get("session_shutdown")?.({}, ctx);
    shutdowns.push(down);
    let calls = 0;
    const checkpoint = async (): Promise<{ decision: string; text: string }> => {
      const r = (await tools.get("foreman_checkpoint")!.execute("ck", { path: ".workflow/scratch/plan-widget.md" }, undefined, undefined, ctx)) as { details: { decision: string }; content: { text: string }[] };
      return { decision: r.details.decision, text: r.content[0].text };
    };
    return {
      down,
      ctx,
      checkpoint,
      tool: (name: string) => tools.get(name),
      /** The `[plan-review]` launch: a block reason, or null once started (then `end` ends the run). */
      async reviewLaunch(task = "[plan-review] review .workflow/scratch/plan-widget.md"): Promise<{ blocked: string | null; id: string }> {
        const id = `c${++calls}`;
        const input = { agent: "reviewer", task };
        await handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } }, ctx);
        const blocked = (await handlers.get("tool_call")!({ toolName: "subagent", toolCallId: id, input }, ctx)) as Block;
        if (blocked) return { blocked: blocked.reason ?? "blocked", id };
        await handlers.get("tool_result")!({ toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false }, ctx);
        return { blocked: null, id };
      },
      /** A full `[plan-review]` run ending with `verdict`; returns the block reason when the launch was refused. */
      async review(verdict: "PASS" | "FAIL"): Promise<string | null> {
        const r = await this.reviewLaunch();
        if (r.blocked) return r.blocked;
        channels.get("subagent:async-complete")!({ runId: `run-${r.id}`, agent: "reviewer", success: true, status: "completed", results: [{ agent: "reviewer", status: "completed", success: true, output: `Overall verdict: ${verdict}` }] });
        await tick();
        return null;
      },
      async launch(agent: string): Promise<Block> {
        const id = `c${++calls}`;
        const input = { agent, task: `${agent} the widget` };
        await handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } }, ctx);
        return (await handlers.get("tool_call")!({ toolName: "subagent", toolCallId: id, input }, ctx)) as Block;
      },
      /** A tool call then its result: the block reason, or the text the result gained (a read reminder). */
      async call(toolName: string, input: Record<string, unknown>): Promise<{ block: Block; note: string }> {
        const id = `k${++calls}`;
        const block = (await handlers.get("tool_call")!({ toolName, toolCallId: id, input }, ctx)) as Block;
        if (block) return { block, note: "" };
        const r = (await handlers.get("tool_result")!({ toolName, toolCallId: id, input, details: {}, content: [{ type: "text", text: "ok" }], isError: false }, ctx)) as { content?: { text: string }[] } | undefined;
        return { block: undefined, note: (r?.content ?? []).map((c) => c.text).join("\n") };
      },
      ownerPrompt: () => handlers.get("input")!({ source: "interactive", text: "next" }, ctx),
      command: (name: string, args: string) => commands.get(name)!.handler(args, ctx),
      /** A foreman write of the ledger (tool_call, file, tool_result) so the tier header is read. */
      async writeLedger(text: string): Promise<void> {
        const file = path.join(project, ".workflow", "LEDGER-x.md");
        const id = `w${++calls}`;
        const input = { path: file, content: text };
        await handlers.get("tool_call")!({ toolName: "write", toolCallId: id, input }, ctx);
        fs.writeFileSync(file, text);
        await handlers.get("tool_result")!({ toolName: "write", toolCallId: id, input, details: {}, content: [{ type: "text", text: "ok" }], isError: false }, ctx);
      },
      checkCall: async (toolName: string, input: Record<string, unknown>): Promise<Block> => (await handlers.get("tool_call")!({ toolName, toolCallId: `t${++calls}`, input }, ctx)) as Block,
    };
  }

  /** Writes a verdict file whose ctime is newer than the plan file's. */
  const rule = (name: string, text: string) => {
    const f = path.join(handoff, name);
    const planCtime = Math.max(...[planFile, path.join(handoff, "plan.md")].map((p) => fs.statSync(p).ctimeMs));
    fs.writeFileSync(f, text);
    while (fs.statSync(f).ctimeMs <= planCtime) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      fs.writeFileSync(f, text);
    }
  };
  /** The adapter's trace events so far (state dir `trace-*.jsonl`). */
  const traceEvents = async (): Promise<Record<string, unknown>[]> => {
    await tick(50);
    const dir = path.join(agentDir, "pi-foreman", "state");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith("trace-") && n.endsWith(".jsonl")) : [];
    return files.flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
  };
  const ceremonyEntries = () => entries.filter((e) => e.customType === "pi-foreman-ceremony-state");
  return { adapter, rule, traceEvents, entries, ceremonyEntries, notes, state, handoff, planFile, project, sessionFile, hash: () => planVersionHash(fs.readFileSync(planFile)) };
}

export const planRequired = (r: Block): boolean => r?.block === true && /\[launch_refused:plan_required\]/.test(r.reason ?? "");
export const planChanged = (r: Block): boolean => r?.block === true && /\[launch_refused:plan_changed\]/.test(r.reason ?? "");
