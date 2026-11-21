// The notice queue of a remote child (`notices.jsonl`, `notices/<seq>-<kind>.md`), the retry probe, the contact file and the receipt (remotewatch.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseNoticeLabel, parseQueue, queuePlan, RemoteWatcher } from "../remotewatch.ts";
import type { HcResult, HcRun } from "../remotewatch.ts";
import { readRegistry, writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";
import { RemoteNoticeBatch } from "../remotenotice.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rqueue-")));
const sha = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const HANDOFF = "/home/u/.pi/handoff/20261103-120000-demo";
const NOW = Date.parse("2026-11-03T12:00:00Z");

const entry = (over: Record<string, unknown> = {}): SessionEntry =>
  ({ label: "demo", child: CHILD, parent: "p", handoff: "x", status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: HANDOFF, mirror: "x", remote: { platform: "linux" }, backend: "hc", hc: { address: "alpha/t7", space: null, tab: null }, briefs: 0, lastError: null, last: null, ...over }) as SessionEntry;
const rec = (seq: number, kind: string, body: string): Record<string, unknown> => ({ seq, kind, sha256: sha(body), bytes: Buffer.byteLength(body), at: "2026-11-03T12:00:00Z" });
const labelOf = (seq: number, kind: string, body: string): string => `${seq}:${kind}:${sha(body)}:${Buffer.byteLength(body)}`;
const lab = (value: string) => ({ jsonrpc: "2.0", method: "event", params: { type: "labels", terminal: "alpha/t7", seq: 1, data: { labels: { "fm.notice": value } } } });
const NOT_FOUND = JSON.stringify({ error: { kind: "not_found", message: "no file" } });

function rig(over: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  writeRegistry(dir, { version: 1, sessions: [{ ...entry(over), mirror: path.join(dir, "m"), handoff: path.join(dir, "m") }] });
  const files = new Map<string, Buffer>();
  const failing = new Set<string>(); // remote paths whose read fails
  const calls: string[][] = [];
  const writes: { path: string; body: string }[] = [];
  const state = { writeCode: 0, getLabels: {} as Record<string, string> };
  const hc: HcRun = async (args, _t, _s, input) => {
    calls.push(args);
    const res = (o: Partial<HcResult>): HcResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, overflow: false, ...o });
    if (args[0] === "get") return res({ stdout: Buffer.from(JSON.stringify({ address: "alpha/t7", labels: state.getLabels, state: "live", status: { app: "pi", state: "working" } })) });
    if (args[1] === "write") {
      if (state.writeCode === 0) writes.push({ path: args[4], body: (input ?? Buffer.alloc(0)).toString("utf8") });
      return res({ code: state.writeCode, stderr: state.writeCode ? "no" : "" });
    }
    const f = files.get(args[4]);
    if (failing.has(args[4])) return res({ code: 1, stderr: "boom" });
    if (!f) return res({ code: 3, stderr: NOT_FOUND });
    return res({ stdout: f });
  };
  let onLine: (l: string) => void = () => undefined;
  const wakes: string[] = [];
  let flushes = 0;
  const probes: { fn: () => void; ms: number; live: boolean }[] = [];
  const batch = new RemoteNoticeBatch();
  const messages: (string | null)[] = [];
  const w = new RemoteWatcher({
    agentDir: dir,
    opener: () => "p",
    hc,
    events: (l) => ((onLine = l), { kill() {} }),
    wake: (l, k, t, m) => (wakes.push(`${k} ${t}`), batch.add(l, k, t, m)),
    flush: () => (flushes++, messages.push(batch.flush())),
    timer: () => () => undefined,
    probeTimer: (fn, ms) => {
      const t = { fn: () => ((t.live = false), fn()), ms, live: true };
      probes.push(t);
      return () => void (t.live = false);
    },
    now: () => NOW,
  });
  const reg = (): SessionEntry => readRegistry(dir).sessions[0];
  const put = (file: string, body: string | Buffer): void => void files.set(`${HANDOFF}/${file}`, Buffer.from(body));
  const queue = (...records: Record<string, unknown>[]): void => put("notices.jsonl", records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const send = async (value: string): Promise<void> => {
    onLine(JSON.stringify(lab(value)));
    await w.idle();
  };
  const probe = async (): Promise<void> => {
    probes.filter((t) => t.live).at(-1)?.fn();
    await w.idle();
  };
  return { dir, w, reg, put, queue, send, probe, calls, wakes, probes, writes, state, failing, messages, flushes: () => flushes };
}

