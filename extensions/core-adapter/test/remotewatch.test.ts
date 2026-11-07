import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyEvent, applyGet, commit, fail, fetchTimeoutMs, mapHcState, parseEvents, parseNoticeLabel, pollPlan, RemoteWatcher, remotePath, runHc, watchState } from "../remotewatch.ts";
import type { HcResult, HcRun, WatchState } from "../remotewatch.ts";
import { readRegistry, writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";
import { WaitRuntime } from "../wait.ts";
import type { Outcome } from "../wait.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rwatch-")));
const sha = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const HANDOFF = "/home/u/.pi/handoff/20261103-120000-demo";

function entry(over: Record<string, unknown> = {}, dir = root): SessionEntry {
  return {
    label: "demo", child: CHILD, parent: "p", handoff: path.join(dir, "mirror"), status: "open", machine: "alpha", originMachine: "alpha",
    remoteHandoff: HANDOFF, mirror: path.join(dir, "mirror"), remote: { platform: "linux" }, backend: "hc", hc: { address: "alpha/t7", space: null, tab: null }, briefs: 0, lastError: null, last: null,
    ...over,
  } as SessionEntry;
}
const label = (seq: number, kind: string, body: Buffer | string): string => `${seq}:${kind}:${sha(body)}:${Buffer.byteLength(body as string)}`;
// the real `hc events --json` lines (see the comment block of remotewatch.ts)
const rpc = (type: string, terminal: string, data: unknown) => ({ jsonrpc: "2.0", method: "event", params: { type, terminal, seq: 1, data } });
const lab = (labels: Record<string, string>, terminal = "alpha/t7") => rpc("labels", terminal, { labels });
const ev = (value: string, terminal = "alpha/t7") => lab({ "herdr.tab": "x", "fm.notice": value }, terminal);
const stat = (state: string, terminal = "alpha/t7") => rpc("status", terminal, { status: { app: "pi", state } });
const gotten = (state: string, labels: Record<string, string> = {}) => ({ address: "alpha/t7", labels, state: "live", status: { app: "pi", state } });

