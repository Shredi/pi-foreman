// PR 2 of the intercom round: the `[review_loop]` stop text of a session a parent opened. A child that intercom cannot reach the parent of (remote,
// `PI_FOREMAN_REMOTE_PARENT=1`) gets the text of origin/main byte for byte (report by file, `ask.md`); a local child gets the new text.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { loopRefusalParented, type LoopStop } from "../reviewloop.ts";
import { tick, world } from "./_r46world.ts";

// The text as origin/main has it; `WHY` stands for the part that names the rule and the findings.
const TAIL = " Stop and report the open findings to the parent by file (ask.md in the handoff dir) and wait for its ruling, which lifts this stop. Ask the owner with ask_user_question only when a finding needs the owner's decision (an answer lifts this stop too). A parent brief, a new owner prompt, or a /ceremony tier change also lifts this; a [second-opinion] review is still allowed.";
const ORIGIN_MAIN = "pi-foreman: launch refused [review_loop]: the last two plan review rounds failed with the same findings (item:1)." + TAIL;
const ORIGIN_MAIN_STALLED = "pi-foreman: launch refused [review_loop]: the last code review failed again with no new finding and no change to the work since the round before (item:2)." + TAIL;
const STOP: LoopStop = { rule: "repeat", kind: "plan", sig: ["item:1"] };

test("the by-file text equals the origin/main text; the default text is the new one", () => {
  assert.equal(loopRefusalParented(STOP, true), ORIGIN_MAIN);
  assert.equal(loopRefusalParented({ rule: "stalled", kind: "code", sig: ["item:2"] }, true), ORIGIN_MAIN_STALLED);
  const local = loopRefusalParented(STOP);
  assert.notEqual(local, ORIGIN_MAIN);
  assert.match(local, /report the open findings to the parent in an intercom message whose first line starts with Question/);
  assert.match(local, /If intercom cannot reach the parent \(it is not a Pi session, or the send says Session not found\), report by file \(ask\.md in the handoff dir\)/);
});

const FAIL1 = "1. FAIL: the goal is vague\nOverall verdict: FAIL";
const FAIL2 = "1. FAIL: the scope is unclear\nOverall verdict: FAIL";

/** Drives a parented session into the loop stop and returns the refusal text of the next review launch. */
async function refusalText(t: { after(fn: () => void | Promise<void>): void }, remote: boolean): Promise<string> {
  const saved = process.env.PI_FOREMAN_REMOTE_PARENT;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_FOREMAN_REMOTE_PARENT;
    else process.env.PI_FOREMAN_REMOTE_PARENT = saved;
  });
  const w = world(t, { handoff: true, parent: true });
  if (remote) process.env.PI_FOREMAN_REMOTE_PARENT = "1";
  else delete process.env.PI_FOREMAN_REMOTE_PARENT;
  const a = await w.adapter("startup");
  let rounds = 0;
  const review = async (report: string): Promise<string | null> => {
    const r = await a.reviewLaunch();
    if (r.blocked) return r.blocked;
    const want = ++rounds;
    a.endRun(r.id, report);
    const end = Date.now() + 10_000;
    while ((await w.traceEvents()).filter((e) => e.event === "plan_review").length < want) {
      assert.ok(Date.now() < end, `plan review ${want} was recorded within 10 s`);
      await tick(25);
    }
    return null;
  };
  assert.equal(await review(FAIL1), null);
  fs.writeFileSync(w.planFile, fs.readFileSync(w.planFile, "utf8").replace("Ship it.", "Ship it twice."));
  assert.equal(await review(FAIL2), null);
  assert.equal(await review(FAIL2), null);
  const end = Date.now() + 10_000;
  while (!(await w.traceEvents()).some((e) => e.event === "review_loop")) {
    assert.ok(Date.now() < end, "the loop stop is set within 10 s");
    await tick(25);
  }
  const refused = await review(FAIL2);
  assert.ok(refused && /\[review_loop\]/.test(refused), "the stop refuses the launch");
  return refused;
}

test("a remote child's loop-stop text is the origin/main text", async (t) => {
  const text = await refusalText(t, true);
  const why = /^pi-foreman: launch refused \[review_loop\]: [^(]*\(item:1\)\./.exec(text)?.[0] ?? "";
  assert.ok(why, "the text opens as the origin/main text does");
  assert.equal(text, why + TAIL);
});

test("a local child's loop-stop text is the new one", async (t) => {
  const text = await refusalText(t, false);
  assert.match(text, /to the parent in an intercom message whose first line starts with Question/);
  assert.doesNotMatch(text, /and wait for its ruling, which lifts this stop\. Ask/);
});
