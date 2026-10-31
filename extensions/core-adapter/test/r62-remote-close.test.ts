import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeChildren } from "../closechildren.ts";
import { CloseFlow, closeFrom, closePrompt, CLOSE_SOURCES, HANDOFF_DIR_ENV, INTERCOM_INBOUND_TYPE, PARENT_INTERCOM_ENV, REMOTE_PARENT_ENV, registerClose, remoteParentClose } from "../close.ts";
import type { CloseDeps } from "../close.ts";
import { applyRemoteNotice, parseRemoteNotice } from "../remotesession.ts";
import type { Registry, SessionEntry } from "../session.ts";
import { parseSessionArgs, readRegistry, registerSessionOpenTool, runSessionCommand, runSessionOpenTool, writeRegistry } from "../session.ts";
import type { SessionDeps } from "../session.ts";
import type { SpawnResult } from "../spawn.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rclose-")));
const mk = (name: string): string => fs.mkdtempSync(path.join(root, `${name}-`));
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const PARENT = "opener-1@gamma";
const NOW = new Date("2026-10-25T12:00:00Z");
const close = (text = "foreman:close", extra: Record<string, unknown> = {}) => ({ from: { id: "ephemeral-9", name: "cli" }, message: { content: { text }, ...extra } });
const iso = (d: Date): string => d.toISOString();

function handoff(order: Record<string, unknown> | null): string {
  const dir = mk("handoff");
  if (order) fs.writeFileSync(path.join(dir, "close.json"), `${JSON.stringify(order)}\n`);
  return dir;
}
const env = { [PARENT_INTERCOM_ENV]: PARENT };

test("remoteParentClose: a fresh matching close.json accepts, is consumed once, and the sender is not the authority", () => {
  const dir = handoff({ v: 1, parent: PARENT, at: iso(NOW) });
  assert.deepEqual(remoteParentClose(close(), env, dir, NOW), { kind: "close", path: undefined, sender: "ephemeral-9" });
  assert.ok(!fs.existsSync(path.join(dir, "close.json")));
  assert.ok(fs.existsSync(path.join(dir, "close.json.seen")));
  const again = remoteParentClose(close(), env, dir, NOW);
  assert.equal(again?.kind, "refused");
});

test("remoteParentClose: ordinary text is null; missing file, parent mismatch and stale at are refused and the file stays", () => {
  const dir = handoff({ v: 1, parent: PARENT, at: iso(NOW) });
  assert.equal(remoteParentClose(close("hello"), env, dir, NOW), null);
  assert.ok(fs.existsSync(path.join(dir, "close.json")));
  assert.equal(remoteParentClose(close(), env, handoff(null), NOW)?.kind, "refused");
  const other = handoff({ v: 1, parent: "someone@gamma", at: iso(NOW) });
  assert.match((remoteParentClose(close(), env, other, NOW) as { reason: string }).reason, /does not name the parent/);
  assert.equal(remoteParentClose(close(), {}, handoff({ v: 1, parent: PARENT, at: iso(NOW) }), NOW)?.kind, "refused");
  const stale = handoff({ v: 1, parent: PARENT, at: iso(new Date(NOW.getTime() - 16 * 60_000)) });
  assert.match((remoteParentClose(close(), env, stale, NOW) as { reason: string }).reason, /stale/);
  assert.ok(fs.existsSync(path.join(stale, "close.json")));
  const edge = handoff({ v: 1, parent: PARENT, at: iso(new Date(NOW.getTime() - 14 * 60_000)) });
  assert.equal(remoteParentClose(close(), env, edge, NOW)?.kind, "close");
  const bad = handoff(null);
  fs.writeFileSync(path.join(bad, "close.json"), "not json");
  assert.equal(remoteParentClose(close(), env, bad, NOW)?.kind, "refused");
});

