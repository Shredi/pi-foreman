import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveState, prWatchWait, liveDir } from "../livestate.ts";
import type { LiveFile, LiveWait } from "../livestate.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { ReviewFacts } from "../prready.ts";
import type { PrKey } from "../prhost.ts";

const key = (repo: string, host = "github.com") => ({ repo, host });
const A = "a".repeat(40);
const B = "b".repeat(40);
const fact = (n: number, head: string, state: "ok" | "wip" | "unreviewed", noChecks?: boolean) => ({ n, repo: "owner/repo", host: "github.com", head, state, ...(noChecks ? { noChecks } : {}) });

test("prWatchWait without the review input is what it was; the unreviewed field stays", () => {
  const w = prWatchWait([{ n: 5, key: key("owner/repo") }], [{ n: 5, repo: "owner/repo", host: "github.com" }]);
  assert.deepEqual(w, { id: "pr_watch", kind: "pr", note: "1 pr watch", ageSeconds: 0, leftSeconds: 0, prs: [5], prRefs: [{ n: 5, repo: "owner/repo", host: "github.com" }], unreviewed: [{ n: 5, repo: "owner/repo", host: "github.com" }] });
  assert.equal("review" in prWatchWait([{ n: 5, key: key("owner/repo") }], [], []), false);
});

test("prWatchWait with review facts carries them beside unreviewed", () => {
  const review = [fact(5, A, "ok"), fact(6, B, "unreviewed", true)];
  const w = prWatchWait([{ n: 5, key: key("owner/repo") }, { n: 6, key: key("owner/repo") }], [{ n: 6, repo: "owner/repo", host: "github.com" }], review);
  assert.deepEqual(w?.review, review);
  assert.equal(w?.unreviewed?.length, 1);
});

function liveWith(wait: LiveWait): LiveFile {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-review-"));
  try {
    const live = LiveState.start({ agentDir: dir, sessionId: "s1", cwd: dir, mode: "rpc", env: {} }, () => [], undefined, () => [wait]);
    assert.ok(live);
    live.stop();
    return JSON.parse(fs.readFileSync(path.join(liveDir(dir), "s1.json"), "utf8")) as LiveFile;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the live file keeps well-formed review facts and drops malformed ones; a wait without them has no field", () => {
  const base = prWatchWait([{ n: 5, key: key("owner/repo") }], [])!;
  const bad = [{ n: 7, repo: "r", host: "", head: A, state: "ready" }, { n: 1.5, repo: "r", host: "", head: A, state: "ok" }, { n: 8, repo: "r", host: "", state: "ok" }] as unknown as NonNullable<LiveWait["review"]>;
  const f = liveWith({ ...base, review: [fact(5, A, "ok", true), ...bad] });
  assert.deepEqual(f.waits[0].review, [fact(5, A, "ok", true)]);
  assert.equal("review" in liveWith(base).waits[0], false);
});

const K: PrKey = { host: "github.com", repo: "owner/repo", n: 7 };
const K2: PrKey = { host: "github.com", repo: "owner/repo", n: 8 };
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }], comments: [], ...o });

function watches(o: { facts?: (head: string) => ReviewFacts; gate?: boolean; noFacts?: boolean } = {}) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const h = { read: { kind: "entry", snap: snap(), okAt: 1000 } as StoreRead, facts: o.facts ?? ((): ReviewFacts => "ok") };
  const w = new PrWatches({
    storeEntry: () => h.read,
    githubHosts: () => ({ hosts: ["github.com"] }),
    ...(o.noFacts ? {} : { reviewFacts: (head: string) => h.facts(head) }),
    reviewGate: () => o.gate ?? true,
    persist: () => {},
    cwd: () => "/work",
    child: () => false,
    send: () => {},
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => 0,
    now: () => 0,
    timers,
  });
  const tick = async () => {
    fns.shift()?.();
    await new Promise((r) => setImmediate(r));
  };
  return { w, h, tick };
}

test("the live file carries facts only for owned PRs, for the host head the watch last evaluated", () => {
  const x = watches();
  x.w.start(K, snap(), null, true);
  x.w.start(K2, snap(), null, false);
  assert.deepEqual(x.w.reviewLive(), [{ n: 7, repo: "owner/repo", host: "github.com", head: A, state: "ok" }]);
});

test("the fact follows the session at once (a revision) and the head the watch saw (a new head)", async () => {
  let state: ReviewFacts = "ok";
  const x = watches({ facts: () => state });
  x.w.start(K, snap(), null, true);
  state = "wip";
  assert.equal(x.w.reviewLive()[0].state, "wip");
  state = "ok";
  x.h.read = { kind: "entry", snap: snap({ head: B, updatedAt: "t2" }), okAt: 2000 };
  await x.tick();
  assert.equal(x.w.reviewLive()[0].head, B);
});

test("noChecks is set once the watch confirmed that the head has no checks", async () => {
  const x = watches();
  x.h.read = { kind: "entry", snap: snap({ runs: [] }), okAt: 1000 };
  x.w.start(K, snap({ runs: [] }), null, true);
  assert.equal(x.w.reviewLive()[0].noChecks, undefined);
  await x.tick();
  assert.equal(x.w.reviewLive()[0].noChecks, true);
});

test("no facts without a facts source, with the review gate off, or when the source throws", () => {
  const a = watches({ noFacts: true });
  a.w.start(K, snap(), null, true);
  assert.deepEqual(a.w.reviewLive(), []);
  const b = watches({ gate: false });
  b.w.start(K, snap(), null, true);
  assert.deepEqual(b.w.reviewLive(), []);
  const c = watches({ facts: () => { throw new Error("x"); } });
  c.w.start(K, snap(), null, true);
  assert.deepEqual(c.w.reviewLive(), []);
});
