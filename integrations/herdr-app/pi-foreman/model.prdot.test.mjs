import test from "node:test";
import assert from "node:assert/strict";
import { prDotState, prCard, enrichPrs, parseRadarDoc } from "./model.js";

const pr = (checks, over = {}) => ({ number: 7, checks, ...over });
const dot = (checks, over) => prDotState(pr(checks, over));

test("ring while any job runs; no ring otherwise", () => {
  assert.equal(dot(["pending", "ok"]).ring, true);
  assert.equal(dot(["ok", "ok"]).ring, false);
  assert.equal(dot(["fail"]).ring, false);
});

test("fill: amber while none finished", () => {
  assert.deepEqual([dot(["pending"]).fill, dot(["pending", "pending"]).fill], ["amber", "amber"]);
});

test("fill: red once a finished job failed, even while others run", () => {
  assert.equal(dot(["fail"]).fill, "red");
  assert.deepEqual(dot(["pending", "fail", "ok"]), { ring: true, fill: "red", conflict: false });
});

test("fill: green when every finished job passed (jobs may still run)", () => {
  assert.equal(dot(["ok", "ok"]).fill, "green");
  assert.deepEqual(dot(["ok", "pending"]), { ring: true, fill: "green", conflict: false });
});

test("fill: dim when unknown (no jobs, or only unknown ones)", () => {
  assert.equal(dot([]).fill, "dim");
  assert.equal(dot(["none"]).fill, "dim");
  assert.equal(prDotState(null).fill, "dim");
});

test("conflict marker is independent of the dot", () => {
  assert.equal(dot(["ok"], { mergeable: "CONFLICTING" }).conflict, true);
  assert.equal(dot(["ok"], { mergeable: "MERGEABLE" }).conflict, false);
  assert.equal(dot(["ok"]).conflict, false);
  assert.equal(dot(["ok"], { mergeable: "CONFLICTING" }).fill, "green");
});

const jobs = (...states) => states.map((state, i) => ({ name: `job-${i}`, state }));

test("card groups jobs failed / running / passed, capped with +N more", () => {
  const states = [...Array(7).fill("ok"), "fail", "pending", "pending"];
  const c = prCard(pr(states, { jobs: jobs(...states), title: "Fix it", bodyText: "Some text" }));
  assert.deepEqual(c.groups.map((g) => [g.key, g.count, g.names.length, g.more]), [["failed", 1, 1, 0], ["running", 2, 2, 0], ["passed", 7, 5, 2]]);
  assert.deepEqual(c.counts, { failed: 1, running: 2, passed: 7 });
  assert.equal(c.title, "Fix it");
});

test("card without job names falls back to numbered jobs; empty groups are dropped", () => {
  const c = prCard(pr(["ok", "ok"]));
  assert.deepEqual(c.groups.map((g) => g.key), ["passed"]);
  assert.deepEqual(c.groups[0].names, ["job 1", "job 2"]);
  assert.equal(c.title, "PR #7");
});

test("excerpt collapses whitespace and is cut at 200 characters", () => {
  assert.equal(prCard(pr([], { bodyText: "a\n\n  b   c" })).excerpt, "a b c");
  const long = prCard(pr([], { bodyText: "x".repeat(500) })).excerpt;
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
  assert.equal(prCard(pr([])).excerpt, "");
});

test("conflict line names the base branch, else a fallback", () => {
  assert.equal(prCard(pr([], { mergeable: "CONFLICTING", baseRef: "main" })).conflict, "conflicts with main");
  assert.equal(prCard(pr([], { mergeable: "CONFLICTING" })).conflict, "conflicts with its base branch");
  assert.equal(prCard(pr([], { mergeable: "MERGEABLE", baseRef: "main" })).conflict, "");
});

const feedDoc = (extra = {}) => JSON.stringify({
  v: 1, roots: [],
  openPrs: [{
    repo: "acme/widgets", number: 5, title: "Add widgets", url: "https://github.com/acme/widgets/pull/5", state: "open", author: "o",
    headRefName: "feat/w", bodyText: "Adds widgets.", mergeable: "CONFLICTING", baseRefName: "main",
    checks: [{ n: "build", state: "ok", label: "build" }, { n: "lint", state: "fail", label: "lint" }, { n: "e2e", state: "run", label: "e2e" }], ...extra,
  }],
});

test("radar openPrs keep title, body, mergeable, branch, base and per-job names", () => {
  const [p] = parseRadarDoc(feedDoc()).openPrs;
  assert.deepEqual([p.title, p.bodyText, p.mergeable, p.branch, p.baseRef], ["Add widgets", "Adds widgets.", "CONFLICTING", "feat/w", "main"]);
  assert.deepEqual(p.jobs, [{ name: "build", state: "ok" }, { name: "lint", state: "fail" }, { name: "e2e", state: "pending" }]);
  assert.deepEqual(p.checks, ["ok", "fail", "pending"]);
});

test("an older radar without the new fields still parses: fields empty, dot works", () => {
  const [p] = parseRadarDoc(JSON.stringify({ v: 1, roots: [], openPrs: [{ repo: "a/b", number: 1, title: "t", url: "https://github.com/a/b/pull/1", state: "open", author: "o", checks: [] }] })).openPrs;
  assert.deepEqual([p.bodyText, p.mergeable, p.branch, p.baseRef], ["", "", "", ""]);
  assert.equal(prDotState(p).fill, "dim");
  assert.equal(prCard(p).excerpt, "");
});

test("an unknown mergeable value is dropped", () => {
  assert.equal(parseRadarDoc(feedDoc({ mergeable: "WHATEVER" })).openPrs[0].mergeable, "");
});

test("enrichPrs fills a session PR from the feed twin by url, keeps what the PR has", () => {
  const [feed] = parseRadarDoc(feedDoc()).openPrs;
  const dotPr = { number: 5, checks: ["ok"], jobs: [{ name: "", state: "ok" }], url: "https://github.com/acme/widgets/pull/5", repo: "https://github.com/acme/widgets", title: "", bodyText: "", mergeable: "", baseRef: "", branch: "" };
  const [got] = enrichPrs([dotPr], [feed]);
  assert.deepEqual([got.title, got.bodyText, got.mergeable, got.baseRef], ["Add widgets", "Adds widgets.", "CONFLICTING", "main"]);
  assert.equal(got.jobs.length, 3);
  const [again] = enrichPrs([{ ...dotPr, url: "", title: "Own" }], [feed]);
  assert.equal(again.title, "Own");
  assert.equal(again.bodyText, "Adds widgets.");
  assert.deepEqual(enrichPrs([{ ...dotPr, number: 9, url: "" }], [feed])[0].title, "");
});
