// The high-stakes review wired into the adapter, third part: a second checkout (main-path PR gate, a pass raised by the foreman, the gate shared by the
// session), an open PR's readiness through the PR watch, an unmeasurable checkout, a session with no bound ledger, a verdict after the model was unset.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { holdFacts, HighStakes, readyOverride } from "../highstakes.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, WatchSnapshot } from "../prwatch.ts";
import { reviewFactsForHead } from "../prready.ts";
import type { ReviewRecord } from "../reviews.ts";
import { tick, world } from "./_r46world.ts";

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
type World = ReturnType<typeof world>;
type Settle = { entries?: { customType?: string; content?: string }[] } | undefined;

const MODEL = "fake/hs";
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const lines = (n: number) => "x\n".repeat(n);

/** A standard-tier world over a real git repo: `main` seeded, the session on `feature`; `commit` false leaves the repo without a commit and without a base. */
async function setup(t: Parameters<typeof world>[0], o: { commit?: boolean } = {}) {
  const w = world(t, { ceremony: { default: "standard", highStakes: { model: MODEL, modules: 0, lines: 50 } } });
  const presenceFile = path.join(w.project, "..", "agent", "foreman.json");
  fs.writeFileSync(presenceFile, JSON.stringify({ ...(JSON.parse(fs.readFileSync(presenceFile, "utf8")) as object), presence: { enabled: false } })); // an owner dialog must not depend on the host's idle state
  fs.rmSync(path.join(w.project, ".git"), { recursive: true });
  git(w.project, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(w.project, ".gitignore"), ".workflow/\n");
  if (o.commit !== false) {
    git(w.project, "add", "-A");
    git(w.project, "commit", "-q", "-m", "seed");
    const cfgFile = path.join(w.project, "..", "agent", "foreman.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
    cfg.safety = { ops: { baseBranch: "main" } };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    git(w.project, "checkout", "-q", "-b", "feature");
  }
  const a = await w.adapter("startup");
  await a.command("ceremony", "standard");
  await a.writeLedger("# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [x] V. fresh-eyes verification passed\n");
  return { w, a };
}

const commitIn = (dir: string, name: string, n: number) => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), lines(n));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `work ${name}`);
};

async function launch(a: Rig, agent: string, task: string, extra: Record<string, unknown> = {}) {
  const id = `k${Math.random().toString(36).slice(2, 8)}`;
  const input: Record<string, unknown> = { agent, task, ...extra };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  if (res?.block) return { blocked: res.reason ?? "blocked", id, input };
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  return { blocked: null as string | null, id, input };
}
const end = async (a: Rig, s: { id: string }, agent: string, output: string, cwd?: string) => {
  a.endRunAs(s.id, agent, output, cwd);
  await tick(150);
};
const settle = async (a: Rig): Promise<string> => {
  const r = (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as Settle;
  return (r?.entries ?? []).find((e) => e.customType === "pi-foreman-ceremony-gate")?.content ?? "";
};
const pr = async (a: Rig, input: Record<string, unknown> = {}): Promise<string> => (await a.checkCall("create_pull_request", input))?.reason ?? "";
const traces = async (w: World, event: string) => (await w.traceEvents()).filter((e) => e.event === event);
/** The record of a normal PASS is written by an async chain (git calls): wait until `n` are traced. */
const recorded = async (w: World, n: number) => {
  const stop = Date.now() + 15000;
  while ((await traces(w, "review_recorded")).length < n && Date.now() < stop) await tick(100);
  assert.ok((await traces(w, "review_recorded")).length >= n, `${n} review records`);
};
const builder = async (a: Rig, cwd?: string) => end(a, await launch(a, "builder", "build the widget", cwd ? { cwd } : {}), "builder", "done", cwd);
const normalPass = async (a: Rig, cwd?: string) => end(a, await launch(a, "reviewer", "[pre-pr] review the branch", cwd ? { cwd } : {}), "reviewer", "Overall verdict: PASS", cwd);

test("item 4/6: a second checkout: pr_create {head} for its branch is refused from the session's checkout while it has the pass due, naming it; a pass the foreman launches fires its checkout with reason foreman; a second pass is refused while another checkout's PASS set the session gate", async (t) => {
  const { w, a } = await setup(t);
  const wt2Real = path.join(fs.realpathSync.native(path.join(w.project, "..")), "wt2");
  git(w.project, "worktree", "add", "-q", "-b", "other", wt2Real);
  w.state.answer = "allow once"; // a launch in the second checkout asks the gate

  // own checkout: small change, normal PASS; the second checkout: a large change, normal PASS
  commitIn(w.project, "src/a/small.ts", 2);
  await builder(a);
  await normalPass(a);
  await recorded(w, 1);
  assert.equal(await pr(a), "", "own checkout is below the bound");
  commitIn(wt2Real, "src/b/big.ts", 100);
  await builder(a, wt2Real);
  await normalPass(a, wt2Real);
  await recorded(w, 2);
  const fired = await traces(w, "review_stakes");
  assert.equal(fired.length, 1, "only the large checkout fired");
  const refusal = await pr(a, { head: "other" });
  assert.match(refusal, /\[pr_refused:high_stakes_required\]/);
  assert.ok(refusal.includes(wt2Real), "the refusal names the second checkout");
  assert.match(refusal, /cwd /, "the hint says to launch with cwd <root>");

  // the foreman raises a pass in the own checkout, below the bound: accepted, the trigger is recorded with reason foreman and traced
  const own = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(own.blocked, null, String(own.blocked));
  const stakes = await traces(w, "review_stakes");
  assert.deepEqual(stakes.map((e) => e.reasons), ["lines", "foreman"]);
  await end(a, own, "reviewer", "Overall verdict: PASS");

  // the second checkout's pass FAILs; then a normal PASS in the own checkout sets the session's gate; the second pass of the second checkout is still refused
  const hs = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: wt2Real });
  assert.equal(hs.blocked, null, String(hs.blocked));
  await end(a, hs, "reviewer", "1. FAIL src/b/big.ts:1 broken\nOverall verdict: FAIL", wt2Real);
  commitIn(w.project, "src/a/more.ts", 2);
  await builder(a);
  await normalPass(a);
  const again = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: wt2Real });
  assert.match(again.blocked ?? "", /\[high_stakes_early\]/, "the FAIL of the second checkout is not cleared by a PASS elsewhere");
  assert.match(await pr(a, { head: "other" }), /\[pr_refused:high_stakes_failed\]/);
});

