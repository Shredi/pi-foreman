// Shared rig of the R11 P2 fixtures (r11-review-cap, r11-read-budget): the real adapter hooks (index.ts) with a fake
// pi, a temp agent dir, and handoff dirs under `<agentDir>/pi-foreman/handoffs` keyed by this session's intercom id.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { rmTestTmp } from "./_tmpbase.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
export type Block = { block?: boolean; reason?: string } | undefined;

let rigs = 0;

export async function r11Rig(t: { after(fn: () => void | Promise<void>): void }, ceremony: Record<string, unknown> = {}) {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_PRESSURE_FIXTURE", "PI_INTERCOM_SESSION_ID", "PI_INTERCOM_STABLE_ID"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r11-p2-")));
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    try { await shutdown?.(); } catch { /* best effort */ }
    await new Promise((r) => setTimeout(r, 300));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const ps = path.join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system");
  fs.mkdirSync(path.join(ps, "src"), { recursive: true });
  fs.writeFileSync(path.join(ps, "package.json"), JSON.stringify({ name: "@gotgenes/pi-permission-system" }));
  fs.writeFileSync(path.join(ps, "src", "index.ts"), "export default () => undefined;\n");
  const sessionId = `r11-p2-${++rigs}`;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_SESSION_ID = sessionId;
  delete process.env.PI_INTERCOM_STABLE_ID;
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_FOREMAN_PRESSURE_FIXTURE;
  const roles = ["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"];
  const l2 = {
    providers: { fake: { roles: Object.fromEntries(roles.map((r) => [r, { model: `fake/${r}` }])) } },
    trace: { enabled: true },
    ceremony: { launchWait: "detach", ...ceremony },
  };
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify(l2));
  const handlers = new Map<string, Handler>();
  const channels = new Map<string, (d: unknown) => void>();
  const pi = {
    events: { on: (n: string, h: (d: unknown) => void) => void channels.set(n, h), emit: () => undefined },
    on: (n: string, h: Handler) => {
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
    ownerPrompt: (text = "next") => handlers.get("input")!({ source: "interactive", text }, ctx),
  };
}

/** Write `file` with `text` and set its mtime to `at` (ms epoch). */
export function writeAt(file: string, text: string, at: number): void {
  fs.writeFileSync(file, text);
  fs.utimesSync(file, at / 1000, at / 1000);
}
