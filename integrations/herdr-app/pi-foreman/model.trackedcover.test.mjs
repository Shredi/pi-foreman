import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const url = (n, repo = "acme/widgets") => `https://github.com/${repo}/pull/${n}`;
const dot = (n, over = {}) => ({ n, state: "none", label: `#${n}`, src: "pr", url: url(n), ...over });
const root = (dots) => ({ key: "r", kind: "session", name: "r", state: "idle", sym: "idle", own: cost, tot: cost, age_s: 1, waits: [], children: [], dots });
const open = (number, over = {}) => ({ repo: "acme/widgets", number, title: `t${number}`, url: url(number), state: "open", author: "o", checks: [], headRefName: `f/${number}`, ...over });
const parse = (dots, openPrs, openPrsAt = "2026-11-02T20:22:18Z") =>
  parseRadarDoc(JSON.stringify({ v: 1, now: "2026-11-02T20:23:27Z", roots: [root(dots)], openPrs, ...(openPrsAt ? { openPrsAt } : {}) }));
const numbers = (got) => got.nodes[0].prs.map((p) => p.number);

test("normOpenPrs keeps tracked: true and adds nothing for other entries", () => {
  const got = parse([], [open(1, { tracked: true }), open(2), open(3, { tracked: "yes" })]);
  assert.equal(got.openPrs[0].tracked, true);
  assert.ok(!("tracked" in got.openPrs[1]));
  assert.ok(!("tracked" in got.openPrs[2]));
});

test("a tracked entry does not make its repo covered: another PR's session chip stays", () => {
  assert.deepEqual(numbers(parse([dot(56)], [open(77, { tracked: true })])), [56]);
  assert.deepEqual(numbers(parse([dot(56)], [open(77)])), [], "an untracked search entry still covers the repo");
});

test("a tracked entry keeps its own session chip and joins forks on headRepo", () => {
  const r = root([dot(77)]);
  r.repo = "acme/widgets"; r.branch = "f/77";
  const fork = root([]);
  fork.repo = "someone/widgets"; fork.branch = "f/88"; fork.key = "f";
  const got = parseRadarDoc(JSON.stringify({
    v: 1, now: "2026-11-02T20:23:27Z", roots: [r, fork], openPrsAt: "2026-11-02T20:22:18Z",
    openPrs: [open(77, { tracked: true }), open(88, { tracked: true, headRepo: "someone/widgets", headRefName: "f/88" })],
  }));
  assert.deepEqual(got.nodes[0].prs.map((p) => p.number), [77]);
  assert.deepEqual(got.nodes[1].prs.map((p) => p.number), [88]);
});

test("with no search time, tracked entries still reach the list and drop nothing", () => {
  const got = parse([dot(56)], [open(77, { tracked: true })], null);
  assert.deepEqual(numbers(got), [56]);
  assert.equal(got.openPrs.length, 1);
  assert.ok(!("openPrsAt" in got));
});

test("the openPrs cap is 300: 250 survive, 301 are cut to 300", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => open(i + 1, { repo: `acme/r${i}` }));
  assert.equal(parse([], many(250)).openPrs.length, 250);
  assert.equal(parse([], many(301)).openPrs.length, 300);
});
