// Shared rig of the R11 P2 fixtures (r11-review-cap, r11-read-budget): the real adapter hooks (index.ts) with a fake
// pi, a temp agent dir, and handoff dirs under `<agentDir>/pi-foreman/handoffs` keyed by this session's intercom id.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
export type Block = { block?: boolean; reason?: string } | undefined;

let rigs = 0;

/** `opts.ctx`: fields that replace the fake ctx's (ui, modelRegistry, ...); `opts.config`: top-level keys merged into the user foreman.json. */
export async function r11Rig(t: { after(fn: () => void | Promise<void>): void }, ceremony: Record<string, unknown> = {}, opts: { ctx?: Record<string, unknown>; config?: Record<string, unknown>; child?: boolean } = {}) {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PRESSURE_FIXTURE", "PI_INTERCOM_SESSION_ID", "PI_INTERCOM_STABLE_ID", "HERDR_PANE_ID", "HERDR_ENV"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r11-p2-")));
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
  const sessionId = `r11-p2-${++rigs}`;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_SESSION_ID = sessionId;
  delete process.env.PI_INTERCOM_STABLE_ID;
  if (opts.child) process.env.PI_SUBAGENT_CHILD = "1";
  else delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_FOREMAN_PRESSURE_FIXTURE;
  delete process.env.HERDR_PANE_ID; // the presence file would name the runner's pane
  delete process.env.HERDR_ENV;
  const roles = ["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"];
  const l2 = {
    providers: { fake: { roles: Object.fromEntries(roles.map((r) => [r, { model: `fake/${r}` }])) } },
    trace: { enabled: true },
    ceremony: { launchWait: "detach", ...ceremony },
    ...opts.config,
  };
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify(l2));
  const handlers = new Map<string, Handler>();
  const inputHandlers: Handler[] = [];
  const channels = new Map<string, (d: unknown) => void>();
  const pi = {
    events: { on: (n: string, h: (d: unknown) => void) => void channels.set(n, h), emit: () => undefined },
    on: (n: string, h: Handler) => {
      if (n === "input") inputHandlers.push(h);
      const prev = handlers.get(n);
      // tool_call: the first block wins; any other event runs every handler (the first result is kept)
      handlers.set(n, !prev ? h : n === "tool_call" ? async (e, c) => (await prev(e, c)) ?? (await h(e, c)) : async (e, c) => { const r = await prev(e, c); const r2 = await h(e, c); return r ?? r2; });
    },
    registerCommand: () => undefined,
    registerTool: () => undefined,
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }, { name: "subagent" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never, { pressureNow: () => Date.now(), pressureRun: async () => ({ ok: true, text: "" }) });
  const ctx = {
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined },
    ...opts.ctx,
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const trace = (): Record<string, unknown>[] => {
    const dir = path.join(agentDir, "pi-foreman", "state");
    const f = fs.readdirSync(dir).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl"));
    return f ? fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  const handoffs = path.join(agentDir, "pi-foreman", "handoffs");
  let calls = 0;
  return {
    ctx,
    agentDir,
    project,
    sessionId,
    trace,
    events: (name: string) => trace().filter((r) => r.event === name),
    /**
     * A handoff dir: `side` "child" = this session is the opened (child) side, its parent rules there;
     * "parent" = this session opened it, its own child session writes there. The dir gets an ask.md.
     */
    handoff(name: string, side: "child" | "parent"): string {
      const dir = path.join(handoffs, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, side), `${sessionId}\n`);
      fs.writeFileSync(path.join(dir, side === "child" ? "parent" : "child"), "other-session\n");
      fs.writeFileSync(path.join(dir, "ask.md"), "ask\n");
      return dir;
    },
    /** A launch through message_end + tool_call; returns the tool_call result (a block, or undefined). */
    async launch(input: Record<string, unknown>): Promise<{ id: string; res: Block }> {
      const id = `c${++calls}`;
      await handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } }, ctx);
      return { id, res: (await handlers.get("tool_call")!({ toolName: "subagent", toolCallId: id, input }, ctx)) as Block };
    },
    started: (id: string, input: Record<string, unknown>, runId: string) => handlers.get("tool_result")!({ toolName: "subagent", toolCallId: id, input, details: { runId }, content: [{ type: "text", text: "started" }], isError: false }, ctx),
    /** A launch's tool_result that is an error with no run started. */
    errored: (id: string, input: Record<string, unknown>) => handlers.get("tool_result")!({ toolName: "subagent", toolCallId: id, input, details: {}, content: [{ type: "text", text: "launch failed" }], isError: true }, ctx),
    end: (data: Record<string, unknown>) => channels.get("subagent:async-complete")!(data),
    /** One foreman tool call (tool_call only); returns its block or undefined. */
    async call(toolName: string, input: Record<string, unknown>): Promise<Block> {
      return (await handlers.get("tool_call")!({ toolName, toolCallId: `t${++calls}`, input }, ctx)) as Block;
    },
    /** One foreman tool call whose effect `during` runs between its tool_call and its tool_result. */
    async toolDoing(toolName: string, input: Record<string, unknown>, during: () => void | Promise<void>): Promise<Block> {
      const id = `t${++calls}`;
      const res = (await handlers.get("tool_call")!({ toolName, toolCallId: id, input }, ctx)) as Block;
      await during();
      await handlers.get("tool_result")!({ toolName, toolCallId: id, input, details: {}, content: [{ type: "text", text: "ok" }], isError: false }, ctx);
      return res;
    },
    /** The tool_result of a foreman write that went through (marks a self-written ruling). */
    wrote: (file: string) => handlers.get("tool_result")!({ toolName: "write", toolCallId: `w${++calls}`, input: { path: file }, content: [{ type: "text", text: "ok" }], isError: false }, ctx),
    /** A custom `subagent-notify` message (a child completion notice) as the foreman receives it. */
    notice: (text: string) => handlers.get("message_end")!({ message: { role: "custom", customType: "subagent-notify", content: text } }, ctx),
    /** An event-bus message (`pi.events.on` channel) such as `permissions:ui_prompt`. */
    channel: (name: string, data: unknown) => channels.get(name)?.(data),
    /** turn_start: the foreman's calls that never got a tool_result (`call` is a tool_call only) are no longer in flight. */
    turnStart: () => handlers.get("turn_start")!({}, ctx),
    /** session_start again (a reload): the round-state file is restored. */
    restart: () => handlers.get("session_start")!({ reason: "reload" }, ctx),
    /** An input event of any source. */
    input: (source: string, text: string) => handlers.get("input")!({ source, text }, ctx),
    ownerPrompt: (text = "next") => handlers.get("input")!({ source: "interactive", text }, ctx),
    /** An input event run as pi runs it: every handler in order, the first `handled` ends it; otherwise `continue`. */
    async inputRun(source: string, text: string): Promise<unknown> {
      for (const h of inputHandlers) {
        const res = (await h({ source, text }, ctx)) as { action?: string } | undefined;
        if (res?.action === "handled") return res;
      }
      return { action: "continue" };
    },
  };
}

