// Where the remote return path (#85) meets the PR watch flow: refusal slugs and the self-finish of a remote child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseFlow, prMergedPrompt, REMOTE_PARENT_ENV } from "../close.ts";
import type { CloseDeps } from "../close.ts";
import { refuseSlug } from "../session.ts";

const FILE = "/h/20261102-120000-demo/result.md";
const merged = { source: "pr-merged" as const, file: FILE, shown: FILE, prompt: prMergedPrompt(FILE, 7), pr: { n: 7, parent: "parent-1@gamma", label: "demo" } };

function rig() {
  const log: string[] = [];
  const files = new Map<string, string>();
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: () => undefined,
    runSync: async () => ({ text: "sync ok", ok: true }),
    retro: async () => "",
    reply: (to, t) => void log.push(`reply:${to}:${t}`),
    remoteReply: (kind, arg) => void log.push(`remote:${kind}:${arg ?? ""}`),
    notify: () => undefined,
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: (f, t) => void files.set(f, t),
    exists: (f) => files.has(f),
    setTimer: () => () => undefined,
    report: async () => ({ ready: true, removed: 0, handover: [], closeLine: "CLOSE: ready" }),
    selfFinish: async () => ({ lines: ["cleanup: ok"] }),
    appendResult: () => undefined,
  };
  const ctx = { isIdle: () => true, shutdown: () => void log.push("shutdown") };
  return { log, flow: new CloseFlow(deps), ctx };
}

async function drive(remote: boolean): Promise<string[]> {
  const saved = process.env[REMOTE_PARENT_ENV];
  if (remote) process.env[REMOTE_PARENT_ENV] = "1";
  else delete process.env[REMOTE_PARENT_ENV];
  try {
    const r = rig();
    r.flow.request(merged, r.ctx);
    r.flow.onInput(prMergedPrompt(FILE, 7), "extension");
    r.flow.onModelReply("stop");
    await r.flow.onSettled(r.ctx);
    return r.log;
  } finally {
    if (saved === undefined) delete process.env[REMOTE_PARENT_ENV];
    else process.env[REMOTE_PARENT_ENV] = saved;
  }
}

test("pr-merged in a remote child sends the closed notice over the return path, once", async () => {
  const log = await drive(true);
  assert.equal(log.filter((l) => l.startsWith("remote:")).length, 1);
  assert.ok(log.includes("remote:closed:ready"), log.join("|"));
});

test("pr-merged in a local child sends no remote notice and keeps the intercom report", async () => {
  const log = await drive(false);
  assert.ok(!log.some((l) => l.startsWith("remote:")), log.join("|"));
  assert.ok(log.some((l) => l.startsWith("reply:parent-1@gamma:PR #7 merged, closing")), log.join("|"));
});

test("refuseSlug: the PR-watch and close-start refusals map to fixed non-generic slugs", () => {
  const seen: string[] = [];
  const flow = new CloseFlow({ trace: () => undefined, notify: (t: string) => void seen.push(t), reply: () => undefined, activeRuns: () => 0, activeWaits: () => [], watchedPrs: () => [7, 9], remoteReply: (_k: string, a?: string) => void seen.push(`slug:${refuseSlug(a ?? "")}`) } as unknown as CloseDeps);
  flow.request({ source: "remote-parent", file: FILE, shown: FILE }, { isIdle: () => true, shutdown: () => undefined } as never);
  assert.ok(seen.includes("slug:pr-watched"), seen.join("|"));
  assert.equal(refuseSlug("PR #7 open and watched (wait for the merge, or pr_unwatch)"), "pr-watched");
  assert.equal(refuseSlug("the close turn failed to start: boom"), "not-started");
  assert.equal(refuseSlug("something else"), "refused");
});
