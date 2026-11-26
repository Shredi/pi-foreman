// The turn warning (ChildLadder.warnOf) and the reviewer default turn cap (roles.reviewer.childMaxTurns 100 in config/foreman.defaults.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ChildLadder, childMaxTurns } from "../ladder.ts";

const defaults = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "config", "foreman.defaults.json"), "utf8"));

/** Drive `n` turns, collecting the turn each warning and each cap steer came with. */
function run(l: ChildLadder, n: number): { warned: number[]; capped: number[]; texts: string[] } {
  const out = { warned: [] as number[], capped: [] as number[], texts: [] as string[] };
  for (let i = 1; i <= n; i++) {
    const steer = l.onUsage({});
    if (steer) out.capped.push(steer.count);
    const w = l.warnOf();
    if (w) {
      out.warned.push(w.turns);
      out.texts.push(w.text);
    }
  }
  return out;
}

test("turn warning: once, at 80 % of a limit of 100, with the turns left in the text; the cap steer still fires after it", () => {
  const r = run(new ChildLadder({ bottom: true, maxTurns: 100 }), 105);
  assert.deepEqual(r.warned, [80]);
  assert.equal(r.texts[0], "pi-foreman ladder: 80 of 100 turns used; finish your work and do your end step within the next 20 turns.");
  assert.deepEqual(r.capped, [101]);
});

test("turn warning: rounds up (limit 12 warns at turn 10), and fires on the top rung too", () => {
  assert.deepEqual(run(new ChildLadder({ bottom: false, maxTurns: 12 }), 12).warned, [10]);
  assert.deepEqual(run(new ChildLadder({ bottom: false, maxTurns: 10 }), 10).warned, [8]);
});

test("turn warning: no warning for a limit below 10, with no limit, or after the cap steer", () => {
  assert.deepEqual(run(new ChildLadder({ bottom: true, maxTurns: 9 }), 12).warned, []);
  assert.deepEqual(run(new ChildLadder({ bottom: true, maxTurns: 2 }), 5).warned, []);
  assert.deepEqual(run(new ChildLadder({ bottom: true }), 200).warned, []);
  assert.deepEqual(run(new ChildLadder(undefined), 200).warned, []);
  const r = run(new ChildLadder({ bottom: true, maxTurns: 10 }), 12);
  assert.deepEqual([r.warned, r.capped], [[8], [11]], "once before the cap; nothing after the cap steer");
  const late = new ChildLadder({ bottom: false, strongAbove: 1, maxTurns: 10, contextCap: 5 });
  late.onUsage({ input: 10 }); // the context-cap steer is sent first
  assert.equal(late.warnOf(9), null, "no warning after a steer");
});

test("turn warning: onUsage keeps its contract (no steer before the cap, one steer at the cap)", () => {
  const l = new ChildLadder({ bottom: false, maxTurns: 10 });
  const steers = Array.from({ length: 12 }, () => l.onUsage({}));
  assert.deepEqual(steers.map((s) => s?.trigger ?? null), [...Array(10).fill(null), "turns", null]);
});

test("reviewer turn cap: 100 by default; the user's own reviewer cap wins; global and provider caps no longer reach the reviewer", () => {
  const d = { ladder: defaults.ladder, roles: defaults.roles };
  assert.equal(childMaxTurns(d, undefined, "reviewer"), 100);
  assert.equal(childMaxTurns(d, undefined, "explorer"), 60, "other roles keep the ladder default");
  assert.equal(childMaxTurns({ ...d, roles: { ...d.roles, reviewer: { ...d.roles.reviewer, childMaxTurns: 40 } } }, undefined, "reviewer"), 40);
  assert.equal(childMaxTurns({ ...d, ladder: { ...d.ladder, maxTurns: { builder: 100, reviewer: 30 } } }, undefined, "reviewer"), 30);
  assert.equal(childMaxTurns({ ...d, ladder: { ...d.ladder, childMaxTurns: 20 }, providers: { p: { childMaxTurns: 25 } } }, "p", "reviewer"), 100);
});
