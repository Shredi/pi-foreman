// D206: open review threads are counted, reported once, and hold the ready line and the ready label.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineOf, pollWatch, prDelta, prMessage, threadsOf } from "../prwatch.ts";
import type { Bucket, Run, WatchSnapshot } from "../prwatch.ts";
import { labelTarget } from "../prready.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { PrKey } from "../prhost.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const run = (name: string, bucket: Bucket): Run => ({ id: name, name, bucket, url: `https://h.invalid/${name}` });
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abcdef0123456789", base: "main", updatedAt: "t0", runs: [], ...o });
const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result: { ok: true, ...result } });
const open = { open: 2, lines: ["rename this", "missing test"] };

test("an open thread holds the ready line; resolved, the line follows and the thread set is not reported again", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")] }));
  const held = prDelta(base, snap({ runs: [run("a", "passed")], threads: open }), true);
  assert.deepEqual(held.delta?.events, ["checks finished: pass", "open review threads"]);
  assert.ok(!held.delta!.events.includes("ready to merge"));
  const msg = prMessage(7, held.delta!).content;
  assert.match(msg, /^pi-foreman-pr: PR #7 checks finished: pass, open review threads /);
  assert.match(msg, /\n- 2 open review threads \(the ready line waits until they are resolved\)\n- open thread: rename this\n- open thread: missing test/);
  assert.ok(!msg.includes("ready to merge"));
  // the same set on the next tick: silent, still held
  assert.equal(prDelta(held.state, snap({ runs: [run("a", "passed")], threads: open }), true).delta, null);
  // resolved: the ready line is sent
  const done = prDelta(held.state, snap({ runs: [run("a", "passed")] }), true);
  assert.deepEqual(done.delta?.events, ["ready to merge"]);
  // a thread opened later is news again
  assert.deepEqual(prDelta(done.state, snap({ runs: [run("a", "passed")], threads: { open: 1, lines: ["late"] } }), true).delta?.events, ["open review threads"]);
});

test("a changed set is reported again; 'at least' when the first page was full", () => {
  const runs = [run("a", "pending")];
  const first = prDelta(baselineOf(snap({ runs })), snap({ runs, threads: { open: 1, lines: ["a"] } }), false);
  assert.deepEqual(first.delta?.events, ["open review threads"]);
  const more = prDelta(first.state, snap({ runs, threads: { open: 100, more: true, lines: ["a"] } }), false);
  assert.match(prMessage(7, more.delta!).content, /\n- at least 100 open review threads /);
  assert.match(prMessage(7, first.delta!).content, /\n- 1 open review thread \(/);
});

test("no threads field (none open, or a host without the field) changes nothing", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")] }));
  assert.deepEqual(prDelta(base, snap({ runs: [run("a", "passed")] }), true).delta?.events, ["checks finished: pass", "ready to merge"]);
});

test("labelTarget: an open thread keeps the ready label off", () => {
  const ready = { facts: "ok" as const, checks: "green" as const, mergeable: "mergeable" as const, mergeState: "clean", draft: false };
  assert.equal(labelTarget(ready), true);
  assert.equal(labelTarget({ ...ready, threadsOpen: true }), false);
  assert.equal(labelTarget({ ...ready, threadsOpen: true, checks: "running" }), null);
});

test("threadsOf: only a positive count, cut short", () => {
  assert.equal(threadsOf({ open: 0, lines: [] }), undefined);
  assert.equal(threadsOf(undefined), undefined);
  assert.deepEqual(threadsOf({ open: 3, more: true, lines: ["x".repeat(500), 7, "b"] }), { open: 3, more: true, lines: ["x".repeat(160), "b"] });
});

test("pollWatch carries the batch item's threads into the snapshot, and pr_status's openThreads for a single poll", async () => {
  const item = { repo: "acme/app", number: 7, state: "open", mergeable: "mergeable", headSha: "h1", baseRef: "main", updatedAt: "t0", runs: [], threads: open };
  const r = (async (op: string) => (op === "pr_batch" ? ran({ prs: [item], errors: [] }) : ran({ comments: [] }))) as never;
  const p = (await pollWatch(r, K, { updatedAt: "t0" })) as { snap: WatchSnapshot };
  assert.deepEqual(p.snap.threads, open);
  const plain = (async (op: string) => (op === "pr_batch" ? ran({ prs: [{ ...item, threads: undefined }], errors: [] }) : ran({ comments: [] }))) as never;
  assert.equal(((await pollWatch(plain, K, { updatedAt: "t0" })) as { snap: WatchSnapshot }).snap.threads, undefined);
});
