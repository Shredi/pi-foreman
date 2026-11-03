import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyEvent, applyGet, commit, fail, fetchTimeoutMs, mapHcState, parseEvent, parseNoticeLabel, pollPlan, RemoteWatcher, remotePath, watchState } from "../remotewatch.ts";
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
const ev = (value: string, terminal = "t7", key = "fm.notice") => ({ terminal, label: key, value });

function rig(entries: SessionEntry[] = [entry()]) {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  writeRegistry(dir, { version: 1, sessions: entries.map((e) => ({ ...e, mirror: path.join(dir, "m", String(e.child)), handoff: path.join(dir, "m", String(e.child)) })) });
  const files = new Map<string, Buffer[]>(); // remote path -> successive reads
  const calls: string[][] = [];
  const hcGet: { reply: unknown; code: number } = { reply: { labels: {}, state: "working" }, code: 0 };
  const hc: HcRun = async (args) => {
    calls.push(args);
    const res = (over: Partial<HcResult>): HcResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, overflow: false, ...over });
    if (args[0] === "get") return res({ code: hcGet.code, stdout: Buffer.from(JSON.stringify(hcGet.reply)), stderr: hcGet.code ? "no such terminal: x" : "" });
    const q = files.get(args[4]);
    if (!q || !q.length) return res({ code: 4, stderr: "no such file\u0007: x" });
    return res({ stdout: q.length > 1 ? (q.shift() as Buffer) : q[0] });
  };
  const streams = new Map<string, { onLine: (l: string) => void; onEnd: () => void; killed: boolean }>();
  const opened: string[] = [];
  const wakes: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const w = new RemoteWatcher({
    agentDir: dir,
    hc,
    events: (onLine, onEnd) => {
      const s = { onLine, onEnd, killed: false };
      const k = `s${opened.length}`;
      opened.push(k);
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
  return { dir, w, reg, send, put, calls, wakes, timers, streams, opened, hcGet, files };
}

const st = (over: Record<string, unknown> = {}): WatchState => watchState({ sessions: [entry(over)] });

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
  assert.deepEqual(applyEvent(s, ev(v1, "t9")), [], "another terminal");
  assert.deepEqual(applyEvent(s, ev(v1, "t7"), "beta"), [], "another machine");
  assert.equal(applyEvent(s, ev(v1, "alpha/t7")).length, 1, "the full address matches too");
  assert.deepEqual(applyEvent(s, ev(v1)), [], "duplicate while pending");
  fail(s, CHILD);
  assert.equal(applyEvent(s, ev(v1)).length, 1, "failed fetch: the same value triggers again");
  commit(s, CHILD, 1);
  assert.deepEqual(applyEvent(s, ev(label(1, "result", "r"))), [], "seq not above the last applied");
  assert.deepEqual(applyEvent(s, ev(`0:result:${sha("r")}:1`)), [], "backwards");
  assert.deepEqual(applyEvent(s, ev("garbage")), []);
  const next = applyEvent(s, ev(label(2, "result", "r")));
  assert.deepEqual(next.map((a) => a.type === "notice" && [a.seq, a.kind]), [[2, "result"]]);
});

test("applyEvent: close and state labels, refused slug, lost terminal; applyGet reads labels and state", () => {
  const s = st();
  assert.deepEqual(applyEvent(s, { terminal: "t7", labels: { "fm.close": "ready" } }), [{ type: "close", child: CHILD, close: "ready" }]);
  assert.deepEqual(applyEvent(s, { terminal: "t7", state: "blocked" }), [{ type: "live", child: CHILD, state: "blocked" }]);
  assert.deepEqual(applyEvent(s, { type: "terminal.removed", terminal: "t7" }), [{ type: "live", child: CHILD, state: "lost" }]);
  assert.deepEqual(applyEvent(s, ev("2:refused:running-wait")).map((a) => a.type), ["refused"]);
  const g = applyGet(st(), CHILD, { labels: { "fm.notice": label(1, "ask", "q"), "fm.close": "open" }, state: "idle" });
  assert.deepEqual(g.map((a) => a.type), ["close", "notice", "live"]);
  assert.equal(parseEvent({ nothing: 1 }), null);
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
  assert.deepEqual([...watchState(reg).keys()], [CHILD]);
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
  await r.send({ terminal: "t7", labels: { "fm.close": "ready" } });
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
  await r.send({ terminal: "t7", labels: { "fm.close": "open" } });
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
  await r.send({ terminal: "t7", state: "blocked" });
  assert.deepEqual(r.reg().remoteLive, { state: "blocked", seenAt: "2026-11-03T12:00:00.000Z", address: "alpha/t7" });
  await r.send({ terminal: "t7", state: "done" });
  assert.equal((r.reg().remoteLive as { state: string }).state, "done");
  await r.send({ type: "terminal.removed", terminal: "t7" });
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

test("watcher: ruling delivered (briefs up) clears the ask on refresh", async () => {
  const r = rig();
  r.w.start();
  r.put("ask.md", "q");
  await r.send(ev(label(1, "ask", "q")));
  assert.ok(r.reg().ask);
  const reg = readRegistry(r.dir);
  reg.sessions[0].briefs = 1;
  writeRegistry(r.dir, reg);
  r.w.refresh();
  assert.equal(r.reg().ask, undefined);
});

test("watcher: when the events stream ends, hc get is polled every 5 s with an ask and 60 s without; the stream restarts after a minute", async () => {
  const r = rig([entry({ ask: { seq: 1, briefs: 0 } })]);
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
  r.hcGet.reply = { labels: { "fm.notice": label(1, "ask", "q") }, state: "blocked" };
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
  r.hcGet.code = 4;
  r.timers.filter((t) => t.live && t.ms === 60_000)[0].fn();
  restart[1].fn();
  await r.w.idle();
  assert.equal(r.opened.length, 2, "the stream was reopened");
  assert.equal(r.timers.filter((t) => t.live && t.ms === 60_000).length, 0, "polls cancelled while the stream is up (restart timer consumed)");
});

test("foreman_wait kind child: the watcher wake resolves a child wait with `child <label>: <kind> <path>`", async () => {
  const outcomes: Outcome[][] = [];
  const rt = new WaitRuntime({ timers: { set: () => 1, clear: () => undefined }, now: () => 0, limits: () => ({ batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true }), stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => outcomes.push(o), trace: () => undefined });
  assert.ok("id" in rt.start({ kind: "child", label: "demo", note: "n" }));
  const r = rig();
  const w = new RemoteWatcher({ agentDir: r.dir, hc: async (a) => ({ code: 0, stdout: a[0] === "get" ? Buffer.from("{}") : Buffer.from("r\n"), stderr: "", timedOut: false, overflow: false }), events: (onLine) => { onLine(JSON.stringify(ev(label(1, "result", "r\n")))); return { kill() {} }; }, wake: (l, k, t) => void rt.childNotice(l, k, t) });
  w.start();
  await w.idle();
  w.stop();
  assert.match(outcomes[0][0].outcome, /^child demo: result \S+result\.md$/);
  assert.equal(rt.active, 0);
});
