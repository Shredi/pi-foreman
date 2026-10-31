import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeChildren } from "../closechildren.ts";
import { backoffSeconds, cleanError, createRemotePull, periodSeconds, validLive } from "../remotepull.ts";
import type { PullDeps, PullHost } from "../remotepull.ts";
import type { SpawnResult, Spawner } from "../spawn.ts";
import { formatList, parseSessionArgs, readRegistry, runSessionCommand, writeRegistry } from "../session.ts";
import type { Registry, SessionDeps, SessionEntry } from "../session.ts";
import { sanitizeTrace } from "../trace.ts";
import { WaitRuntime } from "../wait.ts";
import type { Outcome, Timers, WaitLimits } from "../wait.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-pull-")));
const mk = (name: string): string => fs.mkdtempSync(path.join(root, `${name}-`));
const sha = (s: string): string => crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const REMOTE_DIR = "/home/u/.pi/agent/pi-foreman/handoffs/20261024-120000-demo";
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const T0 = Date.parse("2026-10-25T12:00:00Z");

function entry(agent: string, over: Partial<SessionEntry> = {}): SessionEntry {
  const mirror = path.join(agent, "mirror");
  fs.mkdirSync(mirror, { recursive: true });
  return { label: "demo", child: CHILD, parent: "sess-1", status: "open", opened: "2020-01-01T00:00:00", handoff: mirror, machine: "alpha", originMachine: "Alpha", remoteHandoff: REMOTE_DIR, handoffName: "20261024-120000-demo", mirror, remote: { platform: "linux" }, returnPath: "pull", ...over };
}
const regOf = (...s: SessionEntry[]): Registry => ({ version: 1, sessions: s });
const noteText = (kind: string, file: string, content: string): string => `${kind} from demo: ${REMOTE_DIR}/${file} sha256:${sha(content)} bytes:${Buffer.byteLength(content)}\n---\n${content}`;
const LIVE = { state: "working", heartbeatAgeSeconds: 3, lastEventAgeSeconds: 10, blockedAgeSeconds: null, workingRuns: 2, paneId: "p_1" };
const reply = (entries: unknown[], next: number, over: Record<string, unknown> = {}): string => JSON.stringify({ pulled: [{ child: CHILD, label: "demo", machine: "alpha", entries, next, more: false, live: LIVE, ...over }], errors: [] });
const ok = (stdout: string, code = 0): SpawnResult => ({ code, stdout, stderr: "", timedOut: false });

interface Rig {
  agent: string;
  clock: { t: number };
  notes: string[];
  traces: Record<string, unknown>[];
  wakes: string[][];
  calls: string[][];
  host: PullHost;
  pull: ReturnType<typeof createRemotePull>;
  script: { next: (args: string[]) => Promise<SpawnResult> | SpawnResult };
}

function rig(entries: SessionEntry[], extra: Partial<PullDeps> = {}, hostOver: Partial<PullHost> = {}, agent = mk("agent")): Rig {
  writeRegistry(agent, regOf(...entries));
  const clock = { t: T0 };
  const notes: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const wakes: string[][] = [];
  const calls: string[][] = [];
  const script: Rig["script"] = { next: () => ok(reply([], 0)) };
  const spawner: Spawner = async (_cmd, args) => {
    calls.push(args);
    return script.next(args);
  };
  const host: PullHost = { id: "sess-1", isChild: false, agentDir: agent, opener: "sess-1", python: "python3", config: undefined, notify: (t) => void notes.push(t), trace: (r) => void traces.push(r), ...hostOver };
  const pull = createRemotePull({ host: () => host, spawner, pkgRoot: "/pkg", now: () => clock.t, onNotice: (_s, label, kind, p) => void wakes.push([label, kind, p]), ...extra });
  return { agent, clock, notes, traces, wakes, calls, host, pull, script };
}
const stored = (r: Rig, i = 0): SessionEntry => readRegistry(r.agent).sessions[i];