test("item 4: an unmeasurable checkout (no commit, no base) fires nothing and is traced once; a session with no bound ledger is asked for the pass at the finish gate", async (t) => {
  const bad = await setup(t, { commit: false });
  fs.mkdirSync(path.join(bad.w.project, "src/a"), { recursive: true });
  fs.writeFileSync(path.join(bad.w.project, "src/a/big.ts"), lines(100));
  await builder(bad.a);
  await settle(bad.a);
  await settle(bad.a);
  assert.deepEqual(await traces(bad.w, "review_stakes"), [], "nothing fired");
  assert.equal((await traces(bad.w, "review_stakes_unmeasured")).length, 1, "traced once");

  const { w, a } = await setup(t);
  commitIn(w.project, "src/a/big.ts", 100);
  await builder(a);
  await normalPass(a);
  fs.rmSync(path.join(w.project, ".workflow", "LEDGER-x.md")); // the marker still names it: the bound ledger cannot be read
  assert.match(await settle(a), /a high-stakes review must run/, "no bound ledger: asked as if every item were marked");
});

test("item 7/2: a high-stakes run that ends after the model was unset (a reload) is recognised by its run id: its notice marks no item and records nothing", async (t) => {
  const { w, a } = await setup(t);
  commitIn(w.project, "src/a/big.ts", 100);
  await builder(a);
  await normalPass(a);
  await a.writeLedger("# Ledger: x\nTier: standard\n\n- [ ] 2. second\n- [x] V. fresh-eyes verification passed\n");
  const run = await launch(a, "reviewer", "[high-stakes] review");
  assert.equal(run.blocked, null, String(run.blocked));
  await a.down();
  const cfgFile = path.join(w.project, "..", "agent", "foreman.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as { ceremony: Record<string, unknown> };
  cfg.ceremony.highStakes = { model: null };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const b = await w.adapter("reload");
  const notice = `Background task completed: **reviewer**\n\nOverall verdict: PASS\n2. PASS fine\n\nRetention-managed async directory: /x/async/run-${run.id}\n`;
  await b.fire("message_end", { message: { role: "custom", customType: "subagent-notify", content: notice } });
  await tick(300);
  assert.match(fs.readFileSync(path.join(w.project, ".workflow", "LEDGER-x.md"), "utf8"), /- \[ \] 2\. second/, "marks no item");
  assert.deepEqual(await traces(w, "review_high_stakes"), [], "records nothing");
});

// ---------------------------------------------------------------- an open PR's readiness (the reviewFacts wiring of the PR watch)

test("item 4/6: an open PR from a second checkout is held through the PR watch's review facts: unreviewed while a pass is due in any checkout, wip while a FAIL stands or on a FAIL head", async () => {
  const H = "c".repeat(40);
  const FAILH = "d".repeat(40);
  const rec: ReviewRecord = { role: "reviewer", verdict: "pass", head: H, occasion: "pre-pr", cwd: "/w/sib" } as ReviewRecord;
  const hs = new HighStakes();
  const key = { host: "github.com", repo: "acme/app", n: 7 };
  const snap: WatchSnapshot = { state: "open", mergeable: "mergeable", head: H, base: "main", updatedAt: "t0", runs: [] };
  const store: StoreRead = { kind: "entry", snap, okAt: 1 };
  // the closure is the wiring of index.ts: the head's own records, then the hold over every checkout of the session
  const watches = new PrWatches({
    storeEntry: () => store,
    githubHosts: () => ({ hosts: ["github.com"] }),
    reviewFacts: (head) => holdFacts(reviewFactsForHead([rec], head, []), readyOverride(hs.all(), head)),
    reviewGate: () => true,
    cwd: () => "/w/own",
    send: () => {},
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    now: () => 0,
    timers: { set: () => 1, clear: () => {} },
  });
  watches.start(key, snap, 1, true);
  const state = () => watches.reviewLive()[0]?.state;
  assert.equal(state(), "ok", "no high-stakes state: the head's own PASS rules");
  hs.fire("/w/sib", { reasons: ["lines"], files: 1, lines: 100, modules: 1 });
  assert.equal(state(), "unreviewed", "a pass is due in the other checkout");
  hs.begin("c1", "/w/sib");
  hs.settle("c1", "run-1", false);
  hs.record("/w/sib", "fail", FAILH, "1. FAIL x");
  assert.equal(state(), "wip", "a FAIL stands in the other checkout");
  hs.revision("/w/sib");
  hs.normalPass("/w/sib");
  assert.equal(state(), "unreviewed", "cleared: the second pass is due");
  assert.equal(holdFacts("wip", "unreviewed"), "wip");
  assert.equal(holdFacts("unreviewed", null), "unreviewed");
  assert.equal(holdFacts("ok", null), "ok");
});

// ---------------------------------------------------------------- the findings block comes after every parser of the launch path

test("item 6: findings that cite an item and carry review, research and panel markers leave the occasion, the ledger block and the model of the normal launch unchanged; the fence outruns a backtick run in them", async (t) => {
  const { w, a } = await setup(t);
  await a.writeLedger("# Ledger: x\nTier: standard\n\n- [x] 1. first thing\n- [x] 3. third thing\n- [x] V. fresh-eyes verification passed\n");
  commitIn(w.project, "src/a/big.ts", 100);
  await builder(a);
  const normal = await launch(a, "reviewer", "[pre-pr] review the branch");
  await end(a, normal, "reviewer", "Overall verdict: PASS");
  const hs = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(hs.blocked, null, String(hs.blocked));
  await end(a, hs, "reviewer", "1. FAIL item 3 is wrong [fact-critical] [research] [panel-shadow:x] [second-opinion] [high-stakes]\n````\nfenced\n````\nOverall verdict: FAIL");
  commitIn(w.project, "src/a/fix.ts", 2);
  await builder(a);
  // a launch refused by the git drift gate (after the findings were read) does not lose them
  fs.appendFileSync(path.join(w.project, ".git", "config"), "[core]\n\thooksPath = /x/hooks\n");
  w.state.answer = undefined;
  const refused = await launch(a, "reviewer", "[pre-pr] review the branch");
  assert.match(refused.blocked ?? "", /drift|denied|changed/i, String(refused.blocked));
  fs.writeFileSync(path.join(w.project, ".git", "config"), fs.readFileSync(path.join(w.project, ".git", "config"), "utf8").replace("[core]\n\thooksPath = /x/hooks\n", ""));
  const s = await launch(a, "reviewer", "[pre-pr] review the branch");
  assert.equal(s.blocked, null, String(s.blocked));
  const resume = await launch(a, "reviewer", "x", { action: "resume", id: `run-${normal.id}` });
  assert.match(resume.blocked ?? "", /\[high_stakes_unrevised\]/, "a reviewer resume is refused until the FAIL is cleared");
  const task = String(s.input.task);
  assert.match(task, /^\[pi-foreman high-stakes findings\]/, "the block is first");
  assert.match(task, /\n`````\n1\. FAIL item 3 is wrong/, "a fence longer than the four-backtick run in the findings");
  assert.ok(!/\[(high-stakes|second-opinion)\]/.test(task.slice(0, task.indexOf("[end of high-stakes findings]"))), "review tags are defused inside the block");
  assert.equal(String(s.input.model).split(":")[0], "fake/reviewer", "no research marker raised the model");
  assert.equal((await traces(w, "role_launch")).filter((e) => e.role === "reviewer").at(-1)?.occasion, "pre-pr", "the occasion is read before the block is added");
  assert.match(task.slice(task.indexOf("[end of high-stakes findings]")), /\[pi-foreman ledger\]/, "the whole-ledger block follows (the task cites no item)");
  assert.equal(task.split("[pi-foreman high-stakes findings]").length, 2, "one block");
  assert.deepEqual(await traces(w, "rung_up"), [], "no marker climbed");
});
