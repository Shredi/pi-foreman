import test from "node:test";
import assert from "node:assert/strict";
import { sessionTree, openPrGroups, shownSet, sessionCount } from "./model.js";
import { sess, treeOf } from "./fixtures.mjs";

const dot = (n) => ({ n, state: "ok", label: `#${n}`, src: "pr", url: `https://example.test/acme/widgets/pull/${n}` });
const flat = (item) => [item, ...item.children.flatMap(flat)];
const build = (pDots, oldState = "closed") => {
  const top = treeOf(sess("p", "p", { hcTerminal: "t1", repoUrl: "https://example.test/acme/widgets", dots: pDots }, [
    sess("old", "old", { state: oldState, sym: "done", repoUrl: "https://example.test/acme/widgets", dots: [dot(9)] }),
  ]));
  const root = sessionTree(top);
  return { top, root, groups: openPrGroups([], [top], shownSet([top], [root])) };
};

test("a hidden closed session gives its open PR to Open PRs, once", () => {
  const { root, groups } = build([dot(5)]);
  assert.deepEqual(flat(root).map((i) => i.label), ["p"]);
  assert.deepEqual(groups.flatMap((g) => g.prs.map((p) => p.number)), [9]);
});

test("a drawn session keeps its PR on its row, not in Open PRs", () => {
  const { root, groups } = build([dot(5)], "working");
  assert.ok(flat(root).some((i) => i.label === "old"));
  assert.deepEqual(groups, []);
});

test("a hidden closed session's merged PR is not listed", () => {
  const top = treeOf(sess("p", "p", { hcTerminal: "t1", repoUrl: "https://example.test/acme/widgets" }, [
    sess("old", "old", { state: "closed", sym: "done", repoUrl: "https://example.test/acme/widgets", dots: [dot(9)] }),
  ]));
  const feed = [{ repo: "acme/widgets", number: 9, title: "t", url: dot(9).url, state: "merged", checks: [] }];
  assert.deepEqual(openPrGroups(feed, [top], shownSet([top], [sessionTree(top)])), []);
});

test("a closed parent with a live child is drawn dimmed", () => {
  const top = treeOf(sess("r", "r", {}, [sess("p", "p", { state: "closed", sym: "done" }, [sess("kid", "kid", { hcTerminal: "t2" })])]));
  const p = sessionTree(top).children[0];
  assert.equal(p.dim, true);
});

test("sessionCount skips closed sessions", () => {
  const top = treeOf(sess("r", "r", {}, [sess("a", "a"), sess("old", "old", { state: "closed", sym: "done" })]));
  assert.equal(sessionCount(top), 2);
});
