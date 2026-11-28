// Crash restart through the real adapter (index.ts): the pane note at session_start, the restart message (one custom message, no turn, appended only),
// the timers cleared at shutdown, children writing nothing, and a resumed opened child keeping identity, plan phase and approval.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world } from "./_r46world.ts";
import { IDENTITY_ENTRY_TYPE, buildSpawnEnv, readNoteRaw, readSessionFile } from "../paneresume-core.ts";
import { posixOnly } from "./_platform.ts";
import { strRaw } from "../strof.ts";

const SLOT = Symbol.for("pi-foreman.paneresume");
type Sent = { message: { customType: string; content: string }; options: unknown }[];

/** The adapter installs process signal listeners once per process: take them out again after the test. */
function cleanupSignals(t: TestContext): void {
  t.after(() => {
    const s = (globalThis as unknown as Record<symbol, { ours: Record<string, () => void> } | undefined>)[SLOT];
    if (s) for (const [sig, fn] of Object.entries(s.ours)) process.off(sig as NodeJS.Signals, fn);
    delete (globalThis as unknown as Record<symbol, unknown>)[SLOT];
    for (const k of ["HC_TERMINAL_ID", "HC_BIN", "HC_TERMINAL_SOCKET", "PI_FOREMAN_RESUMED", "PI_BG_FEATURES"]) delete process.env[k];
  });
}

function fakeHc(root: string): string {
  const hc = path.join(root, "hc");
  fs.writeFileSync(hc, `#!/bin/sh\nprintf '{"created_ms":1000,"pid":777}'\n`, { mode: 0o755 });
  return hc;
}
const until = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("the adapter writes the pane note at session_start; a shutdown without reason quit keeps it", { skip: posixOnly }, async (t) => {
  cleanupSignals(t);
  const w = world(t);
  const agentDir = path.join(path.dirname(w.project), "agent");
  process.env.HC_BIN = fakeHc(path.dirname(w.project));
  process.env.HC_TERMINAL_ID = "t1";
  process.env.HC_TERMINAL_SOCKET = "/s/sock";
  const a = await w.adapter("startup");
  await until(() => readNoteRaw(agentDir, "t1") !== undefined);
  const note = readNoteRaw(agentDir, "t1") as Record<string, unknown>;
  assert.equal(note.terminal, "t1");
  assert.equal(note.sessionFile, path.join(agentDir, "sessions", "--project--", `2026_${strRaw(note.sessionId)}.jsonl`));
  assert.equal(note.createdMs, 1000);
  assert.equal(note.rootPid, 777);
  assert.equal(note.cwd, w.project);
  await a.down(); // the rig's shutdown carries no reason: nothing is deleted
  assert.ok(readNoteRaw(agentDir, "t1"), "no quit: the note stays");
  const live = JSON.parse(fs.readFileSync(path.join(agentDir, "pi-foreman", "state", "live", `${strRaw(note.sessionId)}.json`), "utf8"));
  assert.equal(live.hcTerminal, "t1");
  assert.equal("endedBy" in live, false, "a normal end carries no endedBy");
});

test("a subagent child (PI_SUBAGENT_CHILD=1) writes no note and keeps no signal listener of its own", { skip: posixOnly }, async (t) => {
  cleanupSignals(t);
  const w = world(t);
  const agentDir = path.join(path.dirname(w.project), "agent");
  process.env.HC_BIN = fakeHc(path.dirname(w.project));
  process.env.HC_TERMINAL_ID = "t1";
  process.env.PI_SUBAGENT_CHILD = "1";
  t.after(() => { delete process.env.PI_SUBAGENT_CHILD; });
  const before = process.listenerCount("SIGTERM");
  const a = await w.adapter("startup");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(readNoteRaw(agentDir, "t1"), undefined);
  assert.equal(process.listenerCount("SIGTERM"), before);
  await a.down();
});

