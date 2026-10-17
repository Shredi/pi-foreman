// R11 P2 fix round 1 (S1): a session cannot forge a parent ruling lift (`review-cap: +N` / `read-budget: +N`). A ruling
// that appears or changes while a background job of the session runs (foreman_bg, bg_run, a backgrounded bash call)
// is self-written, also after the job's exit; each ruling path lifts once, so touching an old ruling never re-lifts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { backgroundsJob, jobPid, parentRulingLift, SelfRulings } from "../ruling.ts";
import { r11Rig, writeAt } from "./_r11rig.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const review = (n: number) => ({ agent: "reviewer", task: `review items ${n}` });
const capRefused = (r: { block?: boolean; reason?: string } | undefined): boolean => r?.block === true && /\[review_cap\]/.test(r.reason ?? "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Rig = Awaited<ReturnType<typeof r11Rig>>;
/** A rig with reviewRuns 1, one review used, and a child-side handoff dir with an old ask.md. */
async function capped(t: Parameters<typeof r11Rig>[0]): Promise<{ a: Rig; dir: string }> {
  const a = await r11Rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  writeAt(path.join(dir, "ask.md"), "ask: one more review round?\n", Date.now() - 60_000);
  assert.equal((await a.launch(review(1))).res, undefined);
  assert.ok(capRefused((await a.launch(review(2))).res), "capped before any ruling");
  return { a, dir };
}

test("ruling_lift_bg_job_written_ruling_ignored", async (t) => {
  const { a, dir } = await capped(t);
  const job = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => void job.kill("SIGKILL"));
  const pid = job.pid!;
  const res = await a.tool("foreman_bg", { command: "sleep 30", note: "job" }, { details: { decision: "start", id: "w1", kind: "pid", pid }, text: `Background run w1 (pid ${pid}) started` });
  assert.equal(res, undefined, `foreman_bg: ${res?.reason}`);
  // the job writes a ruling while it runs
  writeAt(path.join(dir, "ruling.md"), "APPROVED\nreview-cap: +2\n", Date.now());
  assert.ok(capRefused((await a.launch(review(2))).res), "a ruling written while the bg job runs never lifts");
  // backdated to before the job's launch: still new since the launch snapshot
  writeAt(path.join(dir, "ruling.md"), "APPROVED\nreview-cap: +2\n", Date.now() - 30_000);
  assert.ok(capRefused((await a.launch(review(2))).res), "a backdated ruling written by the job never lifts");
  // the job exits: the fresh snapshot after the exit keeps the ruling self-written
  job.kill("SIGKILL");
  await once(job, "exit");
  assert.ok(capRefused((await a.launch(review(2))).res), "still ignored after the job's exit");
  assert.deepEqual(a.events("review_cap_lift"), []);
  // a new parent ruling after the exit lifts (positive control: the window closed)
  await sleep(20);
  writeAt(path.join(dir, "ruling-2.md"), "review-cap: +1\n", Date.now() + 1000);
  assert.equal((await a.launch(review(2))).res, undefined, "a parent ruling after the job's exit lifts");
});

test("ruling_lift_bg_job_written_ruling_ignored: a bg_run task without a known pid keeps the window open", async (t) => {
  const { a, dir } = await capped(t);
  await a.tool("bg_run", { command: "sleep 5", label: "n" }, { details: {}, text: "started task t1" });
  await sleep(20);
  writeAt(path.join(dir, "ruling.md"), "APPROVED\nreview-cap: +2\n", Date.now() + 1000);
  assert.ok(capRefused((await a.launch(review(2))).res), "a ruling that appears while a bg_run task may run never lifts");
  assert.deepEqual(a.events("review_cap_lift"), []);
});

test("ruling_lift_bg_job_written_ruling_ignored: SelfRulings job windows", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r11-forge-")));
  t.after(() => rmTestTmp(root));
  const dir = path.join(root, "d");
  fs.mkdirSync(dir);
  const now = Date.now();
  writeAt(path.join(dir, "plan.md"), "plan\n", now - 60_000);
  writeAt(path.join(dir, "ruling-1.md"), "APPROVED\n", now - 50_000);
  const self = new SelfRulings();
  let alive = true;
  self.openJob("j1", () => [dir], now - 40_000);
  self.watchJob("j1", () => alive);
  assert.equal(self.has(path.join(dir, "ruling-1.md"), fs.statSync(path.join(dir, "ruling-1.md")).mtimeMs), false, "a ruling unchanged since the launch is not self-written");
  writeAt(path.join(dir, "ruling-2.md"), "read-budget: +4\n", now - 45_000);
  assert.equal(parentRulingLift([dir], "read-budget", self, new Set()), null, "appeared during the open job (backdated)");
  alive = false; // the exit is observed at the next check
  assert.equal(parentRulingLift([dir], "read-budget", self, new Set()), null, "the closing snapshot marks it self-written");
  writeAt(path.join(dir, "ruling-3.md"), "read-budget: +4\n", now - 20_000);
  assert.equal(parentRulingLift([dir], "read-budget", self, new Set()), null, "mtime inside the closed job's span");
  writeAt(path.join(dir, "ruling-4.md"), "read-budget: +4\n", Date.now() + 2000);
  assert.deepEqual(parentRulingLift([dir], "read-budget", self, new Set()), { file: path.join(dir, "ruling-4.md"), n: 4 });
  // a throwing exit probe keeps the job open (fail closed)
  const s2 = new SelfRulings();
  s2.openJob("j2", () => [dir], now - 40_000);
  s2.watchJob("j2", () => {
    throw new Error("unknown");
  });
  assert.equal(s2.has(path.join(dir, "ruling-4.md"), fs.statSync(path.join(dir, "ruling-4.md")).mtimeMs), true);
  // jobPid reads details.pid, else `pid N` in the text
  assert.equal(jobPid({ pid: 4242 }, ""), 4242);
  assert.equal(jobPid({}, "Background run w1 (pid 77) started"), 77);
  assert.equal(jobPid({}, "started"), null);
});

