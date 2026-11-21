// The high-stakes review wired into the adapter, third part: a second checkout (main-path PR gate, a pass raised by the foreman, the gate shared by the
// session), an open PR's readiness through the PR watch, an unmeasurable checkout, a session with no bound ledger, a verdict after the model was unset.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { dueReasons, holdFacts, HighStakes, readyOverride } from "../highstakes.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, WatchSnapshot } from "../prwatch.ts";
import { reviewFactsForHead } from "../prready.ts";
import type { ReviewRecord } from "../reviews.ts";
import { endWith, type Ended } from "./_hsrig.ts";
import { tick, world } from "./_r46world.ts";

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
type World = ReturnType<typeof world>;
type Settle = { entries?: { customType?: string; content?: string }[] } | undefined;

const MODEL = "fake/hs";
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const lines = (n: number) => "x\n".repeat(n);

/** A standard-tier world over a real git repo: `main` seeded, the session on `feature`; `commit` false leaves the repo without a commit and without a base. */
async function setup(t: Parameters<typeof world>[0], o: { commit?: boolean } = {}) {
  const w = world(t, { ceremony: { default: "standard", highStakes: { model: MODEL } } });
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
  const reason = input.reason; // the end reads the occasion from the task the test passed, not the rewritten one
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  if (res?.block) return { blocked: res.reason ?? "blocked", id, input, task, reason };
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  return { blocked: null as string | null, id, input, task, reason };
}
const end = (a: Rig, s: Ended, agent: string, output: string, cwd?: string) => endWith(a, s, agent, output, () => a.endRunAs(s.id, agent, output, cwd));
const settle = async (a: Rig): Promise<string> => {
  const r = (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as Settle;
  return (r?.entries ?? []).find((e) => e.customType === "pi-foreman-ceremony-gate")?.content ?? "";
};
const pr = async (a: Rig, input: Record<string, unknown> = {}): Promise<string> => (await a.checkCall("create_pull_request", input))?.reason ?? "";
/** What the adapter adds to a successful PR tool result: the due-review reminder, "" when none. */
const prNote = async (a: Rig, input: Record<string, unknown> = {}): Promise<string> => {
  const r = (await a.fire("tool_result", { toolName: "create_pull_request", toolCallId: `pn${Math.random()}`, input, details: {}, content: [{ type: "text", text: "created" }], isError: false })) as { content?: { text?: string }[] } | undefined;
  return (r?.content ?? []).map((c) => c.text ?? "").filter((x) => x !== "created").join("\n");
};
const traces = async (w: World, event: string) => (await w.traceEvents()).filter((e) => e.event === event);
/** The record of a normal PASS is written by an async chain (git calls): wait until `n` are traced. */
const recorded = async (w: World, n: number) => {
  const stop = Date.now() + 15000;
  while ((await traces(w, "review_recorded")).length < n && Date.now() < stop) await tick(100);
  assert.ok((await traces(w, "review_recorded")).length >= n, `${n} review records`);
};
const builder = async (a: Rig, cwd?: string, extra: Record<string, unknown> = {}) => end(a, await launch(a, "builder", "build the widget", { ...(cwd ? { cwd } : {}), ...extra }), "builder", "done", cwd);
const normalPass = async (a: Rig, cwd?: string) => end(a, await launch(a, "reviewer", "[pre-pr] review the branch", cwd ? { cwd } : {}), "reviewer", "Overall verdict: PASS", cwd);

test("item 4/6: a tagged builder in a second checkout makes the session's review due (the refusal names the reasons, one state for the session); the FAIL in that checkout is cleared only there: a revision and a normal PASS in the own checkout leave it uncleared", async (t) => {
  const { w, a } = await setup(t);
  const wt2Real = path.join(fs.realpathSync.native(path.join(w.project, "..")), "wt2");
  git(w.project, "worktree", "add", "-q", "-b", "other", wt2Real);
  w.state.answer = "allow once"; // a launch in the second checkout asks the gate

  // own checkout: an untagged change, normal PASS; the second checkout: a tagged builder, normal PASS
  commitIn(w.project, "src/a/small.ts", 2);
  await builder(a);
  await normalPass(a);
  await recorded(w, 1);
  assert.equal(await pr(a), "", "nothing fired: no tag, no heavy tier");
  commitIn(wt2Real, "src/b/big.ts", 100);
  await builder(a, wt2Real, { size: { files: ["src/b/big.ts"] }, risk: ["design"] });
  await normalPass(a, wt2Real);
  await recorded(w, 2);
  assert.deepEqual((await traces(w, "review_stakes")).map((e) => e.reasons), ["design"]);
  assert.equal(await pr(a, { head: "other" }), "", "a due review refuses nothing");
  assert.match(await prNote(a, { head: "other" }), /a \[high-stakes\] review is due \(risk tag design\); launch it if the change warrants it/);
  assert.equal(await pr(a), "", "the same state from the own checkout");

  // the session's first run FAILs in the second checkout; a revision and a normal PASS in the own checkout leave it uncleared
  const hs = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: wt2Real });
  assert.equal(hs.blocked, null, String(hs.blocked));
  await end(a, hs, "reviewer", "1. FAIL src/b/big.ts:1 broken\nOverall verdict: FAIL", wt2Real);
  commitIn(w.project, "src/a/more.ts", 2);
  await builder(a);
  await normalPass(a);
  const again = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: wt2Real });
  assert.match(again.blocked ?? "", /\[high_stakes_early\]/, "the FAIL of the second checkout is not cleared by a PASS elsewhere");
  assert.match(await pr(a, { head: "other" }), /\[pr_refused:high_stakes_failed\]/);
  assert.equal(await pr(a), "", "a PR from the own checkout is not held by a FAIL that ran in the second checkout (D129)");
  assert.match(await settle(a), /high-stakes review in the checkout .* FAILED/, "the finish hint names the checkout of the FAIL");
});