/** Write `file` with `text` and set its mtime to `at` (ms epoch). */
export function writeAt(file: string, text: string, at: number): void {
  fs.writeFileSync(file, text);
  fs.utimesSync(file, at / 1000, at / 1000);
}

/** R41: the gate's outcome of the trace records of one tool call: `allowed:<rule>`, `blocked:<rule>`, `dialog:<cause>:<answer>`, or `pass` (no gate record). */
export function gateOutcome(recs: Record<string, unknown>[]): string {
  const g = recs.filter((x) => x.event === "guard" && x.guard === "gate");
  const last = g[g.length - 1];
  const dlg = recs.find((x) => x.event === "dialog" && x.guard === "gate");
  if (dlg && !(last && last.decision === "allowed")) return `dialog:${dlg.cause}:${dlg.decision}`;
  return last ? `${last.decision}:${last.rule}` : "pass";
}

/** R41: r11Rig options whose gate review always allows (policy entry read-only-inspection), for rigs whose bash calls have no default allow. */
export function reviewAllowOpts(): { ctx: Record<string, unknown>; config: Record<string, unknown> } {
  return {
    ctx: {
      modelRegistry: {
        find: () => ({ id: "m" }),
        getProviderAuthStatus: () => ({ configured: false }),
        complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ verdict: "allow", entry: "read-only-inspection", reason: "stub" }) }], stopReason: "stop", usage: { input: 1, output: 1 } }),
      },
    },
    config: { providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"].map((r) => [r, { model: `fake/${r}` }])) } } },
  };
}
