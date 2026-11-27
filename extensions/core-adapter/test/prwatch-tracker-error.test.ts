// D214: a tracker error (a failed tracked step stored in tracked-prs-state.json) reaches the watch as an error, not as "no tracker", and is reported once per new text.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pollPrs } from "../prs-cli.ts";
import type { PollDeps } from "../prs-cli.ts";
import { clearStoreCache, readStoreEntry, trackedStateFile } from "../prstore.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { MergedConfig } from "../config.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const K: PrKey = { host: "github.com", repo: "acme/app", n: 5 };
const flush = () => new Promise((r) => setImmediate(r));

function deps(agentDir: string, python: boolean): PollDeps {
  const clock = { t: 50_000_000 };
  return {
    agentDir,
    pkgRoot: PKG,
    now: () => (clock.t += 1000),
    resolve: async (p) => (python ? { ok: true, info: { executable: p ?? "/py", version: [3, 13], source: "test" }, rejected: [] } : { ok: false, rejected: ["python: too old"] }),
    loadConfig: async () => ({ config: { radar: { openPrs: { mine: false } } }, warnings: [], errors: [], safetyFallback: false, roles: {}, source: "cli" }) as MergedConfig,
    runOp: () => async () => ({ kind: "ran", result: { prs: [], errors: [], comments: [] } }) as SafeOpOutcome,
    refresh: async () => "off",
  } as PollDeps;
}

test("a poll whose tracked step cannot run writes the state file with the error; the store reads error, not down", async () => {
  clearStoreCache();
  const agentDir = mkTestTmp("trackerr-");
  try {
    const d = deps(agentDir, false);
    const res = await pollPrs(d);
    assert.match(res.error ?? "", /no Python/);
    const file = trackedStateFile(agentDir);
    assert.equal(fs.existsSync(file), true, "the state file is never absent after a poll");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.match(doc.error, /no Python/);
    const r = readStoreEntry(agentDir, K, d.now(), true);
    assert.equal(r.kind, "error");
    assert.match(r.kind === "error" ? r.error : "", /no Python/);
    // a run that gets through writes the file without the error
    const ok = await pollPrs(deps(agentDir, true));
    assert.equal(ok.error, undefined);
    assert.equal("error" in JSON.parse(fs.readFileSync(file, "utf8")), false);
  } finally {
    rmTestTmp(agentDir);
  }
});

test("the watch reports a tracker error once per new text", async () => {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const h = { read: { kind: "error", error: "no Python >= 3.13 found" } as StoreRead };
  const watches = new PrWatches({ storeEntry: () => h.read, send: (m) => void sent.push(m.content), idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers });
  const tick = async () => {
    fns.shift()?.();
    await flush();
  };
  watches.startPending(K);
  await tick();
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /the tracker's last poll failed: no Python >= 3.13 found/);
  h.read = { kind: "error", error: "rate limit" };
  await tick();
  assert.equal(sent.length, 2);
  h.read = { kind: "waiting" };
  await tick();
  h.read = { kind: "error", error: "rate limit" };
  await tick();
  assert.equal(sent.length, 3, "after the error cleared, the same text is news again");
});

test("two watches: one failing, one waiting; the error is noticed once, not on every tick", async () => {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const K2: PrKey = { host: "github.com", repo: "acme/app", n: 6 };
  const storeEntry = (k: PrKey): StoreRead => (k.n === K.n ? { kind: "error", error: "rate limit" } : { kind: "waiting" });
  const watches = new PrWatches({ storeEntry, send: (m) => void sent.push(m.content), idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers });
  watches.startPending(K);
  watches.startPending(K2);
  for (let i = 0; i < 10; i++) {
    fns.shift()?.();
    await flush();
  }
  assert.equal(sent.filter((s) => /last poll failed: rate limit/.test(s)).length, 1);
});
