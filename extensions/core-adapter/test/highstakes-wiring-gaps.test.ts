// The high-stakes review wired into the adapter, fourth part: a climb relaunch keeps its ledger lines and the ledger notes name only the cited items,
// a [high-stakes] launch is never a repeat, the fallback base is the HEAD of the session start, the FAIL is read after the review records landed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { tick, world } from "./_r46world.ts";

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
type World = ReturnType<typeof world>;

const MODEL = "fake/hs";
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const LEDGER = "# Ledger: x\nTier: standard\n\n- [x] 1. first thing\n- [x] 3. third thing\n- [x] V. fresh-eyes verification passed\n";

/** A standard-tier world over a real git repo: `main` seeded, the session on `feature`; `base` false leaves no base branch configured (the fallback applies). */
async function setup(t: Parameters<typeof world>[0], o: { base?: boolean; strong?: boolean } = {}) {
  const w = world(t, { ceremony: { default: "standard", highStakes: { model: MODEL } } });
  fs.rmSync(path.join(w.project, ".git"), { recursive: true });
  git(w.project, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(w.project, ".gitignore"), ".workflow/\n");
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", "seed");
  const cfgFile = path.join(w.project, "..", "agent", "foreman.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as { providers: { fake: { roles: Record<string, Record<string, unknown>> } } } & Record<string, unknown>;
  if (o.base !== false) cfg.safety = { ops: { baseBranch: "main" } };
  cfg.presence = { enabled: false }; // an owner dialog must not depend on the host's idle state
  if (o.strong) cfg.providers.fake.roles.reviewer.strong = { model: "fake/reviewer-strong" };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  git(w.project, "checkout", "-q", "-b", "feature");
  const seed = git(w.project, "rev-parse", "HEAD");
  const a = await w.adapter("startup");
  await a.command("ceremony", "standard");
  await a.writeLedger(LEDGER);
  return { w, a, seed };
}

const work = (w: World, name: string, n: number) => {
  fs.mkdirSync(path.dirname(path.join(w.project, name)), { recursive: true });
  fs.writeFileSync(path.join(w.project, name), "x\n".repeat(n));
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", `work ${name}`);
};

async function launch(a: Rig, agent: string, task: string, extra: Record<string, unknown> = {}) {
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  const input: Record<string, unknown> = { agent, task, ...extra };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  if (res?.block) return { blocked: res.reason ?? "blocked", id, input };
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  return { blocked: null as string | null, id, input };
}
const end = async (a: Rig, s: { id: string }, agent: string, output: string, summary?: string) => {
  a.endRunAs(s.id, agent, output, undefined, summary);
  await tick(150);
};
const pr = async (a: Rig): Promise<string> => (await a.checkCall("create_pull_request", {}))?.reason ?? "";
const traces = async (w: World, event: string) => (await w.traceEvents()).filter((e) => e.event === event);
const builder = async (a: Rig) => {
  const b = await launch(a, "builder", "build the widget");
  assert.equal(b.blocked, null, String(b.blocked));
  await end(a, b, "builder", "done");
};

test("item 6: a climb relaunch of the normal reviewer keeps the ledger lines of the items the task cites (not those the findings cite); the ledger notes name only the cited items", async (t) => {
  const { w, a } = await setup(t, { strong: true });
  work(w, "src/a/big.ts", 100);
  await builder(a);
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "half done", "RUNG_UP: context\nDone: half");
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
  const hs = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(hs.blocked, null, String(hs.blocked));
  await end(a, hs, "reviewer", "1. FAIL item 3 is wrong\nOverall verdict: FAIL");
  work(w, "src/a/fix.ts", 2);
  await builder(a);
  const s = await launch(a, "reviewer", "[pre-pr] review item 1 of the branch", { model: "strong" });
  assert.equal(s.blocked, null, String(s.blocked));
  const task = String(s.input.task);
  assert.equal(String(s.input.model).split(":")[0], "fake/reviewer-strong");
  const block = task.slice(0, task.indexOf("[end of high-stakes findings]"));
  const rest = task.slice(task.indexOf("[end of high-stakes findings]"));
  assert.match(block, /1\. FAIL item 3 is wrong/, "the findings are handed");
  assert.match(rest, /\[pi-foreman rung-up handoff\]/, "the handoff follows the block");
  assert.match(rest, /- \[x\] 1\. first thing/, "the ledger line of the cited item is kept");
  assert.doesNotMatch(rest, /- \[x\] 3\. third thing/, "the findings' item 3 pulled no ledger line");
  const ledger = fs.readFileSync(path.join(w.project, ".workflow", "LEDGER-x.md"), "utf8");
  const note = `reviewer launched (run ${`run-${s.id}`.slice(0, 8)})`;
  const section = (id: string) => ledger.slice(ledger.indexOf(`- [x] ${id}.`)).split(/\n- \[/)[0];
  assert.ok(section("1").includes(note), "the note names the cited item");
  assert.ok(!section("3").includes(note), "the findings' item 3 got no note");
});

test("item 2: a [high-stakes] launch is never refused as a repeat: right after a normal PASS with nothing changed an item review is, the pass is not", async (t) => {
  const { w, a } = await setup(t);
  work(w, "src/a/big.ts", 100);
  await builder(a);
  await end(a, await launch(a, "reviewer", "review item 1"), "reviewer", "Overall verdict: PASS");
  const repeat = await launch(a, "reviewer", "review item 1 again");
  assert.match(repeat.blocked ?? "", /nothing changed since/, `control: ${repeat.blocked}`);
  const hs = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(hs.blocked, null, String(hs.blocked));
  assert.deepEqual((await traces(w, "review_high_stakes_refused")), []);
});

test("item 3: the fallback base is the first HEAD the session saw in the repository, recorded at session start (no base branch resolvable): work committed before the first builder launch counts; a worktree shares it; a reload keeps it", async (t) => {
  const { w, a, seed } = await setup(t, { base: false });
  work(w, "src/a/big.ts", 100); // HEAD moves after the session start, before any builder launch
  await builder(a);
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(s.blocked, null, String(s.blocked));
  assert.ok(String(s.input.task).includes(`against ${seed.slice(0, 12)}`), "the task line names the HEAD of the session start");
  await end(a, s, "reviewer", "Overall verdict: FAIL\n1. FAIL a");
  await a.down();
  work(w, "src/a/more.ts", 5);
  const b = await w.adapter("reload");
  work(w, "src/a/fix.ts", 1);
  await end(b, await launch(b, "builder", "fix"), "builder", "done");
  await end(b, await launch(b, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
  const again = await launch(b, "reviewer", "[high-stakes] review the whole change");
  assert.equal(again.blocked, null, String(again.blocked));
  assert.ok(String(again.input.task).includes(`against ${seed.slice(0, 12)}`), "the stored base was not replaced by the reload");
});

test("item 3: a worktree of the repository reviews against the same recorded first HEAD; neither a base nor a recorded head resolves: the task line names no base", async (t) => {
  const { w, a, seed } = await setup(t, { base: false });
  const wt = path.join(fs.realpathSync.native(path.join(w.project, "..")), "wt-base");
  git(w.project, "worktree", "add", "-q", "-b", "other", wt);
  w.state.answer = "allow once";
  fs.writeFileSync(path.join(wt, "w.txt"), "w\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "w");
  await end(a, await launch(a, "builder", "build", { cwd: wt }), "builder", "done");
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch", { cwd: wt }), "reviewer", "Overall verdict: PASS");
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change", { cwd: wt });
  assert.equal(s.blocked, null, String(s.blocked));
  assert.ok(String(s.input.task).includes(`against ${seed.slice(0, 12)}`), "the worktree shares the repository's recorded first HEAD");
});

test("item 3: with neither a merge-base nor a recorded ancestor the task line names no base", async (t) => {
  const { w, a } = await setup(t, { base: false });
  // the recorded head is no ancestor of HEAD any more: history rewritten to an unrelated root
  git(w.project, "checkout", "-q", "--orphan", "fresh");
  fs.writeFileSync(path.join(w.project, "n.txt"), "n\n");
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", "unrelated");
  await builder(a);
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(s.blocked, null, String(s.blocked));
  assert.doesNotMatch(String(s.input.task), /the whole change against /);
  assert.match(String(s.input.task), /occasion: high-stakes \(the whole change: /);
});

test("item 6: a normal reviewer launched right after a high-stakes FAIL ended waits for the FAIL to be recorded and then gets the findings (never refused for a missing revision)", async (t) => {
  const { w, a } = await setup(t);
  work(w, "src/a/big.ts", 100);
  await builder(a);
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
  const hs = await launch(a, "reviewer", "[high-stakes] review the whole change");
  a.endRunAs(hs.id, "reviewer", "1. FAIL a\nOverall verdict: FAIL"); // no tick: the review round is still being recorded
  const next = await launch(a, "reviewer", "[pre-pr] review the branch");
  assert.equal(next.blocked, null, String(next.blocked));
  assert.match(String(next.input.task), /\[pi-foreman high-stakes findings\]/);
});
