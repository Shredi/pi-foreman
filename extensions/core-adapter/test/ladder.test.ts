import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildLadder, childMaxTurns, climbCause, LadderState, ledgerLines, onBottomRung, strongAbove } from "../ladder.ts";
import { applyLaunchModels } from "../launchmodel.ts";

const ROLES = {
  builder: { model: "p/small", thinking: "medium", strong: { model: "p/big", thinking: "medium" } },
  explorer: { model: "p/small", thinking: "low" },
};
const end = (runId: string, summary: string) => ({ runId, status: "completed", role: "builder", summary, resultPath: `/r/${runId}` });

test("strongAbove and childMaxTurns: role, then provider, then ladder, then the default", () => {
  const cfg = { roles: { builder: { strongAbove: 7, childMaxTurns: 3 } }, providers: { p: { strongAbove: 8, childMaxTurns: 4 } }, ladder: { strongAbove: 9, childMaxTurns: 5 } };
  assert.deepEqual([strongAbove(cfg, "p", "builder"), strongAbove(cfg, "p", "explorer"), strongAbove(cfg, "q", "explorer"), strongAbove({}, "p", "x")], [7, 8, 9, 100000]);
  assert.deepEqual([childMaxTurns(cfg, "p", "builder"), childMaxTurns(cfg, "p", "explorer"), childMaxTurns(cfg, "q", "x"), childMaxTurns({}, "p", "x")], [3, 4, 5, 60]);
});

test("child side: context above strongAbove on the bottom rung steers once with RUNG_UP: context", () => {
  const c = new ChildLadder({ bottom: true, strongAbove: 100, maxTurns: 60 });
  assert.equal(c.onUsage({ input: 50, cacheRead: 40, cacheWrite: 10 }), null);
  const s = c.onUsage({ input: 50, cacheRead: 40, cacheWrite: 11 });
  assert.deepEqual([s?.trigger, s?.count, s?.rung], ["context", 101, "bottom"]);
  assert.match(s!.text, /first line is exactly: RUNG_UP: context/);
  assert.equal(c.onUsage({ input: 500 }), null);
  assert.equal(new ChildLadder({ bottom: false, strongAbove: 100 }).onUsage({ input: 500 }), null);
  assert.equal(new ChildLadder(undefined).onUsage({ input: 1e9 }), null);
});

test("child side: past childMaxTurns the bottom rung hands off (RUNG_UP: turns), the top rung reports", () => {
  const bottom = new ChildLadder({ bottom: true, maxTurns: 2 });
  assert.equal(bottom.onUsage({}), null);
  assert.equal(bottom.onUsage({}), null);
  const s = bottom.onUsage({});
  assert.deepEqual([s?.trigger, s?.count, s?.rung], ["turns", 3, "bottom"]);
  assert.match(s!.text, /RUNG_UP: turns/);
  assert.equal(bottom.onUsage({}), null);
  const top = new ChildLadder({ bottom: false, maxTurns: 1 });
  top.onUsage({});
  const t = top.onUsage({});
  assert.deepEqual([t?.trigger, t?.rung], ["turns", "top"]);
  assert.doesNotMatch(t!.text, /RUNG_UP/);
});

test("climbCause: RUNG_UP marker, STATUS: stuck, own checks failed", () => {
  assert.equal(climbCause("\nRUNG_UP: context\nDone: a"), "context");
  assert.equal(climbCause("RUNG_UP: turns"), "turns");
  assert.equal(climbCause("builder:\nRUNG_UP: context\nDone: x"), "context"); // run-end summary shape
  assert.equal(climbCause("Files changed: x\nSTATUS: stuck"), "stuck");
  assert.equal(climbCause("My own checks failed twice."), "checks_failed");
  assert.equal(climbCause("All done. Mentions RUNG_UP: later"), null);
});