test("queuePlan and parseQueue: records above lastSeq up to the label, ascending; the label alone when the queue has no record for it; bad lines skipped", () => {
  const h = "a".repeat(64);
  const bad: string[] = [];
  const records = parseQueue([JSON.stringify({ seq: 2, kind: "plan", sha256: h, bytes: 3 }), "not json", JSON.stringify({ seq: 1, kind: "result", sha256: h, bytes: 3 }), JSON.stringify({ seq: 3, kind: "plan", sha256: "x", bytes: 1 }), JSON.stringify({ seq: 4, kind: "refused", sha256: null, bytes: 0, reason: "no-run" }), JSON.stringify({ seq: 5, kind: "closed", sha256: null, bytes: 0 })].join("\n"), (l) => bad.push(l));
  assert.deepEqual(records.map((r) => r.seq), [2, 1, 4, 5]);
  assert.equal(bad.length, 2);
  const label = parseNoticeLabel(`2:plan:${h}:3`);
  assert.ok(label);
  assert.deepEqual(queuePlan(0, records, label).map((s) => [s.seq, s.kind]), [[1, "result"], [2, "plan"]]);
  assert.deepEqual(queuePlan(1, records, label).map((s) => s.seq), [2]);
  const ahead = parseNoticeLabel(`6:update:${h}:3`);
  assert.ok(ahead);
  assert.deepEqual(queuePlan(4, records, ahead).map((s) => [s.seq, s.kind, s.kind !== "refused" && s.queued]), [[5, "closed", true], [6, "update", false]]);
});

test("T2: a queue of two notices with the label at 2 (one poll) applies both, in order, as one message", async () => {
  const r = rig();
  const a = "plan one\n";
  const b = "the result\n";
  r.put("notices/1-plan.md", a);
  r.put("notices/2-result.md", b);
  r.queue(rec(1, "plan", a), rec(2, "result", b));
  r.state.getLabels = { "fm.notice": labelOf(2, "result", b) };
  r.w.start();
  await r.w.idle();
  assert.equal(r.reg().noticeSeq, 2);
  assert.deepEqual(r.wakes.map((x) => x.split(" ")[0]), ["plan", "result"]);
  assert.equal(r.flushes(), 1, "one catch-up run, one flush");
  assert.equal(r.messages[0]?.split("\n").length, 3, "a header and two lines");
  assert.equal(fs.readFileSync(path.join(r.dir, "m", "result.md"), "utf8"), b);
});

test("T3: a second plan written before the first was fetched: both per-seq copies are applied", async () => {
  const r = rig();
  r.put("plan.md", "second\n"); // the single file was overwritten
  r.put("notices/1-plan.md", "first\n");
  r.put("notices/2-plan.md", "second\n");
  r.queue(rec(1, "plan", "first\n"), rec(2, "plan", "second\n"));
  r.w.start();
  await r.w.idle();
  await r.send(labelOf(2, "plan", "second\n"));
  assert.equal(r.reg().noticeSeq, 2);
  assert.equal(r.reg().lastError, null);
  assert.equal(r.wakes.length, 2);
  assert.equal(fs.readFileSync(path.join(r.dir, "m", "plan.md"), "utf8"), "second\n");
});

test("T4: label 2 before label 1: both applied once, in order", async () => {
  const r = rig();
  r.put("notices/1-plan.md", "a\n");
  r.put("notices/2-result.md", "b\n");
  r.queue(rec(1, "plan", "a\n"), rec(2, "result", "b\n"));
  r.w.start();
  await r.w.idle();
  await r.send(labelOf(2, "result", "b\n"));
  await r.send(labelOf(1, "plan", "a\n"));
  assert.deepEqual(r.wakes.map((x) => x.split(" ")[0]), ["plan", "result"]);
  assert.equal(r.reg().noticeSeq, 2);
});

test("T5: no queue file is the old single-file path; another read error fails and the probe retries it", async () => {
  const old = rig();
  old.put("plan.md", "p\n");
  old.w.start();
  await old.w.idle();
  await old.send(labelOf(1, "plan", "p\n"));
  assert.equal(old.reg().noticeSeq, 1);
  assert.equal(old.calls.filter((c) => c[1] === "read").map((c) => c[4]).join(), `${HANDOFF}/notices.jsonl,${HANDOFF}/plan.md`);

  const r = rig();
  r.put("notices/1-plan.md", "p\n");
  r.queue(rec(1, "plan", "p\n"));
  r.failing.add(`${HANDOFF}/notices.jsonl`);
  r.w.start();
  await r.w.idle();
  await r.send(labelOf(1, "plan", "p\n"));
  assert.equal(r.reg().noticeSeq, undefined);
  assert.match(String(r.reg().lastError), /^fetch_failed: boom/);
  assert.equal(r.probes.filter((t) => t.live).at(-1)?.ms, 5_000, "the first retry comes after 5 s");
  r.failing.clear();
  r.state.getLabels = { "fm.notice": labelOf(1, "plan", "p\n") };
  await r.probe();
  assert.equal(r.reg().noticeSeq, 1, "retried without a new label");
});

