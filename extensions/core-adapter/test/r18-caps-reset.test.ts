// R18 item 1: a parent-written ruling-<n>.md or brief-<x>.md in the session's handoff dir resets the review cap, the
// recheck budget and the read budget (index.ts capsReset, rounds.ts rulingReset strict). No text parser; ruling.md,
// ruling-plan.md and brief.md never reset; a self-written, symlinked, ctime-only changed or older file does not; the
// owner-prompt reset stays as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_READ_LIMITS } from "../budget.ts";
import { restoreRoundState, ROUND_STATE_FILE } from "../roundstate.ts";
import { isBriefName, isCapsResetName, isTrackedRulingName } from "../ruling.ts";
import { r11Rig, writeAt } from "./_r11rig.ts";

type Rig = Awaited<ReturnType<typeof r11Rig>>;
type Res = { block?: boolean; reason?: string } | undefined;

const WARN = DEFAULT_READ_LIMITS.before.warn;
const review = (n: number) => ({ agent: "reviewer", task: `review items ${n}` });
const capRefused = (r: Res): boolean => r?.block === true && /\[review_cap\]/.test(r.reason ?? "");
const recheckDenied = (r: Res): boolean => r?.block === true && /\[recheck_budget_exceeded\]/.test(r.reason ?? "");
const PASS = "Background task completed: **reviewer**\nOverall verdict: PASS";

/** A rig whose env has no PI_FOREMAN_HANDOFF_DIR (restored afterwards). */
async function rig(t: Parameters<typeof r11Rig>[0], ceremony: Record<string, unknown> = {}): Promise<Rig> {
  const saved = process.env.PI_FOREMAN_HANDOFF_DIR;
  delete process.env.PI_FOREMAN_HANDOFF_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_FOREMAN_HANDOFF_DIR;
    else process.env.PI_FOREMAN_HANDOFF_DIR = saved;
  });
  return r11Rig(t, ceremony);
}

/** reviewRuns 1 with one review used and the second refused. */
async function reviewCapped(a: Rig): Promise<void> {
  assert.equal((await a.launch(review(1))).res, undefined);
  assert.ok(capRefused((await a.launch(review(2))).res), "capped before the file");
}
/** A shell read that runs to its tool_result (nothing stays in flight). */
const bash = (a: Rig, command: string): Promise<Res> => a.toolDoing("bash", { command }, () => undefined);
const reminds = (a: Rig): number => a.events("read_budget").filter((r) => r.action === "remind").length;
/** Read budget used up (WARN + 3 reads, one reminder). */
async function readsReminded(a: Rig): Promise<void> {
  for (let i = 0; i < WARN + 3; i++) assert.equal(await bash(a, `ls -la src${i}`), undefined);
  assert.equal(reminds(a), 1, "reminded at the limit");
}
/** After a reset the count restarted: WARN - 1 reads raise no new reminder (without the reset the 16th read would). */
async function readsFresh(a: Rig): Promise<void> {
  for (let i = 0; i < WARN - 1; i++) assert.equal(await bash(a, `ls fresh${i}`), undefined);
  assert.equal(reminds(a), 1, "the count restarted");
}
/** recheckBudget 1: a PASS, one read allowed, the next refused. */
async function recheckDeniedState(a: Rig): Promise<void> {
  await a.notice(PASS);
  assert.equal(await bash(a, "ls one"), undefined);
  assert.ok(recheckDenied(await bash(a, "ls two")), "recheck budget used");
}

test("caps_name_predicates", () => {
  for (const n of ["ruling-1.md", "ruling-2.md", "brief-1.md", "brief-x.y_z-9.md"]) assert.ok(isCapsResetName(n), n);
  for (const n of ["ruling.md", "ruling-0.md", "ruling-plan.md", "brief.md", "brief-.md", "brief-a b.md", "brief-x.md.ack", "ruling-1.md.ack"]) assert.ok(!isCapsResetName(n), n);
  assert.ok(isBriefName("brief-1.md") && !isBriefName("ruling-1.md"));
  for (const n of ["brief-1.md", "ruling-2.md", "ruling-plan.md", "ruling.md"]) assert.ok(isTrackedRulingName(n), n);
});

