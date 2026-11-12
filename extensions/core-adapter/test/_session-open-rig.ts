// Shared rig of the foreman_session_open dialog tests: the real tool (registerSessionOpenTool) with a fake pi, a fake
// spawner standing in for foreman_session.py, and a confirm dialog the test answers by hand.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSessionOpenTool, registryFile, SESSION_OPEN_TOOL } from "../session.ts";
import type { SessionEntry } from "../session.ts";
import type { SpawnResult } from "../spawn.ts";

export interface Dialog {
  title: string;
  message: string;
  signal: AbortSignal | undefined;
  /** Answer the dialog (what the owner's click does). */
  answer: (yes: boolean) => void;
}
export interface ToolResult {
  content: { type: string; text: string }[];
  details: { decision?: string };
  isError?: boolean;
}
export interface Woke {
  message: { customType: string; content: string; details?: unknown };
  options: Record<string, unknown>;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Resolves "returned" when `p` settles within `ms`, else "blocked". */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<"returned" | "blocked"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p.then(() => "returned" as const, () => "returned" as const), new Promise<"blocked">((r) => (timer = setTimeout(() => r("blocked"), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export function rig(o: { confirmWaitSeconds?: number; honourSignal?: boolean; spawn?: (args: string[]) => SpawnResult | Promise<SpawnResult>; isChild?: boolean; sendThrows?: boolean } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-open-dialog-")));
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(root, "b.md"), "# Title\nbody\n");
  const dialogs: Dialog[] = [];
  const spawned: string[][] = [];
  const woke: Woke[] = [];
  const tools = new Map<string, { execute: (id: string, p: Record<string, unknown>, s: AbortSignal | undefined, u: unknown, c: unknown) => Promise<ToolResult> }>();
  const pi = {
    events: undefined,
    getCommands: () => [],
    registerTool: (t: { name: string; execute: never }) => void tools.set(t.name, t),
    sendMessage: (message: Woke["message"], options: Woke["options"]) => {
      if (o.sendThrows) throw new Error("stale session");
      woke.push({ message, options });
    },
  };
  const config = o.confirmWaitSeconds === undefined ? {} : { sessions: { confirmWaitSeconds: o.confirmWaitSeconds } };
  const spawner = async (_cmd: string, args: string[]): Promise<SpawnResult> => {
    spawned.push(args);
    return o.spawn ? o.spawn(args) : { code: 0, stdout: "handoff: x", stderr: "", timedOut: false };
  };
  registerSessionOpenTool(pi as never, {
    spawner,
    pkgRoot: "/pkg",
    session: async () => ({ id: "sess-1", isChild: o.isChild ?? false, cwd: root, agentDir, python: "/usr/bin/python3", config }),
  });
  const ctx = {
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    ui: {
      confirm: (title: string, message: string, opts?: { signal?: AbortSignal }) =>
        new Promise<boolean>((resolve) => {
          const d: Dialog = { title, message, signal: opts?.signal, answer: resolve };
          dialogs.push(d);
          // a UI that honours the signal (Pi's does) dismisses the dialog: No
          if (o.honourSignal !== false) opts?.signal?.addEventListener("abort", () => resolve(false), { once: true });
        }),
    },
  };
  const tool = tools.get(SESSION_OPEN_TOOL)!;
  return {
    root,
    agentDir,
    dialogs,
    spawned,
    woke,
    call: (params: Record<string, unknown>, signal?: AbortSignal, context: unknown = ctx): Promise<ToolResult> => tool.execute("c1", { label: "demo", brief: "b.md", ...params }, signal, undefined, context),
    ctx,
    text: (r: ToolResult): string => r.content.map((c) => c.text).join("\n"),
    /** Write the registry the Python side would have written. */
    registry: (...sessions: SessionEntry[]): void => {
      fs.mkdirSync(path.dirname(registryFile(agentDir)), { recursive: true });
      fs.writeFileSync(registryFile(agentDir), JSON.stringify({ version: 1, sessions }));
    },
    cleanup: (): void => fs.rmSync(root, { recursive: true, force: true }),
  };
}
