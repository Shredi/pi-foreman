import test from "node:test";
import assert from "node:assert/strict";
import { twinOf, prUrl } from "./model.js";

// The brute-force twin scan that `twinOf` replaced (the old scan, with lowercased keys), with the private helpers it used copied here.
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");
const listOf = (x) => (Array.isArray(x) ? x : []);
function repoName(url, fallback) {
  const m = /^https:\/\/[^/]+\/(.+?)\/?$/.exec(str(url));
  return m ? m[1] : fallback;
}
const nameOf = (v) => repoName(v, str(v));
function oldTwinOf(pr, feed, fallbackRepo = "") {
  const list = listOf(feed).filter(isObj);
  const repo = nameOf(pr.repo || fallbackRepo).toLowerCase();
  const url = prUrl(null, { url: pr.url }).toLowerCase();
  const same = list.filter((f) => f.number === pr.number);
  return list.find((f) => {
    const fu = prUrl(null, { url: f.url }).toLowerCase();
    if (url && fu) return url === fu;
    if (f.number !== pr.number) return false;
    const fr = nameOf(f.repo).toLowerCase();
    return repo && fr ? repo === fr : same.length === 1;
  }) ?? null;
}

// Seeded generator (mulberry32): the same cases on every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

const NUMBERS = [1, 2, 3, NaN, -0, 0, "2", 2.5, undefined, null];
const URLS = [
  undefined, "", "https://h.test/a/x/pull/1", "https://h.test/a/x/pull/2", "https://h.test/a/y/pull/1", "https://h.test/a/x/pull/1/",
  "http://h.test/a/x/pull/1", "javascript:alert(1)", "not a url", "https://h.test/a/y/pull/3",
];
const REPOS = [undefined, "", "a/x", "a/y", "A/X", "https://h.test/a/x", "https://h.test/a/y/", null];
const FALLBACKS = ["", "a/x", "https://h.test/a/y", undefined];
const NON_OBJECTS = [null, 5, "x", [1], undefined, true];

// One feed entry, a non-object now and then, and the same object pushed again now and then (duplicates).
function genEntry(r) {
  if (r() < 0.1) return pick(r, NON_OBJECTS);
  return { number: pick(r, NUMBERS), url: pick(r, URLS), repo: pick(r, REPOS), title: "t" };
}
function genFeed(r) {
  const feed = [];
  const n = Math.floor(r() * 41);
  for (let i = 0; i < n; i++) {
    const prev = feed.filter(isObj);
    feed.push(prev.length && r() < 0.1 ? pick(r, prev) : genEntry(r));
  }
  if (r() < 0.05 && feed.length) delete feed[Math.floor(r() * feed.length)];
  return feed;
}
// A PR: a fresh object, or a copy of a feed entry (as enrichPrs sees them), or a non-object.
function genPr(r, feed) {
  if (r() < 0.05) return pick(r, NON_OBJECTS.filter((v) => v !== null && v !== undefined));
  const objs = feed.filter(isObj);
  if (objs.length && r() < 0.3) return { ...pick(r, objs) };
  return { number: pick(r, NUMBERS), url: pick(r, URLS), repo: pick(r, REPOS) };
}

function checkAll(feed, prs, r) {
  for (const pr of prs) {
    const fb = pick(r, FALLBACKS);
    assert.equal(twinOf(pr, feed, fb), oldTwinOf(pr, feed, fb), `pr ${JSON.stringify(pr)} fallback ${JSON.stringify(fb)}`);
  }
}

test("twinOf returns the entry the brute-force scan returns, over seeded generated feeds", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const feed = genFeed(r);
    const prs = Array.from({ length: 30 }, () => genPr(r, feed));
    checkAll(feed, prs, r);
  }
});

test("twinOf over a non-array feed is null, as the scan is", () => {
  const prs = [{ number: 1, url: URLS[2], repo: "a/x" }, { number: NaN }, { repo: "a/x" }];
  for (const feed of [null, undefined, {}, "str", 5, new Map(), { 0: { number: 1 }, length: 1 }]) {
    for (const pr of prs) assert.equal(twinOf(pr, feed, "a/x"), oldTwinOf(pr, feed, "a/x"));
    assert.equal(twinOf(prs[0], feed), null);
  }
});

test("a PR that is null or undefined throws as before, with an empty or a filled feed", () => {
  for (const feed of [[], [{ number: 1 }]]) {
    for (const pr of [null, undefined]) {
      assert.throws(() => oldTwinOf(pr, feed), TypeError);
      assert.throws(() => twinOf(pr, feed), TypeError);
    }
  }
});

test("NaN, -0 and string numbers match as the scan matches them", () => {
  const feed = [{ number: NaN, repo: "a/x" }, { number: "2", repo: "a/x" }, { number: 0, repo: "a/x" }];
  assert.equal(twinOf({ number: NaN, repo: "a/x" }, feed), null);
  assert.equal(twinOf({ number: -0, repo: "a/x" }, feed), feed[2]);
  assert.equal(twinOf({ number: 2, repo: "a/x" }, feed), null);
  assert.equal(twinOf({ number: "2", repo: "a/x" }, feed), feed[1]);
  assert.equal(twinOf({ number: NaN, repo: "a/x" }, feed), oldTwinOf({ number: NaN, repo: "a/x" }, feed));
});

test("pushing onto the same feed array, or emptying it, is seen by the next lookup", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(1000 + seed);
    const feed = genFeed(r);
    const prs = Array.from({ length: 20 }, () => genPr(r, feed));
    checkAll(feed, prs, r);
    for (let k = 0; k < 3; k++) feed.push(genEntry(r));
    checkAll(feed, prs, r);
    feed.length = 0;
    checkAll(feed, prs, r);
    for (let k = 0; k < 5; k++) feed.push(genEntry(r));
    checkAll(feed, prs, r);
  }
});

test("a feed entry that is the same object twice is the twin at its first place", () => {
  const e = { number: 7, url: "https://h.test/a/x/pull/7", repo: "a/x" };
  const feed = [null, e, e];
  assert.equal(twinOf({ number: 7, url: "https://h.test/a/x/pull/7" }, feed), e);
  assert.equal(twinOf({ number: 7, repo: "a/x" }, feed), oldTwinOf({ number: 7, repo: "a/x" }, feed));
});