function rig(entries: SessionEntry[] = [entry()]) {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  writeRegistry(dir, { version: 1, sessions: entries.map((e) => ({ ...e, mirror: path.join(dir, "m", String(e.child)), handoff: path.join(dir, "m", String(e.child)) })) });
  const files = new Map<string, Buffer[]>(); // remote path -> successive reads
  const calls: string[][] = [];
  const hcGet: { reply: unknown; code: number } = { reply: gotten("working"), code: 0 };
  const signals: (AbortSignal | undefined)[] = [];
  const hc: HcRun = async (args, _t, signal) => {
    calls.push(args);
    signals.push(signal);
    const res = (over: Partial<HcResult>): HcResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, overflow: false, ...over });
    if (args[0] === "get") return res({ code: hcGet.code, stdout: Buffer.from(JSON.stringify(hcGet.reply)), stderr: hcGet.code ? JSON.stringify({ error: { hint: "see `hc ls --all`", kind: "not_found", message: "no terminal" } }) : "" });
    const q = files.get(args[4]);
    if (!q || !q.length) return res({ code: 4, stderr: "no such file\u0007: x" });
    return res({ stdout: q.length > 1 ? (q.shift() as Buffer) : q[0] });
  };
  const streams = new Map<string, { onLine: (l: string) => void; onEnd: () => void; killed: boolean }>();
  const opened: string[] = [];
  const extras: string[][] = [];
  const wakes: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const w = new RemoteWatcher({
    agentDir: dir,
    opener: () => "p",
    hc,
    events: (onLine, onEnd, extra) => {
      const s = { onLine, onEnd, killed: false };
      const k = `s${opened.length}`;
      opened.push(k);
      extras.push(extra ?? []);
      streams.set(k, s);
      return { kill: () => void (s.killed = true) };
    },
    wake: (l, k, t) => wakes.push(`child ${l}: ${k}${t ? ` ${t}` : ""}`),
    timer: (fn, ms) => {
      const t = { fn: () => { t.live = false; fn(); }, ms, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    now: () => Date.parse("2026-11-03T12:00:00Z"),
  });
  const reg = (): SessionEntry => readRegistry(dir).sessions[0];
  const send = async (e: unknown, stream = [...streams.values()].at(-1)): Promise<void> => {
    stream?.onLine(JSON.stringify(e));
    await w.idle();
  };
  const put = (file: string, ...bodies: (Buffer | string)[]): void => void files.set(`${HANDOFF}/${file}`, bodies.map((b) => Buffer.from(b)));
  return { dir, w, reg, send, put, calls, wakes, timers, streams, opened, hcGet, files, extras, signals };
}

const st = (over: Record<string, unknown> = {}): WatchState => watchState({ sessions: [entry(over)] }, undefined, "p");

test("parseNoticeLabel: the grammar of the child side", () => {
  const h = "a".repeat(64);
  assert.deepEqual(parseNoticeLabel(`3:plan:${h}:120`), { seq: 3, kind: "plan", sha256: h, bytes: 120 });
  assert.deepEqual(parseNoticeLabel("4:closed:-:0"), { seq: 4, kind: "closed", sha256: "-", bytes: 0 });
  assert.deepEqual(parseNoticeLabel("5:refused:no-run"), { seq: 5, kind: "refused", slug: "no-run" });
  for (const bad of ["x", "1:plan:zz:1", "1:refused:Bad Slug", `1:what:${h}:1`, 7, undefined]) assert.equal(parseNoticeLabel(bad), null, String(bad));
});

test("mapHcState and fetchTimeoutMs", () => {
  assert.deepEqual(["blocked", "working", "idle", "done", "exited", "error", "lost", "weird"].map(mapHcState), ["blocked", "working", "idle", "done", "done", "lost", "lost", null]);
  assert.deepEqual([undefined, 1, 30, 9999, "x"].map(fetchTimeoutMs), [30_000, 5_000, 30_000, 600_000, 30_000]);
});

test("applyEvent: filters on the address, ignores duplicates and a seq that goes backwards, commit/fail decide the retry", () => {
  const s = st();
  const body = "plan\n";
  const v1 = label(1, "plan", body);
  assert.deepEqual(applyEvent(s, ev(v1, "alpha/t9")), [], "another terminal");
  assert.deepEqual(applyEvent(s, ev(v1), "beta"), [], "another machine");
  assert.equal(applyEvent(s, ev(v1)).length, 1, "the full address matches");
  assert.deepEqual(applyEvent(s, ev(v1)), [], "duplicate while pending");
  fail(s, CHILD, "older value");
  assert.deepEqual(applyEvent(s, ev(v1)), [], "a failure of another value keeps the pending one");
  fail(s, CHILD, v1);
  assert.equal(applyEvent(s, ev(v1)).length, 1, "failed fetch: the same value triggers again");
  commit(s, CHILD, 1);
  assert.deepEqual(applyEvent(s, ev(label(1, "result", "r"))), [], "seq not above the last applied");
  assert.deepEqual(applyEvent(s, ev(`0:result:${sha("r")}:1`)), [], "backwards");
  assert.deepEqual(applyEvent(s, ev("garbage")), [{ type: "ignored", child: CHILD, value: "garbage" }]);
  assert.deepEqual(applyEvent(s, ev("garbage")), [], "traced once");
  const next = applyEvent(s, ev(label(2, "result", "r")));
  assert.deepEqual(next.map((a) => a.type === "notice" && [a.seq, a.kind]), [[2, "result"]]);
});

test("applyEvent: close and state labels, refused slug, lost terminal; applyGet reads labels and state", () => {
  const s = st();
  assert.deepEqual(applyEvent(s, lab({ "fm.close": "ready" })), [{ type: "close", child: CHILD, close: "ready" }]);
  assert.deepEqual(applyEvent(s, stat("blocked")), [{ type: "live", child: CHILD, state: "blocked" }]);
  assert.deepEqual(applyEvent(s, stat("error")), [{ type: "live", child: CHILD, state: "lost" }]);
  assert.deepEqual(applyEvent(s, ev("2:refused:running-wait")).map((a) => a.type), ["refused"]);
  const g = applyGet(st(), CHILD, gotten("idle", { "fm.notice": label(1, "ask", "q"), "fm.close": "open" }));
  assert.deepEqual(g.map((a) => a.type), ["close", "notice", "live"]);
  assert.deepEqual(applyGet(st(), CHILD, { state: "live", labels: {} }), [], "the lifecycle `live` is no agent state");
  assert.deepEqual(applyGet(st(), CHILD, gotten("working")).map((a) => a.type === "live" && a.state), ["working"]);
});

test("parseEvents: the real snapshot and JSON-RPC lines; heartbeats, turn and unknown methods give nothing", () => {
  const snap = { channel: null, seq: 8750, terminals: [{ address: "t3", labels: { k: "v" }, state: "live", status: { app: "pi", state: "done" }, records: {} }, { address: "alpha/t9", labels: {}, state: "live" }, { nope: 1 }] };
  assert.deepEqual(parseEvents(snap), [{ address: "t3", labels: { k: "v" }, state: "done" }, { address: "alpha/t9", labels: {}, state: null }]);
  assert.deepEqual(parseEvents(stat("done", "t3")), [{ address: "t3", state: "done" }]);
  assert.deepEqual(parseEvents(lab({ a: "b" }, "t3")), [{ address: "t3", labels: { a: "b" }, state: null }]);
  assert.deepEqual(parseEvents(rpc("labels", "t3", { label: "fm.close", value: "open" })), [], "the unobserved label+value form is gone");
  assert.deepEqual(parseEvents(rpc("finished", "t3", { exit_code: 0, finished_ms: 1, reason: "exited", signal: null })), [{ address: "t3", state: "lost" }]);
  const gone = { address: "t3", labels: {}, state: "finished", status: null, reason: "killed", exit_code: null };
  assert.deepEqual(parseEvents({ channel: null, seq: 1, terminals: [gone, { ...gone, address: "t4", status: { app: "pi", state: "working" } }] }).map((e) => e.state), ["lost", "lost"], "a finished lifecycle is lost whatever status says");
  assert.deepEqual(parseEvents(rpc("turn", "t3", { state: "done", turn: 112 })), []);
  assert.deepEqual(parseEvents(rpc("records", "t3", { records: {} })), []);
  assert.deepEqual(parseEvents({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 8751 } }), []);
  assert.deepEqual(parseEvents({ terminal: "t7", label: "fm.notice", value: "1:ask:-:0" }), [], "the old guessed shape is gone");
  assert.deepEqual(parseEvents("x"), []);
});

