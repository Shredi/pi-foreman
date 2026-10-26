// (l) The launch trace events and the launch result carry the resolved child model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewAllowOpts } from "./_r11rig.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import coreAdapter from "../index.ts";
import { roleModelsOf } from "../launchmodel.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

test("roleModelsOf: single, tasks, chain and parallel entries; first per role", () => {
  assert.deepEqual([...roleModelsOf({ agent: "builder", model: "p/b" })], [["builder", "p/b"]]);
  assert.deepEqual([...roleModelsOf({ chain: [{ agent: "planner", model: "p/p" }, { parallel: [{ agent: "reviewer", model: "p/r" }, { agent: "reviewer", model: "p/x" }] }] })], [["planner", "p/p"], ["reviewer", "p/r"]]);
  assert.deepEqual([...roleModelsOf({ agent: "builder" })], []);
});

test("a launch traces role_launch and role_launched with the mapped model and the result names it", async (t) => {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(mkTestTmp("pf-lmodel-"));
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    // t.after hooks run in registration order, so shutdown and the quiescence wait live in this one hook,
    // before the removal: the dir must have stopped changing before it is deleted.
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
  const roles = Object.fromEntries(["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"].map((r) => [r, { model: `fake/${r}` }]));
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
    sessionManager: { getSessionId: () => "lmodel-session", getSessionFile: () => undefined },
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
  const input: Record<string, unknown> = { agent: "explorer", task: "look" };
  await handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "subagent", arguments: input }] } }, ctx);
  assert.equal(await handlers.get("tool_call")!({ toolName: "subagent", toolCallId: "c1", input }, ctx), undefined);
  const res = (await handlers.get("tool_result")!({ toolName: "subagent", toolCallId: "c1", input, details: { runId: "run-1" }, content: [{ type: "text", text: "started" }], isError: false }, ctx)) as { content: { text: string }[] };
  assert.ok(res.content.some((c) => c.text === "pi-foreman: launched explorer on fake/explorer."), JSON.stringify(res));
  const dir = path.join(agentDir, "pi-foreman", "state");
  const f = fs.readdirSync(dir).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl"))!;
  const recs = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const ev of ["role_launch", "role_launched"]) assert.equal(recs.find((r) => r.event === ev)?.model, "fake/explorer", ev);
});