test("pullNow applies mirror and sha256, advances the cursor, records pulledAt/remoteLive, sets ask, wakes with the mirror path", async () => {
  const dir = mk("a2");
  const e = entry(dir);
  const r2 = rig([e]);
  const ask = "# Ask 3: which db?\nbody\n";
  r2.script.next = () => ok(reply([{ seq: 1, at: "x", text: noteText("Result", "result.md", "done ✓\n") }, { seq: 2, at: "x", text: noteText("Ask", "ask.md", ask) }], 2));
  const out = await r2.pull.pullNow(CHILD);
  assert.deepEqual([out.ok, out.entries, out.skipped], [true, 2, 0]);
  assert.deepEqual(r2.calls[0].slice(-6), ["--agent-dir", r2.agent, "pull", "--json", "--", CHILD]);
  assert.equal(fs.readFileSync(path.join(dir, "mirror", "result.md"), "utf8"), "done ✓\n");
  assert.equal(fs.readFileSync(path.join(dir, "mirror", "ask.md"), "utf8"), ask);
  const got = stored(r2);
  assert.equal(got.outboxSeq, 2);
  assert.equal(got.pulledAt, new Date(T0).toISOString());
  assert.deepEqual(got.remoteLive, LIVE);
  assert.equal(got.pullError, null);
  assert.deepEqual([(got.ask as { n: number }).n, (got.ask as { topic: string }).topic], [3, "which db?"]);
  assert.equal(got.result, path.join(dir, "mirror", "result.md"));
  assert.deepEqual(r2.wakes, [["demo", "result", path.join(dir, "mirror", "result.md")], ["demo", "ask", path.join(dir, "mirror", "ask.md")]]);
});

test("a hash mismatch mirrors nothing, warns and still advances the cursor", async () => {
  const dir = mk("hash");
  const r = rig([entry(dir)]);
  r.script.next = () => ok(reply([{ seq: 1, at: "x", text: noteText("Result", "result.md", "abc").replace(sha("abc"), "0".repeat(64)) }], 1));
  const out = await r.pull.pullNow(CHILD);
  assert.equal(out.ok, true);
  assert.deepEqual(fs.readdirSync(path.join(dir, "mirror")), []);
  assert.match(r.notes.join("\n"), /hash mismatch/);
  assert.equal(stored(r).outboxSeq, 1);
  assert.deepEqual(r.wakes, []);
});

test("a truncated notice goes to .partial", async () => {
  const dir = mk("trunc");
  const r = rig([entry(dir)]);
  r.script.next = () => ok(reply([{ seq: 1, at: "x", text: `Plan from demo: ${REMOTE_DIR}/plan.md sha256:${"a".repeat(64)} bytes:900 truncated\n---\nfirst part` }], 1));
  await r.pull.pullNow(CHILD);
  assert.equal(fs.readFileSync(path.join(dir, "mirror", "plan.md.partial"), "utf8"), "first part");
  assert.equal(fs.existsSync(path.join(dir, "mirror", "plan.md")), false);
});

test("a structural violation is a failed poll with 'malformed reply' and applies nothing", async () => {
  const good = { seq: 1, at: "x", text: noteText("Result", "result.md", "r") };
  const bads: [string, string][] = [
    ["entries not an array", reply([good], 1, { entries: "no" })],
    ["next below after", reply([good], 1)],
    ["next not an integer", reply([good], 1.5)],
    ["more not a boolean", reply([good], 1, { more: "yes" })],
    ["live not an object", reply([good], 1, { live: 5 })],
    ["live state unknown", reply([good], 1, { live: { ...LIVE, state: "sleeping" } })],
    ["negative age", reply([good], 1, { live: { ...LIVE, heartbeatAgeSeconds: -1 } })],
    ["fractional age", reply([good], 1, { live: { ...LIVE, lastEventAgeSeconds: 1.5 } })],
    ["blocked age not null or int", reply([good], 1, { live: { ...LIVE, blockedAgeSeconds: "3" } })],
    ["workingRuns over 64", reply([good], 1, { live: { ...LIVE, workingRuns: 65 } })],
    ["workingRuns negative", reply([good], 1, { live: { ...LIVE, workingRuns: -1 } })],
    ["pane id with a space", reply([good], 1, { live: { ...LIVE, paneId: "a b" } })],
    ["reply not an object", "[1]"],
    ["not JSON", "oops"],
    ["no item for the child", JSON.stringify({ pulled: [], errors: [] })],
    ["over 1 MiB", reply([good], 1, { pad: "x".repeat(1024 * 1024) })],
  ];
  for (const [name, stdout] of bads) {
    const dir = mk("bad");
    const r = rig([entry(dir, { outboxSeq: 2 })]);
    r.script.next = () => ok(stdout);
    const out = await r.pull.pullNow(CHILD);
    assert.equal(out.ok, false, name);
    assert.equal(out.error, "malformed reply", name);
    assert.deepEqual(fs.readdirSync(path.join(dir, "mirror")), [], name);
    const got = stored(r);
    assert.equal(got.outboxSeq, 2, name);
    assert.equal(got.pullError, "malformed reply", name);
    assert.equal(got.pullFailures, 1, name);
    assert.equal(got.pulledAt, undefined, name);
  }
});

