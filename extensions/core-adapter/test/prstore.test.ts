import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addTracked, clearStoreCache, readStoreEntry, storeKey, trackedCommentsFile, trackedFile, trackedStateFile } from "../prstore.ts";
import type { PrKey } from "../prhost.ts";

const K: PrKey = { host: "github.com", repo: "Acme/App", n: 7 };
const NOW = 10_000_000;

const snap = (o: Record<string, unknown> = {}) => ({ state: "open", mergeable: "mergeable", head: "abc", base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }], ...o });

function setup(entry: Record<string, unknown> | null, o: { trackedAt?: number; comments?: unknown; off?: boolean } = {}): string {
  clearStoreCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prstore-"));
  fs.mkdirSync(path.dirname(trackedStateFile(dir)), { recursive: true });
  const prs = entry ? { [storeKey("acme/app", 7)]: { repo: "acme/app", number: 7, at: NOW, ...entry } } : {};
  fs.writeFileSync(trackedStateFile(dir), JSON.stringify({ v: 1, trackedAt: o.trackedAt ?? NOW - 1000, ...(o.off ? { off: true } : {}), prs }));
  if (o.comments !== undefined) fs.writeFileSync(trackedCommentsFile(dir), JSON.stringify(o.comments));
  return dir;
}
const goodComments = { v: 1, prs: { [storeKey("acme/app", 7)]: { updatedAt: "t1", comments: [{ id: "c1", kind: "issue", author: "bob", body: "hi" }] } } };

test("readStoreEntry: serves a fresh open entry with its comments, key match is case-insensitive", () => {
  const dir = setup({ snap: snap(), okAt: NOW - 1000 }, { comments: goodComments });
  const r = readStoreEntry(dir, K, NOW, true);
  assert.equal(r.kind, "entry");
  if (r.kind !== "entry") return;
  assert.equal(r.okAt, NOW - 1000);
  assert.equal(r.snap.comments?.length, 1);
  assert.equal(readStoreEntry(dir, { ...K, host: "GitHub.com" }, NOW, true).kind, "entry");
});

test("readStoreEntry: a missing or differing comments entry gives a snap without comments", () => {
  const dir = setup({ snap: snap(), okAt: NOW - 1000 });
  const r = readStoreEntry(dir, K, NOW, true);
  assert.equal(r.kind === "entry" && r.snap.comments, undefined);
  const dir2 = setup({ snap: snap({ updatedAt: "t2" }), okAt: NOW - 1000 }, { comments: goodComments });
  const r2 = readStoreEntry(dir2, K, NOW, true);
  assert.equal(r2.kind === "entry" && r2.snap.comments, undefined);
});

test("readStoreEntry: down when the feed is off, the state file is missing, off, or its trackedAt is older than 10 min", () => {
  const dir = setup({ snap: snap(), okAt: NOW - 1000 });
  assert.equal(readStoreEntry(dir, K, NOW, false).kind, "down");
  clearStoreCache();
  assert.equal(readStoreEntry(fs.mkdtempSync(path.join(os.tmpdir(), "pf-prstore-")), K, NOW, true).kind, "down");
  assert.equal(readStoreEntry(setup({ snap: snap(), okAt: NOW - 1000 }, { trackedAt: NOW - 600_001 }), K, NOW, true).kind, "down");
  assert.equal(readStoreEntry(setup({ snap: snap(), okAt: NOW - 1000 }, { off: true }), K, NOW, true).kind, "down");
});

test("readStoreEntry: a non-github.com host or an empty repo is an error", () => {
  const dir = setup({ snap: snap(), okAt: NOW - 1000 });
  assert.equal(readStoreEntry(dir, { ...K, host: "gitlab.com" }, NOW, true).kind, "error");
  assert.equal(readStoreEntry(dir, { ...K, repo: "" }, NOW, true).kind, "error");
});

test("readStoreEntry: waiting without an entry or a snap", () => {
  assert.equal(readStoreEntry(setup(null), K, NOW, true).kind, "waiting");
  assert.equal(readStoreEntry(setup({}), K, NOW, true).kind, "waiting");
});

test("readStoreEntry: errorAt newer than okAt is the tracker's error, gone is flagged", () => {
  const r = readStoreEntry(setup({ snap: snap(), okAt: NOW - 5000, error: "boom", errorAt: NOW - 1000 }), K, NOW, true);
  assert.deepEqual(r, { kind: "error", error: "boom" });
  const g = readStoreEntry(setup({ error: "the pull request was not found", errorAt: NOW - 1000, gone: true }), K, NOW, true);
  assert.equal(g.kind === "error" && g.gone, true);
});

test("readStoreEntry: an open snap older than 10 min is stale", () => {
  assert.equal(readStoreEntry(setup({ snap: snap(), okAt: NOW - 600_001 }), K, NOW, true).kind, "stale");
});

test("readStoreEntry: an ended snap is returned whatever its age", () => {
  for (const state of ["merged", "closed"]) {
    const r = readStoreEntry(setup({ snap: snap({ state }), okAt: NOW - 700_000, endedAt: NOW - 700_000 }), K, NOW, true);
    assert.equal(r.kind === "entry" && r.snap.state, state);
  }
});

test("readStoreEntry: an mtime change re-parses the file", () => {
  const dir = setup({ snap: snap(), okAt: NOW - 1000 });
  assert.equal(readStoreEntry(dir, K, NOW, true).kind, "entry");
  const file = trackedStateFile(dir);
  fs.writeFileSync(file, JSON.stringify({ v: 1, trackedAt: NOW - 1000, prs: {} }));
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(file, t, t);
  assert.equal(readStoreEntry(dir, K, NOW, true).kind, "waiting");
});

test("readStoreEntry: an unparseable state file is down", () => {
  const dir = setup(null);
  fs.writeFileSync(trackedStateFile(dir), "{nope");
  assert.equal(readStoreEntry(dir, K, NOW, true).kind, "down");
});

test("addTracked: adds once, case-insensitive, and never overwrites an unparseable list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prstore-"));
  assert.equal(await addTracked(dir, "Acme/App", 7, () => NOW), "added");
  assert.equal(await addTracked(dir, "acme/app", 7, () => NOW), "present");
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "pf-prstore-"));
  fs.mkdirSync(path.dirname(trackedFile(bad)), { recursive: true });
  fs.writeFileSync(trackedFile(bad), "garbage");
  assert.equal(await addTracked(bad, "acme/app", 7), "unavailable");
  assert.equal(fs.readFileSync(trackedFile(bad), "utf8"), "garbage");
});