test("applyEvent: a bare local terminal id never drives a remote entry; only the full address matches", () => {
  const s = st();
  assert.deepEqual(applyEvent(s, stat("blocked", "t7")), [], "local t7, remote alpha/t7");
  assert.deepEqual(applyEvent(s, lab({ "fm.close": "ready" }, "t7")), []);
  const snap = (machine?: string) => ({ channel: null, seq: 1, terminals: [{ address: "t7", ...(machine ? { machine } : {}), labels: { "fm.close": "ready" }, state: "live" }] });
  assert.deepEqual(applyEvent(s, snap()), []);
  assert.deepEqual(applyEvent(s, snap("alpha")), [], "a machine field no longer makes a bare id match");
  assert.deepEqual(applyEvent(s, { channel: null, seq: 1, terminals: [{ address: "alpha/t7", labels: { "fm.close": "ready" }, state: "live" }] }).map((a) => a.type), ["close"]);
});

test("finished terminal: snapshot, get and the finished event give lost; a live one keeps its status state", () => {
  const fin = { address: "alpha/t7", labels: {}, state: "finished", status: null, reason: "exited", exit_code: 0 };
  assert.deepEqual(applyGet(st(), CHILD, fin), [{ type: "live", child: CHILD, state: "lost" }]);
  assert.deepEqual(applyGet(st(), CHILD, { ...fin, reason: "killed", status: { app: "pi", state: "working" } }), [{ type: "live", child: CHILD, state: "lost" }]);
  assert.deepEqual(applyEvent(st(), { channel: null, seq: 1, terminals: [fin] }), [{ type: "live", child: CHILD, state: "lost" }]);
  assert.deepEqual(applyEvent(st(), rpc("finished", "alpha/t7", { exit_code: 0, finished_ms: 1, reason: "exited", signal: null })), [{ type: "live", child: CHILD, state: "lost" }]);
  assert.deepEqual(applyGet(st(), CHILD, gotten("working")), [{ type: "live", child: CHILD, state: "working" }]);
});

test("parseNoticeLabel: `-` as sha and 0 bytes are for closed only", () => {
  const h = "b".repeat(64);
  assert.equal(parseNoticeLabel("1:closed:-:0")?.kind, "closed");
  assert.equal(parseNoticeLabel(`1:closed:${h}:9`)?.kind, "closed");
  for (const k of ["plan", "result", "update", "ask"]) assert.equal(parseNoticeLabel(`1:${k}:-:0`), null, k);
  assert.equal(parseNoticeLabel("1:closed:-:5"), null);
  assert.equal(parseNoticeLabel(`1:plan:${h}:0`)?.kind, "plan");
});

test("watcher: a malformed fm.notice is traced once and does nothing", async () => {
  const r = rig();
  const recs: Record<string, unknown>[] = [];
  (r.w as unknown as { d: { trace?: (x: Record<string, unknown>) => void } }).d.trace = (x) => void recs.push(x);
  r.w.start();
  await r.w.idle();
  await r.send(ev("1:plan:-:0"));
  await r.send(ev("1:plan:-:0"));
  assert.deepEqual(recs, [{ event: "remote_notice_ignored", child: CHILD, value: "1:plan:-:0" }]);
  assert.deepEqual(r.wakes, []);
});

