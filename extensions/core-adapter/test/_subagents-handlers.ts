// The handlers the installed pi-subagents registers in a main session, collected by running its extension against a pi that accepts every call.
// Pi runs them after the adapter's (the adapter loads first), so a test of a request that crosses both runs `context_with_system` in that order.
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Msg = { role: string } & Record<string, unknown>;
export type SubagentsHandler = (event: unknown, ctx: unknown) => Promise<{ messages?: Msg[] } | undefined> | { messages?: Msg[] } | undefined;

export const SUBAGENTS_PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "pi-subagents");

export async function subagentsHandlers(): Promise<Record<string, SubagentsHandler[]>> {
  const saved = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    const handlers: Record<string, SubagentsHandler[]> = {};
    const pi = new Proxy({}, {
      get(_t, name) {
        if (name === "on") return (n: string, h: SubagentsHandler) => ((handlers[n] ??= []).push(h), () => undefined);
        if (name === "events") return { on: () => () => undefined, emit: () => undefined };
        if (name === "getAllTools" || name === "getActiveTools") return () => [];
        return () => undefined;
      },
    });
    const mod = (await import(path.join(SUBAGENTS_PKG, "index.js"))) as { default: (pi: unknown) => void };
    mod.default(pi);
    return handlers;
  } finally {
    if (saved !== undefined) process.env.PI_SUBAGENT_CHILD = saved;
  }
}
