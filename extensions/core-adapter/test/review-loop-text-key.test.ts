// D133: a review-loop repeat is keyed on the normalized finding text, not on file, line/5 and class (reviewloop.ts sigOf, loopVerdictOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { loopRefusal, loopRefusalParented, loopVerdictOf, sigOf, type LoopRound } from "../reviewloop.ts";
import { tick, world } from "./_r46world.ts";
import type { RecSpec } from "./_verdict-rig.ts";

const fail = (state: string, sig: string[], work?: number): LoopRound => ({ verdict: "fail", state, sig, ...(work === undefined ? {} : { work }) });
const d = (text: string, file?: string, line?: number, cls?: string) => ({ kind: "defect" as const, text, ...(file ? { file } : {}), ...(line !== undefined ? { line } : {}), ...(cls ? { class: cls } : {}) });

test("sigOf: case, whitespace and trailing punctuation variants give one key; file, line and class do not enter it", () => {
  const a = sigOf([], [d("The guard  is Missing.", "a.ts", 3, "bug")]);
  const b = sigOf([], [d("  the guard is missing;; ", "b.ts", 90, "style")]);
  assert.deepEqual(a, ["txt:the guard is missing"]);
  assert.deepEqual(a, b);
  assert.deepEqual(sigOf([], [d("no file here")]), ["txt:no file here"], "a file-less defect keys now");
  assert.deepEqual(sigOf([], [d("   ")]), [], "an empty text gives no key");
  assert.equal(sigOf([], [d("x".repeat(300))])[0], `txt:${"x".repeat(300)}`, "the stored key keeps the full text");
});

test("loopVerdictOf: a new text at the same file and line bucket is progress; the same text again is a repeat", () => {
  const k1 = sigOf([{ id: 1, result: "fail" }], [d("the goal is vague", "plan.md", 1)]);
  const k2 = sigOf([{ id: 1, result: "fail" }], [d("the scope is unclear", "plan.md", 2)]);
  assert.equal(loopVerdictOf("code", fail("s1", k1), fail("s2", k2)), null, "session A: other finding, same items");
  assert.equal(loopVerdictOf("code", fail("s1", k1), fail("s2", k1)), "repeat", "same text again");
  const norm = sigOf([{ id: 1, result: "fail" }], [d("The Goal is   vague.", "other.md", 77)]);
  assert.equal(loopVerdictOf("code", fail("s1", k1), fail("s2", norm)), "repeat", "a whitespace and case variant");
  assert.equal(loopVerdictOf("plan", fail("p1", k1), fail("p2", k1)), "repeat", "a plan version change does not hide the same text");
  assert.equal(loopVerdictOf("plan", fail("p1", k1), fail("p2", k2)), null);
  assert.equal(loopVerdictOf("code", fail("s1", k1, 1), fail("s2", k1, 2)), "repeat", "work up, but a txt: key is in the set");
});

test("loopVerdictOf: session B: A fixed, a new finding B comes: no stop", () => {
  const a = sigOf([], [d("finding A")]);
  const b = sigOf([], [d("finding B")]);
  assert.equal(loopVerdictOf("code", fail("s1", a), fail("s2", b)), null);
});

test("loopVerdictOf: a leftover at: key of an older record is treated like a txt: key and never equals a txt: key", () => {
  assert.equal(loopVerdictOf("plan", fail("a", ["at:f:1:x"]), fail("b", ["at:f:1:x"])), "repeat");
  assert.equal(loopVerdictOf("plan", fail("a", ["at:f:1:x"]), fail("b", ["txt:the goal is vague"])), null, "first round after the upgrade cannot stop");
});

test("the refusal texts show a txt: key cut to 60 characters with …", () => {
  const long = `txt:${"y".repeat(100)}`;
  const stop = { rule: "repeat" as const, kind: "code" as const, sig: [long, "item:2"] };
  for (const text of [loopRefusal(stop), loopRefusalParented(stop), loopRefusalParented(stop, true)]) {
    assert.ok(text.includes(`${long.slice(0, 59)}…, item:2`), text);
    assert.ok(!text.includes(long));
  }
});

// a plan review's findings: the same line bucket in both rounds, different texts
test("a plan session: a revised plan with new texts at the same line goes on; the same text on a newer plan version stops", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  const a = await w.adapter("startup");
  let rounds = 0;
  const review = async (spec: RecSpec): Promise<string | null> => {
    const r = await a.reviewLaunch();
    if (r.blocked) return r.blocked;
    const want = ++rounds;
    a.endRunRecord(r.id, spec);
    const end = Date.now() + 10_000;
    while ((await w.traceEvents()).filter((e) => e.event === "plan_review").length < want) {
      assert.ok(Date.now() < end, `plan review ${want} recorded`);
      await tick(25);
    }
    return null;
  };
  const f = (text: string): RecSpec => ({ verdict: "fail", findings: [{ kind: "defect", text, file: "plan.md", line: 1, class: "off-by-one" }] });
  const bump = (from: string, to: string): void => fs.writeFileSync(w.planFile, fs.readFileSync(w.planFile, "utf8").replace(from, to));
  assert.equal(await review(f("first problem")), null);
  bump("Ship it.", "Ship it twice.");
  assert.equal(await review(f("second problem")), null);
  assert.equal((await w.traceEvents()).filter((e) => e.event === "review_loop").length, 0, "new text on a revised plan: no stop");
  bump("Ship it twice.", "Ship it thrice.");
  assert.equal(await review(f("Second  problem.")), null, "the same problem comes back on a new plan version");
  const end = Date.now() + 10_000;
  while (!(await w.traceEvents()).some((e) => e.event === "review_loop")) {
    assert.ok(Date.now() < end, "the loop stop is set");
    await tick(25);
  }
});
