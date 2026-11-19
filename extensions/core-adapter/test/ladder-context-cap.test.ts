// D70: builders have no coded read budget (a configured one says "write the code"), and ladder.contextCap makes a child stop and hand off at an
// absolute context size; a top-rung handoff lets the foreman relaunch a fresh run with model "strong".
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildReads, childReadLimits } from "../childreads.ts";
import { ChildLadder, contextCap, LadderState, topClimbHint } from "../ladder.ts";
import type { Json } from "../config.ts";
import { bindLaunch, readBinding, recordUsageLaunch, BINDINGS_ENV } from "../usage.ts";

const ROLES = {
  builder: { model: "p/small", thinking: "medium", strong: { model: "p/big", thinking: "medium" } },
  explorer: { model: "p/small", thinking: "low" },
};
const NO_STRONG = { builder: { model: "p/small", thinking: "medium" } };
const CAP_REPORT = "RUNG_UP: context\nDone: parser\nRemaining: tests\nFiles touched: a.rs";
const end = (runId: string, summary: string, extra: Record<string, unknown> = {}) => ({ runId, status: "completed", role: "builder", summary, resultPath: `/r/${runId}`, ...extra });

/** A top-rung (strong model) single launch of `role` that ended with `summary`. */
function topRun(l: LadderState, runId: string, summary: string, extra: Record<string, unknown> = {}, bottom = false): void {
  l.onLaunch(`call-${runId}`, "builder", bottom);
  l.onLaunched(`call-${runId}`, runId);
  l.onRunEnd(end(runId, summary, extra));
}
const relaunch = (extra: Record<string, unknown> = {}): Json => ({ agent: "builder", task: "item 2 again", model: "strong", ...extra });
const noop = () => [] as string[];

// ------------------------------------------------------------------ read budget

test("builder read budget: none by default, a configured one keeps working", () => {
  assert.equal(childReadLimits({}, "builder"), null);
  assert.equal(childReadLimits({ ceremony: { childReads: { reviewer: { warn: 15, deny: 30 } } } }, "builder"), null);
  assert.deepEqual(childReadLimits({ ceremony: { childReads: { builder: { warn: 2, deny: 3 } } } }, "builder"), { warn: 2, deny: 3 });
});

test("builder budget texts say write the code, never return the report; reviewer texts are unchanged", () => {
  const b = new ChildReads();
  const lim = { warn: 1, deny: 2, role: "builder" };
  const warn = b.check("read", "1", {}, lim);
  assert.equal(warn.kind, "warn");
  const warnText = (warn as { text: string }).text;
  assert.match(warnText, /write the code now/);
  assert.match(warnText, /1 of 2 read calls/);
  b.check("read", "2", {}, lim);
  const deny = b.check("read", "3", {}, lim);
  assert.equal(deny.kind, "deny");
  const reason = (deny as { reason: string }).reason;
  assert.match(reason, /\[child_read_budget_exceeded\]/);
  assert.match(reason, /Make your edits now/);
  assert.match(reason, /STATUS: stuck/);
  for (const text of [warnText, reason]) assert.doesNotMatch(text, /return your report/i);
  const r = new ChildReads();
  const rl = { warn: 1, deny: 1, role: "reviewer" };
  assert.match((r.check("read", "1", {}, rl) as { text: string }).text, /Continue the task/);
  assert.match((r.check("read", "2", {}, rl) as { reason: string }).reason, /return your report now with what you have/);
  const plain = new ChildReads();
  assert.match((plain.check("read", "1", {}, { warn: 1, deny: 1 }) as { text: string }).text, /Continue the task/);
});

// ------------------------------------------------------------------ cap lookup and child side

test("contextCap: ladder.contextCap.<role>, builder 250000 by default, 0 = off, other roles none", () => {
  assert.deepEqual([contextCap({}, "builder"), contextCap({}, "explorer"), contextCap({}, "reviewer")], [250000, 0, 0]);
  const cfg = { ladder: { contextCap: { builder: 0, explorer: 90000, reviewer: -5 } } };
  assert.deepEqual([contextCap(cfg, "builder"), contextCap(cfg, "explorer"), contextCap(cfg, "reviewer")], [0, 90000, 0]);
});