test("a start with PI_FOREMAN_RESUMED: the variable leaves process.env, one message at 10 s with no turn; a shutdown inside the window sends nothing", { skip: posixOnly }, async (t) => {
  cleanupSignals(t);
  const sent: Sent = [];
  const w = world(t, { sent });
  const heartbeat = Date.UTC(2026, 10, 16, 9, 5);
  process.env.PI_FOREMAN_RESUMED = String(heartbeat);
  const x = await w.adapter("startup");
  assert.equal(process.env.PI_FOREMAN_RESUMED, undefined, "children never inherit it");
  await x.down(); // /reload or /new inside the window: both timers cleared
  process.env.PI_FOREMAN_RESUMED = String(heartbeat);
  const y = await w.adapter("startup");
  await new Promise((r) => setTimeout(r, 10_400));
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.equal(sent[0].message.customType, "pi-foreman-restart");
  assert.match(sent[0].message.content, /restarted after a crash \(last sign of life 2026-11-16 09:05 UTC\)/);
  assert.deepEqual(sent[0].options, { triggerTurn: false }, "appended, never a turn");
  assert.equal(w.entries.some((e) => /restart/.test(e.customType)), false, "no session entry of its own: the message is the only write");
  await y.down();
});

test("a resumed opened child keeps its identity, plan phase and approval; the identity entry is not appended again", { skip: posixOnly }, async (t) => {
  cleanupSignals(t);
  const w = world(t, { handoff: true });
  const agentDir = path.join(path.dirname(w.project), "agent");
  const child = fs.readFileSync(path.join(w.handoff, "child"), "utf8").trim(); // the handoff names this session as the child
  process.env.PI_INTERCOM_STABLE_ID = child;
  process.env.PI_FOREMAN_PLAN_PHASE = "1";
  process.env.PI_BG_FEATURES = "process";
  for (const f of [w.planFile, path.join(w.handoff, "plan.md")]) fs.appendFileSync(f, "\n## Decisions and assumptions\nnone\n\n## Open questions\nnone\n");
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  assert.equal((await a.checkpoint()).decision, "approve");
  await a.down();
  const identity = () => w.entries.filter((e) => e.customType === IDENTITY_ENTRY_TYPE);
  assert.equal(identity().length, 1);
  const stored = identity()[0].data as Record<string, unknown>;
  assert.equal(stored.planPhase, "1");
  assert.deepEqual(stored.bgEnv, { PI_BG_FEATURES: "process" });
  // what `foreman pane-resume` does: read the session file, build the env, start Pi with it
  fs.mkdirSync(path.dirname(w.sessionFile), { recursive: true });
  const sid = (a.ctx as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId();
  fs.writeFileSync(w.sessionFile, [{ type: "session", id: sid }, ...w.entries].map((e) => `${JSON.stringify(e)}\n`).join(""));
  const read = readSessionFile(w.sessionFile, sid, agentDir);
  const env = buildSpawnEnv({ PATH: process.env.PATH, PI_FOREMAN_HANDOFF_DIR: "/stale" }, read.identity, 1);
  for (const k of ["PI_FOREMAN_HANDOFF_DIR", "PI_INTERCOM_STABLE_ID", "PI_FOREMAN_PLAN_PHASE", "PI_BG_FEATURES"]) delete process.env[k];
  assert.equal(env.PI_FOREMAN_HANDOFF_DIR, undefined);
  assert.equal(env.PI_FOREMAN_PLAN_PHASE, "1");
  assert.equal(env.PI_BG_FEATURES, "process");
  process.env.PI_FOREMAN_PLAN_PHASE = env.PI_FOREMAN_PLAN_PHASE;
  process.env.PI_BG_FEATURES = env.PI_BG_FEATURES;
  const b = await w.adapter("startup");
  assert.equal(process.env.PI_INTERCOM_STABLE_ID, child, "the intercom id comes back through restoreIdentity");
  assert.equal(process.env.PI_FOREMAN_HANDOFF_DIR, w.handoff, "and the handoff dir");
  // the approval ended the phase, so the flag the resume put back is dropped and the identity is rewritten without planPhase (once)
  assert.equal(process.env.PI_FOREMAN_PLAN_PHASE, undefined);
  assert.equal(identity().length, 2);
  assert.equal((identity()[1].data as Record<string, unknown>).planPhase, undefined);
  assert.equal(await b.launch("builder"), undefined, "the approval survived: the plan phase is over although the env says 1");
  await b.down();
});