test("each validated live field is kept; unknown fields are dropped; null is accepted", () => {
  assert.deepEqual(validLive({ ...LIVE, blockedAgeSeconds: 7, paneId: null, extra: "x" }), { ...LIVE, blockedAgeSeconds: 7, paneId: null });
  assert.equal(validLive(null), null);
  for (const state of ["working", "blocked", "waiting", "idle", "done"]) assert.ok(validLive({ ...LIVE, state }));
  assert.equal(validLive([]), undefined);
  assert.equal(validLive({ ...LIVE, workingRuns: 64 })?.workingRuns, 64);
  assert.equal(validLive({ ...LIVE, workingRuns: 0 })?.workingRuns, 0);
});

test("a bad entry is skipped and reported; the cursor advances past it", async () => {
  const dir = mk("skip");
  const r = rig([entry(dir)]);
  const big = "x".repeat(65_537);
  r.script.next = () =>
    ok(reply([
      { seq: 1, at: "x", text: noteText("Result", "result.md", "one") },
      { seq: 1, at: "x", text: noteText("Result", "result.md", "dup") },
      { seq: "2", at: "x", text: "t" },
      { seq: 3, at: "x", text: 7 },
      { seq: 4, at: "x", text: big },
      { seq: 5, at: "x", text: "not a notice" },
      { seq: 6, at: "x", text: noteText("Update", "result.md", "six") },
    ], 6));
  const out = await r.pull.pullNow(CHILD);
  assert.deepEqual([out.ok, out.entries, out.skipped], [true, 2, 5]);
  assert.equal(fs.readFileSync(path.join(dir, "mirror", "result.md"), "utf8"), "six");
  const msgs = r.notes.filter((n) => n.startsWith("outbox entry"));
  assert.equal(msgs.length, 5);
  assert.match(msgs[0], /^outbox entry 1 of demo@alpha skipped \(.+\)$/);
  assert.match(msgs[3], /^outbox entry 4 of demo@alpha skipped \(/);
  assert.equal(stored(r).outboxSeq, 6);
  // the cursor is the highest seq seen even when the reply's next is lower
  const r2 = rig([entry(mk("skip2"))]);
  r2.script.next = () => ok(reply([{ seq: 9, at: "x", text: "nope" }], 4));
  await r2.pull.pullNow(CHILD);
  assert.equal(stored(r2).outboxSeq, 9);
});

test("pullError has control characters stripped and is cut to 200; pullFailures counts, success resets", async () => {
  const r = rig([entry(mk("err"))]);
  r.script.next = () => ok(JSON.stringify({ pulled: [], errors: [{ child: CHILD, label: "demo", machine: "alpha", error: `boom\u001b[31m\nline2${"x".repeat(300)}` }] }), 1);
  const out = await r.pull.pullNow(CHILD);
  assert.equal(out.ok, false);
  const got = stored(r);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(got.pullError as string));
  assert.equal((got.pullError as string).length, 200);
  assert.match(got.pullError as string, /^boom/);
  await r.pull.pullNow(CHILD);
  assert.equal(stored(r).pullFailures, 2);
  r.script.next = () => ok(reply([], 0));
  await r.pull.pullNow(CHILD);
  assert.equal(stored(r).pullError, null);
  assert.equal(stored(r).pullFailures, 0);
  assert.equal(cleanError("a\u0007b"), "a b");
});