for (const bottom of [true, false]) {
  test(`child side: steers once at the cap, not below it, on the ${bottom ? "bottom" : "top"} rung`, () => {
    const c = new ChildLadder({ bottom, contextCap: 1000, maxTurns: 60 });
    assert.equal(c.onUsage({ input: 400, cacheRead: 599 }), null, "999 is below the cap");
    const s = c.onUsage({ input: 400, cacheRead: 500, cacheWrite: 100 });
    assert.deepEqual([s?.trigger, s?.count, s?.cap, s?.rung], ["context", 1000, 1000, bottom ? "bottom" : "top"]);
    assert.match(s!.text, /first line is exactly: RUNG_UP: context/);
    assert.match(s!.text, /Done: <what is finished>; Remaining: <what is left>; Files touched: <paths>/);
    assert.equal(s!.text.trimEnd().split("\n").at(-1), "The foreman relaunches a fresh run with your report.");
    assert.equal(c.onUsage({ input: 5000 }), null, "once");
  });
}

test("child side: the growth steer comes first on the bottom rung; the cap comes before the turn limit; no cap, no steer", () => {
  const grow = new ChildLadder({ bottom: true, strongAbove: 100, contextCap: 150, maxTurns: 1 });
  grow.onUsage({ input: 10 });
  assert.equal(grow.onUsage({ input: 200 })?.cap, undefined, "growth over strongAbove");
  const both = new ChildLadder({ bottom: false, contextCap: 150, maxTurns: 1 });
  both.onUsage({ input: 10 });
  const s = both.onUsage({ input: 200 });
  assert.deepEqual([s?.trigger, s?.cap], ["context", 150], "turn 2 is past maxTurns 1, the cap wins");
  assert.equal(new ChildLadder({ bottom: true }).onUsage({ input: 1e9 }), null);
  assert.equal(new ChildLadder({ bottom: true, contextCap: 0 }).onUsage({ input: 1e9 }), null);
});

test("binding: contextCap round-trips through the launch binding and the child's ChildLadder steers at it", () => {
  const b = recordUsageLaunch(new Map(), { foremanSession: "s", workspace: "/w", role: "builder", model: null, ladder: { bottom: false, maxTurns: 100, contextCap: 777 } });
  const input: Record<string, unknown> = {};
  bindLaunch(input, b);
  const back = readBinding({ [BINDINGS_ENV]: JSON.stringify(input.extensionBindings) });
  assert.equal(back?.ladder?.contextCap, 777);
  assert.equal(back?.ladder?.bottom, false);
  const child = new ChildLadder(back?.ladder);
  assert.equal(child.onUsage({ input: 776 }), null);
  assert.equal(child.onUsage({ input: 777 })?.cap, 777);
  const bad = readBinding({ [BINDINGS_ENV]: JSON.stringify({ "pi-foreman/1": { foremanSession: "s", role: "builder", launchId: "l", ladder: { contextCap: -4, bottom: true } } }) });
  assert.equal(bad?.ladder?.contextCap, undefined);
});

// ------------------------------------------------------------------ foreman side

test("onRunEnd: a top-rung RUNG_UP: context is kept as the role's top handoff; stuck, turns, policy block and repeat refusal are not", () => {
  const l = new LadderState();
  topRun(l, "t1", CAP_REPORT);
  assert.equal(l.topHandoffs.get("builder")?.runId, "t1");
  assert.equal(l.eligible.size, 0, "never climb-eligible");
  const other = new LadderState();
  topRun(other, "t2", "STATUS: stuck\nneed a decision");
  topRun(other, "t3", "RUNG_UP: turns\nDone: x");
  topRun(other, "t4", CAP_REPORT, { policyBlock: true });
  topRun(other, "t5", CAP_REPORT, { repeatRefusal: true });
  assert.equal(other.topHandoffs.size, 0);
  const bottom = new LadderState();
  topRun(bottom, "b1", CAP_REPORT, {}, true);
  assert.equal(bottom.eligible.get("builder")?.runId, "b1");
  assert.equal(bottom.topHandoffs.size, 0, "a bottom-rung run stays eligible only");
});

