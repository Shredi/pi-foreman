import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, enrichPrs, mergeFeeds, prDotState, prState, prStateText, prCard, prCardHeight } from "./model.js";

// The required-check wait: a passed PR whose tracker names the required checks still to come (`waiting`), with no `unsettled`.
const H1 = "1111111111111111111111111111111111111111";
const url = (n) => `https://github.com/acme/app/pull/${n}`;
const entry = (over = {}) => ({
  number: 7, repo: "acme/app", title: "Change", url: url(7), state: "open", author: "me", checks: [{ n: "ci", state: "ok" }],
  mergeable: "MERGEABLE", headRefName: "feat", head: H1, mergeState: "blocked", waiting: ["security-scan", "license-check"], ...over,
});
// The feed entry as the radar document parses it (the same path the sidebar takes).
const feedOnly = (over) => parseRadarDoc(JSON.stringify({ roots: [], openPrs: [entry(over)] })).openPrs[0];
const names = (c, key) => c.groups.find((g) => g.key === key)?.names ?? null;

test("required: waiting set, no unsettled, checks green, merge blocked: a still amber ring, the card names the waiting checks", () => {
  const pr = feedOnly();
  assert.deepEqual(prDotState(pr), { pulse: false, fill: "amber", hollow: true, conflict: false });
  assert.equal(prState(pr), "pending", "counted as pending in the summary and the sort");
  assert.equal(prStateText(pr), "checks passed, waiting on required checks");
  const c = prCard(pr);
  assert.deepEqual(names(c, "waiting"), ["security-scan", "license-check"]);
  assert.deepEqual(c.counts, { failed: 0, running: 0, passed: 1 }, "counts stay failed, running, passed");
  assert.deepEqual(c.groups.map((g) => g.key), ["waiting", "passed"], "the waiting group sits between running and passed");
});

test("required: a plain green PR (merge clean, not known to be mergeable) is required too", () => {
  const pr = feedOnly({ mergeState: "clean", mergeable: "UNKNOWN" });
  assert.deepEqual(prDotState(pr), { pulse: false, fill: "amber", hollow: true, conflict: false });
  assert.equal(prStateText(pr), "checks passed, waiting on required checks");
  assert.deepEqual(names(prCard(pr), "waiting"), ["security-scan", "license-check"]);
});

test("ready wins: mergeable, clean and checks green keep the check mark; no waiting group", () => {
  const pr = feedOnly({ mergeState: "clean" });
  assert.deepEqual(prDotState(pr), { pulse: false, fill: "green", mark: "check", conflict: false });
  assert.equal(prStateText(pr), "ready to merge (CI passing, no review claim)");
  assert.equal(names(prCard(pr), "waiting"), null);
});

test("behind wins: the branch-behind words stay, no ring, no waiting group", () => {
  const pr = feedOnly({ mergeState: "behind" });
  assert.equal(prStateText(pr), "CI passing, branch behind");
  assert.deepEqual(prDotState(pr), { pulse: false, fill: "amber", conflict: false });
  assert.equal(names(prCard(pr), "waiting"), null);
});

test("unsettled with waiting: pulsing amber, no ring, no waiting group", () => {
  const pr = feedOnly({ unsettled: true });
  assert.equal(prDotState(pr).pulse, true);
  assert.equal(prDotState(pr).hollow, undefined);
  assert.equal(names(prCard(pr), "waiting"), null);
});

test("a running check with waiting and no unsettled: pulsing amber, no ring", () => {
  const pr = feedOnly({ checks: [{ n: "ci", state: "ok" }, { n: "lint", state: "pending" }] });
  assert.equal(prDotState(pr).pulse, true);
  assert.equal(prDotState(pr).hollow, undefined);
  assert.equal(names(prCard(pr), "waiting"), null);
});

test("waiting with a failed check: red", () => {
  const pr = feedOnly({ checks: [{ n: "ci", state: "fail" }, { n: "lint", state: "ok" }] });
  assert.equal(prDotState(pr).fill, "red");
  assert.equal(prState(pr), "fail");
});

