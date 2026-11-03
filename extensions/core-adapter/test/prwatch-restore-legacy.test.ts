import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchRecord } from "../prwatch.ts";
import { clearStoreCache, readStoreEntry, trackedStateFile } from "../prstore.ts";

const state = { head: "", failedIds: [], ci: "", mergeable: "" as const, commentIds: [], updatedAt: "", noCi: 0, noCiHead: "", readyHead: "", last: "watching" };
const rec = (host: string, repo: string, n: number): WatchRecord => ({ key: { host, repo, n }, cwd: "/work", startedAt: 1, state });
const flush = () => new Promise((r) => setImmediate(r));

function rig(read: (w: { host: string; repo: string; n: number }) => StoreRead) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const w = new PrWatches({ storeEntry: read, send: (m) => void sent.push(m.content), idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 1_000_000, timers });
  const tick = async () => {
    const batch = fns.splice(0);
    for (const f of batch) f();
    await flush();
  };
  return { w, sent, tick, flush };
}

const restore = (watches: WatchRecord[]) => ({ status: "ok" as const, watches, bad: 0 });

test("a restored github watch next to a number-only one, no state file: one tracker-down notice in 6 ticks", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-legacy-"));
  try {
    clearStoreCache();
    const x = rig((k) => readStoreEntry(agentDir, k, 1_000_000, true));
    x.w.restore(restore([rec("github.com", "acme/app", 7), rec("", "", 3)]));
    await x.flush();
    for (let i = 0; i < 5; i++) await x.tick();
    assert.equal(x.sent.filter((s) => s.includes("no PR tracker running")).length, 1);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("restored non-github.com and number-only watches end once with the lost message", async () => {
  const x = rig(() => ({ kind: "down" }));
  x.w.restore(restore([rec("ghe.example.com", "acme/app", 4), rec("", "", 3)]));
  await x.flush();
  await x.tick();
  await x.tick();
  const lost = x.sent.filter((s) => s.includes("watch lost on restart: the PR tracker covers github.com only"));
  assert.equal(lost.length, 2);
  assert.match(lost[0], /PR #4/);
  assert.match(lost[1], /PR #3/);
  assert.equal(x.w.list().length, 0);
});

test("a number-only key is not resolved (that would need a GitHub call): it ends and a github watch stays", async () => {
  const x = rig(() => ({ kind: "waiting" }));
  x.w.restore(restore([rec("", "", 3), rec("github.com", "acme/app", 7)]));
  await x.flush();
  assert.deepEqual(x.w.list().map((l) => l.n), [7]);
});

test("tracker down, up, down with a legacy watch present: two notices", async () => {
  let up = false;
  const x = rig((k) => (!up ? { kind: "down" } : k.host === "github.com" ? { kind: "waiting" } : { kind: "error", error: "only github.com PRs are tracked" }));
  x.w.restore(restore([rec("github.com", "acme/app", 7), rec("", "", 3)]));
  await x.flush();
  await x.tick();
  up = true;
  await x.tick();
  up = false;
  await x.tick();
  await x.tick();
  assert.equal(x.sent.filter((s) => s.includes("no PR tracker running")).length, 2);
});
