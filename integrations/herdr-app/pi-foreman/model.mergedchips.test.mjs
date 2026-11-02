import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, prSummary } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const url = (n, repo = "acme/widgets") => `https://github.com/${repo}/pull/${n}`;
const dot = (n, over = {}) => ({ n, state: "none", label: `#${n}`, src: "pr", url: url(n), ...over });
const root = (dots) => ({ key: "r", kind: "session", name: "r", state: "idle", sym: "idle", own: cost, tot: cost, age_s: 1, waits: [], children: [], dots });
const open = (number, over = {}) => ({ repo: "acme/widgets", number, title: `t${number}`, url: url(number), state: "open", author: "o", checks: [], headRefName: `f/${number}`, ...over });
const parse = (dots, openPrs, openPrsAt = "2026-11-02T20:22:18Z", now = "2026-11-02T20:23:27Z") =>
  parseRadarDoc(JSON.stringify({ v: 1, now, roots: [root(dots)], openPrs, openPrsAt }));
const numbers = (got) => got.nodes[0].prs.map((p) => p.number);

test("a merged PR absent from a fresh feed that covers its repo drops; an open one stays; the summary follows", () => {
  const got = parse([dot(56), dot(77)], [open(77)]);
  assert.deepEqual(numbers(got), [77]);
  assert.equal(prSummary(got.nodes[0].prs), "1 PR");
  assert.deepEqual(buildTree(got.nodes)[0].prs.map((p) => p.number), [77]);
});

test("a stale feed leaves the chip", () => {
  assert.deepEqual(numbers(parse([dot(56), dot(77)], [open(77)], "2026-11-02T19:00:00Z")), [56, 77]);
  assert.deepEqual(numbers(parse([dot(56)], [open(77)], null)), [56]);
});

test("a repository the feed does not cover, or a chip without a known repository, stays", () => {
  assert.deepEqual(numbers(parse([dot(5, { url: url(5, "other/repo") }), dot(6, { url: undefined })], [open(77)])), [5, 6]);
});

test("a twin that says merged or closed drops even when the feed is stale", () => {
  const got = parse([dot(56), dot(57), dot(58)], [open(56, { state: "merged" }), open(57, { state: "closed" }), open(58)], "2026-11-02T10:00:00Z");
  assert.deepEqual(numbers(got), [58]);
});

test("nested sessions are filtered too", () => {
  const r = root([]);
  r.children = [{ ...root([dot(56)]), key: "c" }];
  const got = parseRadarDoc(JSON.stringify({ v: 1, now: "2026-11-02T20:23:27Z", roots: [r], openPrs: [open(77)], openPrsAt: "2026-11-02T20:22:18Z" }));
  assert.deepEqual(got.nodes[0].children[0].prs, []);
});