test("watcher: a finished event and a finished lifecycle in get set remoteLive lost", async () => {
  const r = rig();
  r.w.start();
  await r.w.idle();
  await r.send(stat("working"));
  assert.equal((r.reg().remoteLive as { state: string }).state, "working");
  await r.send(rpc("finished", "alpha/t7", { exit_code: 1, finished_ms: 1, reason: "killed", signal: 9 }));
  assert.equal((r.reg().remoteLive as { state: string }).state, "lost");
});

test("fail: a failure of an older value keeps the newer pending one", () => {
  const s = st();
  const v1 = label(1, "plan", "a");
  const v2 = label(2, "plan", "b");
  assert.equal(applyEvent(s, ev(v1)).length, 1);
  assert.equal(applyEvent(s, ev(v2)).length, 1);
  fail(s, CHILD, v1);
  assert.deepEqual(applyEvent(s, ev(v2)), [], "v2 is still pending");
});

test("pollPlan: 5 s with an open ask or a pending plan, else 60 s", () => {
  const plan = (over: Record<string, unknown>) => pollPlan(st(over).values())[0].everyMs;
  assert.equal(plan({}), 60_000);
  assert.equal(plan({ ask: { seq: 1 } }), 5_000);
  assert.equal(plan({ last: { kind: "plan", at: "x" } }), 5_000);
  assert.equal(plan({ last: { kind: "result", at: "x" } }), 60_000);
});

test("watchState: only open hc entries with a machine; remotePath uses the remote separator", () => {
  const reg = { sessions: [entry(), entry({ child: "c2", status: "closed" }), entry({ child: "c3", backend: undefined }), entry({ child: "c4", machine: undefined })] };
  assert.deepEqual([...watchState(reg, undefined, "p").keys()], [CHILD]);
  const mixed = { sessions: [entry(), entry({ child: "c-other", parent: "someone-else" }), entry({ child: "c-none", parent: undefined })] };
  assert.deepEqual([...watchState(mixed, undefined, "p").keys()], [CHILD], "only this session's own children");
  assert.equal(watchState(mixed, undefined, undefined).size, 0, "no opener id: no listener");
  assert.equal(watchState(mixed, undefined, "").size, 0);
  assert.equal(remotePath({ handoff: "C:\\h\\x\\", platform: "win32" }, "plan.md"), "C:\\h\\x\\plan.md");
  assert.equal(remotePath({ handoff: "/h/x/", platform: "posix" }, "ask.md"), "/h/x/ask.md");
});

test("watcher: a plan label is fetched, checked, mirrored and wakes the wait with the mirror path", async () => {
  const r = rig();
  r.w.start();
  await r.w.idle();
  assert.equal(r.opened.length, 1);
  r.put("plan.md", "the plan\n");
  await r.send(ev(label(1, "plan", "the plan\n")));
  const e = r.reg();
  const mirror = path.join(r.dir, "m", CHILD, "plan.md");
  assert.equal(fs.readFileSync(mirror, "utf8"), "the plan\n");
  assert.deepEqual(r.wakes, [`child demo: plan ${mirror}`]);
  assert.equal(e.noticeSeq, 1);
  assert.equal(e.lastError, null);
  assert.equal(e.status, "open");
  assert.equal((e.remoteLive as { state: string }).state, "working", "initial hc get");
  assert.deepEqual(r.calls.find((c) => c[0] === "file"), ["file", "read", "--on", "alpha", `${HANDOFF}/plan.md`]);
  r.w.stop();
});

test("watcher: open → ask → open → closing → closed, the ask cleared by the next notice", async () => {
  const r = rig();
  r.w.start();
  r.put("ask.md", "which?\n");
  await r.send(ev(label(1, "ask", "which?\n")));
  assert.deepEqual((r.reg().ask as { seq: number }).seq, 1);
  assert.match(r.wakes[0], /^child demo: ask .*ask\.md$/);
  r.put("result.md", "done\n");
  await r.send(ev(label(2, "update", "done\n")));
  assert.equal(r.reg().ask, undefined);
  assert.equal(r.reg().status, "open");
  const reg = readRegistry(r.dir);
  reg.sessions[0].status = "closing";
  writeRegistry(r.dir, reg);
  r.w.refresh();
  await r.send(ev("3:refused:running-wait"));
  assert.equal(r.reg().status, "open", "a refusal reopens a closing entry");
  assert.equal(r.reg().lastError, "refused running-wait");
  assert.equal(r.wakes.at(-1), "child demo: refused running-wait");
  const again = readRegistry(r.dir);
  again.sessions[0].status = "closing";
  writeRegistry(r.dir, again);
  r.w.refresh();
  await r.send(ev(label(4, "closed", "done\n")));
  await r.send(lab({ "fm.close": "ready" }));
  const e = r.reg();
  assert.equal(e.status, "closed");
  assert.equal(e.close, "ready");
  assert.equal(e.result, path.join(r.dir, "m", CHILD, "result.md"));
  assert.match(r.wakes.at(-1) as string, /^child demo: closed .*result\.md$/);
  r.w.refresh();
  assert.equal(r.streams.get("s0")?.killed, true, "no open entry on the machine: the listener stops");
});