test("ruling_lift_mtime_touch_does_not_relift", async (t) => {
  const { a, dir } = await capped(t);
  const file = path.join(dir, "ruling.md");
  writeAt(file, "APPROVED\nreview-cap: +1\n", Date.now() - 1000);
  assert.equal((await a.launch(review(2))).res, undefined, "the parent ruling lifts once");
  assert.ok(capRefused((await a.launch(review(3))).res));
  // touched (and rewritten) with a newer mtime: the same path never lifts again
  writeAt(file, "APPROVED\nreview-cap: +3\n", Date.now() + 5000);
  assert.ok(capRefused((await a.launch(review(3))).res), "a touched old ruling never re-lifts");
  fs.utimesSync(file, (Date.now() + 9000) / 1000, (Date.now() + 9000) / 1000);
  assert.ok(capRefused((await a.launch(review(3))).res), "a second touch neither");
  assert.equal(a.events("review_cap_lift").length, 1);
});

test("ruling_lift_mtime_touch_does_not_relift: parentRulingLift keys a lift by path", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r11-touch-")));
  t.after(() => rmTestTmp(root));
  const dir = path.join(root, "d");
  fs.mkdirSync(dir);
  const now = Date.now();
  writeAt(path.join(dir, "ask.md"), "ask\n", now - 60_000);
  writeAt(path.join(dir, "ruling.md"), "read-budget: +2\n", now - 1000);
  const used = new Set<string>();
  assert.deepEqual(parentRulingLift([dir], "read-budget", undefined, used), { file: path.join(dir, "ruling.md"), n: 2 });
  writeAt(path.join(dir, "ruling.md"), "read-budget: +2\n", now + 3000);
  assert.equal(parentRulingLift([dir], "read-budget", undefined, used), null, "touched: same path, no second lift");
  writeAt(path.join(dir, "ruling-2.md"), "read-budget: +1\n", now + 4000);
  assert.deepEqual(parentRulingLift([dir], "read-budget", undefined, used), { file: path.join(dir, "ruling-2.md"), n: 1 }, "a new file lifts");
});

test("ruling_lift_backgrounded_bash_written_ruling_ignored", async (t) => {
  const { a, dir } = await capped(t);
  const res = await a.tool("bash", { command: "sleep 1 &" });
  assert.equal(res, undefined, `bash: ${res?.reason}`);
  // the backgrounded job writes the ruling after the tool result
  await sleep(20);
  writeAt(path.join(dir, "ruling.md"), "APPROVED\nreview-cap: +2\n", Date.now() + 1000);
  assert.ok(capRefused((await a.launch(review(2))).res), "a ruling written after a backgrounded bash call never lifts");
  assert.deepEqual(a.events("review_cap_lift"), []);
});

test("ruling_lift_backgrounded_bash_written_ruling_ignored: a foreground bash leaves a later parent ruling alone", async (t) => {
  const { a, dir } = await capped(t);
  assert.equal(await a.tool("bash", { command: "ls -la" }), undefined);
  await sleep(20);
  writeAt(path.join(dir, "ruling.md"), "APPROVED\nreview-cap: +1\n", Date.now() + 1000);
  assert.equal((await a.launch(review(2))).res, undefined, "the parent ruling lifts");
});

test("ruling_lift_backgrounded_bash_written_ruling_ignored: backgroundsJob", () => {
  for (const c of ["sleep 1 &", "(echo x > f) & wait", "nohup ./run.sh", "./run.sh; disown", "setsid ./run.sh", "sh -c 'sleep 9 &'", "a 2>&1 &", "a&b"]) assert.equal(backgroundsJob(c), true, c);
  for (const c of ["git status && git log", "make 2>&1", "make &> log.txt", "make |& tee log", "ls -la", "nohupx", "my-disown-tool"]) assert.equal(backgroundsJob(c), false, c);
  assert.equal(backgroundsJob(undefined), false);
});