test("parent_ruling_file_lifts_review_cap", async (t) => {
  const a = await rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  await reviewCapped(a);
  writeAt(path.join(dir, "ruling-2.md"), "go on\n", Date.now());
  assert.equal((await a.launch(review(2))).res, undefined, "the cap is lifted");
  assert.deepEqual(a.events("cap_reset").map((r) => [r.by, r.count]), [["ruling", 1]]);
  assert.ok(capRefused((await a.launch(review(3))).res), "the file counts once");
});

test("parent_ruling_file_lifts_recheck_budget", async (t) => {
  const a = await rig(t, { recheckBudget: 1 });
  const dir = a.handoff("round", "child");
  await recheckDeniedState(a);
  writeAt(path.join(dir, "ruling-2.md"), "go on\n", Date.now());
  assert.equal(await bash(a, "ls three"), undefined, "the recheck budget is lifted");
  assert.equal(a.events("cap_reset").length, 1);
});

test("parent_ruling_file_resets_read_budget", async (t) => {
  const a = await rig(t);
  const dir = a.handoff("round", "child");
  await readsReminded(a);
  writeAt(path.join(dir, "ruling-2.md"), "go on\n", Date.now());
  await readsFresh(a);
  assert.equal(a.events("cap_reset").length, 1);
});

test("parent_brief_file_lifts_the_caps", async (t) => {
  const a = await rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  await reviewCapped(a);
  await readsReminded(a);
  writeAt(path.join(dir, "brief-1.md"), "more work\n", Date.now());
  await readsFresh(a);
  assert.equal((await a.launch(review(2))).res, undefined, "the review cap is lifted");
  assert.deepEqual(a.events("cap_reset").map((r) => [r.by, r.count]), [["brief", 1]]);
});

test("ruling_md_plan_and_plain_brief_do_not_reset", async (t) => {
  const a = await rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  await reviewCapped(a);
  for (const n of ["ruling.md", "ruling-plan.md", "brief.md", "ruling-0.md", "brief-x.md.ack"]) writeAt(path.join(dir, n), "APPROVED\n", Date.now());
  assert.ok(capRefused((await a.launch(review(2))).res));
  assert.deepEqual(a.events("cap_reset"), []);
});

test("self_written_files_do_not_reset", async (t) => {
  const a = await rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  await reviewCapped(a);
  // a literal write to either name is refused outright
  for (const n of ["brief-x.md", "ruling-2.md"]) {
    const res = await a.call("write", { path: path.join(dir, n), content: "x" });
    assert.equal(res?.block, true, `${n}: ${res?.reason}`);
  }
  // written by a shell command whose line does not show the name: the snapshot marks it
  for (const n of ["brief-x.md", "ruling-2.md"]) {
    await a.toolDoing("bash", { command: "./tools/fixup.sh" }, () => fs.writeFileSync(path.join(dir, n), "go on\n"));
    assert.ok(capRefused((await a.launch(review(2))).res), `${n} written by the shell`);
  }
  // a write tool_result for a file (the tool wrote it): marked, brief names included
  for (const n of ["brief-y.md", "ruling-3.md"]) {
    const file = path.join(dir, n);
    fs.writeFileSync(file, "go on\n");
    await a.wrote(file);
    assert.ok(capRefused((await a.launch(review(2))).res), `${n} written by the write tool`);
  }
  assert.deepEqual(a.events("cap_reset"), []);
});

test("file_written_while_a_shell_call_is_in_flight_waits", async (t) => {
  const a = await rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  await reviewCapped(a);
  // a file lands while a bash call runs: a parallel call does not reset (it cannot tell the shell's write from the parent's)
  let parallel: Res = { block: false };
  await a.toolDoing("bash", { command: "./tools/slow.sh" }, async () => {
    writeAt(path.join(dir, "brief-1.md"), "go on\n", Date.now());
    parallel = (await a.launch(review(2))).res;
  });
  assert.ok(capRefused(parallel), "no reset while a shell call is in flight");
  // the result marks the file the shell call changed as self-written
  assert.ok(capRefused((await a.launch(review(2))).res), "and not afterwards");
  assert.deepEqual(a.events("cap_reset"), []);
});