test("watcher: closed without a result (-:0) fetches nothing; fm.close=open is recorded", async () => {
  const r = rig();
  r.w.start();
  const before = r.calls.filter((c) => c[0] === "file").length;
  await r.send(ev("1:closed:-:0"));
  await r.send(lab({ "fm.close": "open" }));
  assert.equal(r.calls.filter((c) => c[0] === "file").length, before);
  assert.equal(r.reg().status, "closed");
  assert.equal(r.reg().close, "open");
  assert.deepEqual(r.wakes, ["child demo: closed"]);
});

test("watcher: a hash mismatch is fetched twice, then pending; the identical label later retriggers", async () => {
  const r = rig();
  r.w.start();
  r.put("plan.md", "tampered\n", "tampered\n");
  const v = label(1, "plan", "the plan\n");
  await r.send(ev(v));
  assert.equal(r.calls.filter((c) => c[0] === "file").length, 2);
  assert.equal(r.reg().lastError, "hash mismatch, not mirrored");
  assert.equal(r.reg().noticeSeq, undefined);
  assert.equal(fs.existsSync(path.join(r.dir, "m", CHILD, "plan.md")), false);
  assert.deepEqual(r.wakes, []);
  r.put("plan.md", "the plan\n");
  await r.send(ev(v));
  assert.equal(r.reg().lastError, null);
  assert.equal(r.reg().noticeSeq, 1);
  assert.equal(r.wakes.length, 1);
});

test("watcher: the second fetch can repair a first mismatch; a truncated fetch is a size mismatch", async () => {
  const r = rig();
  r.w.start();
  r.put("plan.md", "the pl", "the plan\n");
  await r.send(ev(label(1, "plan", "the plan\n")));
  assert.equal(r.reg().noticeSeq, 1);
  r.put("result.md", "half", "half");
  await r.send(ev(label(2, "result", "half and more")));
  assert.equal(r.reg().lastError, "hash mismatch, not mirrored");
  assert.equal(r.reg().noticeSeq, 1);
});

test("watcher: a failed hc file read is fetch_failed with stripped stderr, and stays pending", async () => {
  const r = rig();
  r.w.start();
  const v = label(1, "plan", "p");
  await r.send(ev(v));
  assert.equal(r.reg().lastError, "fetch_failed: no such file : x");
  assert.deepEqual(r.wakes, []);
  r.put("plan.md", "p");
  await r.send(ev(v));
  assert.equal(r.reg().lastError, null);
});

test("watcher: terminal state events set remoteLive; a lost terminal is lost; unchanged state writes nothing new", async () => {
  const r = rig();
  r.w.start();
  await r.w.idle();
  await r.send(stat("blocked"));
  assert.deepEqual(r.reg().remoteLive, { state: "blocked", seenAt: "2026-11-03T12:00:00.000Z", address: "alpha/t7" });
  await r.send(stat("done"));
  assert.equal((r.reg().remoteLive as { state: string }).state, "done");
  await r.send(stat("error"));
  assert.equal((r.reg().remoteLive as { state: string }).state, "lost");
});

test("watcher: two machines get two listeners, each filtered to its own entries", async () => {
  const other = entry({ child: "c-beta", label: "other", machine: "beta", hc: { address: "beta/t2" }, remoteHandoff: "/b/h" });
  const r = rig([entry(), other]);
  r.w.start();
  await r.w.idle();
  assert.equal(r.opened.length, 2);
  r.put("plan.md", "p");
  await r.send(ev(label(1, "plan", "p")), r.streams.get("s1"));
  assert.deepEqual(r.wakes, [], "beta's stream does not carry alpha's terminal");
  await r.send(ev(label(1, "plan", "p")), r.streams.get("s0"));
  assert.equal(r.wakes.length, 1);
});

