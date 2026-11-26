// The finish refusal names the ways out of a re-opened checkout (docs/review.md "One review per revision"): a review in that checkout, and for a side checkout
// `supersededGone` could drop once its worktree is gone, the removal of that worktree. The gate verdicts stay as they were.
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialReviewGate, onReviewVerdicts } from "../bound.ts";
import { droppableOnceGone, gatesRevise, gatesVerdict, openHint, openRoots, supersededGone } from "../reviewgates.ts";

const own = { cwd: "/w/main", own: "/w/main" };
const passed = (at = 1) => onReviewVerdicts(initialReviewGate(), ["pass"], at, "r1", at);
const REMOVE = /remove the worktree: its open entry is then dropped once another checkout has a PASS later in time/;

test("a reopened side checkout built after its PASS gets both ways out", () => {
  const g = gatesRevise({ "/w/main": passed(), "/w/main/wt": passed() }, "/w/main/wt", 5);
  const hint = openHint(g, own);
  assert.match(hint, /^\(re-review needed: wt: revised after the last PASS\) - run a reviewer in that checkout again; or, when the work in wt is no longer needed, /);
  assert.match(hint, REMOVE);
});

test("the removal way is the one supersededGone applies: once the worktree is gone and another checkout has a later PASS, the entry is dropped", () => {
  const g = gatesRevise({ "/w/main": passed(1), "/w/main/wt": passed(1) }, "/w/main/wt", 5);
  const later = gatesVerdict(g, ["/w/main"], ["pass"], 9, "r2");
  assert.deepEqual(openRoots(later), ["/w/main/wt"]);
  assert.match(openHint(later, own), REMOVE);
  assert.deepEqual(supersededGone(later, (d) => d !== "/w/main/wt").dropped, [{ dir: "/w/main/wt", by: "/w/main" }]);
});

test("the session's own checkout, the session-wide entry, an entry without builtAt and an entry with a running builder get only the re-review line", () => {
  const stale = gatesRevise({ "/w/main": passed(), "/w/main/wt": passed(), "/w/side": passed() }, "/w/main/wt", 5);
  // own checkout open next to a side checkout: the own one is never offered for removal
  const ownOpen = gatesRevise(stale, "/w/main", 6);
  const hintOwn = openHint({ "/w/main": ownOpen["/w/main"], "/w/main/wt": { ...ownOpen["/w/main/wt"], builtAt: undefined } }, own);
  assert.match(hintOwn, /- run a reviewer in each of these checkouts again$/);
  assert.doesNotMatch(hintOwn, /remove the worktree/);
  // session-wide entry
  assert.doesNotMatch(openHint({ "": { last: "pass", revised: true, builtAt: 5 }, "/w/main/wt": { last: null, revised: true } }, own), /remove the worktree/);
  assert.doesNotMatch(openHint({ "": { last: "pass", revised: true, builtAt: 5 } }, own), /remove the worktree/);
  // no builtAt
  const noTime = gatesRevise({ "/w/main": passed(), "/w/side": passed() }, "/w/side");
  assert.equal(noTime["/w/side"].builtAt, undefined);
  assert.doesNotMatch(openHint(noTime, own), /remove the worktree/);
  assert.match(openHint(noTime, own), /re-review needed: \/w\/side: revised after the last PASS\) - run a reviewer in that checkout again$/);
  // running builder
  const built = gatesRevise({ "/w/main": passed(), "/w/side": passed() }, "/w/side", 5);
  assert.match(openHint(built, own), REMOVE);
  assert.match(openHint(built, { ...own, running: new Set(["/w/other"]) }), REMOVE);
  const hintRunning = openHint(built, { ...own, running: new Set(["/w/side"]) });
  assert.doesNotMatch(hintRunning, /remove the worktree/);
  assert.match(hintRunning, /- run a reviewer in that checkout again$/);
});

test("droppableOnceGone is the predicate supersededGone uses", () => {
  const e = gatesRevise({ "/a": passed() }, "/a", 5)["/a"];
  assert.equal(droppableOnceGone("/a", e), true);
  assert.equal(droppableOnceGone("", e), false);
  assert.equal(droppableOnceGone("/a", passed()), false, "a standing entry");
  assert.equal(droppableOnceGone("/a", e, new Set(["/a"])), false);
  assert.equal(droppableOnceGone("/a", { ...e, builtAt: undefined }), false);
});
