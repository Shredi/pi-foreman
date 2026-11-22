// Where the remote return path (#85) meets the PR watch flow: refusal slugs and the self-finish of a remote child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CloseFlow } from "../close.ts";
import type { CloseDeps } from "../close.ts";
import { refuseSlug } from "../session.ts";

const FILE = "/h/20261102-120000-demo/result.md";
const remoteClose = { source: "remote-parent" as const, file: FILE, shown: FILE };
const localClose = { source: "intercom-parent" as const, file: FILE, shown: FILE, replyTo: "parent-1@gamma" };

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
    mergedPr: () => 7,
  };
  const ctx = { isIdle: () => true, shutdown: () => void log.push("shutdown") };
  return { log, flow: new CloseFlow(deps), ctx };
}

async function drive(req: typeof remoteClose | typeof localClose): Promise<string[]> {
  const r = rig();
  void r.flow.request(req, r.ctx);
  r.flow.onInput(r.flow.closeText(), "extension");
  r.flow.onModelReply("stop");
  await r.flow.onSettled(r.ctx);
  return r.log;
}

test("a remote parent's close after a merge sends the closed notice over the return path, once", async () => {
  const log = await drive(remoteClose);
  assert.equal(log.filter((l) => l.startsWith("remote:")).length, 1);
  assert.ok(log.includes("remote:closed:ready"), log.join("|"));
});

test("a local child's parent close after a merge sends no remote notice and acks over intercom", async () => {
  const log = await drive(localClose);
  assert.ok(!log.some((l) => l.startsWith("remote:")), log.join("|"));
  assert.ok(log.some((l) => l.startsWith("reply:parent-1@gamma:foreman:closed ")), log.join("|"));
});

test("refuseSlug: the PR-watch and close-start refusals map to fixed non-generic slugs", () => {
  const seen: string[] = [];
  const flow = new CloseFlow({ trace: () => undefined, notify: (t: string) => void seen.push(t), reply: () => undefined, activeRuns: () => 0, activeWaits: () => [], watchedPrs: () => [7, 9], remoteReply: (_k: string, a?: string) => void seen.push(`slug:${refuseSlug(a ?? "")}`) } as unknown as CloseDeps);
  void flow.request({ source: "remote-parent", file: FILE, shown: FILE }, { isIdle: () => true, shutdown: () => undefined } as never);
  assert.ok(seen.includes("slug:pr-watched"), seen.join("|"));
  assert.equal(refuseSlug("PR #7 open and watched (wait for the merge, or pr_unwatch)"), "pr-watched");
  assert.equal(refuseSlug("the close turn failed to start: boom"), "not-started");
  assert.equal(refuseSlug("something else"), "refused");
});
