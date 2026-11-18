import test from "node:test";
import assert from "node:assert/strict";
import { mergeFeeds, openPrGroups, enrichPrs, twinOf } from "./model.js";

// Two machines list the same PR #5. The regression proof of the sidebar is render.twofeeds.test.mjs (fails on the old code); here the
// merged list is checked against openPrGroups, enrichPrs and twinOf.
const entry = (over = {}) => ({ number: 5, repo: "o/r", url: "", title: "Fix the thing", state: "open", checks: [], jobs: [], ...over });
const session = (name, prs) => ({ key: name, kind: "session", name, state: "working", prs, children: [], waits: [] });
const numbers = (groups) => groups.map((g) => [g.repo, g.prs.map((p) => p.number)]);

// repository (and URL) spelled differently by the two machines
const SHAPES = {
  "repo case": [[entry({ repo: "o/r" })], [entry({ repo: "O/R" })]],
  "repo and URL case": [
    [entry({ repo: "o/r", url: "https://host.example.test/o/r/pull/5" })],
    [entry({ repo: "O/R", url: "https://host.example.test/O/R/pull/5" })],
  ],
  "URL case only": [
    [entry({ url: "https://host.example.test/o/r/pull/5" })],
    [entry({ url: "https://host.example.test/O/R/pull/5" })],
  ],
};

for (const [name, [a, b]] of Object.entries(SHAPES)) {
  for (const side of [0, 1]) {
    const own = [a, b][side][0];
    test(`${name}: the session on machine ${side + 1} shows #5 once, not under Open PRs`, () => {
      const feed = mergeFeeds([a, b]);
      assert.equal(feed.length, 1);
      const s = session("s", [{ number: 5, repo: own.repo, url: own.url }]);
      assert.deepEqual(numbers(openPrGroups(feed, [s], new Set([s]))), []);
      assert.equal(enrichPrs(s.prs, feed)[0].title, "Fix the thing");
    });
    test(`${name}: an unshown session on machine ${side + 1} lists #5 once`, () => {
      const feed = mergeFeeds([a, b]);
      const s = session("s", [{ number: 5, repo: own.repo, url: own.url }]);
      const groups = openPrGroups(feed, [s], new Set());
      assert.equal(groups.flatMap((g) => g.prs).length, 1);
    });
  }
}

test("a session PR without a repository finds its twin in the merged feed", () => {
  const feed = mergeFeeds([[entry({ repo: "o/r" })], [entry({ repo: "O/R" })]]);
  const s = session("s", [{ number: 5 }]);
  assert.deepEqual(numbers(openPrGroups(feed, [s], new Set([s]))), []);
  assert.equal(enrichPrs(s.prs, feed)[0].title, "Fix the thing");
});

test("an unshown session PR without a repository lists #5 exactly once", () => {
  const feed = mergeFeeds([[entry({ repo: "o/r" })], [entry({ repo: "O/R" })]]);
  const s = session("s", [{ number: 5 }]);
  const groups = openPrGroups(feed, [s], new Set());
  assert.deepEqual(groups.flatMap((g) => g.prs.map((p) => p.number)), [5]);
});

test("twinOf compares repository and URL without case", () => {
  const byRepo = [entry({ repo: "O/R" })];
  assert.equal(twinOf({ number: 5, repo: "o/r" }, byRepo), byRepo[0]);
  const byUrl = [entry({ url: "https://host.example.test/O/R/pull/5" })];
  assert.equal(twinOf({ number: 5, url: "https://host.example.test/o/r/pull/5" }, byUrl), byUrl[0]);
  assert.equal(twinOf({ number: 5, repo: "o/other" }, [entry({ repo: "O/R" }), entry({ repo: "O/R", number: 6 })]), null);
});
