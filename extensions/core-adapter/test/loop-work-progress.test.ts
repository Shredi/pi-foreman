// D62+: a code review that repeats only `item:<N>` keys is progress when the foreman's work count grew between the two rounds and the
// reviewed state changed (reviewloop.ts loopVerdictOf); the round's `work` is persisted (reviews.ts, planstate.ts) and survives a reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loopVerdictOf } from "../reviewloop.ts";
import type { LoopRound } from "../reviewloop.ts";
import { buildCeremonyState, latestCeremonyState } from "../planstate.ts";
import { reviewsOfEntry } from "../reviews.ts";
import type { ReviewRecord } from "../reviews.ts";
import { sharedWorld, tick, world } from "./_r46world.ts";
import { lightSpawner } from "./_light-spawner.ts";
import { codeReview, loopRefused } from "./_loopstop.ts";

const standard = { ceremony: { default: "standard" } };
const round = (state: string, work: number | undefined, ...sig: string[]): LoopRound => ({ verdict: "fail", state, sig, ...(work === undefined ? {} : { work }) });

test("loopVerdictOf(code): an item-only repeat is progress only with work up and a known, changed state", () => {
  const rows: [string, LoopRound, LoopRound, ReturnType<typeof loopVerdictOf>][] = [
    ["work up, state changed", round("s1", 1, "item:2"), round("s2", 2, "item:2"), null],
    ["work up, same state (a builder that changed nothing)", round("s1", 1, "item:2"), round("s1", 2, "item:2"), "repeat"],
    ["no work, state changed", round("s1", 1, "item:2"), round("s2", 1, "item:2"), "repeat"],
    ["equal at: key, work up, state changed", round("s1", 1, "at:a.ts:2:bug", "item:2"), round("s2", 2, "at:a.ts:2:bug", "item:2"), "repeat"],
    ["missing work on the earlier round", round("s1", undefined, "item:2"), round("s2", 2, "item:2"), "repeat"],
    ["missing work on the later round", round("s1", 1, "item:2"), round("s2", undefined, "item:2"), "repeat"],
    ["work went down (a fork)", round("s1", 5, "item:2"), round("s2", 0, "item:2"), "repeat"],
    ["unknown state before", round("", 1, "item:2"), round("s2", 2, "item:2"), "repeat"],
    ["unknown state now", round("s1", 1, "item:2"), round("", 2, "item:2"), "repeat"],
  ];
  for (const [name, prev, cur, want] of rows) assert.equal(loopVerdictOf("code", prev, cur), want, name);
});

test("loopVerdictOf: stalled and the plan rule are unchanged by work", () => {
  assert.equal(loopVerdictOf("code", round("s1", 1, "item:1", "item:2"), round("s1", 2, "item:1")), "stalled");
  const plan = (state: string, work?: number): LoopRound => round(state, work, "item:2");
  assert.equal(loopVerdictOf("plan", plan("p1"), plan("p1")), "repeat");
  assert.equal(loopVerdictOf("plan", plan("p1"), plan("p2")), null);
});

test("a record's work survives reviewsOfEntry and buildCeremonyState; a bad work is dropped", () => {
  const rec: ReviewRecord = { role: "reviewer", verdict: "fail", head: null, kind: "code", state: "s1", sig: ["item:2"], work: 3 };
  const entry = buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews: [rec, { ...rec, work: 0 }, { role: "reviewer", verdict: "fail", head: null }] });
  assert.deepEqual(entry.reviews.map((r) => r.work), [3, 0, undefined]);
  const back = reviewsOfEntry(JSON.parse(JSON.stringify(entry.reviews)));
  assert.deepEqual(back.map((r) => r.work), [3, 0, undefined]);
  assert.equal("work" in back[2], false);
  const bad = reviewsOfEntry([{ ...rec, work: -1 }, { ...rec, work: 1.5 }, { ...rec, work: "2" }]);
  assert.deepEqual(bad.map((r) => r.work), [undefined, undefined, undefined]);
  assert.ok(latestCeremonyState([{ type: "custom", customType: "pi-foreman-ceremony-state", data: entry }]) !== undefined);
});

function repo(dir: string): void {
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.autocrlf=false", ...a], { encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "base");
}

// One repository for the cases below: built once, put back by the world's reset. The cases do not test the python guards, so the spawn gate
// answers allow, the config CLI runs once (nothing changes the config between the cases) and the reports name no file, so the findings record has none.
const shared = sharedWorld({ ...standard, spawner: lightSpawner({ memoConfig: true, noFindings: true }) }, async (w) => repo(w.project));