test("a spawn error, a timeout and an exit with stderr and no JSON are failed polls", async () => {
  const r = rig([entry(mk("spawnerr"))]);
  r.script.next = () => ({ code: null, stdout: "", stderr: "", timedOut: true });
  assert.equal((await r.pull.pullNow(CHILD)).error, "pull timed out");
  r.script.next = () => ({ code: 2, stdout: "", stderr: "pi-foreman session: refused [not_pullable]: x\nmore", timedOut: false });
  assert.equal((await r.pull.pullNow(CHILD)).error, "pi-foreman session: refused [not_pullable]: x");
  r.script.next = () => ({ code: null, stdout: "", stderr: "", error: new Error("ENOENT"), timedOut: false });
  assert.equal((await r.pull.pullNow(CHILD)).error, "ENOENT");
  const none = rig([entry(mk("nopy"))], {}, { python: null });
  assert.match((await none.pull.pullNow(CHILD)).error ?? "", /no usable Python/);
});

test("ask: an unparsable header sets {n: 0, topic: ''}; a new ask replaces the old; a poll alone never clears it", async () => {
  const r = rig([entry(mk("ask"))]);
  r.script.next = () => ok(reply([{ seq: 1, at: "x", text: noteText("Ask", "ask.md", "# Ask 1: first\n") }], 1));
  await r.pull.pullNow(CHILD);
  assert.equal((stored(r).ask as { n: number }).n, 1);
  r.script.next = () => ok(reply([], 1));
  await r.pull.pullNow(CHILD);
  assert.equal((stored(r).ask as { n: number }).n, 1, "cleared only by a ruling deliver of the same or a later number (Python remote_brief)");
  r.script.next = () => ok(reply([{ seq: 2, at: "x", text: noteText("Ask", "ask.md", "no header here\n") }], 2));
  await r.pull.pullNow(CHILD);
  const ask = stored(r).ask as { n: number; topic: string; at: string };
  assert.deepEqual([ask.n, ask.topic], [0, ""]);
  assert.equal(ask.at, new Date(T0).toISOString());
});

test("a closed notice marks the entry closed with the mirror result; later entries of the batch are skipped", async () => {
  const dir = mk("closed");
  const r = rig([entry(dir)]);
  r.script.next = () => ok(reply([{ seq: 1, at: "x", text: noteText("Result", "result.md", "fin") }, { seq: 2, at: "x", text: "foreman:closed /remote/x/result.md CLOSE: ready" }, { seq: 3, at: "x", text: noteText("Update", "result.md", "late") }], 3, { more: true }));
  const out = await r.pull.pullNow(CHILD);
  assert.deepEqual([out.ok, out.closed, out.skipped, r.calls.length], [true, true, 1, 1]);
  const got = stored(r);
  assert.equal(got.status, "closed");
  assert.equal(got.result, path.join(dir, "mirror", "result.md"));
  assert.equal(fs.readFileSync(path.join(dir, "mirror", "result.md"), "utf8"), "fin");
  assert.deepEqual(r.wakes.map((w) => w[1]), ["result", "closed"]);
});

test("the wake reaches a foreman_wait kind child wait with the mirror path", async () => {
  const wakes: Outcome[][] = [];
  const timers: Timers = { set: () => 1, clear: () => undefined };
  const limits: WaitLimits = { batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true };
  const rt = new WaitRuntime({ timers, now: () => 0, limits: () => limits, stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => wakes.push(o), trace: () => undefined });
  const dir = mk("wait");
  const r = rig([entry(dir)], { onNotice: (_s, label, kind, p) => void rt.childNotice(label, kind, p) });
  rt.start({ kind: "child", label: "demo", note: "" });
  r.script.next = () => ok(reply([{ seq: 1, at: "x", text: noteText("Result", "result.md", "w") }], 1));
  await r.pull.pullNow(CHILD);
  assert.equal(wakes[0][0].outcome, `child demo: result ${path.join(dir, "mirror", "result.md")}`);
});

