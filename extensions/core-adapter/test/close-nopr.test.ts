// A session that never opened a PR closes through the handshake: no watch, no PR needed, the stub result is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseFlow, closePrompt } from "../close.ts";
import type { CloseDeps } from "../close.ts";

test("close: a session with no PR closes via the handshake and writes the stub result", async () => {
  const log: string[] = [];
  const files = new Map<string, string>();
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: (t) => void log.push(`prompt:${t}`),
    runSync: async () => ({ text: "sync ok", ok: true }),
    retro: async () => "",
    reply: (to, t) => void log.push(`reply:${to}:${t}`),
    notify: () => undefined,
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: (f, t) => void (files.set(f, t), log.push("stub")),
    exists: (f) => files.has(f),
    setTimer: () => () => undefined,
    watchedPrs: () => [],
  };
  const ctx = { isIdle: () => true, shutdown: () => void log.push("shutdown") };
  const flow = new CloseFlow(deps);
  const file = "/x/.workflow/r.md";
  await flow.request({ source: "intercom-parent", file, replyTo: "parent-1" }, ctx, true);
  flow.onInput(closePrompt(file), "extension");
  flow.onModelReply("toolUse");
  await flow.onSettled(ctx);
  assert.ok(log.includes(`prompt:${closePrompt(file)}`));
  assert.ok(files.has(file), "stub result written");
  assert.ok(log.includes(`reply:parent-1:foreman:closed ${file}`));
  assert.equal(log[log.length - 1], "shutdown");
});