test("watcher: a delivered ruling (rulings up) clears the ask on refresh; a plain brief does not", async () => {
  const r = rig();
  r.w.start();
  r.put("ask.md", "q");
  await r.send(ev(label(1, "ask", "q")));
  assert.ok(r.reg().ask);
  const reg = readRegistry(r.dir);
  reg.sessions[0].briefs = 1;
  writeRegistry(r.dir, reg);
  r.w.refresh();
  assert.ok(r.reg().ask, "a plain brief leaves the ask");
  const ruled = readRegistry(r.dir);
  ruled.sessions[0].briefs = 2;
  ruled.sessions[0].rulings = 1;
  writeRegistry(r.dir, ruled);
  r.w.refresh();
  assert.equal(r.reg().ask, undefined);
});

test("watcher: when the events stream ends, hc get is polled every 5 s with an ask and 60 s without; the stream restarts after a minute", async () => {
  const r = rig([entry({ ask: { seq: 1, rulings: 0 } })]);
  r.w.start();
  await r.w.idle();
  const gets = (): number => r.calls.filter((c) => c[0] === "get").length;
  const base = gets();
  r.streams.get("s0")?.onEnd();
  const poll = r.timers.filter((t) => t.live && t.ms === 5_000);
  assert.equal(poll.length, 1, "ask open: 5 s");
  assert.ok(r.timers.some((t) => t.live && t.ms === 60_000), "restart in a minute");
  poll[0].fn();
  await r.w.idle();
  assert.equal(gets(), base + 1);
  assert.equal(r.timers.filter((t) => t.live && t.ms === 5_000).length, 1, "rescheduled");
  r.hcGet.reply = gotten("blocked", { "fm.notice": label(1, "ask", "q") });
  r.hcGet.code = 0;
  r.put("ask.md", "q");
  r.timers.filter((t) => t.live && t.ms === 5_000)[0].fn();
  await r.w.idle();
  assert.equal((r.reg().remoteLive as { state: string }).state, "blocked");
  assert.equal(r.reg().noticeSeq, 1, "the polled label is applied like an event");
});

test("watcher: a plain entry polls every 60 s and a stream restart replaces the polls", async () => {
  const r = rig();
  r.w.start();
  await r.w.idle();
  r.streams.get("s0")?.onEnd();
  assert.equal(r.timers.filter((t) => t.live && t.ms === 5_000).length, 0);
  const restart = r.timers.filter((t) => t.live && t.ms === 60_000);
  assert.equal(restart.length, 2, "one poll, one restart");
  r.hcGet.code = 3;
  r.timers.filter((t) => t.live && t.ms === 60_000)[0].fn();
  restart[1].fn();
  await r.w.idle();
  assert.equal(r.opened.length, 2, "the stream was reopened");
  assert.equal(r.timers.filter((t) => t.live && t.ms === 60_000).length, 0, "polls cancelled while the stream is up (restart timer consumed)");
});

test("watcher: heartbeats keep the stream healthy; 90 s of silence ends it and starts the poll fallback", async () => {
  const r = rig();
  r.w.start();
  await r.w.idle();
  const silence = (): { fn: () => void; ms: number; live: boolean }[] => r.timers.filter((t) => t.live && t.ms === 90_000);
  assert.equal(silence().length, 1);
  const first = silence()[0];
  r.streams.get("s0")?.onLine(JSON.stringify({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 9 } }));
  assert.equal(first.live, false, "a heartbeat re-arms the watchdog");
  assert.equal(silence().length, 1);
  assert.equal(r.timers.filter((t) => t.live && t.ms === 60_000).length, 0, "no poll while heartbeats arrive");
  silence()[0].fn();
  assert.equal(r.streams.get("s0")?.killed, true);
  assert.equal(r.timers.filter((t) => t.live && t.ms === 60_000).length, 2, "poll and restart");
  r.hcGet.code = 3;
  r.timers.filter((t) => t.live && t.ms === 60_000)[0].fn();
  await r.w.idle();
  assert.equal((r.reg().remoteLive as { state: string }).state, "lost", "hc get exit 3 {error:{kind:not_found}} is a lost terminal");
});

test("watcher: an hc get with another failure is not a lost terminal", async () => {
  const r = rig([entry({ remoteLive: { state: "working", seenAt: "x", address: "alpha/t7" } })]);
  r.w.start();
  await r.w.idle();
  r.streams.get("s0")?.onEnd();
  r.hcGet.code = 1;
  r.timers.filter((t) => t.live && t.ms === 60_000)[0].fn();
  await r.w.idle();
  assert.notEqual((r.reg().remoteLive as { state: string }).state, "lost");
});

