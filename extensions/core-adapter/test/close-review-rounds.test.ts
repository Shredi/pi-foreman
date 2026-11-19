// The close appends the review-round lines to the result after the `## Close` section (CloseDeps.reviewRounds); best effort.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloseFlow, closePrompt } from "../close.ts";
import type { CloseDeps } from "../close.ts";
import { sessionFileOf } from "../findings.ts";
import { closeLines } from "../reviewrounds.ts";

async function closeWith(extra: Partial<CloseDeps>, report = true): Promise<{ log: string[]; shutdown: boolean }> {
  const log: string[] = [];
  const files = new Map<string, string>();
  let shutdown = false;
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: () => undefined,
    runSync: async () => ({ text: "sync ok", ok: true }),
    retro: async () => "",
    reply: (to, t) => void log.push(`reply:${to}:${t}`),
    notify: () => undefined,
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: (f, t) => void files.set(f, t),
    exists: (f) => files.has(f),
    setTimer: () => () => undefined,
    watchedPrs: () => [],
    appendResult: (_f, text) => void log.push(`append:${text}`),
    ...(report ? { report: async () => (log.push("report"), { ready: true, removed: 0, handover: [], closeLine: "CLOSE: ready" }) } : {}),
    ...extra,
  };
  const ctx = { isIdle: () => true, shutdown: () => void (shutdown = true) };
  const flow = new CloseFlow(deps);
  const file = "/x/.workflow/r.md";
  await flow.request({ source: "intercom-parent", file, replyTo: "parent-1" }, ctx, true);
  flow.onInput(closePrompt(file), "extension");
  flow.onModelReply("toolUse");
  await flow.onSettled(ctx);
  return { log, shutdown };
}

test("close appends the review-round lines after the report", async () => {
  const { log, shutdown } = await closeWith({ reviewRounds: () => ["Review rounds: 4 (2 fail, 2 pass; 1 high-stakes), plan reviews 2, PR #301"] });
  assert.deepEqual(log.slice(0, 2), ["report", "append:\nReview rounds: 4 (2 fail, 2 pass; 1 high-stakes), plan reviews 2, PR #301\n"]);
  assert.equal(shutdown, true);
});

test("close appends one line per branch", async () => {
  const { log } = await closeWith({ reviewRounds: () => ["a: Review rounds: 1 (0 fail, 1 pass)", "b: Review rounds: 2 (1 fail, 1 pass)"] });
  assert.ok(log.includes("append:\na: Review rounds: 1 (0 fail, 1 pass)\nb: Review rounds: 2 (1 fail, 1 pass)\n"));
});

test("close appends nothing when the session has no counted review", async () => {
  const { log } = await closeWith({ reviewRounds: () => [] });
  assert.equal(log.filter((l) => l.startsWith("append:")).length, 0);
  const none = await closeWith({});
  assert.equal(none.log.filter((l) => l.startsWith("append:")).length, 0);
});

test("close survives a rounds reader or a result write that throws", async () => {
  const a = await closeWith({ reviewRounds: () => { throw new Error("store unreadable"); } });
  assert.equal(a.shutdown, true);
  assert.ok(a.log.some((l) => l.startsWith("reply:parent-1:foreman:closed")));
  const b = await closeWith({ reviewRounds: () => ["Review rounds: 1 (0 fail, 1 pass)"], appendResult: () => { throw new Error("read-only"); } });
  assert.equal(b.shutdown, true);
});

test("close survives an unreadable findings store (a directory where a file belongs)", async () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "closerounds-"));
  try {
    const file = sessionFileOf(agent, "s1");
    fs.mkdirSync(file, { recursive: true });
    assert.deepEqual(closeLines(agent, "s1"), []);
    const { shutdown } = await closeWith({ reviewRounds: () => closeLines(agent, "s1") });
    assert.equal(shutdown, true);
  } finally {
    fs.rmSync(agent, { recursive: true, force: true });
  }
});
