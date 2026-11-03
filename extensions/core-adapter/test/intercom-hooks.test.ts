// Hook-level regression tests of the inbound-intercom detection (ledger 17): the real index.ts handlers, with
// close.ts registered inside, driven in registration order as Pi runs them, plus session.ts's legacy `input`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { readRegistry, registerSession, writeRegistry } from "../session.ts";
import { INTERCOM_WAKE_TEXT } from "../usage.ts";

const ROLES = Object.fromEntries(["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"].map((r) => [r, { model: `pa/${r}-m` }]));
const config = {
  providers: {
    pa: { roles: { ...ROLES, foreman: { model: "pa/big", idle: { model: "pb/small", thinking: "low" } } }, cache: { ttlSeconds: 300, billing: "token" }, ranks: [{ match: "big", tier: 2 }, { match: "*-m", tier: 3 }] },
    pb: { roles: ROLES, cache: { ttlSeconds: 1800, billing: "token" }, ranks: [{ match: "small", tier: 3 }, { match: "*-m", tier: 3 }] },
  },
};
const modelOf = (ctx: unknown): string => `${(ctx as { model: { provider: string; id: string } }).model.provider}/${(ctx as { model: { id: string } }).model.id}`;
const detailsOf = (text: string) => ({ from: { id: "parent-1", name: "mom" }, message: { id: "m1", content: { text } } });
const msgOf = (text: string) => ({ role: "custom", customType: "intercom_message", details: detailsOf(text) });
const start = { systemPrompt: "", systemPromptOptions: { sections: {} } };

async function rig(t: Parameters<typeof r11Rig>[0], branch: unknown[] = []) {
  const sent: string[] = [];
  const prev = process.env.PI_FOREMAN_PARENT_INTERCOM;
  process.env.PI_FOREMAN_PARENT_INTERCOM = "parent-1";
  t.after(() => void (prev === undefined ? delete process.env.PI_FOREMAN_PARENT_INTERCOM : (process.env.PI_FOREMAN_PARENT_INTERCOM = prev)));
  const notes: string[] = [];
  const r = await r11Rig(t, {}, {
    config,
    ctx: {
      model: { provider: "pa", id: "big" },
      modelRegistry: { find: (p: string, id: string) => ({ provider: p, id }), getProviderAuthStatus: () => ({ configured: true }) },
      ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined },
    },
    piExtra: { appendEntry: () => undefined, sendUserMessage: (text: string) => void sent.push(text) },
    deps: { piVersion: async () => "1.4.0" },
  });
  (r.ctx.sessionManager as { getBranch: () => unknown[] }).getBranch = () => branch;
  execFileSync("git", ["init", "-q", r.project]);
  return { ...r, notes, sent };
}

test("triggerTurn path: a foreman:close run keeps cause close and is not downshifted, also after its message_end", async (t) => {
  const r = await rig(t);
  const msg = msgOf("foreman:close .workflow/r.md");
  const out = (await r.fire("before_agent_start", { messageType: "custom", message: msg, ...start })) as { message?: { customType?: string } } | undefined;
  assert.equal(out?.message?.customType, "foreman_close", "close claimed the run");
  assert.equal(modelOf(r.ctx), "pa/big", "the close turn is not downshifted to the idle model");
  await r.fire("message_end", { message: msg });
  await r.fire("agent_start", {});
  await r.fire("agent_end", {});
  assert.deepEqual(r.events("turn").map((e) => e.cause), ["close"]);
  assert.ok(!r.notes.some((n) => n.includes("started by an intercom message")), r.notes.join("|"));
});

test("triggerTurn path: a plain intercom message is cause intercom, downshifts, and the notice names the sender", async (t) => {
  const r = await rig(t);
  const msg = msgOf("hello");
  assert.equal(await r.fire("before_agent_start", { messageType: "custom", message: msg, ...start }), undefined);
  assert.equal(modelOf(r.ctx), "pb/small", "intercom is a default downshift cause");
  await r.fire("message_end", { message: msg });
  await r.fire("agent_start", {});
  await r.fire("agent_end", {});
  assert.deepEqual(r.events("turn").map((e) => e.cause), ["intercom"]);
  assert.ok(r.notes.includes("pi-foreman: this turn was started by an intercom message from mom"), r.notes.join("|"));
});

test("legacy path: the wake line (source extension) is cause intercom with the sender from the branch", async (t) => {
  const r = await rig(t, [{ type: "custom_message", customType: "intercom_message", details: detailsOf("hello") }]);
  await r.input("extension", INTERCOM_WAKE_TEXT);
  await r.fire("agent_start", {});
  await r.fire("agent_end", {});
  assert.deepEqual(r.events("turn").map((e) => e.cause), ["intercom"]);
  assert.ok(r.notes.includes("pi-foreman: this turn was started by an intercom message from mom"), r.notes.join("|"));
});

test("legacy path: the wake text from another source is not an intercom turn", async (t) => {
  const r = await rig(t, [{ type: "custom_message", customType: "intercom_message", details: detailsOf("hello") }]);
  await r.input("interactive", INTERCOM_WAKE_TEXT);
  await r.fire("agent_end", {});
  assert.deepEqual(r.events("turn").map((e) => e.cause), ["user"]);
});

test("triggerTurn path: a foreman:close message without an id is not claimed by before_agent_start (message_end starts it once)", async (t) => {
  const r = await rig(t);
  const msg = { role: "custom", customType: "intercom_message", details: { from: { id: "parent-1", name: "mom" }, message: { content: { text: "foreman:close .workflow/r.md" } } } };
  assert.equal(await r.fire("before_agent_start", { messageType: "custom", message: msg, ...start }), undefined);
  await r.fire("message_end", { message: msg });
  assert.equal(r.events("close").filter((e) => e.decision === "refused").length, 0, "no 'already in progress' refusal");
  assert.equal(r.sent.length, 1, "the close prompt follows once");
});

test("session.ts input: the legacy wake line registers the inbound of a registry child", async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hook-session-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  delete process.env.PI_SUBAGENT_CHILD;
  const agent = path.join(root, "agent");
  writeRegistry(agent, { version: 1, sessions: [{ label: "phase1", child: "fm-phase1-abc123", status: "pending", handoff: "/h" }] });
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
  const pi = { on: (n: string, h: (e: unknown, c: unknown) => Promise<unknown>) => void handlers.set(n, h) };
  registerSession(pi as never, { spawner: async () => { throw new Error("no spawn"); }, pkgRoot: "/pkg", session: async () => ({ id: "sess-1", isChild: false, cwd: root, agentDir: agent, python: null }) });
  const notes: string[] = [];
  const entry = { type: "custom_message", customType: "intercom_message", details: { from: { id: "fm-phase1-abc123" }, message: { id: "m1", content: { text: "foreman:plan /h/plan.md" } } } };
  const ctx = { ui: { notify: (m: string) => void notes.push(m) }, sessionManager: { getBranch: () => [entry] } };
  assert.deepEqual(await handlers.get("input")!({ source: "interactive", text: INTERCOM_WAKE_TEXT }, ctx), { action: "continue" });
  assert.equal(readRegistry(agent).sessions[0].status, "pending", "a user prompt with that text is not a wake line");
  assert.deepEqual(await handlers.get("input")!({ source: "extension", text: INTERCOM_WAKE_TEXT }, ctx), { action: "continue" });
  assert.equal(readRegistry(agent).sessions[0].status, "open");
  assert.deepEqual(notes, ["pi-foreman session phase1: plan /h/plan.md"]);
});