test("watcher: entries of another parent are not watched, a session without an opener has no listener", async () => {
  const r = rig([entry({ parent: "someone-else" })]);
  r.w.start();
  await r.w.idle();
  assert.equal(r.opened.length, 0);
  assert.deepEqual(r.calls, []);
  r.w.stop();
  const none = new RemoteWatcher({ agentDir: r.dir, opener: () => undefined, hc: async () => { throw new Error("unused"); }, events: () => { throw new Error("unused"); }, wake: () => undefined });
  none.start();
  await none.idle();
  none.stop();
});

test("watcher: bytes that are not valid UTF-8 are mirrored exactly, not a false hash mismatch", async () => {
  const r = rig();
  r.w.start();
  const body = Buffer.from([0x70, 0x6c, 0x61, 0x6e, 0x20, 0xe9, 0x0a]); // `plan \xe9\n`, Latin-1
  r.put("plan.md", body);
  await r.send(ev(label(1, "plan", body)));
  assert.equal(r.reg().lastError, null);
  assert.deepEqual(fs.readFileSync(path.join(r.dir, "m", CHILD, "plan.md")), body);
  assert.equal(r.wakes.length, 1);
});

test("watcher: an older notice failing while a newer one is queued applies each notice once (deterministic race)", async () => {
  const r = rig();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((res) => (release = res));
  const base = r.w as unknown as { hc: HcRun };
  const inner = base.hc;
  let firstRead = true;
  base.hc = async (args, t) => {
    if (args[0] === "file" && firstRead) {
      firstRead = false;
      await gate;
      return { code: 1, stdout: Buffer.alloc(0), stderr: "gone", timedOut: false, overflow: false };
    }
    return inner(args, t);
  };
  r.w.start();
  await r.w.idle();
  r.put("plan.md", "a");
  r.put("result.md", "b");
  const stream = r.streams.get("s0");
  stream?.onLine(JSON.stringify(ev(label(1, "plan", "a"))));
  stream?.onLine(JSON.stringify(ev(label(2, "result", "b"))));
  release(); // v1 fails after v2 is queued
  await r.w.idle();
  stream?.onLine(JSON.stringify(ev(label(2, "result", "b")))); // the same label again
  await r.w.idle();
  assert.equal(r.wakes.filter((w) => w.includes("result")).length, 1);
  assert.equal(r.reg().noticeSeq, 2);
});

test("foreman_wait kind child: the watcher wake resolves a child wait with `child <label>: <kind> <path>`", async () => {
  const outcomes: Outcome[][] = [];
  const rt = new WaitRuntime({ timers: { set: () => 1, clear: () => undefined }, now: () => 0, limits: () => ({ batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true }), stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => outcomes.push(o), trace: () => undefined });
  assert.ok("id" in rt.start({ kind: "child", label: "demo", note: "n" }));
  const r = rig();
  const w = new RemoteWatcher({ agentDir: r.dir, opener: () => "p", hc: async (a) => ({ code: 0, stdout: a[0] === "get" ? Buffer.from("{}") : Buffer.from("r\n"), stderr: "", timedOut: false, overflow: false }), events: (onLine) => { onLine(JSON.stringify(ev(label(1, "result", "r\n")))); return { kill() {} }; }, wake: (l, k, t) => void rt.childNotice(l, k, t) });
  w.start();
  await w.idle();
  w.stop();
  assert.match(outcomes[0][0].outcome, /^child demo: result \S+result\.md$/);
  assert.equal(rt.active, 0);
});

const second = (over: Record<string, unknown> = {}): SessionEntry => entry({ child: "c-two", label: "two", hc: { address: "alpha/t8" }, ...over });
const addEntry = (r: ReturnType<typeof rig>, e: SessionEntry): void => {
  const reg = readRegistry(r.dir);
  reg.sessions.push({ ...e, mirror: path.join(r.dir, "m", String(e.child)), handoff: path.join(r.dir, "m", String(e.child)) });
  writeRegistry(r.dir, reg);
};

test("watcher: a lone watched entry gets a --terminal filter, several get the full stream; a changed set restarts the stream", async () => {
  const r = rig();
  r.w.start();
  await r.w.idle();
  assert.deepEqual(r.extras, [["--terminal", "alpha/t7"]]);
  addEntry(r, second());
  r.w.refresh();
  await r.w.idle();
  assert.equal(r.streams.get("s0")?.killed, true, "the old filter is gone");
  assert.deepEqual(r.extras, [["--terminal", "alpha/t7"], []]);
  r.w.refresh();
  await r.w.idle();
  assert.equal(r.opened.length, 2, "an unchanged set keeps the stream");
  const reg = readRegistry(r.dir);
  reg.sessions[1].status = "closed";
  writeRegistry(r.dir, reg);
  r.w.refresh();
  await r.w.idle();
  assert.deepEqual(r.extras.at(-1), ["--terminal", "alpha/t7"]);
  assert.equal(r.streams.get("s1")?.killed, true);
});

