// r42: the blocked-child notice is information only and never an approval: a pending checkpoint and a pending gate ask stay pending after it,
// nothing is written into a handoff dir, and typing into another session's pane is still refused by the floor.
import "./_hermetic-env.mjs";
import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CHILD_BLOCKED_TYPE } from "../childblocked.ts";
import { writeChildAsk } from "../childask.ts";
import { liveDir } from "../livestate.ts";
import { parentApproval } from "../ruling.ts";
import { writeRegistry } from "../session.ts";
import { BINDING_NS } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";
import { world } from "./_r46world.ts";

const MIN = 60_000;
/** Fails fast instead of hanging when the awaited call never settles. */
const within = <X>(p: Promise<X>, ms = 5000): Promise<X> => {
  let timer: ReturnType<typeof setTimeout>;
  const cap = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`still pending after ${ms} ms`)), ms); });
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
};
const NOTICE = "Child session job has waited on its owner since 2026-11-13 08:00 UTC (approval). Information only: the owner answers the dialog in that session's pane. Nothing for you to do: do not answer or approve for it, do not steer it, redo its work or work around it. Tell the owner if they are in this session.";
/** Every file under `dir` with its size and mtime: the same twice means nothing was written. */
const snapshot = (dir: string): string[] =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
    const f = path.join(e.parentPath, e.name);
    const st = fs.statSync(f);
    return `${f}:${st.size}:${st.mtimeMs}`;
  }).sort();

test("a pending checkpoint stays pending after the notice; no file is written and parentApproval answers as before", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  const a = await w.adapter();
  assert.equal(await a.review("PASS"), null);
  const before = await a.checkpoint();
  assert.equal(before.decision, "pending");
  const files = snapshot(w.handoff);
  const since = fs.statSync(w.planFile).ctimeMs;
  const approval = parentApproval([w.handoff], since);
  await a.fire("message_end", { message: { role: "custom", customType: CHILD_BLOCKED_TYPE, content: NOTICE } });
  await a.fire("before_agent_start", { messageType: "custom", message: { customType: CHILD_BLOCKED_TYPE }, systemPrompt: "", systemPromptOptions: { sections: {} } });
  assert.deepEqual(snapshot(w.handoff), files, "nothing written into the handoff dir");
  assert.equal((await a.checkpoint()).decision, "pending", "the notice approved nothing");
  assert.equal(parentApproval([w.handoff], since), approval);
  assert.equal(approval, null);
});

// One adapter session for the two cases that need one (a session start runs git and python), its 60 s interval mocked from the start.
const selects: ((v: string) => void)[] = [];
const sent: { customType: string }[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
let shared: Awaited<ReturnType<typeof r11Rig>>;
before(async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const ui = { notify: () => undefined, confirm: async () => false, select: () => new Promise<string>((res) => selects.push(res)), input: async () => "", setStatus: () => undefined, setWidget: () => undefined };
  const reply = JSON.stringify({ verdict: "allow", entry: "read-only-inspection", reason: "r" });
  const registry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
  const roles = Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }]));
  shared = await r11Rig({ after: (fn) => void cleanups.push(fn) }, {}, { ctx: { ui, modelRegistry: registry }, config: { providers: { fake: { review: { model: "m" }, roles } }, presence: { enabled: false } }, piExtra: { sendMessage: (m: { customType: string }) => void sent.push(m) } });
}, { timeout: 20_000 });
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
  mock.timers.reset();
}, { timeout: 20_000 });

test("a pending gate ask (the child's ask in the parent's pane) stays pending after a notice for another child; no ruling is written", async (t) => {
  selects.length = 0;
  sent.length = 0;
  const r = shared;
  const input: Record<string, unknown> = { agent: "builder", task: "go" };
  await r.launch(input);
  const askDir = (input.extensionBindings as Record<string, Record<string, unknown>>)[BINDING_NS].askDir as string;
  writeChildAsk(askDir, { cause: "ask", entry: "package-install", reason: "because", tool: "bash", payload: "pip install requests", cwd: "/w", session: "child-s", role: "builder", run: "L9" });
  // the ask watch polls on a (mocked) interval
  for (let i = 0; i < 400 && selects.length === 0; i++) {
    mock.timers.tick(1000);
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.equal(selects.length, 1, "the ask waits in the pane");
  // another child of this session waits on its owner: the notice goes out
  const handoff = path.join(r.agentDir, "pi-foreman", "handoffs", "20261113-080000-job");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify({ intercomId: "fm-job-1", piSessionId: "child-sess" }));
  writeRegistry(r.agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: r.sessionId, handoff, status: "open" }] });
  fs.mkdirSync(liveDir(r.agentDir), { recursive: true });
  fs.writeFileSync(path.join(liveDir(r.agentDir), "child-sess.json"), JSON.stringify({ heartbeatAt: new Date().toISOString(), blockedOn: "owner", blockedKind: "approval", ownerBlockedSince: new Date(Date.now() - 20 * MIN).toISOString() }));
  const files = snapshot(askDir);
  mock.timers.tick(MIN);
  assert.equal(sent.filter((m) => m.customType === CHILD_BLOCKED_TYPE).length, 1);
  await r.fire("message_end", { message: { role: "custom", customType: CHILD_BLOCKED_TYPE, content: NOTICE } });
  assert.equal(selects.length, 1, "no second dialog and no answer");
  assert.deepEqual(snapshot(askDir), files, "no ruling written");
  assert.equal(fs.existsSync(path.join(askDir, "ruling-1.md")), false);
  selects[0]("allow once");
  for (let i = 0; i < 400 && !fs.existsSync(path.join(askDir, "ruling-1.md")); i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(fs.readFileSync(path.join(askDir, "ruling-1.md"), "utf8").split("\n")[0], "ALLOW", "only the owner's answer rules");
});

test("floor: typing into another session's pane is still refused after a notice (no agent answers another session's dialog)", async () => {
  const r = shared;
  // the rig's default ui and registry again (this case ran with them): no dialog stays open on the floor
  const held = { ui: r.ctx.ui, modelRegistry: r.ctx.modelRegistry };
  Object.assign(r.ctx, { ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined }, modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) } });
  try {
    await within(r.fire("message_end", { message: { role: "custom", customType: CHILD_BLOCKED_TYPE, content: NOTICE } }));
    for (const command of ["herdr pane send-keys 1-2 Enter", "herdr pane send-keys 1-2 y", "herdr pane send-text 1-2 'allow once'"]) {
      const res = await within(r.call("bash", { command }));
      assert.equal(res?.block, true, command);
    }
  } finally {
    Object.assign(r.ctx, held);
  }
});