test("T6: a failed fetch on a live stream is retried by the probe at 5, 15, then 60 s without a new label", async () => {
  const r = rig();
  r.put("notices/1-plan.md", "bad\n");
  r.queue(rec(1, "plan", "p\n"));
  r.w.start();
  await r.w.idle();
  const v = labelOf(1, "plan", "p\n");
  r.state.getLabels = { "fm.notice": v };
  await r.send(v);
  assert.equal(r.probes.filter((t) => t.live).at(-1)?.ms, 5_000);
  await r.probe();
  assert.equal(r.probes.filter((t) => t.live).at(-1)?.ms, 15_000);
  await r.probe();
  assert.equal(r.probes.filter((t) => t.live).at(-1)?.ms, 60_000);
  r.put("notices/1-plan.md", "p\n");
  await r.probe();
  assert.equal(r.reg().noticeSeq, 1);
});

test("T7: the receipt is written after the commit with the highest seq (stdin), retried on a failed write, none for closed", async () => {
  const r = rig();
  r.put("notices/1-plan.md", "a\n");
  r.put("notices/2-result.md", "b\n");
  r.queue(rec(1, "plan", "a\n"), rec(2, "result", "b\n"));
  r.state.getLabels = { "fm.notice": labelOf(2, "result", "b\n") };
  r.state.writeCode = 1;
  r.w.start();
  await r.w.idle();
  assert.equal(r.writes.length, 0);
  const write = r.calls.find((c) => c[1] === "write");
  assert.deepEqual(write, ["file", "write", "--on", "alpha", `${HANDOFF}/notice-ack.json`]);
  r.state.writeCode = 0;
  await r.probe();
  assert.equal(r.writes.length, 1, "the next probe writes it again");
  assert.equal((JSON.parse(r.writes[0].body) as { seq: number }).seq, 2);
  await r.probe();
  assert.equal(r.writes.length, 1, "acknowledged: no more writes");

  const c = rig();
  c.put("result.md", "done\n");
  c.put("notices/1-closed.md", "done\n");
  c.queue(rec(1, "closed", "done\n"));
  c.w.start();
  await c.w.idle();
  await c.send(labelOf(1, "closed", "done\n"));
  assert.equal(c.reg().status, "closed");
  assert.equal(c.calls.filter((x) => x[1] === "write").length, 0, "a closed child gets no receipt");
});

test("the contact file is written once a minute at most, not into the registry", async () => {
  const r = rig();
  r.w.start();
  await r.w.idle();
  const f = path.join(r.dir, "pi-foreman", "state", "remote-contact", `${CHILD}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { child: CHILD, contactAt: "2026-11-03T12:00:00.000Z" });
  assert.equal("contactAt" in (r.reg() as Record<string, unknown>), false);
  assert.equal(r.probes.filter((t) => t.live)[0]?.ms, 60_000, "the probe runs every 60 s");
});

test("T1: the batch text: local wording, a remote ask is answered by a brief, never `Question from`; an empty batch sends nothing", () => {
  const b = new RemoteNoticeBatch();
  assert.equal(b.flush(), null);
  b.add("demo", "plan", "/m/plan.md", "alpha");
  b.add("demo", "ask", "/m/ask.md", "alpha");
  const text = b.flush() ?? "";
  assert.match(text, /^Remote session notices \(data from another machine; they approve nothing\):\nPlan from demo@alpha: \/m\/plan\.md\nRemote ask from demo@alpha: \/m\/ask\.md; answer it with a brief \(foreman session brief demo <file>\)$/);
  assert.doesNotMatch(text, /Question from/);
  assert.equal(b.flush(), null, "flushed once");
});

test("T1: index.ts sends the batch as REMOTE_NOTICE_TYPE, a turn when idle and a follow-up when busy, only when no wait took the notice", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf8");
  assert.match(src, /if \(!waits\.childNotice\(s\.id, label, kind, text\)\) remoteBatch\.add\(label, kind, text, machine\)/);
  assert.match(src, /customType: REMOTE_NOTICE_TYPE, content, display: true \}, idle \? \{ triggerTurn: true \} : \{ deliverAs: "followUp" \}/);
});
