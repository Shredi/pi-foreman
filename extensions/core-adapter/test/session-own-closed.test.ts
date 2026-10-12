import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CloseFlow, closePrompt, INTERCOM_WAKE_TEXT } from "../close.ts";
import type { CloseDeps } from "../close.ts";
import { markOwnClosed, readRegistry, registryFile } from "../session.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-own-closed-")));
const agentDir = path.join(root, "agent");
const kidHandoff = path.join(root, "handoffs", "20261012-100000-kid");
const otherHandoff = path.join(root, "handoffs", "20261012-100500-other");

function seed(): void {
  fs.mkdirSync(path.dirname(registryFile(agentDir)), { recursive: true });
  fs.writeFileSync(registryFile(agentDir), JSON.stringify({
    version: 1,
    sessions: [
      { label: "kid", child: "fm-kid-abc123", parent: "fm-top", handoff: kidHandoff, status: "open" },
      { label: "other", child: "fm-other-def456", parent: "fm-top", handoff: otherHandoff, status: "open" },
    ],
  }));
}

test("own close: the child's registry entry (matched by its handoff dir) becomes closed; the others stay", () => {
  seed();
  assert.equal(markOwnClosed(agentDir, { PI_FOREMAN_HANDOFF_DIR: kidHandoff }), true);
  const sessions = readRegistry(agentDir).sessions;
  assert.equal(sessions.find((s) => s.child === "fm-kid-abc123")?.status, "closed");
  assert.equal(sessions.find((s) => s.child === "fm-other-def456")?.status, "open");
});

test("own close: no handoff env (not a foreman child) or no matching entry changes nothing", () => {
  seed();
  const before = fs.readFileSync(registryFile(agentDir), "utf8");
  assert.equal(markOwnClosed(agentDir, {}), false);
  assert.equal(markOwnClosed(agentDir, { PI_FOREMAN_HANDOFF_DIR: path.join(root, "handoffs", "nope") }), false);
  assert.equal(fs.readFileSync(registryFile(agentDir), "utf8"), before);
  assert.equal(markOwnClosed(agentDir, { PI_FOREMAN_HANDOFF_DIR: kidHandoff }), true);
  assert.equal(markOwnClosed(agentDir, { PI_FOREMAN_HANDOFF_DIR: kidHandoff }), false, "already closed: no second write");
});

test("own close: the close flow marks the registry before the foreman:closed ack", async () => {
  const log: string[] = [];
  const deps: CloseDeps = {
    activeWaits: () => [],
    activeRuns: () => 0,
    sendUserMessage: (t) => void log.push(`prompt:${t}`),
    runSync: async () => ({ text: "sync", ok: true }),
    retro: async () => "",
    reply: (to, t) => void log.push(`reply:${to}:${t}`),
    notify: () => undefined,
    trace: () => undefined,
    markCause: () => undefined,
    writeStub: () => undefined,
    exists: () => true,
    setTimer: () => () => undefined,
    markClosed: () => void log.push("markClosed"),
  };
  const ctx = { isIdle: () => true, shutdown: () => void log.push("shutdown") };
  const flow = new CloseFlow(deps);
  const file = "/x/.workflow/r.md";
  flow.request({ source: "intercom-parent", file, replyTo: "fm-top" }, ctx, true);
  assert.equal(flow.onInput(INTERCOM_WAKE_TEXT, "extension"), true);
  flow.onInput(closePrompt(file), "extension");
  flow.onModelReply("stop");
  await flow.onSettled(ctx);
  const seq = log.filter((l) => /^(markClosed|reply|shutdown)/.test(l));
  assert.deepEqual(seq, ["markClosed", `reply:fm-top:foreman:closed ${file}`, "shutdown"]);
});
