// T9: the child's view of the delivery receipt (remotereceipt.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseReceipt, parseReports, ReceiptWatch, receiptState, RECEIPT_ENTRY } from "../remotereceipt.ts";
import type { NotedSeqs } from "../remotereceipt.ts";

const T0 = Date.parse("2026-11-03T12:00:00Z");
const recs = (...seqs: number[]) => seqs.map((seq) => ({ seq, kind: "result", at: T0 }));

test("receiptState: pending under 5 minutes, not confirmed after, delivered with the receipt time", () => {
  assert.equal(receiptState(recs(1), null, T0 + 30_000).status, "report #1 (result) sent, not yet confirmed");
  assert.deepEqual(receiptState(recs(1), null, T0 + 30_000).unconfirmed, []);
  const late = receiptState(recs(1), null, T0 + 6 * 60_000);
  assert.equal(late.status, "report #1 (result) not confirmed by the parent for 6 min");
  assert.deepEqual(late.unconfirmed.map((r) => r.seq), [1]);
  const ack = { seq: 1, at: T0 + 60_000 };
  const done = receiptState(recs(1), ack, T0 + 2 * 60_000);
  assert.match(done.status ?? "", /^report #1 delivered to parent at \d\d:\d\d$/);
  assert.equal(done.pending, false);
  assert.equal(receiptState(recs(1), ack, T0 + 12 * 60_000).status, undefined, "cleared after 10 minutes");
  assert.equal(receiptState(recs(1, 2), ack, T0 + 90_000).status, "report #2 (result) sent, not yet confirmed", "the receipt covers seq 1 only");
});

test("an unreadable or half-written receipt is no receipt; closed records are ignored", () => {
  assert.equal(parseReceipt('{"seq": 1, "at": "2026-11'), null);
  assert.equal(parseReceipt(null), null);
  assert.equal(parseReceipt('{"seq":"1","at":"x"}'), null);
  assert.deepEqual(parseReceipt('{"seq":2,"at":"2026-11-03T12:00:00Z"}'), { seq: 2, at: T0 });
  const text = [{ seq: 1, kind: "closed", at: "2026-11-03T12:00:00Z" }, { seq: 2, kind: "plan", at: "2026-11-03T12:00:00Z" }].map((x) => JSON.stringify(x)).join("\n") + "\nnot json\n";
  assert.deepEqual(parseReports(text).map((r) => r.seq), [2]);
});

function rig(noted?: NotedSeqs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-receipt-"));
  const state = { now: T0, status: undefined as string | undefined, notes: [] as string[], persisted: [] as NotedSeqs[], timers: [] as number[] };
  const w = new ReceiptWatch({
    handoff: () => dir,
    now: () => state.now,
    setStatus: (t) => void (state.status = t),
    note: (t) => void state.notes.push(t),
    persist: (n) => void state.persisted.push(n),
    timer: (_fn, ms) => (state.timers.push(ms), () => undefined),
  });
  if (noted) w.restore([{ type: "custom", customType: RECEIPT_ENTRY, data: noted }]);
  const report = (seq: number, kind = "result"): void => fs.appendFileSync(path.join(dir, "notices.jsonl"), `${JSON.stringify({ seq, kind, at: new Date(T0).toISOString() })}\n`);
  const ack = (seq: number, at = T0 + 60_000): void => fs.writeFileSync(path.join(dir, "notice-ack.json"), JSON.stringify({ seq, at: new Date(at).toISOString() }));
  return { dir, w, state, report, ack };
}

test("ReceiptWatch: pending polls every 5 s, one unconfirmed note after 5 minutes, one delivered note after the receipt", () => {
  const r = rig();
  r.w.start();
  assert.equal(r.state.timers.at(-1), 30_000, "nothing pending: 30 s");
  r.report(1);
  r.w.tick();
  assert.equal(r.state.status, "report #1 (result) sent, not yet confirmed");
  assert.equal(r.state.timers.at(-1), 5_000);
  assert.deepEqual(r.state.notes, []);
  r.state.now = T0 + 6 * 60_000;
  r.w.tick();
  r.w.tick();
  assert.equal(r.state.notes.length, 1, "one note");
  assert.match(r.state.notes[0], /^Your result report #1 has no receipt from the parent after 5 minutes\. Do not say it was delivered\.$/);
  r.ack(1, T0 + 7 * 60_000);
  r.state.now = T0 + 7 * 60_000;
  r.w.tick();
  r.w.tick();
  assert.equal(r.state.notes.length, 2);
  assert.match(r.state.notes[1], /^report #1 \(result\) delivered to parent at \d\d:\d\d$/);
  assert.match(r.state.status ?? "", /delivered to parent at/);
  assert.equal(r.state.timers.at(-1), 30_000);
});

test("ReceiptWatch: a reload with the noted seqs repeats no note; a half-written receipt counts as none", () => {
  const r = rig({ unconfirmed: [1], delivered: [1] });
  r.report(1);
  r.ack(1);
  r.state.now = T0 + 6 * 60_000;
  r.w.start();
  assert.deepEqual(r.state.notes, []);
  const h = rig();
  h.report(1);
  fs.writeFileSync(path.join(h.dir, "notice-ack.json"), '{"seq":1,"a');
  h.w.start();
  assert.equal(h.state.status, "report #1 (result) sent, not yet confirmed");
  assert.deepEqual(h.state.notes, []);
});
