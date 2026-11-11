import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { baselineOf, prDelta, prMessage } from "../prwatch.ts";
import type { Bucket, Run, WatchSnapshot } from "../prwatch.ts";
import { clearStoreCache, readStoreEntry, storeKey, trackedStateFile } from "../prstore.ts";
import type { PrKey } from "../prhost.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const NOW = 10_000_000;
const SHA = "abcdef0123456789";

const run = (name: string, bucket: Bucket): Run => ({ id: name, name, bucket, url: `https://h.invalid/${name}` });
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: SHA, base: "main", updatedAt: "t0", runs: [], ...o });

const DRAFT_LINE = /\nreport to the parent: PR #7 green on abcdef0, mergeable, still a draft$/;

test("draft: a child whose draft PR has passing checks says draft in the message and the report line, never ready", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], mergeable: "unknown", draft: true }));
  const { delta } = prDelta(base, snap({ runs: [run("a", "passed")], draft: true }), true);
  assert.deepEqual(delta?.events, ["checks finished: pass, draft", "green, still a draft"]);
  const msg = prMessage(7, delta!).content;
  assert.match(msg, /checks finished: pass, draft/);
  assert.match(msg, DRAFT_LINE);
  assert.ok(!msg.includes("ready to merge"));
});

test("draft: mergeable known one tick after the checks settled, the draft report line still comes once", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], mergeable: "unknown", draft: true }));
  const first = prDelta(base, snap({ runs: [run("a", "passed")], mergeable: "unknown", draft: true }), true);
  assert.deepEqual(first.delta?.events, ["checks finished: pass, draft"]);
  assert.ok(!prMessage(7, first.delta!).content.includes("report to the parent"));
  const second = prDelta(first.state, snap({ runs: [run("a", "passed")], draft: true }), true);
  assert.deepEqual(second.delta?.events, ["green, still a draft"]);
  assert.match(prMessage(7, second.delta!).content, DRAFT_LINE);
  assert.equal(prDelta(second.state, snap({ runs: [run("a", "passed")], draft: true }), true).delta, null);
});

test("draft: a top-level session gets the draft checks line and no report line", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], mergeable: "unknown", draft: true }));
  const { delta } = prDelta(base, snap({ runs: [run("a", "passed")], draft: true }), false);
  assert.deepEqual(delta?.events, ["checks finished: pass, draft"]);
  assert.ok(!prMessage(7, delta!).content.includes("report to the parent"));
});

test("draft: the same PR not in draft gives the ready lines as before", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], mergeable: "unknown" }));
  const { delta } = prDelta(base, snap({ runs: [run("a", "passed")] }), true);
  assert.deepEqual(delta?.events, ["checks finished: pass", "ready to merge"]);
  assert.match(prMessage(7, delta!).content, /\nreport to the parent: PR #7 green on abcdef0, mergeable, ready to merge$/);
});

test("draft: marked ready for review on the same head, the ready lines come once", () => {
  const base = baselineOf(snap({ runs: [run("a", "pending")], mergeable: "unknown", draft: true }));
  const draft = prDelta(base, snap({ runs: [run("a", "passed")], draft: true }), true);
  assert.deepEqual(draft.delta?.events, ["checks finished: pass, draft", "green, still a draft"]);
  const ready = prDelta(draft.state, snap({ runs: [run("a", "passed")] }), true);
  assert.deepEqual(ready.delta?.events, ["ready to merge"]);
  assert.match(prMessage(7, ready.delta!).content, /\nreport to the parent: PR #7 green on abcdef0, mergeable, ready to merge$/);
  assert.equal(prDelta(ready.state, snap({ runs: [run("a", "passed")] }), true).delta, null);
});

test("draft: the tracker's draft flag reaches the watch snap; an absent one is not draft", () => {
  const meta = { url: "u", title: "t", headRefName: "b", headRepo: "acme/app" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-draft-"));
  fs.mkdirSync(path.dirname(trackedStateFile(dir)), { recursive: true });
  const write = (entryMeta: Record<string, unknown> | undefined) => {
    fs.writeFileSync(trackedStateFile(dir), JSON.stringify({ v: 1, trackedAt: NOW - 1000, prs: { [storeKey("acme/app", 7)]: { repo: "acme/app", number: 7, at: NOW, okAt: NOW - 1000, snap: { state: "open", mergeable: "mergeable", head: SHA, base: "main", updatedAt: "t1", runs: [] }, ...(entryMeta ? { meta: entryMeta } : {}) } } }));
    clearStoreCache();
    return readStoreEntry(dir, K, NOW, true);
  };
  const drafted = write({ ...meta, draft: true });
  assert.equal(drafted.kind === "entry" && drafted.snap.draft, true);
  const open = write({ ...meta, draft: false });
  assert.equal(open.kind === "entry" && open.snap.draft, false);
  const none = write(undefined);
  assert.equal(none.kind === "entry" && none.snap.draft, undefined);
});