test("a strong launch without reason or trigger is refused; reason, heavy tier and revision pass", () => {
  const l = new LadderState();
  const refused = l.plan({ agent: "builder", task: "t", model: "strong" }, ROLES);
  assert.match(refused.block ?? "", /strong_no_reason/);
  const input: Record<string, unknown> = { agent: "builder", task: "t", model: "strong", reason: "the bug spans three crates" };
  const ok = l.plan(input, ROLES);
  assert.deepEqual([ok.block, ok.climbs.map((c) => [c.reason, c.from, c.to])], [undefined, [["foreman", "p/small", "p/big"]]]);
  assert.equal("reason" in input, false);
  assert.equal(l.plan({ agent: "builder", task: "t", model: "strong" }, ROLES, { tier: "heavy" }).climbs[0].reason, "heavy");
  assert.equal(l.plan({ agent: "builder", task: "t" }, ROLES, { preferStrong: true }).climbs[0].reason, "revision");
  assert.deepEqual(l.plan({ agent: "explorer", task: "t", model: "strong" }, ROLES), { climbs: [] }); // no strong rung: notice path
  assert.deepEqual(l.plan({ agent: "builder", task: "t" }, ROLES), { climbs: [] });
});

test("a climb-eligible bottom-rung run allows strong and its handoff is prepended once; rung_up is traced", () => {
  const l = new LadderState();
  l.onLaunch("c1", "builder", onBottomRung(ROLES, "builder", "p/small:medium"));
  l.onLaunched("c1", "r1");
  assert.equal(l.onRunEnd(end("r1", "RUNG_UP: context\nDone: parser\nRemaining: tests\nFiles touched: a.rs"))?.cause, "context");
  const input: Record<string, unknown> = { agent: "builder", task: "Finish item 2.", model: "strong" };
  const plan = l.plan(input, ROLES);
  applyLaunchModels(input, ROLES, "high");
  const ledger = "# L\n- [x] 1. one\n- [ ] 2. two\n- [ ] 3. three\n";
  const recs = l.apply(plan.climbs, (task) => ledgerLines(ledger, task));
  assert.deepEqual(recs, [{ event: "rung_up", role: "builder", from: "p/small", to: "p/big", reason: "context" }]);
  const task = input.task as string;
  assert.ok(task.startsWith("[pi-foreman rung-up handoff] The previous builder run r1 stopped (context)."));
  assert.ok(task.includes("Remaining: tests") && task.includes("Full result: /r/r1") && task.includes("- [ ] 2. two") && !task.includes("3. three"));
  assert.ok(task.endsWith("Finish item 2."));
  assert.equal(input.model, "p/big:medium");
  assert.match(l.plan({ agent: "builder", task: "t", model: "strong" }, ROLES).block ?? "", /strong_no_reason/);
  // a strong-rung run that gets stuck has no rung above: not eligible
  l.onLaunch("c2", "builder", onBottomRung(ROLES, "builder", "p/big:medium"));
  l.onLaunched("c2", "r2");
  assert.equal(l.onRunEnd(end("r2", "STATUS: stuck")), null);
});

test("ledgerLines: named items, else the open ones; bounded handoff summary", () => {
  const ledger = "- [ ] 1. a\n```\n- [ ] 9. fenced\n```\n- [x] 2. b\n- [ ] 3. c\n";
  assert.deepEqual(ledgerLines(ledger, "do items 2 and 3"), ["- [x] 2. b", "- [ ] 3. c"]);
  assert.deepEqual(ledgerLines(ledger, "go"), ["- [ ] 1. a", "- [ ] 3. c"]);
  assert.deepEqual(ledgerLines(null, "go"), []);
  const l = new LadderState();
  l.onLaunch("c", "builder", true);
  l.onLaunched("c", "r");
  l.onRunEnd(end("r", `RUNG_UP: context\n${"x".repeat(9000)}`));
  const input: Record<string, unknown> = { agent: "builder", task: "t", model: "strong" };
  l.apply(l.plan(input, ROLES).climbs, () => []);
  assert.ok((input.task as string).length < 4500 && (input.task as string).includes("cut at 4000 characters"));
});