test("more: true re-polls at once, at most 5 in a row", async () => {
  const r = rig([entry(mk("more"))]);
  let n = 0;
  r.script.next = () => ok(reply([], ++n, { more: true }));
  await r.pull.pullNow(CHILD);
  assert.equal(r.calls.length, 5);
  assert.equal(stored(r).outboxSeq, 5);
  const r2 = rig([entry(mk("more2"))]);
  let k = 0;
  r2.script.next = () => ok(reply([], ++k, { more: k < 2 }));
  await r2.pull.pullNow(CHILD);
  assert.equal(r2.calls.length, 2);
});

test("periodSeconds: normal, fast by ask (ends after 30 minutes), closing, and the window after open or deliver", () => {
  const now = T0;
  const iso = (ms: number): string => new Date(now - ms).toISOString();
  const base = entry(mk("p"), { opened: iso(10 * 60_000) });
  assert.equal(periodSeconds(base, undefined, now), 20);
  assert.equal(periodSeconds({ ...base, ask: { n: 1, topic: "t", at: iso(60_000) } }, undefined, now), 5);
  assert.equal(periodSeconds({ ...base, ask: { n: 1, topic: "t", at: iso(31 * 60_000) } }, undefined, now), 20);
  assert.equal(periodSeconds({ ...base, status: "closing" }, undefined, now), 5);
  assert.equal(periodSeconds({ ...base, opened: iso(60_000) }, undefined, now), 5);
  assert.equal(periodSeconds({ ...base, opened: iso(121_000) }, undefined, now), 20);
  assert.equal(periodSeconds({ ...base, lastDeliverAt: iso(30_000) }, undefined, now), 5);
  assert.equal(periodSeconds({ ...base, lastDeliverAt: iso(130_000) }, undefined, now), 20);
  const cfg = { sessions: { pull: { intervalSeconds: 60, fastSeconds: 3 } } };
  assert.equal(periodSeconds(base, cfg, now), 60);
  assert.equal(periodSeconds({ ...base, status: "closing" }, cfg, now), 3);
  assert.equal(periodSeconds(base, { sessions: { pull: { intervalSeconds: 1 } } }, now), 20, "out of range falls back to the default");
});

test("backoffSeconds doubles per failure up to the 300 s cap", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((f) => backoffSeconds(20, f)), [40, 80, 160, 300, 300]);
  assert.equal(backoffSeconds(5, 1), 10);
});

test("tick: polls only eligible entries when due; backoff after a failure and reset after a success", async () => {
  const E = (child: string, over: Partial<SessionEntry> = {}): SessionEntry => entry(mk("t"), { child, label: child, ...over });
  const rows = [
    E("a-pull"),
    E("b-push", { returnPath: "push" }),
    E("c-missing", { returnPath: undefined }),
    E("d-closed", { status: "closed" }),
    E("e-failed", { status: "failed" }),
    E("f-other", { parent: "sess-2" }),
    E("g-local", { machine: undefined }),
    E("h-pending", { status: "pending" }),
    E("i-closing", { status: "closing" }),
  ];
  const r = rig(rows);
  const polled = (): string[] => r.calls.map((c) => c[c.length - 1]);
  r.script.next = (args) => ok(reply([], 0, { child: args[args.length - 1] }));
  await r.pull.tick();
  assert.deepEqual(polled().sort(), ["a-pull", "h-pending", "i-closing"]);
  await r.pull.tick();
  assert.equal(r.calls.length, 3, "not due yet");
  // normal period 20 s; a-pull and h-pending were opened long ago, i-closing is fast (5 s)
  r.clock.t += 6_000;
  await r.pull.tick();
  assert.deepEqual(polled().slice(3), ["i-closing"]);
  r.clock.t += 20_000;
  r.calls.length = 0;
  r.script.next = () => ({ code: 1, stdout: "", stderr: "down", timedOut: false });
  await r.pull.tick();
  assert.equal(r.calls.length, 3);
  assert.equal(readRegistry(r.agent).sessions[0].pullFailures, 1);
  r.calls.length = 0;
  r.clock.t += 21_000; // a-pull: 20 s * 2 = 40 s backoff, not due; i-closing: 5 s * 2 = 10 s, due
  r.script.next = (args) => ok(reply([], 0, { child: args[args.length - 1] }));
  await r.pull.tick();
  assert.deepEqual(polled(), ["i-closing"]);
  r.calls.length = 0;
  r.clock.t += 20_000;
  await r.pull.tick();
  assert.deepEqual(polled().sort(), ["a-pull", "h-pending", "i-closing"]);
  const a = readRegistry(r.agent).sessions[0];
  assert.equal(a.pullFailures, 0, "a success resets the failure count");
  assert.equal(a.pullError, null);
});

