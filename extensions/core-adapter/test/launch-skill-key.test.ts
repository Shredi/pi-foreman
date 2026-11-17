// The per-launch `skill` key of subagent (docs/roles.md, roles.<id>.skills): a launch carrying it is not refused, and the adapter forwards it unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewAllowOpts } from "./_r11rig.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const cases: [string, unknown][] = [
  ["explorer", "prompting-guides"],
  ["explorer", ["prompting-guides", "skill-authoring"]],
  ["builder", "prompting-guides"],
  ["builder", ["prompting-guides", "skill-authoring"]],
];

for (const [agent, skill] of cases) {
  test(`launch: ${agent} with skill ${JSON.stringify(skill)} is not refused and the key reaches the forwarded call unchanged`, async (t) => {
    const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const root = fs.realpathSync(mkTestTmp("pf-launch-skill-"));
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
    delete process.env.PI_SUBAGENT_CHILD;
    const roles = Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }]));
    fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ providers: { fake: { review: { model: "m" }, roles } }, trace: { enabled: true }, ceremony: { launchWait: "detach" } }));
    const handlers = new Map<string, Handler>();
    const pi = {
      events: { on: () => undefined, emit: () => undefined },
      on: (n: string, h: Handler) => {
        const prev = handlers.get(n);
        handlers.set(n, prev ? async (e, c) => (await prev(e, c)) ?? (await h(e, c)) : h);
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
    // no host pressure sampling: a loaded CI runner must not defer the launch (a missing pressure file reads as ok)
    coreAdapter(pi as never, { pressureRun: async () => ({ ok: true, text: "" }) });
    const ctx = {
      sessionManager: { getSessionId: () => "launch-skill-session", getSessionFile: () => undefined },
      cwd: project,
      model: { provider: "fake", id: "foreman" },
      mode: "tui",
      hasUI: true,
      isProjectTrusted: () => false,
      isIdle: () => true,
      modelRegistry: reviewAllowOpts().ctx.modelRegistry,
      ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined },
    };
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
    const input: Record<string, unknown> = { agent, task: "look", skill };
    await handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "subagent", arguments: input }] } }, ctx);
    assert.equal(await handlers.get("tool_call")!({ toolName: "subagent", toolCallId: "c1", input }, ctx), undefined, "not blocked");
    assert.deepEqual(input.skill, skill);
  });
}
