import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { OpenPrsRefresher, openPrsConfig, openPrsFile, openPrsQueries, parseSearch, realGh, refreshOpenPrs } from "../openprs.ts";
import type { GhRunner, OpenPrsFile } from "../openprs.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const node = (n: number, over: Record<string, unknown> = {}) => ({
  number: n, title: `PR ${n}`, url: `https://example.test/acme/widgets/pull/${n}`, isDraft: false, updatedAt: "2026-10-31T10:00:00Z",
  repository: { nameWithOwner: "acme/widgets" }, author: { login: "octo" },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null },
    { __typename: "StatusContext", context: "legacy", state: "PENDING" },
  ] } } } }] },
  ...over,
});
const answer = (...nodes: unknown[]) => JSON.stringify({ data: { search: { nodes } } });
const on = { enabled: true };

function rig(config: Record<string, unknown> = on) {
  const dir = mkTestTmp("r78o-");
  const file = openPrsFile(dir);
  const queries: string[] = [];
  const state = { answer: (_q: string): string | Error => answer(node(1)), clock: 1_000_000_000_000 };
  const gh: GhRunner = async (args) => {
    assert.deepEqual(args.slice(0, 2), ["api", "graphql"]);
    const q = args.find((a) => a.startsWith("q="))!.slice(2);
    queries.push(q);
    const r = state.answer(q);
    if (r instanceof Error) throw r;
    return r;
  };
  const run = (force = false) => refreshOpenPrs({ file, config: openPrsConfig(config), gh, now: () => state.clock, force });
  const read = () => JSON.parse(fs.readFileSync(file, "utf8")) as OpenPrsFile;
  return { dir, file, queries, state, run, read, done: () => rmTestTmp(dir) };
}

test("a refresh writes the cache file with mapped checks", async () => {
  const r = rig();
  assert.equal(await r.run(), "refreshed");
  const f = r.read();
  assert.equal(f.v, 1);
  assert.equal(f.openPrs.length, 1);
  assert.deepEqual(f.openPrs[0], {
    repo: "acme/widgets", number: 1, title: "PR 1", url: "https://example.test/acme/widgets/pull/1", state: "open", author: "octo",
    checks: [{ n: "build", state: "ok", label: "build" }, { n: "lint", state: "fail", label: "lint" }, { n: "e2e", state: "run", label: "e2e" }, { n: "legacy", state: "run", label: "legacy" }],
  });
  assert.equal(f.error, undefined);
  assert.deepEqual(r.queries, ["is:pr is:open author:@me", "is:pr is:open review-requested:@me"]);
  r.done();
});

test("refreshSeconds is respected", async () => {
  const r = rig({ enabled: true, refreshSeconds: 600 });
  assert.equal(await r.run(), "refreshed");
  r.state.clock += 599_000;
  assert.equal(await r.run(), "fresh");
  assert.equal(r.queries.length, 2);
  r.state.clock += 2_000;
  assert.equal(await r.run(), "refreshed");
  assert.equal(r.queries.length, 4);
  r.done();
});

test("a held lock prevents a second refresh; a stale lock is taken over", async () => {
  const r = rig();
  fs.mkdirSync(path.dirname(r.file), { recursive: true });
  fs.writeFileSync(`${r.file}.lock`, "");
  const now = Date.now();
  const fresh = new Date(now);
  fs.utimesSync(`${r.file}.lock`, fresh, fresh);
  const gh: GhRunner = async () => { throw new Error("must not run"); };
  assert.equal(await refreshOpenPrs({ file: r.file, config: openPrsConfig(on), gh, now: () => now }), "locked");
  assert.equal(fs.existsSync(r.file), false);
  const old = new Date(now - 30 * 60_000);
  fs.utimesSync(`${r.file}.lock`, old, old);
  assert.equal(await refreshOpenPrs({ file: r.file, config: openPrsConfig(on), gh: async () => answer(node(2)), now: () => now }), "refreshed");
  assert.equal(fs.existsSync(`${r.file}.lock`), false);
  r.done();
});