test("symlinked_brief_does_not_reset", async (t) => {
  const a = await rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  await reviewCapped(a);
  const target = path.join(a.project, ".workflow", "notes.md");
  fs.writeFileSync(target, "go on\n");
  fs.symlinkSync(target, path.join(dir, "brief-1.md"));
  assert.ok(capRefused((await a.launch(review(2))).res));
  assert.deepEqual(a.events("cap_reset"), []);
});

test("ctime_only_change_does_not_reset_again", async (t) => {
  const a = await rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  await reviewCapped(a);
  const file = path.join(dir, "ruling-2.md");
  writeAt(file, "go on\n", Date.now());
  assert.equal((await a.launch(review(2))).res, undefined);
  assert.ok(capRefused((await a.launch(review(3))).res), "capped again");
  await new Promise((r) => setTimeout(r, 20));
  fs.chmodSync(file, 0o600); // changes only the ctime
  assert.ok(capRefused((await a.launch(review(3))).res), "a chmod of the applied file does not reset");
  assert.equal(a.events("cap_reset").length, 1);
});

test("file_outside_child_dirs_does_not_reset", async (t) => {
  const a = await rig(t, { reviewRuns: 1 });
  a.handoff("round", "child");
  const mine = a.handoff("opened", "parent"); // this session is the parent there: its child writes there
  await reviewCapped(a);
  writeAt(path.join(mine, "ruling-2.md"), "go on\n", Date.now());
  writeAt(path.join(a.project, "ruling-3.md"), "go on\n", Date.now());
  assert.ok(capRefused((await a.launch(review(2))).res));
  assert.deepEqual(a.events("cap_reset"), []);
});

test("watermark_persisted_and_restored", async (t) => {
  const a = await rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  const other = a.handoff("other", "child");
  process.env.PI_FOREMAN_HANDOFF_DIR = dir;
  await reviewCapped(a);
  // a child dir that is not the round state dir does not count when PI_FOREMAN_HANDOFF_DIR is set
  writeAt(path.join(other, "ruling-2.md"), "go on\n", Date.now());
  assert.ok(capRefused((await a.launch(review(2))).res), "not the round state dir");
  writeAt(path.join(dir, "ruling-2.md"), "go on\n", Date.now());
  // the ruling pickup (a newer ruling in the round state dir) holds this one launch; the caps are reset already
  assert.match((await a.launch(review(2))).res?.reason ?? "", /a newer ruling arrived/);
  assert.equal((await a.launch(review(2))).res, undefined);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, ROUND_STATE_FILE), "utf8")) as Record<string, unknown>;
  assert.equal(typeof stored.capsResetAt, "number");
  assert.ok((stored.capsResetAt as number) >= fs.statSync(path.join(dir, "ruling-2.md")).mtimeMs);
  assert.equal(restoreRoundState(dir, () => null)!.capsResetAt, stored.capsResetAt);
  // a reload restores the watermark: a file older than it (the pre-restart self-written ones included) does not reset
  stored.capsResetAt = Date.now() + 60_000;
  fs.writeFileSync(path.join(dir, ROUND_STATE_FILE), JSON.stringify(stored));
  await a.restart();
  writeAt(path.join(dir, "brief-1.md"), "more\n", Date.now());
  await bash(a, "ls late");
  assert.equal(a.events("cap_reset").length, 1, "older than the restored watermark");
  // control: a watermark below the file's ctime lets it reset
  stored.capsResetAt = 1;
  fs.writeFileSync(path.join(dir, ROUND_STATE_FILE), JSON.stringify(stored));
  await a.restart();
  await bash(a, "ls later");
  assert.equal(a.events("cap_reset").length, 2, "a low watermark does not hold it back");
});

test("owner_prompt_still_resets_all_three", async (t) => {
  const a = await rig(t, { reviewRuns: 1, recheckBudget: 1 });
  a.handoff("round", "child");
  await reviewCapped(a);
  await readsReminded(a);
  await a.ownerPrompt();
  assert.equal((await a.launch(review(3))).res, undefined, "review cap");
  await readsFresh(a);
  await recheckDeniedState(a);
  await a.ownerPrompt();
  assert.equal(await a.call("bash", { command: "ls again" }), undefined, "recheck budget");
  assert.deepEqual(a.events("cap_reset"), []);
});
