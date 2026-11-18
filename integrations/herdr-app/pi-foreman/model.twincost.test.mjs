import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, allSessions, openPrGroups, enrichPrs } from "./model.js";

// Every property read of a feed entry is counted: the twin lookup used to scan the whole feed per PR, so the count grew with the
// square of the feed. With the lookup index a read happens once per entry and per index build, not once per scan.
function counted(list, counter) {
  return list.map((p) => new Proxy(p, { get(t, k, r) { counter.reads++; return Reflect.get(t, k, r); } }));
}

// Neutral example feed as radar sends it: `prs` PRs over `repos` repositories.
function feedList(prs, repos) {
  const out = [];
  for (let i = 0; i < prs; i++) {
    const r = i % repos;
    const n = 1000 + i;
    out.push({
      repo: `example-org/repo-${r}`, number: n, title: `Change ${n}`, url: `https://example.test/example-org/repo-${r}/pull/${n}`, state: "open",
      author: "octo", headRefName: `feat/${n}`, baseRefName: "main", mergeable: "MERGEABLE", bodyText: "A short description.",
      checks: [{ n: "test", state: "ok" }, { n: "lint", state: i % 7 === 0 ? "fail" : "run" }],
    });
  }
  return out;
}

// Sessions as radar sends them: each with three PR dots, pointing at feed PRs (`F` of them over `repos` repositories).
const cost = { cost: 0, in: 0, out: 0 };
function sessionRoots(F, S, repos) {
  const roots = [];
  for (let s = 0; s < S; s++) {
    const r = s % repos;
    const dots = [0, 1, 2].map((k) => {
      const i = (s * 3 + k) % F;
      const n = 1000 + i;
      return { n, state: "ok", label: `#${n}`, src: "pr", url: `https://example.test/example-org/repo-${i % repos}/pull/${n}` };
    });
    roots.push({
      key: `s${s}`, kind: "session", name: `s${s}`, state: "idle", sym: "idle", own: cost, tot: cost, age_s: 100, children: [],
      repoUrl: `https://example.test/example-org/repo-${r}`, dots,
    });
  }
  return roots;
}

test("openPrGroups and enrichPrs over a feed of 400 PRs read its entries fewer than 100 x 400 times", (t) => {
  const counter = { reads: 0 };
  // Not through parseRadarDoc: it keeps 300 feed entries at most.
  const feed = counted(feedList(400, 20), counter);
  const groups = openPrGroups(feed, [], new Set());
  for (const g of groups) enrichPrs(g.prs, feed);
  const shown = counter.reads;
  t.diagnostic(`(i) 400 PRs, 20 repos: ${shown} reads of feed entries`);
  assert.equal(groups.reduce((n, g) => n + g.prs.length, 0), 400);
  assert.ok(shown < 100 * 400, `${shown} reads`);
});

test("the D91 shape, 200 feed PRs and 30 sessions x 3 PRs (10 shown, 20 not), reads its feed entries fewer than 100 x 200 times", (t) => {
  const counter = { reads: 0 };
  const parsed = parseRadarDoc(JSON.stringify({ v: 1, roots: sessionRoots(200, 30, 8), openPrs: feedList(200, 8), openPrsAt: "2026-11-17T10:00:00Z" }));
  const tops = buildTree(parsed.nodes);
  const sessions = allSessions(tops);
  const feed = counted(parsed.openPrs, counter);
  const shown = new Set(sessions.slice(0, 10));
  const groups = openPrGroups(feed, tops, shown);
  for (const s of sessions) enrichPrs(s.prs, feed);
  for (const g of groups) enrichPrs(g.prs, feed);
  const reads = counter.reads;
  t.diagnostic(`(ii) 200 feed PRs, 30 sessions x 3 PRs: ${reads} reads of feed entries`);
  assert.equal(sessions.length, 30);
  assert.ok(sessions.slice(10).every((s) => s.prs.length === 3), "the 20 sessions not shown carry their PRs");
  assert.ok(reads < 100 * 200, `${reads} reads`);
});