test("remoteParentClose: the result path comes from the file only; a path in the message and a bad path in the file are ignored or refused", () => {
  const dir = handoff({ v: 1, parent: PARENT, path: ".workflow/mine.md", at: iso(NOW) });
  assert.deepEqual(remoteParentClose(close("foreman:close .workflow/attacker.md"), env, dir, NOW), { kind: "close", path: ".workflow/mine.md", sender: "ephemeral-9" });
  const none = handoff({ v: 1, parent: PARENT, at: iso(NOW) });
  assert.equal((remoteParentClose(close("foreman:close .workflow/attacker.md"), env, none, NOW) as { path?: string }).path, undefined);
  for (const p of ["a b.md", "x.txt", "x;y.md", 5]) {
    const d = handoff({ v: 1, parent: PARENT, path: p, at: iso(NOW) });
    assert.equal(remoteParentClose(close(), env, d, NOW)?.kind, "refused", String(p));
    assert.ok(fs.existsSync(path.join(d, "close.json")));
  }
});

test("remoteParentClose: a cross-machine message is refused even with a valid order", () => {
  const dir = handoff({ v: 1, parent: PARENT, at: iso(NOW) });
  const r = remoteParentClose(close("foreman:close", { crossMachine: { origin: "x" } }), env, dir, NOW);
  assert.equal(r?.kind, "refused");
  assert.match((r as { reason: string }).reason, /cross-machine/);
  assert.ok(fs.existsSync(path.join(dir, "close.json")));
});

test("close.from: remote-parent is a known source, in the default list, and excludable", () => {
  assert.ok((CLOSE_SOURCES as readonly string[]).includes("remote-parent"));
  assert.ok(closeFrom({}).has("remote-parent"));
  assert.ok(!closeFrom({ close: { from: ["herdr", "intercom-parent"] } }).has("remote-parent"));
  const defaults = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "config", "foreman.defaults.json"), "utf8")) as { close: { from: string[] } };
  assert.deepEqual(defaults.close.from, ["herdr", "intercom-parent", "remote-parent"]);
});

function flowRig(waits = 0) {
  const log: string[] = [];
  const files = new Map<string, string>();
  const deps: CloseDeps = {
    activeWaits: () => (waits ? [{ id: "w1", kind: "timer", note: "" }] : []),
    activeRuns: () => 0,
    sendUserMessage: (t) => void log.push(`prompt:${t}`),
    runSync: async () => ({ text: "pi-foreman sync", ok: true }),
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
  };
  const ctx = { isIdle: () => true, shutdown: () => void log.push("shutdown") };
  return { log, flow: new CloseFlow(deps), ctx };
}

test("replies: a remote-parent close answers through the notice command, never reply(); a refusal carries the raw reason", async () => {
  const r = flowRig();
  const file = "/x/.workflow/r.md";
  r.flow.request({ source: "remote-parent", file }, r.ctx);
  r.flow.onInput(closePrompt(file), "extension");
  r.flow.onModelReply("stop");
  await r.flow.onSettled(r.ctx);
  assert.deepEqual(r.log.filter((l) => /^(remote|reply|shutdown)/.test(l)), ["remote:closed:ready", "shutdown"]);
  const busy = flowRig(1);
  busy.flow.request({ source: "remote-parent", file }, busy.ctx);
  assert.deepEqual(busy.log.filter((l) => /^(remote|reply)/.test(l)), [expect("1 foreman_wait pending (w1 timer); cancel or let them finish, then close again")]);
  busy.flow.refuse("because", "remote-parent");
  assert.ok(busy.log.includes("remote:refused:because"));
  assert.ok(!busy.log.some((l) => l.startsWith("reply:")));
  const local = flowRig();
  local.flow.refuse("because", "intercom-parent", "parent-1");
  assert.ok(local.log.some((l) => l.startsWith("reply:parent-1:")));
  assert.ok(!local.log.some((l) => l.startsWith("remote:")));
});
const expect = (reason: string): string => `remote:refused:${reason}`;