test("a failure keeps the old data and records the error", async () => {
  const r = rig();
  await r.run();
  const before = r.read();
  r.state.clock += 1_000_000;
  r.state.answer = () => new Error("gh: API rate limit exceeded");
  assert.equal(await r.run(), "failed");
  const f = r.read();
  assert.deepEqual(f.openPrs, before.openPrs);
  assert.equal(f.fetchedAt, before.fetchedAt);
  assert.match(f.error ?? "", /rate limit/);
  assert.ok(f.errorAt);
  // the failed attempt throttles the retry
  assert.equal(await r.run(), "fresh");
  // bad JSON is a failure too, and success clears the error
  r.state.clock += 1_000_000;
  r.state.answer = () => "not json";
  assert.equal(await r.run(), "failed");
  r.state.clock += 1_000_000;
  r.state.answer = () => answer(node(3));
  assert.equal(await r.run(), "refreshed");
  assert.equal(r.read().error, undefined);
  assert.equal(r.read().openPrs[0].number, 3);
  r.done();
});

test("a bot author is searched as author:app/<name>, only inside scope", async () => {
  const q = openPrsQueries(openPrsConfig({ enabled: true, mine: false, authors: ["renovate[bot]", "someone"], scope: ["example-org", "acme/widgets", "bad scope", "x;y"] }));
  assert.deepEqual(q, [
    "is:pr is:open author:app/renovate org:example-org", "is:pr is:open author:app/renovate repo:acme/widgets",
    "is:pr is:open author:someone org:example-org", "is:pr is:open author:someone repo:acme/widgets",
  ]);
  assert.deepEqual(openPrsQueries(openPrsConfig({ enabled: true, mine: false, authors: ["renovate[bot]"], scope: [] })), []);
  assert.deepEqual(openPrsQueries(openPrsConfig({ enabled: true, mine: false, authors: ["a b", "x\" y"], scope: ["example-org"] })), []);
  assert.equal(openPrsQueries(openPrsConfig({ enabled: true })).length, 2);
});

test("unsafe or incomplete entries are dropped; duplicates by url are listed once; the list is capped", async () => {
  assert.deepEqual(parseSearch(answer(node(1, { url: "http://example.test/a/b/pull/1" }), node(2, { url: "https://example.test/a b" }), node(3, { number: "3" }), node(4, { repository: null }), null, node(5, { commits: null, isDraft: true }))).map((p) => [p.number, p.state, p.checks.length]), [[5, "draft", 0]]);
  const r = rig({ enabled: true, authors: ["renovate[bot]"], scope: ["example-org"] });
  r.state.answer = () => answer(...Array.from({ length: 80 }, (_, i) => node(i + 1)));
  assert.equal(await r.run(), "refreshed");
  assert.equal(r.queries.length, 3);
  assert.equal(r.read().openPrs.length, 80);
  r.state.clock += 1_000_000;
  r.state.answer = (q) => answer(...Array.from({ length: 60 }, (_, i) => node(i + 1 + (q.includes("review") ? 60 : 0))));
  await r.run();
  assert.equal(r.read().openPrs.length, 100);
  r.done();
});

test("disabled, or nothing to search: no calls and no file", async () => {
  for (const cfg of [{}, { enabled: false }, { enabled: true, mine: false }]) {
    const r = rig(cfg);
    assert.equal(await r.run(), "off");
    assert.equal(r.queries.length, 0);
    assert.equal(fs.existsSync(r.file), false);
    r.done();
  }
});

