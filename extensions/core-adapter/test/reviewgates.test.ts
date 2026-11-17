// The review gate per checkout (reviewgates.ts): revise and verdict by known or unknown checkout, the reads, the combined view, the refusal hint.
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialReviewGate, onRevision, onReviewVerdicts, reviewHint } from "../bound.ts";
import { combined, gateOf, gatesClearFail, gatesMarkStood, gatesRevise, gatesVerdict, openHint, openRoots, standsFor } from "../reviewgates.ts";

const passed = (runId = "r1") => onReviewVerdicts(initialReviewGate(), ["pass"], 1, runId);
const own = { cwd: "/w/main", own: "/w/main" };

test("revise: a known checkout revises its own entry, an absent one is created as built without a review, others stay", () => {
  const g = gatesRevise({ "/a": passed(), "/b": passed() }, "/a");
  assert.deepEqual(g["/a"], { last: "pass", revised: true, passRun: "r1" });
  assert.deepEqual(g["/b"], passed());
  assert.deepEqual(gatesRevise(g, "/c")["/c"], { last: null, revised: true });
  assert.deepEqual(gatesRevise({}, "/c"), { "/c": { last: null, revised: true } });
});

test("revise: an unknown checkout revises every existing entry and creates none", () => {
  const g = gatesRevise({ "/a": passed(), "": passed() }, null);
  assert.equal(g["/a"].revised, true);
  assert.equal(g[""].revised, true);
  assert.deepEqual(gatesRevise({}, null), {});
  assert.deepEqual(gatesRevise({ "/a": initialReviewGate() }, null)["/a"], initialReviewGate(), "no verdict yet: nothing to re-open");
});

test("verdict: known roots take it each; one non-pass wins; a PASS also clears an existing session-wide entry", () => {
  const stale = onRevision(passed());
  const g = gatesVerdict({ "/a": stale, "": stale }, ["/a", "/b"], ["pass"], 5, "r2");
  assert.deepEqual([g["/a"].last, g["/a"].revised, g["/b"].last, g[""].last, g[""].revised], ["pass", false, "pass", "pass", false]);
  const f = gatesVerdict({ "/a": passed(), "": passed() }, ["/a", "/b"], ["pass", "fail"], 7, "r3");
  assert.equal(f["/a"].last, "fail");
  assert.equal(f["/a"].failAt, 7);
  assert.equal(f["/b"].last, "fail");
  assert.equal(f[""].last, "pass", "a FAIL in known checkouts leaves the session-wide entry");
  assert.equal(gatesVerdict({ "/a": passed() }, ["/a"], ["pass", null], 1, "r4")["/a"].last, "none");
  const same = { "/a": passed() };
  assert.equal(gatesVerdict(same, ["/a"], []), same, "no verdict: unchanged");
});

test("verdict: an unknown root's PASS clears only the session-wide entry; its FAIL or missing verdict hits every entry", () => {
  const stale = onRevision(passed());
  const p = gatesVerdict({ "/a": stale }, null, ["pass"], 1, "r5");
  assert.equal(p["/a"].revised, true, "the checkout entry stays stale");
  assert.equal(p[""].last, "pass");
  assert.equal(gatesVerdict({ "/a": stale }, [], ["pass"], 1, "r5")[""].last, "pass", "an empty root list is unknown");
  const f = gatesVerdict({ "/a": passed(), "/b": passed() }, null, ["fail"], 9, "r6");
  assert.deepEqual([f["/a"].last, f["/b"].last, f[""].last, f[""].failAt], ["fail", "fail", "fail", 9]);
  assert.equal(gatesVerdict({ "/a": passed() }, null, [null], 1, "r7")["/a"].last, "none");
});

test("gateOf: the root's entry, else the session-wide one, else initial; an unknown root reads the combined view", () => {
  const g = { "/a": passed("ra"), "": onRevision(passed("rs")) };
  assert.equal(gateOf(g, "/a").revised, false);
  assert.equal(gateOf(g, "/never").revised, true, "no entry: the session-wide (old saved) entry reads");
  assert.deepEqual(gateOf({ "/a": passed() }, "/b"), initialReviewGate());
  assert.equal(gateOf(g, null).revised, true);
  assert.deepEqual(gateOf({}, null), initialReviewGate());
});

