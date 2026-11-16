import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hiddenRepo, openPrsConfig, openPrsFile, refreshOpenPrs, remarkOpenPrs } from "../openprs.ts";
import type { GhRunner, OpenPr, OpenPrsFile } from "../openprs.ts";
import { clearStoreCache, readStoreEntry, trackedStateFile } from "../prstore.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const node = (n: number, repo: string) => ({
  number: n, title: `PR ${n}`, url: `https://example.test/${repo}/pull/${n}`, isDraft: false, updatedAt: "2026-10-31T10:00:00Z",
  repository: { nameWithOwner: repo }, author: { login: "octo" }, commits: { nodes: [] },
});
const answer = (...nodes: unknown[]) => JSON.stringify({ data: { search: { nodes } } });
const pr = (n: number, repo: string, over: Partial<OpenPr> = {}): OpenPr => ({ repo, number: n, title: `PR ${n}`, url: `https://example.test/${repo}/pull/${n}`, state: "open", author: "octo", checks: [], ...over });
const T = 1_000_000_000_000;

function rig() {
  const dir = mkTestTmp("hiderepos-");
  const file = openPrsFile(dir);
  const put = (openPrs: OpenPr[]) => {
    fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, fetchedAt: new Date(T - 1000_000).toISOString(), checkedAt: new Date(T - 1000_000).toISOString(), openPrs }));
  };
  const read = () => JSON.parse(fs.readFileSync(file, "utf8")) as OpenPrsFile;
  return { dir, file, put, read, done: () => rmTestTmp(dir) };
}

test("hideRepos: missing and empty hide nothing without a message", () => {
  for (const raw of [undefined, {}, { hideRepos: [] }]) {
    const c = openPrsConfig(raw);
    assert.deepEqual(c.hideRepos, []);
    assert.equal(c.hideError, undefined);
  }
});

test("hideRepos: a valid list is trimmed and lowercased", () => {
  const c = openPrsConfig({ hideRepos: [" Acme/Archive* ", "acme/old-?"] });
  assert.deepEqual(c.hideRepos, ["acme/archive*", "acme/old-?"]);
  assert.equal(c.hideError, undefined);
});

test("hideRepos: a malformed value is dropped with one message", () => {
  for (const bad of ["acme/*", [1], ["a\u0001b"], ["x".repeat(201)], ["  "], Array.from({ length: 51 }, () => "a")]) {
    const c = openPrsConfig({ hideRepos: bad });
    assert.deepEqual(c.hideRepos, []);
    assert.match(c.hideError ?? "", /^radar\.openPrs\.hideRepos: /);
  }
});

test("hiddenRepo matches case-insensitively with the prSources globs", () => {
  assert.equal(hiddenRepo(["acme/archive*"], "Acme/Archive-2"), true);
  assert.equal(hiddenRepo(["acme/archive*"], "acme/widgets"), false);
  assert.equal(hiddenRepo([], "acme/widgets"), false);
});

test("refreshOpenPrs copies marks per repo and leaves a new repo unmarked", async () => {
  const r = rig();
  r.put([pr(1, "acme/archive", { hiddenRepo: true }), pr(2, "acme/widgets")]);
  const gh: GhRunner = async () => answer(node(5, "acme/archive"), node(6, "acme/widgets"), node(7, "acme/fresh"));
  assert.equal(await refreshOpenPrs({ file: r.file, config: openPrsConfig({ enabled: true, hideRepos: ["acme/fresh"] }), gh, now: () => T, force: true }), "refreshed");
  const by = new Map(r.read().openPrs.map((p) => [p.number, p]));
  assert.equal(by.get(5)?.hiddenRepo, true);
  assert.equal(by.get(6)?.hiddenRepo, undefined);
  assert.equal(by.get(7)?.hiddenRepo, undefined);
  r.done();
});

test("refreshOpenPrs copies the marks of the file as it is under the lock", async () => {
  const r = rig();
  r.put([pr(1, "acme/archive", { hiddenRepo: true })]);
  // the tracker removes the mark after the refresher's first read and before it holds the lock (its first clock read is the lock's)
  let first = true;
  const now = (): number => {
    if (first) r.put([pr(1, "acme/archive")]);
    first = false;
    return T;
  };
  const gh: GhRunner = async () => answer(node(5, "acme/archive"));
  await refreshOpenPrs({ file: r.file, config: openPrsConfig({ enabled: true }), gh, now, force: true });
  assert.equal(r.read().openPrs[0].hiddenRepo, undefined);
  r.done();
});

test("refreshOpenPrs tolerates a file entry without a string repo", async () => {
  const r = rig();
  r.put([pr(1, "acme/archive", { hiddenRepo: true }), { number: 2, hiddenRepo: true } as unknown as OpenPr, { repo: 3, number: 3 } as unknown as OpenPr]);
  const gh: GhRunner = async () => answer(node(5, "acme/archive"));
  assert.equal(await refreshOpenPrs({ file: r.file, config: openPrsConfig({ enabled: true }), gh, now: () => T, force: true }), "refreshed");
  assert.equal(r.read().openPrs.find((p) => p.number === 5)?.hiddenRepo, true);
  r.done();
});

test("remarkOpenPrs marks, unmarks and does not rewrite when nothing changed", () => {
  const r = rig();
  r.put([pr(1, "acme/archive"), pr(2, "acme/widgets", { hiddenRepo: true })]);
  remarkOpenPrs(r.file, ["acme/archive"], T);
  const by = new Map(r.read().openPrs.map((p) => [p.number, p]));
  assert.equal(by.get(1)?.hiddenRepo, true);
  assert.equal(by.get(2)?.hiddenRepo, undefined);
  const before = fs.statSync(r.file).mtimeMs;
  const text = fs.readFileSync(r.file, "utf8");
  fs.utimesSync(r.file, 1, 1);
  remarkOpenPrs(r.file, ["acme/archive"], T);
  assert.equal(fs.readFileSync(r.file, "utf8"), text);
  assert.equal(fs.statSync(r.file).mtimeMs < before, true, "file was not rewritten");
  assert.equal(fs.existsSync(`${r.file}.lock`), false);
  r.done();
});

test("readStoreEntry reads a marked entry like the unmarked one", () => {
  clearStoreCache();
  const dir = mkTestTmp("hiderepos-store-");
  const snap = { state: "open", head: "abc", runs: [], updatedAt: "u1", mergeable: "mergeable" };
  const entry = { repo: "acme/app", number: 1, snap, okAt: T, meta: { url: "https://github.com/acme/app/pull/1", title: "t", draft: true, headRefName: "f", headRepo: "acme/app" }, at: T };
  const write = (e: object) => {
    fs.mkdirSync(trackedStateFile(dir).slice(0, trackedStateFile(dir).lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(trackedStateFile(dir), JSON.stringify({ v: 1, trackedAt: T, prs: { "acme/app#1": e } }));
    clearStoreCache();
    return readStoreEntry(dir, { host: "github.com", repo: "acme/app", n: 1 }, T + 1000, true);
  };
  const plain = write(entry);
  const marked = write({ ...entry, hiddenRepo: true });
  assert.equal(plain.kind, "entry");
  assert.deepEqual(marked, plain);
  rmTestTmp(dir);
});