test("single flight: pullNow, runRemote and the loop never run two pull processes at once", async () => {
  const r = rig([entry(mk("sf"))]);
  let running = 0;
  let peak = 0;
  const gates: (() => void)[] = [];
  r.script.next = async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise<void>((res) => gates.push(res));
    running--;
    return ok(reply([], 0));
  };
  const p1 = r.pull.pullNow(CHILD);
  const p2 = r.pull.runRemote(["close-remote", "demo"]);
  const p3 = r.pull.tick();
  const p4 = r.pull.pullNow(CHILD);
  for (let i = 0; i < 20 && gates.length < 4; i++) {
    await new Promise((res) => setImmediate(res));
    gates.splice(0).forEach((g) => g());
  }
  gates.splice(0).forEach((g) => g());
  await Promise.all([p1, p2, p3, p4]);
  assert.equal(peak, 1);
  assert.deepEqual(r.calls[1].slice(-2), ["close-remote", "demo"]);
  assert.deepEqual(r.calls[1].slice(0, 4), ["-E", "-s", path.join("/pkg", "scripts", "foreman_session.py"), "--agent-dir"]);
});

test("start: a 2 s unref'd tick in a top session only; none in a child, none without a host; stop clears it", () => {
  const made: { fn: () => void; ms: number; unref: number }[] = [];
  const cleared: unknown[] = [];
  const setInterval = (fn: () => void, ms: number) => {
    const t = { fn, ms, unref: 0 };
    made.push(t);
    return { unref: () => void t.unref++ };
  };
  const top = rig([entry(mk("loop"))], { setInterval, clearInterval: (t) => void cleared.push(t) });
  top.pull.start();
  top.pull.start();
  assert.deepEqual([made.length, made[0].ms, made[0].unref], [1, 2000, 1]);
  top.pull.stop();
  assert.equal(cleared.length, 1);
  const child = rig([entry(mk("loop2"))], { setInterval }, { isChild: true });
  child.pull.start();
  assert.equal(made.length, 1);
  const gone = createRemotePull({ host: () => null, spawner: async () => ok(""), pkgRoot: "/pkg", setInterval });
  gone.start();
  assert.equal(made.length, 1);
});

test("a child session's loop never polls even when ticked", async () => {
  const r = rig([entry(mk("child-tick"))], {}, { isChild: true });
  await r.pull.tick();
  assert.equal(r.calls.length, 0);
});

test("pullNow works without the timer and traces remote_pull with the allowed keys", async () => {
  const r = rig([entry(mk("trace"))]);
  r.script.next = () => ok(reply([{ seq: 1, at: "x", text: "nope" }], 1));
  await r.pull.pullNow(CHILD);
  assert.equal(r.traces.length, 1);
  const rec = sanitizeTrace(r.traces[0]) as Record<string, unknown>;
  assert.deepEqual([rec.event, rec.machine, rec.label, rec.entries, rec.skipped], ["remote_pull", "alpha", "demo", 0, 1]);
  assert.equal(typeof rec.ms, "number");
  assert.equal("error" in rec, false);
  r.script.next = () => ok("junk");
  await r.pull.pullNow(CHILD);
  assert.equal((sanitizeTrace(r.traces[1]) as Record<string, unknown>).error, "malformed reply");
});