test("combined: fail beats none beats no review beats pass; revised any; failAt max; empty is initial", () => {
  assert.deepEqual(combined({}), initialReviewGate());
  const f = gatesVerdict({}, ["/a"], ["fail"], 3, "rf");
  const g = gatesVerdict(f, ["/b"], ["fail"], 8, "rg");
  assert.equal(combined({ ...g, "/c": passed() }).last, "fail");
  assert.equal(combined({ ...g, "/c": passed() }).failAt, 8);
  assert.equal(combined({ "/a": passed(), "/b": { last: "none", revised: false } }).last, "none");
  assert.equal(combined({ "/a": passed(), "/b": { last: null, revised: true } }).last, null);
  assert.equal(combined({ "/a": passed(), "/b": { last: null, revised: true } }).revised, true);
  assert.deepEqual([combined({ "/a": passed("x"), "/b": passed("y") }).last, combined({ "/a": passed("x"), "/b": passed("y") }).revised], ["pass", false]);
});

test("standsFor: every root's gate stands (a root without an entry reads the session-wide one); no root stands for nothing", () => {
  const g = { "/a": passed(), "/b": onRevision(passed()) };
  assert.equal(standsFor(g, ["/a"]), true);
  assert.equal(standsFor(g, ["/a", "/b"]), false);
  assert.equal(standsFor(g, [null]), false, "an unknown root reads every entry");
  assert.equal(standsFor({ "/a": passed() }, [null]), true);
  assert.equal(standsFor(g, []), false);
});

test("openRoots and openHint: today's text for the session's own checkout or the session-wide entry; paths and reasons otherwise", () => {
  const g = gatesRevise({ "/w/main": passed("rp") }, "/w/main");
  assert.deepEqual(openRoots(g), ["/w/main"]);
  assert.equal(openHint(g, own), reviewHint(g["/w/main"]));
  assert.equal(openHint(g, own), "(re-review needed: revised after the last PASS) (run rp)");
  assert.equal(openHint({ "": gatesVerdict({}, null, ["fail"], 1)[""] }, own), "(re-review needed: last verdict FAIL)");
  const two = gatesRevise({ "/w/main": passed(), "/w/main/wt": passed() }, "/w/main/wt");
  assert.equal(openHint(two, own), "(re-review needed: wt: revised after the last PASS)");
  const built = gatesRevise({ "/w/main": passed() }, "/w/other");
  assert.equal(openHint(built, own), "(re-review needed: /w/other: built, no review yet)");
  const several = gatesVerdict(gatesRevise({ "/w/main": passed() }, "/w/main"), ["/w/x"], ["fail"], 1);
  assert.equal(openHint(several, own), "(re-review needed: /w/main: revised after the last PASS; /w/x: last verdict FAIL)");
  assert.equal(openHint(gatesRevise({ "": passed() }, null), own).includes("unknown"), false, "the session-wide entry alone: today's text");
  assert.equal(openHint({ "": onRevision(passed()), "/w/x": initialReviewGate(), "/w/y": { last: null, revised: true } }, own), "(re-review needed: unknown checkout: revised after the last PASS; /w/x: no review yet; /w/y: built, no review yet)");
  assert.equal(openHint({ "/w/main": passed() }, own), "", "nothing open: no hint");
});

test("mark stood: a FAIL checkout with no own entry, covered by a standing session-wide entry, is passed by the clear", () => {
  const before = { "": passed() };
  const failed = gatesMarkStood(before, gatesVerdict(before, ["/w/a"], ["fail"], 7, "r1"));
  assert.equal(failed["/w/a"]!.stoodAtFail, true);
  assert.equal(gatesClearFail(failed, "/w/a", 7, 9, "r2")["/w/a"]!.last, "pass");
});
