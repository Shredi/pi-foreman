// The finish refusal names the ways out of a re-opened checkout (docs/review.md "One review per revision"): a review in that checkout, and for a side checkout
// the removal of its worktree (`goneDropped` drops an entry whose path is gone, D189b). The gate verdicts stay as they were.
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialReviewGate, onReviewVerdicts } from "../bound.ts";
import { gatesRevise, goneDropped, openHint, openRoots } from "../reviewgates.ts";

const own = { cwd: "/w/main", own: "/w/main" };
const passed = (at = 1) => onReviewVerdicts(initialReviewGate(), ["pass"], at, "r1");
const REMOVE = /remove the worktree: its open entry is then dropped$/;

test("a reopened side checkout built after its PASS gets both ways out", () => {
  const g = gatesRevise({ "/w/main": passed(), "/w/main/wt": passed() }, "/w/main/wt");
  const hint = openHint(g, own);
  assert.match(hint, /^\(re-review needed: wt: revised after the last PASS\) - run a reviewer in that checkout again; or, when the work in wt is no longer needed, /);
  assert.match(hint, REMOVE);
  assert.doesNotMatch(hint, /once another checkout has a PASS later in time/);
});

test("the removal way is the one goneDropped applies: once the worktree is gone the entry is dropped, with no PASS elsewhere needed", () => {
  const g = gatesRevise({ "/w/main": passed(1), "/w/main/wt": passed(1) }, "/w/main/wt");
  assert.deepEqual(openRoots(g), ["/w/main/wt"]);
  assert.match(openHint(g, own), REMOVE);
  assert.deepEqual(goneDropped(g, (d) => d !== "/w/main/wt").dropped, ["/w/main/wt"]);
  const noPass = gatesRevise({}, "/w/main/wt");
  assert.deepEqual(goneDropped(noPass, () => false).dropped, ["/w/main/wt"]);
});

test("the session's own checkout and the session-wide entry get only the re-review line; any other open side checkout gets the removal way", () => {
  const stale = gatesRevise({ "/w/main": passed(), "/w/main/wt": passed(), "/w/side": passed() }, "/w/main/wt");
  // own checkout open next to a side checkout: the own one is never offered for removal
  const ownOpen = gatesRevise(stale, "/w/main");
  const hintOwn = openHint({ "/w/main": ownOpen["/w/main"], "/w/main/wt": passed() }, own);
  assert.doesNotMatch(hintOwn, /remove the worktree/);
  assert.match(openHint({ "/w/main": ownOpen["/w/main"], "/w/main/wt": ownOpen["/w/main/wt"] }, own), /remove the worktree/);
  // session-wide entry
  assert.doesNotMatch(openHint({ "": { last: "pass", revised: true }, "/w/main": passed() }, own), /remove the worktree/);
  assert.doesNotMatch(openHint({ "": { last: "pass", revised: true } }, own), /remove the worktree/);
  // a side checkout with no review record at all
  const fresh = gatesRevise({ "/w/main": passed(), "/w/side": passed() }, "/w/side");
  assert.match(openHint(fresh, own), REMOVE);
  assert.match(openHint(fresh, own), /re-review needed: \/w\/side: revised after the last PASS\) - run a reviewer in that checkout again; /);
});

test("goneDropped: every gone entry but the session-wide one is dropped, an existing one never; one entry per gone checkout", () => {
  const g = { "": { last: null, revised: true }, "/a": passed(), "/b": { last: "fail" as const, revised: false }, "/c": { last: null, revised: true } };
  const r = goneDropped(g, () => false);
  assert.deepEqual(r.dropped, ["/a", "/b", "/c"]);
  assert.deepEqual(Object.keys(r.gates), [""]);
  const live = goneDropped(g, () => true);
  assert.deepEqual(live.dropped, []);
  assert.deepEqual(Object.keys(live.gates), ["", "/a", "/b", "/c"]);
});