test("the refresher ticks on a timer, skips a non-gh host and stops cleanly", async () => {
  const dir = mkTestTmp("r78o-");
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const fake = { set: (fn: () => void, ms: number) => (timers.push({ fn, ms, live: true }), timers.length - 1), clear: (h: unknown) => void (typeof h === "number" && timers[h] && (timers[h].live = false)) };
  let calls = 0;
  let host = false;
  const rf = new OpenPrsRefresher({ agentDir: dir, config: () => on, ghHost: () => host, gh: async () => (calls++, answer(node(1))), timers: fake });
  rf.start();
  assert.equal(timers.length, 1);
  assert.equal(await rf.tick(), "off");
  assert.equal(calls, 0);
  host = true;
  assert.equal(await rf.tick(), "refreshed");
  rf.stop();
  assert.equal(timers[0].live, false);
  rmTestTmp(dir);
});

test("realGh runs the gh found on PATH and reports its stderr", { skip: process.platform === "win32" }, async () => {
  const bin = mkTestTmp("r78b-");
  const cwd = mkTestTmp("r78w-");
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nif [ \"$2\" = fail ]; then echo 'not logged in' >&2; exit 4; fi\necho '{\"ok\":true}'\n", { mode: 0o755 });
  const env = { ...process.env, PATH: bin };
  assert.equal((await realGh(cwd, env)(["api", "x"])).trim(), '{"ok":true}');
  await assert.rejects(realGh(cwd, env)(["api", "fail"]), /not logged in/);
  await assert.rejects(realGh(cwd, { PATH: "" })(["api", "x"]), /not installed/);
  rmTestTmp(bin);
  rmTestTmp(cwd);
});

test("one failing query keeps the other queries' PRs and records the error", async () => {
  const r = rig();
  r.state.answer = (q) => (q.includes("review-requested") ? new Error("gh: boom") : answer(node(7)));
  assert.equal(await r.run(), "refreshed");
  const f = r.read();
  assert.deepEqual(f.openPrs.map((p) => p.number), [7]);
  assert.match(f.error ?? "", /1 of 2 queries failed: gh: boom/);
  assert.ok(f.fetchedAt && f.errorAt);
  r.done();
});

test("every query failing keeps the old file's entries and fetchedAt", async () => {
  const r = rig();
  await r.run();
  const before = r.read();
  r.state.clock += 1_000_000;
  r.state.answer = () => new Error("gh: down");
  assert.equal(await r.run(), "failed");
  const f = r.read();
  assert.deepEqual(f.openPrs, before.openPrs);
  assert.equal(f.fetchedAt, before.fetchedAt);
  assert.match(f.error ?? "", /2 of 2 queries failed/);
  r.done();
});

test("a first refresh that fails writes no fetchedAt but still throttles", async () => {
  const r = rig();
  r.state.answer = () => new Error("gh: not logged in");
  assert.equal(await r.run(), "failed");
  const f = r.read();
  assert.equal("fetchedAt" in f, false);
  assert.deepEqual(f.openPrs, []);
  assert.ok(f.checkedAt);
  assert.equal(await r.run(), "fresh");
  r.done();
});

test("a stale takeover is not unlocked by the first session", async () => {
  const r = rig();
  const lock = `${r.file}.lock`;
  const gate = () => { let go!: () => void; const p = new Promise<void>((res) => { go = res; }); return { p, go }; };
  const g1 = gate();
  const g2 = gate();
  const started1 = gate();
  const started2 = gate();
  const now = Date.now();
  const cfg = openPrsConfig({ enabled: true, mine: true });
  const first = refreshOpenPrs({ file: r.file, config: cfg, now: () => now, gh: async () => { started1.go(); await g1.p; return answer(node(1)); } });
  await started1.p;
  const old = new Date(now - 60 * 60_000);
  fs.utimesSync(lock, old, old);
  const second = refreshOpenPrs({ file: r.file, config: cfg, now: () => now, force: true, gh: async () => { started2.go(); await g2.p; return answer(node(2)); } });
  await started2.p;
  const token = fs.readFileSync(lock, "utf8");
  g1.go();
  assert.equal(await first, "refreshed");
  assert.equal(fs.readFileSync(lock, "utf8"), token);
  g2.go();
  assert.equal(await second, "refreshed");
  assert.equal(fs.existsSync(lock), false);
  r.done();
});