test("watcher: an entry added while its machine is in poll fallback gets its own scheduled poll", async () => {
  const r = rig();
  r.w.start();
  await r.w.idle();
  r.streams.get("s0")?.onEnd();
  const live60 = (): number => r.timers.filter((t) => t.live && t.ms === 60_000).length;
  const before = live60();
  addEntry(r, second({ ask: { seq: 1, rulings: 0 } }));
  r.w.refresh();
  await r.w.idle();
  assert.equal(r.timers.filter((t) => t.live && t.ms === 5_000).length, 1, "the ask entry polls every 5 s");
  assert.equal(live60(), before);
  const gets = (): number => r.calls.filter((c) => c[0] === "get" && c[1] === "alpha/t8").length;
  const base = gets();
  r.timers.filter((t) => t.live && t.ms === 5_000)[0].fn();
  await r.w.idle();
  assert.equal(gets(), base + 1);
});

test("watcher: stop() aborts the in-flight hc get and file read; nothing is written after", async () => {
  const r = rig();
  const seen: AbortSignal[] = [];
  const started: string[] = [];
  const hc: HcRun = (args, _t, signal) =>
    new Promise((resolve) => {
      started.push(args[0]);
      seen.push(signal as AbortSignal);
      (signal as AbortSignal).addEventListener("abort", () => resolve({ code: null, stdout: Buffer.alloc(0), stderr: "", timedOut: false, overflow: false, error: new Error("aborted") }));
    });
  const w = new RemoteWatcher({ agentDir: r.dir, opener: () => "p", hc, events: (onLine) => { setImmediate(() => onLine(JSON.stringify(ev(label(1, "plan", "p"))))); return { kill() {} }; }, wake: () => assert.fail("woken after stop") });
  w.start();
  for (let i = 0; i < 50 && started.length < 1; i++) await new Promise((res) => setImmediate(res));
  assert.ok(started.length >= 1 && seen.every((s) => s && !s.aborted), "a call is in flight");
  w.stop();
  assert.ok(seen.every((s) => s.aborted));
  await w.idle();
  const e = readRegistry(r.dir).sessions[0];
  assert.equal(e.lastError, null);
  assert.equal(e.noticeSeq, undefined);
});

test("runHc: an abort kills the child and resolves at once", { skip: process.platform === "win32" ? "the stub hc is a `#!/bin/sh` script run through `sleep`, which win32 cannot execute" : false }, async () => {
  const bin = path.join(fs.mkdtempSync(path.join(root, "bin-")), "hc");
  fs.writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const old = process.env.HC_BIN;
  process.env.HC_BIN = bin;
  try {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runHc(["get", "x"], 60_000, ac.signal);
    setTimeout(() => ac.abort(), 100);
    const res = await p;
    assert.ok(Date.now() - t0 < 5_000);
    assert.equal(res.code, null);
    assert.match(res.error?.message ?? "", /aborted/);
    assert.equal((await runHc(["get", "x"], 60_000, ac.signal)).error?.message, "aborted", "an already aborted signal never spawns");
  } finally {
    if (old === undefined) delete process.env.HC_BIN;
    else process.env.HC_BIN = old;
  }
});

test("watcher: a closed notice kills the local attach terminal of the entry; no attach, no kill", async () => {
  const r = rig([entry({ attach: { address: "t9" } })]);
  r.w.start();
  await r.send(ev("1:closed:-:0"));
  assert.deepEqual(r.calls.filter((c) => c[0] === "kill"), [["kill", "t9"]]);
  const n = rig();
  n.w.start();
  await n.send(ev("1:closed:-:0"));
  assert.deepEqual(n.calls.filter((c) => c[0] === "kill"), []);
});

test("watcher: the ask stores n and topic from the ask.md header, never the notice seq", async () => {
  const r = rig();
  r.w.start();
  r.put("ask.md", "# Ask 3: db choice\nwhich?\n");
  await r.send(ev(label(7, "ask", "# Ask 3: db choice\nwhich?\n")));
  const ask = r.reg().ask as { seq: number; n?: number; topic?: string };
  assert.equal(ask.seq, 7);
  assert.equal(ask.n, 3);
  assert.equal(ask.topic, "db choice");
});

test("watcher: an ask.md without the header stores no n", async () => {
  const r = rig();
  r.w.start();
  r.put("ask.md", "which?\n");
  await r.send(ev(label(2, "ask", "which?\n")));
  assert.equal((r.reg().ask as { n?: number }).n, undefined);
});
