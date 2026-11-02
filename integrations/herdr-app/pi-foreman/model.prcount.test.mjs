import test from "node:test";
import assert from "node:assert/strict";
import { parseRadar, buildTree, prSummary, sortPrs } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const node = (key, dots, repoUrl) => ({ key, kind: "session", name: key, state: "idle", sym: "waiting", glyph: "⏸", own: cost, tot: cost, children: [], waits: [], tasks: [], dots, ...(repoUrl ? { repoUrl } : {}) });
const dot = (n, state, over = {}) => ({ n, state, label: `#${n}`, src: "pr", ...over });
const pr = (number, checks, over = {}) => ({ number, checks, url: "", repo: "", ...over });

test("summary: a PR seen on two sessions is counted once (same URL, else same repo and number)", () => {
  const url = "https://example.test/acme/app/pull/73";
  const a = pr(73, ["fail"], { url });
  const b = pr(73, ["fail"], { url });
  assert.equal(prSummary([a, b]), "1 PR · 1 failing");
  const c = pr(5, ["pending"], { repo: "https://example.test/acme/app" });
  const d = pr(5, ["pending"], { repo: "https://example.test/acme/app" });
  const e = pr(5, ["pending"], { repo: "https://example.test/acme/other" });
  assert.equal(prSummary([c, d, e]), "2 PRs · 2 pending");
  assert.equal(sortPrs([a, b]).length, 1);
});

test("summary: a merged or closed PR is not counted or listed", () => {
  const list = [pr(1, ["fail"], { state: "merged" }), pr(2, ["fail"], { state: "closed" }), pr(3, ["ok"], { state: "open" }), pr(4, ["ok"])];
  assert.equal(prSummary(list), "2 PRs · all green");
  assert.deepEqual(sortPrs(list).map((p) => p.number), [4, 3]);
  assert.equal(prSummary([pr(1, ["fail"], { state: "merged" })]), "");
});

test("dots: the same number in two repositories is two PRs; inherited names are not check states", () => {
  const tree = buildTree(parseRadar(JSON.stringify({
    roots: [node("s", [
      dot(7, "ok", { repo: "https://example.test/acme/app" }),
      dot(7, "fail", { repo: "https://example.test/acme/other" }),
      dot(8, "toString"),
      dot(9, "ok", { checks: [{ name: "x", state: "constructor" }] }),
    ])],
  })));
  const prs = tree[0].prs;
  assert.deepEqual(prs.map((p) => p.number), [7, 7, 9]);
  assert.deepEqual(prs[2].checks, ["ok"], "an inherited name is not a check state");
});