test("waiting on a draft: violet work in progress", () => {
  const pr = feedOnly({ state: "draft" });
  assert.equal(prDotState(pr).fill, "violet");
});

test("waiting with the head not reviewed: blue", () => {
  const session = { ...feedOnly(), review: { n: 7, repo: "acme/app", head: H1, state: "unreviewed" } };
  assert.equal(prDotState(session).fill, "blue");
});

test("waiting with no checks: not required (the dot stays grey)", () => {
  const pr = feedOnly({ checks: [] });
  assert.equal(prDotState(pr).fill, "dim");
  assert.equal(prDotState(pr).hollow, undefined);
  assert.equal(names(prCard(pr), "waiting"), null);
});

test("more than 5 waiting names: 5 shown, then the rest counted as more", () => {
  const many = ["a", "b", "c", "d", "e", "f", "g"].map((s) => `check-${s}`);
  const c = prCard(feedOnly({ waiting: many }));
  const g = c.groups.find((x) => x.key === "waiting");
  assert.equal(g.count, 7);
  assert.equal(g.names.length, 5);
  assert.equal(g.more, 2);
  assert.equal(prCardHeight(c) > prCardHeight(prCard(feedOnly({ waiting: many.slice(0, 1) }))), true, "the card grows with the group");
});

test("malformed waiting is cleaned: not an array, non-strings, empty, more than 10, longer than 120", () => {
  assert.equal(feedOnly({ waiting: "security-scan" }).waiting, undefined, "not an array");
  assert.equal(feedOnly({ waiting: [null, 3, { n: 1 }] }).waiting, undefined, "no string at all");
  assert.deepEqual(feedOnly({ waiting: ["", "  ", "ok", 4] }).waiting, ["ok"], "non-strings and empty names dropped");
  const twelve = Array.from({ length: 12 }, (_, i) => `c${i}`);
  assert.deepEqual(feedOnly({ waiting: twelve }).waiting, twelve.slice(0, 10), "at most 10");
  const long = feedOnly({ waiting: ["x".repeat(300)] }).waiting;
  assert.equal(long[0].length, 120, "each name cut to 120 characters");
});

test("mergeFeeds keeps waiting with the check block of the entry that has the jobs", () => {
  const bare = entry({ checks: [], waiting: undefined, mergeState: undefined, head: undefined });
  const full = entry();
  const [merged] = mergeFeeds([parseRadarDoc(JSON.stringify({ roots: [], openPrs: [bare] })).openPrs, parseRadarDoc(JSON.stringify({ roots: [], openPrs: [full] })).openPrs]);
  assert.deepEqual(merged.waiting, ["security-scan", "license-check"]);
  assert.equal(merged.jobs.length, 1, "the check block comes from the later entry");
});

test("enrichPrs copies waiting from the feed twin with its check block, and keeps the PR's own", () => {
  const twin = feedOnly();
  const dotOnly = { number: 7, repo: "acme/app", url: url(7), state: "open", head: H1, mergeState: "blocked", mergeable: "MERGEABLE", checks: [{ n: "ci", state: "ok" }] };
  assert.deepEqual(enrichPrs([dotOnly], [twin])[0].waiting, ["security-scan", "license-check"]);
  const own = { ...dotOnly, waiting: ["own-check"] };
  assert.deepEqual(enrichPrs([own], [twin])[0].waiting, ["own-check"]);
});

test("a raw PR (not through the feed parse) whose waiting holds no non-empty name: no ring, no waiting group", () => {
  const pr = { number: 7, repo: "acme/app", url: url(7), state: "open", head: H1, mergeState: "clean", mergeable: "UNKNOWN", checks: [{ n: "ci", state: "ok" }], waiting: ["", 5] };
  assert.deepEqual(prDotState(pr), { pulse: false, fill: "green", conflict: false });
  assert.equal(prStateText(pr), "CI passing");
  assert.equal(names(prCard(pr), "waiting"), null, "no waiting group on the card");
});