test("a remote_pull trace error is scrubbed like a message and cut at 120 characters", () => {
  const rec = sanitizeTrace({ event: "remote_pull", error: "ssh: /home/someone/.ssh/config line 3: bad option" }) as Record<string, unknown>;
  assert.equal(typeof rec.error, "string");
  assert.equal(String(rec.error).includes("/home/someone"), false);
  assert.match(String(rec.error), /\[path\]/);
  assert.equal(String((sanitizeTrace({ event: "remote_pull", error: "x ".repeat(200) }) as Record<string, unknown>).error).length <= 120, true);
});

function sessionDeps(agent: string, over: Partial<SessionDeps> = {}): SessionDeps {
  return { isChild: false, env: {}, agentDir: agent, cwd: root, piSessionId: "sess-1", pkgRoot: "/pkg", python: null, spawner: async () => ok(""), send: async () => "sent", ...over };
}

test("/foreman session pull [label] polls now and prints the result", async () => {
  assert.deepEqual(parseSessionArgs("pull"), { sub: "pull" });
  assert.deepEqual(parseSessionArgs("pull demo"), { sub: "pull", target: "demo" });
  assert.ok("error" in parseSessionArgs("pull a b"));
  const agent = mk("cmd");
  writeRegistry(agent, regOf(entry(agent), entry(agent, { child: "c2", label: "other", returnPath: "push" }), entry(agent, { child: "c3", label: "third", status: "closed" })));
  const polled: string[] = [];
  const d = sessionDeps(agent, { pullNow: async (c) => (polled.push(c), { ok: true, entries: 2, skipped: 1 }) });
  const one = await runSessionCommand(d, "pull demo");
  assert.deepEqual([one.ok, one.text, polled], [true, "demo@alpha: pulled 2 entries, 1 skipped", [CHILD]]);
  const all = await runSessionCommand(d, "pull");
  assert.equal(all.text, "demo@alpha: pulled 2 entries, 1 skipped");
  assert.equal((await runSessionCommand(d, "pull other")).ok, false, "a push entry is not pulled");
  assert.equal((await runSessionCommand(d, "pull third")).ok, false, "a closed entry is not pulled");
  const bad = await runSessionCommand(sessionDeps(agent, { pullNow: async () => ({ ok: false, entries: 0, skipped: 0, error: "down" }) }), "pull demo");
  assert.deepEqual([bad.ok, bad.text], [false, "demo@alpha: pull failed (down)"]);
  assert.equal((await runSessionCommand(sessionDeps(agent), "pull demo")).ok, false, "no pull module");
  const child = await runSessionCommand(sessionDeps(agent, { isChild: true }), "pull demo");
  assert.equal(child.ok, false);
});

test("session list shows the pull age and the last error", () => {
  const e = entry(mk("list"), { pulledAt: new Date(Date.now() - 12_000).toISOString(), pullError: "ssh: down\u001b[0m" });
  const push = entry(mk("list2"), { child: "c2", label: "pushy", returnPath: "push" });
  const text = formatList(regOf(e, push));
  const [line1, line2] = text.split("\n").slice(1);
  assert.match(line1, / · pull 1[2-9]s ago · pull error: ssh: down \[0m$/);
  assert.ok(!/\u001b/.test(text));
  assert.ok(!/ · pull /.test(line2));
  assert.match(formatList(regOf(entry(mk("list3")))), / · pull never$/);
});

test("closeChildren keeps its shape: with the optional runners a remote child is closed through runRemote", async () => {
  const agent = mk("cc");
  writeRegistry(agent, regOf(entry(agent)));
  const lines = await closeChildren({ agentDir: agent, opener: "sess-1", send: async () => "sent", waitMs: 0, sleep: async () => undefined, pullNow: async () => ({ ok: true, entries: 0, skipped: 0 }), runRemote: async () => ok("") });
  assert.deepEqual(lines, [`child demo@alpha (${CHILD}): timeout after 0 ms`]);
});
