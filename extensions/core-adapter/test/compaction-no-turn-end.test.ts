// r52: the adapter no longer requests a compaction from turn_end (it aborted running child loops);
// Pi's own auto-compaction decides. The idle warm compaction is the only ctx.compact() caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";
import { extractRetro, retroEntry } from "../retrodigest.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

for (const child of [false, true]) {
  test(`turn_end over any context size never requests a compaction (${child ? "child" : "foreman"} session)`, async (t) => {
    const keys = ["PATH", "Path", "PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-noturn-")));
    let shutdown: (() => Promise<unknown>) | undefined;
    t.after(async () => {
      try { await shutdown?.(); } catch { /* best effort */ }
      await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
      rmTestTmp(root);
    });
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    if (child) process.env.PI_SUBAGENT_CHILD = "1";
    else delete process.env.PI_SUBAGENT_CHILD;
    const handlers = new Map<string, Handler[]>();
    const pi = { on: (n: string, h: Handler) => void handlers.set(n, [...(handlers.get(n) ?? []), h]), registerCommand: () => undefined, registerTool: () => undefined, getActiveTools: () => [] as string[], setActiveTools: () => undefined, setModel: async () => true, setThinkingLevel: () => undefined, getSettings: () => ({}) };
    coreAdapter(pi as never);
    let compactCalls = 0;
    const ctx = {
      sessionManager: { getSessionId: () => "no-turn-end", getSessionFile: () => undefined, getEntries: () => [] as unknown[] },
      cwd: project,
      model: { provider: "p", id: "m", contextWindow: 200_000 },
      mode: "print",
      hasUI: false,
      isProjectTrusted: () => false,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => ({ tokens: 199_000, percent: 99.5, contextWindow: 200_000 }),
      compact: () => void compactCalls++,
      modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
      ui: { notify: () => undefined, confirm: async () => false, setStatus: () => undefined },
    };
    const fire = async (name: string, ev: unknown): Promise<void> => {
      for (const h of handlers.get(name) ?? []) await h(ev, ctx);
    };
    await fire("session_start", { reason: "startup" });
    shutdown = async () => fire("session_shutdown", {});
    await fire("turn_end", { turnIndex: 1 });
    await fire("turn_end", { turnIndex: 2 });
    assert.equal(compactCalls, 0);
  });
}

test("a summary without a Retro section yields a null retro and a readable retro entry", () => {
  const summary = "## Goal\nship it\n\n## Progress\nmost of it";
  assert.equal(extractRetro(summary), null);
  const entry = retroEntry({ when: new Date("2026-01-01T00:00:00Z"), reason: "threshold", counters: "counters: no data", retro: extractRetro(summary) });
  assert.match(entry, /\(the compaction summary has no Retro section\)/);
});