test("the next single launch with a foreman-written strong takes the handoff: no reason needed, strong kept, report prepended, once", () => {
  const l = new LadderState();
  topRun(l, "t1", CAP_REPORT);
  const input = relaunch();
  const p = l.plan(input, ROLES);
  assert.equal(p.block, undefined, "no strong_no_reason");
  assert.equal(input.model, "strong", "the relaunch stays on the strong rung");
  assert.equal(p.climbs.length, 1);
  assert.deepEqual([p.climbs[0].reason, p.climbs[0].top, p.climbs[0].fromTop, p.climbs[0].handoff?.runId, p.climbs[0].from, p.climbs[0].to], ["context", true, true, "t1", "p/big", "p/big"]);
  assert.equal(l.topHandoffs.size, 1, "plan alone keeps it pending");
  const traces = l.apply(p.climbs, () => ["- [ ] 2. the item"]);
  assert.deepEqual(traces, [{ event: "rung_top", role: "builder", model: "p/big", reason: "context" }]);
  assert.match(String(input.task), /^\[pi-foreman rung-up handoff\] The previous builder run t1 stopped \(context\)/);
  assert.match(String(input.task), /Done: parser/);
  assert.match(String(input.task), /- \[ \] 2\. the item/);
  assert.match(String(input.task), /item 2 again$/);
  assert.equal(l.topHandoffs.size, 0, "taken");
  // a second strong launch after it does not get the report again (and, with no trigger and no reason, is refused as before)
  const again = relaunch({ reason: "bigger change" });
  const p2 = l.plan(again, ROLES);
  assert.equal(p2.climbs[0]?.handoff, undefined);
  l.apply(p2.climbs, noop);
  assert.doesNotMatch(String(again.task), /rung-up handoff/);
  assert.match(l.plan(relaunch(), ROLES).block ?? "", /strong_no_reason/);
});

test("with no strong model mapped the keyword is dropped (the live model stays) and the handoff is still taken", () => {
  const l = new LadderState();
  l.noteLaunched({ agent: "builder", model: "p/small" });
  topRun(l, "t1", CAP_REPORT);
  const input = relaunch();
  const p = l.plan(input, NO_STRONG);
  assert.equal(p.block, undefined);
  assert.equal(input.model, "p/small");
  l.apply(p.climbs, noop);
  assert.match(String(input.task), /rung-up handoff/);
  assert.equal(l.topHandoffs.size, 0);
  const fresh = new LadderState();
  topRun(fresh, "t2", CAP_REPORT);
  const bare = relaunch();
  fresh.plan(bare, NO_STRONG);
  assert.equal("model" in bare, false, "no live model: the keyword is removed");
});

test("a tasks entry, a launch without strong, a sizing-written strong and a rank-refused launch do not take it; it stays pending", () => {
  const l = new LadderState();
  topRun(l, "t1", CAP_REPORT);
  const entry = relaunch();
  const group = l.plan({ tasks: [entry] }, ROLES, {});
  assert.equal(group.climbs.some((c) => c.fromTop || c.handoff), false, "tasks entry");
  assert.match(group.block ?? "", /strong_no_reason/);
  const chain = { chain: [{ agent: "builder", task: "x", model: "strong", reason: "r" }] };
  assert.equal(l.plan(chain, ROLES).climbs.some((c) => c.handoff), false, "chain entry");
  const plain = { agent: "builder", task: "x" };
  assert.deepEqual(l.plan(plain, ROLES).climbs, [], "no strong keyword");
  const explicit = { agent: "builder", task: "x", model: "p/big" };
  assert.equal(l.plan(explicit, ROLES).climbs.some((c) => c.handoff), false, "explicit model");
  const sized = relaunch();
  const sp = l.plan(sized, ROLES, { sizing: new Set([sized]) });
  assert.equal(sp.climbs.some((c) => c.handoff || c.fromTop), false, "sizing-written strong");
  assert.equal(sp.climbs[0]?.reason, "sizing");
  const refused = { agent: "builder", task: "x", model: "default" };
  const rp = l.plan(refused, ROLES, { strongAllowed: () => false });
  assert.equal(rp.climbs.some((c) => c.fromTop), false, "rank-refused launch");
  assert.equal(l.topHandoffs.get("builder")?.runId, "t1", "still pending");
  const eligible = new LadderState();
  topRun(eligible, "t3", CAP_REPORT);
  const reviewer = { agent: "reviewer", task: "x", model: "strong" };
  assert.equal(eligible.plan(reviewer, ROLES).climbs.some((c) => c.fromTop), false, "another role");
});

test("the launch-result line names the relaunch", () => {
  const l = new LadderState();
  topRun(l, "t1", CAP_REPORT);
  assert.equal(topClimbHint(l.topHandoffs.get("builder")!), 'pi-foreman ladder: run t1 (builder) stopped at the context cap. Relaunch builder with model "strong" for a fresh run; the harness prepends this run\'s report.');
});