const reportItem = (n: number, note: string): string => `${n}. FAIL: ${note}\nOverall verdict: FAIL`;
const loopStops = async (w: ReturnType<typeof world>): Promise<number> => (await w.traceEvents()).filter((r) => r.event === "review_loop").length;
let edits = 0;
const change = (w: ReturnType<typeof world>): void => fs.writeFileSync(path.join(w.project, "a.txt"), `a${++edits}\n`);

test("page 7: FAIL item 2, a builder run changes the tree, FAIL item 2 with other findings: the next builder is accepted", async () => {
  const w = await shared();
  const a = await w.adapter("startup");
  assert.equal(await codeReview(a, reportItem(2, "the guard is missing"), 1), null);
  assert.equal(await a.launch("builder"), undefined);
  change(w);
  assert.equal(await codeReview(a, reportItem(2, "a different problem under the same item"), 2), null);
  assert.equal(await loopStops(w), 0);
  assert.equal(await a.launch("builder"), undefined);
});

test("a builder run that changes nothing between two FAILs of the same item still stops the loop", async () => {
  const w = await shared();
  const a = await w.adapter("startup");
  assert.equal(await codeReview(a, reportItem(2, "x"), 1), null);
  assert.equal(await a.launch("builder"), undefined);
  assert.equal(await codeReview(a, reportItem(2, "y"), 2), null);
  assert.equal(await loopStops(w), 1);
  assert.ok(loopRefused(await a.launch("builder")));
});

test("a changed tree with no builder run or edit in between still stops the loop", async () => {
  const w = await shared();
  const a = await w.adapter("startup");
  assert.equal(await codeReview(a, reportItem(2, "x"), 1), null);
  change(w);
  assert.equal(await codeReview(a, reportItem(2, "y"), 2), null);
  assert.equal(await loopStops(w), 1);
});

test("page 8: a stop lifted by an owner prompt, then a builder changes the tree and the same item fails again: the next builder is accepted", async () => {
  const w = await shared();
  const a = await w.adapter("startup");
  assert.equal(await codeReview(a, reportItem(4, "first"), 1), null);
  assert.equal(await a.launch("builder"), undefined);
  assert.equal(await codeReview(a, reportItem(4, "second"), 2), null);
  assert.equal(await loopStops(w), 1, "the stop is set");
  assert.ok(loopRefused(await a.launch("builder")));
  await a.ownerPrompt();
  assert.equal(await a.launch("builder"), undefined, "the stop is lifted");
  change(w);
  assert.equal(await codeReview(a, reportItem(4, "one new finding in the new code"), 3), null);
  assert.equal(await loopStops(w), 1, "no second stop");
  assert.equal(await a.launch("builder"), undefined);
});

test("page 8: a stop lifted by a parent brief, then new code lands: the next builder is accepted", async () => {
  const w = await shared();
  const a = await w.adapter("startup");
  assert.equal(await codeReview(a, reportItem(4, "first"), 1), null);
  assert.equal(await a.launch("builder"), undefined);
  assert.equal(await codeReview(a, reportItem(4, "second"), 2), null);
  assert.ok(loopRefused(await a.launch("builder")));
  fs.writeFileSync(path.join(w.handoff, "brief-1.md"), "go on differently\n");
  assert.equal(await a.launch("builder"), undefined, "the brief lifts the stop");
  change(w);
  assert.equal(await codeReview(a, reportItem(4, "again"), 3), null);
  assert.equal(await loopStops(w), 1);
  assert.equal(await a.launch("builder"), undefined);
});

test("reload: the round's work and the foreman's work count survive, and the rule still applies", async () => {
  const w = await shared();
  const a = await w.adapter("startup");
  assert.equal(await codeReview(a, reportItem(2, "x"), 1), null);
  assert.equal(await a.launch("builder"), undefined);
  change(w);
  await a.ownerPrompt(); // the work counters are saved at an owner input or a settle
  await a.down();
  const entries = w.ceremonyEntries().map((e) => (e as { data?: { reviews?: { work?: number }[] } }).data);
  const saved = entries.at(-1)?.reviews ?? [];
  assert.equal(typeof saved.at(-1)?.work, "number", "the record carries work");
  const b = await w.adapter("reload");
  await tick(50);
  assert.equal(await codeReview(b, reportItem(2, "y"), 2), null);
  assert.equal(await loopStops(w), 0);
  assert.equal(await b.launch("builder"), undefined);
});