test("registerClose: with PI_FOREMAN_REMOTE_PARENT=1 and remote-parent excluded, a close text is refused through the notice and close.json is untouched", async () => {
  const dir = handoff({ v: 1, parent: PARENT, at: iso(new Date()) });
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
  const pi = { on: (n: string, h: (e: unknown, c: unknown) => Promise<unknown>) => void handlers.set(n, h), sendUserMessage: () => undefined, events: undefined };
  const replies: string[] = [];
  const session = async () => ({ id: "s1", isChild: false, cwd: root, config: () => ({ close: { from: ["herdr", "intercom-parent"] } }), trace: () => undefined, markCause: () => undefined, runSync: async () => ({ text: "", ok: true }), retro: async () => "", remoteReply: (k: string, a?: string) => void replies.push(`${k}:${a ?? ""}`) });
  registerClose(pi as never, { platform: process.platform, activeWaits: () => [], activeRuns: () => 0, session: session as never });
  const ctx = { sessionManager: { getSessionId: () => "s1", getBranch: () => [] }, ui: { notify: () => undefined }, hasUI: true };
  const saved = { r: process.env[REMOTE_PARENT_ENV], h: process.env[HANDOFF_DIR_ENV], p: process.env[PARENT_INTERCOM_ENV], c: process.env.PI_SUBAGENT_CHILD };
  process.env[REMOTE_PARENT_ENV] = "1";
  process.env[HANDOFF_DIR_ENV] = dir;
  process.env[PARENT_INTERCOM_ENV] = PARENT;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    await handlers.get("message_end")!({ message: { role: "custom", customType: INTERCOM_INBOUND_TYPE, details: close() } }, ctx);
    assert.deepEqual(replies, ["refused:close.from does not include remote-parent"]);
    assert.ok(fs.existsSync(path.join(dir, "close.json")));
    // same close.from refusal again: remote-parent is still excluded, so no order is written and the notice is refused
    fs.unlinkSync(path.join(dir, "close.json"));
    replies.length = 0;
    await handlers.get("message_end")!({ message: { role: "custom", customType: INTERCOM_INBOUND_TYPE, details: close() } }, ctx);
    assert.equal(replies.length, 1);
  } finally {
    for (const [k, v] of [[REMOTE_PARENT_ENV, saved.r], [HANDOFF_DIR_ENV, saved.h], [PARENT_INTERCOM_ENV, saved.p], ["PI_SUBAGENT_CHILD", saved.c]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("foreman:refused: parsed, applied (closing back to open, one clean line cut to 200), signatures kept", () => {
  assert.deepEqual(parseRemoteNotice("foreman:refused 1 foreman_wait pending"), { kind: "refused", reason: "1 foreman_wait pending" });
  assert.deepEqual(parseRemoteNotice("[Unverified cross-machine origin]\nforeman:refused no"), { kind: "refused", reason: "no" });
  assert.equal(parseRemoteNotice("foreman:refused x\nmore"), null);
  const dir = mk("refused");
  const e: SessionEntry = { label: "demo", child: CHILD, parent: "sess-1", status: "closing", machine: "alpha", originMachine: "Alpha", mirror: dir, handoff: dir };
  const reg: Registry = { version: 1, sessions: [e] };
  const long = `why\u001b[0m ${"x".repeat(300)}`;
  const hit = applyRemoteNotice(reg, { machine: "alpha", sessionId: CHILD }, { kind: "refused", reason: long }, undefined, NOW);
  assert.ok(hit?.changed);
  assert.equal(hit?.kind, "refused");
  assert.equal(e.status, "open");
  assert.equal(e.last?.kind, "refused");
  assert.equal(e.last?.path?.length, 200);
  assert.ok(!/[\u0000-\u001f]/.test(e.last?.path ?? ""));
  const open: SessionEntry = { ...e, status: "open", last: null };
  applyRemoteNotice({ version: 1, sessions: [open] }, { machine: "alpha", sessionId: CHILD }, { kind: "refused", reason: "r" }, undefined, NOW);
  assert.equal(open.status, "open");
});

// ------------------------------------------------------------------ closeChildren and session close with a runner

function remoteEntry(agent: string, over: Partial<SessionEntry> = {}): SessionEntry {
  return { label: "demo", child: CHILD, parent: "sess-1", status: "open", opened: NOW.toISOString(), handoff: path.join(agent, "m"), machine: "alpha", originMachine: "Alpha", returnPath: "pull", ...over };
}
const spawnOk = (stdout = "{}", code = 0, stderr = ""): SpawnResult => ({ code, stdout, stderr, timedOut: false });

function ccRig(agent: string, runRemote: (a: string[]) => Promise<SpawnResult>, waitMs: number, onPull?: () => void) {
  const slept: number[] = [];
  const pulls: string[] = [];
  const lines = () =>
    closeChildren({
      agentDir: agent, opener: "sess-1", send: async () => "sent", waitMs, runRemote,
      sleep: async (ms) => void slept.push(ms),
      pullNow: async (c) => (pulls.push(c), onPull?.(), { ok: true, entries: 0, skipped: 0 }),
    });
  return { slept, pulls, lines };
}

test("closeChildren: the remote child is closed through runRemote, pulled every 5 s while waiting, and reported closed", async () => {
  const agent = mk("cc-closed");
  writeRegistry(agent, { version: 1, sessions: [remoteEntry(agent)] });
  const calls: string[][] = [];
  const r = ccRig(agent, async (a) => {
    calls.push(a);
    const reg = readRegistry(agent);
    reg.sessions[0].status = "closing";
    writeRegistry(agent, reg);
    return spawnOk();
  }, 30_000, () => {
    if (r.pulls.length === 2) {
      const reg = readRegistry(agent);
      reg.sessions[0].status = "closed";
      writeRegistry(agent, reg);
    }
  });
  const out = await r.lines();
  assert.deepEqual(calls, [["close-remote", CHILD]]);
  assert.deepEqual(out, [`child demo@alpha (${CHILD}): closed`]);
  assert.equal(r.pulls.length, 2);
  assert.equal(r.slept.reduce((a, b) => a + b, 0), 10_000);
});

test("closeChildren: a refused notice, a timeout and a failed send are reported per child", async () => {
  const refusedAgent = mk("cc-refused");
  writeRegistry(refusedAgent, { version: 1, sessions: [remoteEntry(refusedAgent)] });
  const r1 = ccRig(refusedAgent, async () => {
    const reg = readRegistry(refusedAgent);
    reg.sessions[0].status = "closing";
    writeRegistry(refusedAgent, reg);
    return spawnOk();
  }, 30_000, () => {
    const reg = readRegistry(refusedAgent);
    applyRemoteNotice(reg, { machine: "alpha", sessionId: CHILD }, { kind: "refused", reason: "1 child run(s) still active" });
    writeRegistry(refusedAgent, reg);
  });
  assert.deepEqual(await r1.lines(), [`child demo@alpha (${CHILD}): refused (1 child run(s) still active)`]);
  assert.equal(readRegistry(refusedAgent).sessions[0].status, "open");

  const slowAgent = mk("cc-timeout");
  writeRegistry(slowAgent, { version: 1, sessions: [remoteEntry(slowAgent)] });
  const r2 = ccRig(slowAgent, async () => spawnOk(), 6_000);
  assert.deepEqual(await r2.lines(), [`child demo@alpha (${CHILD}): timeout after 6000 ms`]);

  const failAgent = mk("cc-fail");
  writeRegistry(failAgent, { version: 1, sessions: [remoteEntry(failAgent)] });
  const r3 = ccRig(failAgent, async () => spawnOk("", 1, "pi-foreman session: refused [not_open]: demo is closed, not open"), 6_000);
  assert.deepEqual(await r3.lines(), [`child demo@alpha (${CHILD}): not sent (not_open)`]);
  assert.equal(r3.pulls.length, 0);
});

test("closeChildren: without a runner the remote entry is reported and untouched; local children still close", async () => {
  const agent = mk("cc-none");
  const local: SessionEntry = { label: "loc", child: "fm-loc", parent: "sess-1", status: "open" };
  writeRegistry(agent, { version: 1, sessions: [remoteEntry(agent), local] });
  const sent: string[] = [];
  const out = await closeChildren({ agentDir: agent, opener: "sess-1", send: async (to) => (sent.push(to), "sent"), waitMs: 0, sleep: async () => undefined });
  assert.deepEqual(out, ["demo@alpha: not closed (no remote runner)", "child loc (fm-loc): timeout after 0 ms"]);
  assert.deepEqual(sent, ["fm-loc"]);
  assert.equal(readRegistry(agent).sessions[0].status, "open");
});

function sessionDeps(agent: string, over: Partial<SessionDeps> = {}): SessionDeps {
  return { isChild: false, env: {}, agentDir: agent, cwd: root, piSessionId: "sess-1", pkgRoot: "/pkg", python: "/usr/bin/python3", spawner: async () => spawnOk(), send: async () => "sent", ...over };
}

test("/foreman session close <label> [path]: a remote entry goes through runRemote close-remote with --path; failures show stderr", async () => {
  const agent = mk("sc");
  writeRegistry(agent, { version: 1, sessions: [remoteEntry(agent)] });
  const calls: string[][] = [];
  const sent: string[] = [];
  const d = sessionDeps(agent, { send: async (to) => (sent.push(to), "sent"), runRemote: async (a) => (calls.push(a), spawnOk()) });
  const ok = await runSessionCommand(d, "close demo .workflow/r.md");
  assert.equal(ok.ok, true);
  assert.deepEqual(calls[0], ["close-remote", CHILD, "--path", ".workflow/r.md"]);
  assert.deepEqual(sent, []);
  await runSessionCommand(d, "close demo");
  assert.deepEqual(calls[1], ["close-remote", CHILD]);
  const bad = await runSessionCommand(sessionDeps(agent, { runRemote: async () => spawnOk("", 1, "pi-foreman session: refused [not_open]: nope") }), "close demo");
  assert.equal(bad.ok, false);
  assert.match(bad.text, /\[not_open\]/);
  const bare = await runSessionCommand(sessionDeps(agent), "close demo");
  assert.deepEqual([bare.ok, bare.text], [false, "demo@alpha: not closed (no remote runner)"]);
});

// ------------------------------------------------------------------ tool parameters and forwarding

test("foreman_session_open: machine and trust reach the argv, a remote open needs cwd, planMode skips the /plan check", async () => {
  const spawned: string[][] = [];
  const d = sessionDeps(mk("tool"), { commands: [], spawner: async (_c, a) => (spawned.push(a), spawnOk("opened")) });
  const noCwd = await runSessionOpenTool(d, { label: "demo", brief: "b.md", machine: "alpha" });
  assert.equal(noCwd.ok, false);
  assert.match(noCwd.text, /needs --cwd/);
  assert.equal(spawned.length, 0);
  const r = await runSessionOpenTool(d, { label: "demo", brief: "b.md", machine: "alpha", trust: true, cwd: "C:\\work", planMode: true, firstCommand: ["/x"], focus: true });
  assert.equal(r.ok, true);
  const argv = spawned[0];
  assert.equal(argv[argv.indexOf("--machine") + 1], "alpha");
  assert.equal(argv[argv.indexOf("--cwd") + 1], "C:\\work");
  assert.ok(argv.includes("--trust") && argv.includes("--plan-mode") && argv.includes("--focus"));
  assert.equal(argv[argv.indexOf("--first-command") + 1], "/x");
  const local = await runSessionOpenTool(d, { label: "demo", brief: "b.md", planMode: true });
  assert.equal(local.ok, false);
  assert.match(local.text, /plan_mode_unavailable/);
  const plain = await runSessionOpenTool(d, { label: "demo", brief: "b.md", machine: "alpha", cwd: "/p" });
  assert.ok(plain.ok);
  assert.ok(!spawned[1].includes("--trust") && !spawned[1].includes("--plan-mode") && !spawned[1].includes("--first-command") && !spawned[1].includes("--focus"));
});

test("foreman_session_open tool schema lists machine and trust", () => {
  let params: { properties: Record<string, { type: string; description: string }>; additionalProperties: boolean } | undefined;
  registerSessionOpenTool({ registerTool: (t: { parameters: typeof params }) => void (params = t.parameters), getCommands: () => [] } as never, { session: async () => { throw new Error("unused"); }, spawner: async () => spawnOk(), pkgRoot: "/pkg" });
  assert.equal(params?.properties.machine.type, "string");
  assert.equal(params?.properties.trust.type, "boolean");
  assert.match(params?.properties.planMode.description ?? "", /local open/);
  assert.equal(params?.additionalProperties, false);
  assert.ok("error" in parseSessionArgs("open demo b.md --print-all"));
});

