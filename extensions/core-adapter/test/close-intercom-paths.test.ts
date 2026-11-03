// pi-intercom 0.18.1 on Pi 1.2+: an idle session gets foreman:close as a triggerTurn run (before_agent_start,
// then message_end, no `input`); a busy one steers it in (message_end). Both start the close once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closePrompt, CLOSE_MESSAGE_TYPE, INTERCOM_WAKE_TEXT, registerClose } from "../close.ts";

const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-close-paths-")));
fs.mkdirSync(path.join(cwd, ".workflow"));
execFileSync("git", ["init", "-q", cwd]);

type H = (e: unknown, c: unknown) => Promise<unknown>;

function rig() {
  const handlers = new Map<string, H>();
  const sent: string[] = [];
  const log: string[] = [];
  const pi = {
    on: (n: string, h: H) => void handlers.set(n, h),
    sendUserMessage: (t: string) => void sent.push(t),
    events: { emit: () => undefined, on: () => () => undefined },
  };
  registerClose(pi as never, {
    platform: process.platform,
    activeWaits: () => [],
    activeRuns: () => 0,
    session: async () => ({
      id: "s1",
      isChild: false,
      cwd,
      config: () => ({}),
      trace: (r) => void log.push(`trace:${String(r.decision)}`),
      markCause: () => void log.push("cause:close"),
      runSync: async () => ({ text: "", ok: true }),
      retro: async () => "",
    }),
  });
  let idle = true;
  const ctx = {
    hasUI: true,
    isIdle: () => idle,
    shutdown: () => undefined,
    ui: { notify: () => undefined },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
  };
  const custom = (text: string, from = "parent-1", id = "m1") => ({
    role: "custom",
    customType: "intercom_message",
    details: { from: { id: from, name: "p" }, message: { id, content: { text } } },
  });
  return { handlers, sent, log, ctx, custom, setIdle: (v: boolean) => void (idle = v) };
}

const withParent = async (fn: () => Promise<void>): Promise<void> => {
  const before = process.env.PI_FOREMAN_PARENT_INTERCOM;
  const dir = process.env.PI_FOREMAN_HANDOFF_DIR;
  const child = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_FOREMAN_PARENT_INTERCOM = "parent-1";
  delete process.env.PI_FOREMAN_HANDOFF_DIR;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env.PI_FOREMAN_PARENT_INTERCOM;
    else process.env.PI_FOREMAN_PARENT_INTERCOM = before;
    if (dir !== undefined) process.env.PI_FOREMAN_HANDOFF_DIR = dir;
    if (child !== undefined) process.env.PI_SUBAGENT_CHILD = child;
  }
};

test("close, triggerTurn path: before_agent_start makes the run the close turn, no followUp, message_end adds nothing", async () => {
  await withParent(async () => {
    const r = rig();
    const msg = r.custom("foreman:close .workflow/r.md");
    const out = (await r.handlers.get("before_agent_start")!({ messageType: "custom", message: msg }, r.ctx)) as { message: { customType: string; content: string } };
    assert.equal(out.message.customType, CLOSE_MESSAGE_TYPE);
    assert.equal(out.message.content, closePrompt(".workflow/r.md"));
    assert.deepEqual(r.sent, [], "no close prompt is sent: the triggered turn is the close turn");
    assert.ok(r.log.includes("cause:close"));
    await r.handlers.get("message_end")!({ message: msg }, r.ctx);
    assert.equal(r.log.filter((l) => l === "trace:accepted").length, 1, "message_end of the same message is not a second request");
    assert.ok(!r.log.includes("trace:refused"));
    assert.deepEqual(r.sent, []);
    // no wake line follows a triggerTurn run: nothing is left to swallow
    assert.deepEqual(await r.handlers.get("input")!({ text: INTERCOM_WAKE_TEXT, source: "extension" }, r.ctx), { action: "continue" });
  });
});

test("close, triggerTurn path: a refused close (not the parent) lets the run go on with the original message", async () => {
  await withParent(async () => {
    const r = rig();
    const out = await r.handlers.get("before_agent_start")!({ messageType: "custom", message: r.custom("foreman:close", "stranger") }, r.ctx);
    assert.equal(out, undefined);
    assert.ok(r.log.includes("trace:refused"));
    assert.deepEqual(r.sent, []);
  });
});

test("close, triggerTurn path: other messages and user runs are left alone", async () => {
  await withParent(async () => {
    const r = rig();
    assert.equal(await r.handlers.get("before_agent_start")!({ messageType: "custom", message: r.custom("hello") }, r.ctx), undefined);
    assert.equal(await r.handlers.get("before_agent_start")!({ messageType: "user", prompt: "foreman:close" }, r.ctx), undefined);
    assert.deepEqual(r.log, []);
  });
});

test("close, busy path: message_end of a steered foreman:close sends the close prompt once, after the run settles", async () => {
  await withParent(async () => {
    const r = rig();
    r.setIdle(false);
    await r.handlers.get("message_end")!({ message: r.custom("foreman:close .workflow/r.md") }, r.ctx);
    assert.deepEqual(r.sent, [], "busy: nothing sent yet");
    r.setIdle(true);
    await r.handlers.get("agent_settled")!({}, r.ctx);
    assert.deepEqual(r.sent, [closePrompt(".workflow/r.md")]);
    await r.handlers.get("agent_settled")!({}, r.ctx);
    assert.equal(r.sent.length, 1, "exactly once");
  });
});

test("close, idle message_end path: wakePending stays clear, a later wake line is not swallowed", async () => {
  await withParent(async () => {
    const r = rig();
    await r.handlers.get("message_end")!({ message: r.custom("foreman:close .workflow/r.md") }, r.ctx);
    assert.equal(r.sent.length, 1);
    assert.deepEqual(await r.handlers.get("input")!({ text: INTERCOM_WAKE_TEXT, source: "extension" }, r.ctx), { action: "continue" });
  });
});
