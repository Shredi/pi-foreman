// R46 item 1: `session brief` / `session close` resolve the target by a Pi session id found in a registry entry's handoff
// live.json, and retry once with that live.json's intercom id when the send reports a missing target. The events here have
// the shape pi-intercom really emits (settleOutboxRequest: status blocked|failed, code target_not_found|delivery_failed, detail).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { INTERCOM_OUTBOX_EVENT, INTERCOM_OUTBOX_RESULT_EVENT, outboxSendDetailed } from "../close.ts";
import { readRegistry, registerSession, writeRegistry } from "../session.ts";

const savedChild = process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_CHILD;
after(() => {
  if (savedChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = savedChild;
});

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r46-idsess-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

const STALE = "fm-demo-abc123";
const LIVE = "fm-demo-restarted";
const PI_ID = "019e-pi-session";

type Result = { status: string; code?: string; detail?: string };

/** A registry entry whose handoff names `live.json`; `answer` decides the outbox result per target. */
function world(answer: (to: string) => Result, live: Record<string, unknown> | null = { intercomId: LIVE, piSessionId: PI_ID, at: "2026-01-01T00:00:00Z" }) {
  const agent = path.join(root, `agent-${++n}`);
  const handoff = path.join(agent, "pi-foreman", "handoffs", "demo-abc123");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "child"), `${STALE}\n`);
  if (live) fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify(live));
  writeRegistry(agent, { version: 1, sessions: [{ label: "demo", child: STALE, status: "open", handoff }] });
  const sent: { to: string; message: string }[] = [];
  const listeners = new Map<string, (d: unknown) => void>();
  const events = {
    emit: (ch: string, data: Record<string, unknown>) => {
      if (ch !== INTERCOM_OUTBOX_EVENT) return;
      sent.push({ to: String(data.to), message: String(data.message) });
      const r = answer(String(data.to));
      listeners.get(INTERCOM_OUTBOX_RESULT_EVENT)?.({ version: 1, requestId: data.requestId, extensionId: "pi-foreman", extensionName: "pi-foreman", ...r });
    },
    on: (ch: string, h: (d: unknown) => void) => (listeners.set(ch, h), () => listeners.delete(ch)),
  };
  const s = registerSession({ on: () => undefined, events } as never, { spawner: async () => { throw new Error("no spawn"); }, pkgRoot: "/pkg", session: async () => ({ id: "sess-1", isChild: false, cwd: root, agentDir: agent, python: null }) });
  const notes: string[] = [];
  const run = (args: string) => s.command(args, { ui: { notify: (t: string) => void notes.push(t) } } as never);
  return { run, sent, notes, agent, handoff };
}

const sentOk = (to: string): Result => (to === LIVE ? { status: "sent" } : { status: "blocked", code: "target_not_found", detail: `Session "${to}" is not currently connected.` });

test("outboxSendDetailed returns status, code and detail from the real result shape; outboxSend still returns the status", async () => {
  const listeners = new Map<string, (d: unknown) => void>();
  const events = {
    emit: (ch: string, d: Record<string, unknown>) => ch === INTERCOM_OUTBOX_EVENT && listeners.get(INTERCOM_OUTBOX_RESULT_EVENT)?.({ version: 1, requestId: d.requestId, status: "blocked", code: "target_not_found", detail: "gone" }),
    on: (ch: string, h: (d: unknown) => void) => (listeners.set(ch, h), () => listeners.delete(ch)),
  };
  assert.deepEqual(await outboxSendDetailed(events, "x", "m", "t"), { status: "blocked", code: "target_not_found", detail: "gone" });
  const { outboxSend } = await import("../close.ts");
  assert.equal(await outboxSend(events, "x", "m", "t"), "blocked");
});

test("brief retries once via live.json on target_not_found (status blocked)", async () => {
  const w = world(sentOk);
  await w.run("brief demo hello there");
  assert.deepEqual(w.sent.map((s) => s.to), [STALE, LIVE]);
  assert.match(w.notes[0], new RegExp(`brief sent to ${LIVE}`));
  assert.equal(w.sent[0].message, w.sent[1].message);
});

test("brief retries once via live.json on delivery_failed with a not-found/not-connected detail", async () => {
  for (const detail of ["Session not found", "Target is not connected"]) {
    const w = world((to) => (to === LIVE ? { status: "sent" } : { status: "failed", code: "delivery_failed", detail }));
    await w.run("brief demo hello there");
    assert.deepEqual(w.sent.map((s) => s.to), [STALE, LIVE], detail);
  }
});

test("close retries via live.json too, and still marks the registry entry closing", async () => {
  const w = world(sentOk);
  await w.run("close demo");
  assert.deepEqual(w.sent.map((s) => s.to), [STALE, LIVE]);
  assert.equal(readRegistry(w.agent).sessions[0].status, "closing");
});

test("no retry when the first send succeeds, when live.json names the same id, when it is missing, or for other failures", async () => {
  const ok = world(() => ({ status: "sent" }));
  await ok.run("brief demo hi");
  assert.equal(ok.sent.length, 1);
  const same = world(() => ({ status: "blocked", code: "target_not_found", detail: "x" }), { intercomId: STALE, piSessionId: PI_ID, at: "t" });
  await same.run("brief demo hi");
  assert.equal(same.sent.length, 1);
  const none = world(() => ({ status: "blocked", code: "target_not_found", detail: "x" }), null);
  await none.run("brief demo hi");
  assert.equal(none.sent.length, 1);
  assert.match(none.notes[0], /not sent/);
  for (const r of [{ status: "failed", code: "session_unavailable", detail: "Intercom not connected" }, { status: "failed", code: "delivery_failed", detail: "Queue full" }, { status: "blocked", code: "target_ambiguous", detail: "many" }]) {
    const w = world(() => r);
    await w.run("brief demo hi");
    assert.equal(w.sent.length, 1, JSON.stringify(r));
  }
});

test("a failing retry is reported, and only one retry is made", async () => {
  const w = world(() => ({ status: "blocked", code: "target_not_found", detail: "x" }));
  await w.run("brief demo hi");
  assert.equal(w.sent.length, 2);
  assert.match(w.notes[0], /not sent/);
});

test("brief resolves by a Pi session id found in the handoff's live.json", async () => {
  const w = world(sentOk);
  await w.run(`brief ${PI_ID} hello`);
  assert.deepEqual(w.sent.map((s) => s.to), [STALE, LIVE], "the registry child first, then the live id");
  assert.ok(fs.readdirSync(w.handoff).some((f) => /^brief-1\.md$/.test(f)), "the brief is written to the registry entry's handoff dir");
  const closing = world(sentOk);
  await closing.run(`close ${PI_ID}`);
  assert.equal(closing.sent[0].to, STALE);
});

test("an unknown id, or a live.json elsewhere, is never a retry target", async () => {
  const w = world(sentOk);
  fs.mkdirSync(path.join(w.agent, "elsewhere"), { recursive: true });
  fs.writeFileSync(path.join(w.agent, "elsewhere", "live.json"), JSON.stringify({ intercomId: "fm-evil", piSessionId: "other-pi", at: "t" }));
  await w.run("brief other-pi hello");
  assert.deepEqual(w.sent, [], "refused: no handoff dir to write it to");
  assert.match(w.notes[0], /refused/);
});