test("item 4: a repository without a commit measures nothing and asks nothing; a session with no bound ledger is asked for the pass at the finish gate", async (t) => {
  const bad = await setup(t, { commit: false });
  fs.mkdirSync(path.join(bad.w.project, "src/a"), { recursive: true });
  fs.writeFileSync(path.join(bad.w.project, "src/a/big.ts"), lines(100));
  await builder(bad.a);
  await settle(bad.a);
  assert.deepEqual(await traces(bad.w, "review_stakes"), [], "nothing fired");
  assert.deepEqual(await traces(bad.w, "review_stakes_unmeasured"), [], "nothing is measured any more");

  const { w, a } = await setup(t);
  commitIn(w.project, "src/a/big.ts", 100);
  await builder(a, undefined, { size: { files: ["src/a/big.ts"] }, risk: ["design"] });
  await normalPass(a);
  fs.rmSync(path.join(w.project, ".workflow", "LEDGER-x.md")); // the marker still names it: the bound ledger cannot be read
  assert.match(await settle(a), /a \[high-stakes\] review is due \(risk tag design\); launch it if the change warrants it; otherwise finish again/, "no bound ledger: held as if every item were marked");
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

test("item 4/6: an open PR is held through the PR watch's review facts by the session's state: unreviewed while a pass is due, wip while a FAIL stands or on a FAIL head", async () => {
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
    reviewFacts: (head) => holdFacts(reviewFactsForHead([rec], head, []), readyOverride(hs.state(), dueReasons(hs.state(), false), head, [rec].filter((r) => r.head === head && r.cwd).map((r) => r.cwd as string))),
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
  hs.fire(["design"]);
  assert.equal(state(), "ok", "a pass is due: it holds nothing");
  hs.begin("c1", "/w/sib");
  hs.settle("c1", "run-1", false);
  hs.record("/w/sib", "fail", FAILH, "1. FAIL x");
  assert.equal(state(), "wip", "a FAIL stands");
  hs.revision("/w/sib");
  hs.normalPass("/w/sib");
  assert.equal(state(), "ok", "cleared: the second pass is due, it holds nothing");
  assert.equal(holdFacts("wip", "unreviewed"), "wip");
  assert.equal(holdFacts("unreviewed", null), "unreviewed");
  assert.equal(holdFacts("ok", null), "ok");
});

// ---------------------------------------------------------------- the findings block comes after every parser of the launch path

test("item 6: findings that cite an item and carry review, research and panel markers leave the occasion, the ledger block and the model of the normal launch unchanged; the fence outruns a backtick run in them", async (t) => {
  const { w, a } = await setup(t);
  await a.writeLedger("# Ledger: x\nTier: standard\n\n- [x] 1. first thing\n- [x] 3. third thing\n- [x] V. fresh-eyes verification passed\n");
  commitIn(w.project, "src/a/big.ts", 100);
  await builder(a, w.project); // D118: an explicit cwd keeps the builder in the session checkout
  const normal = await launch(a, "reviewer", "[pre-pr] review the branch");
  await end(a, normal, "reviewer", "Overall verdict: PASS");
  const hs = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(hs.blocked, null, String(hs.blocked));
  await end(a, hs, "reviewer", "1. FAIL item 3 is wrong [fact-critical] [research] [panel-shadow:x] [second-opinion] [high-stakes]\n````\nfenced\n````\nOverall verdict: FAIL");
  commitIn(w.project, "src/a/fix.ts", 2);
  await builder(a, w.project); // D118: an explicit cwd keeps the builder in the session checkout
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
