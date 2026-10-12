import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CloseFlow, closePrompt, INTERCOM_WAKE_TEXT } from "../close.ts";
import type { CloseDeps } from "../close.ts";
import { closeChildren } from "../closechildren.ts";
import { applyInbound, parseInbound, readRegistry, registryFile, writeRegistry } from "../session.ts";

function fresh(sessions: Record<string, unknown>[]): string {
  const agentDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-close-children-")));
  fs.mkdirSync(path.dirname(registryFile(agentDir)), { recursive: true });
  fs.writeFileSync(registryFile(agentDir), JSON.stringify({ version: 1, sessions }));
  return agentDir;
}

const entry = (label: string, status: string, parent = "fm-top") => ({ label, child: `fm-${label}-abc123`, parent, status, handoff: `/h/${label}` });

function rig(agentDir: string, send: (to: string, text: string) => Promise<string>, waitMs = 5_000, onSleep?: (total: number) => void) {
  const slept: number[] = [];
  const run = () => closeChildren({
    agentDir, opener: "fm-top", send, waitMs,
    sleep: async (ms) => {
      slept.push(ms);
      onSleep?.(slept.reduce((a, b) => a + b, 0));
    },
  });
  return { slept, run };
}

const statusOf = (agentDir: string, label: string) => readRegistry(agentDir).sessions.find((s) => s.label === label)?.status;

test("close children: open/pending children of this opener get foreman:close and are marked closing; others are left alone", async () => {
  const agentDir = fresh([entry("a", "open"), entry("b", "pending"), entry("c", "closed"), entry("d", "open", "fm-other")]);
  const sent: string[] = [];
  const r = rig(agentDir, async (to, text) => (sent.push(`${to}:${text}`), "sent"), 0);
  const lines = await r.run();
  assert.deepEqual(sent, ["fm-a-abc123:foreman:close", "fm-b-abc123:foreman:close"]);
  assert.equal(statusOf(agentDir, "a"), "closing");
  assert.equal(statusOf(agentDir, "c"), "closed");
  assert.equal(statusOf(agentDir, "d"), "open");
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.includes("timeout")), "waitMs 0: sent but not yet closed");
});

test("close children: the registry is polled until each child is closed", async () => {
  const agentDir = fresh([entry("a", "open"), entry("b", "open")]);
  const r = rig(agentDir, async () => "sent", 10_000, (total) => {
    const reg = readRegistry(agentDir);
    for (const s of reg.sessions) if (s.label === "a" || total >= 2_000) s.status = "closed";
    writeRegistry(agentDir, reg);
  });
  const lines = await r.run();
  assert.deepEqual(r.slept, [1_000, 1_000]);
  assert.deepEqual(lines, ["child a (fm-a-abc123): closed", "child b (fm-b-abc123): closed"]);
});

test("close children: a child that never closes is reported as timeout after the bounded wait", async () => {
  const agentDir = fresh([entry("a", "open")]);
  const r = rig(agentDir, async () => "sent", 2_500);
  const lines = await r.run();
  assert.deepEqual(r.slept, [1_000, 1_000, 500]);
  assert.deepEqual(lines, ["child a (fm-a-abc123): timeout after 2500 ms"]);
  assert.equal(statusOf(agentDir, "a"), "closing");
});

test("close children: a failed send is `not sent` and the child stays open; the others are still closed", async () => {
  const agentDir = fresh([entry("a", "open"), entry("b", "open")]);
  const r = rig(agentDir, async (to) => (to.includes("-a-") ? "failed" : "sent"), 0);
  const lines = await r.run();
  assert.equal(lines[0], "child a (fm-a-abc123): not sent (failed)");
  assert.ok(lines[1].startsWith("child b "));
  assert.equal(statusOf(agentDir, "a"), "open");
  assert.equal(statusOf(agentDir, "b"), "closing");
});

test("close children: a refusal from the child is reported as refused and ends its wait", async () => {
  const agentDir = fresh([entry("a", "open")]);
  const r = rig(agentDir, async () => "sent", 10_000, () => {
    const reg = readRegistry(agentDir);
    const msg = parseInbound("pi-foreman: close refused: 1 child run(s) still active");
    assert.ok(msg);
    applyInbound(reg, "fm-a-abc123", msg, new Date());
    writeRegistry(agentDir, reg);
  });
  const lines = await r.run();
  assert.deepEqual(r.slept, [1_000]);
  assert.deepEqual(lines, ["child a (fm-a-abc123): refused (1 child run(s) still active)"]);
  assert.equal(statusOf(agentDir, "a"), "open");
});

test("close children: no children, a throwing send or a missing registry never throw", async () => {
  const empty = fresh([]);
  assert.deepEqual(await rig(empty, async () => "sent").run(), []);
  const agentDir = fresh([entry("a", "open")]);
  const lines = await rig(agentDir, async () => { throw new Error("boom"); }, 0).run();
  assert.deepEqual(lines, ["child a (fm-a-abc123): not sent (failed)"]);
  const none = path.join(os.tmpdir(), "pf-close-children-missing");
  assert.deepEqual(await rig(none, async () => "sent").run(), []);
});

function flowRig(closeChildrenDep?: () => Promise<string[]>) {
  const log: string[] = [];
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: () => undefined,
    runSync: async () => (log.push("runSync"), { text: "sync", ok: true }),
    retro: async () => "",
    reply: () => undefined,
    notify: (t) => void log.push(`notify:${t}`),
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: () => undefined,
    exists: () => true,
    setTimer: () => () => undefined,
    ...(closeChildrenDep ? { closeChildren: async () => (log.push("closeChildren"), closeChildrenDep()) } : {}),
  };
  const ctx = { isIdle: () => true, shutdown: () => void log.push("shutdown") };
  const flow = new CloseFlow(deps);
  const file = "/x/.workflow/r.md";
  const settle = async () => {
    flow.request({ source: "herdr", file }, ctx);
    flow.onInput(INTERCOM_WAKE_TEXT, "extension");
    flow.onInput(closePrompt(file), "extension");
    flow.onModelReply("stop");
    await flow.onSettled(ctx);
  };
  return { log, settle };
}

test("close flow: children are closed after the result turn and before the sync; each is in the notice", async () => {
  const r = flowRig(async () => ["child a (fm-a-abc123): closed", "child b (fm-b-abc123): timeout after 60000 ms"]);
  await r.settle();
  assert.ok(r.log.indexOf("closeChildren") >= 0 && r.log.indexOf("closeChildren") < r.log.indexOf("runSync"));
  const note = r.log.find((l) => l.startsWith("notify:pi-foreman: close:"));
  assert.ok(note?.includes("child a (fm-a-abc123): closed") && note.includes("child b (fm-b-abc123): timeout"));
  assert.equal(r.log.at(-1), "shutdown");
});

test("close flow: a throwing closeChildren never fails the close", async () => {
  const r = flowRig(async () => { throw new Error("registry gone"); });
  await r.settle();
  assert.ok(r.log.includes("runSync"));
  assert.ok(r.log.some((l) => l.includes("registry gone")));
  assert.equal(r.log.at(-1), "shutdown");
});

test("close flow: without the dep the close is as before", async () => {
  const r = flowRig();
  await r.settle();
  assert.ok(!r.log.includes("closeChildren"));
  assert.equal(r.log.at(-1), "shutdown");
});
