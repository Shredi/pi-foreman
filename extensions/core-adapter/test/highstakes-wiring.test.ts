// The high-stakes review wired into the adapter: launch refusals, the forced model, the PR gate, the finish gate, FAIL handling with the
// second pass, persistence over a reload, silence without a model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { tick, world } from "./_r46world.ts";

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
type World = ReturnType<typeof world>;
type Settle = { entries?: { customType?: string; content?: string }[] } | undefined;

const MODEL = "fake/hs";
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const lines = (n: number) => "x\n".repeat(n);
const PR_TOOL = "create_pull_request";

/** A builder launch that fires the review: risk tag `design` (the size is the sizing field the launch needs when sizing is on). */
const TAGGED = { size: { files: ["src/a/big.ts"] }, risk: ["design"] };

/** A standard-tier world over a real git repo (main, then work on a feature branch); a risk tag, tier heavy or the foreman fires the review, never the size. */
async function setup(t: Parameters<typeof world>[0], hs: Record<string, unknown> | null = { model: MODEL }, extra: Record<string, unknown> = {}) {
  const w = world(t, { ceremony: { default: "standard", ...(hs ? { highStakes: hs } : {}), ...extra } });
  fs.rmSync(path.join(w.project, ".git"), { recursive: true });
  git(w.project, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(w.project, ".gitignore"), ".workflow/\n");
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", "seed");
  const cfgFile = path.join(w.project, "..", "agent", "foreman.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
  cfg.safety = { ops: { baseBranch: "main" } };
  cfg.presence = { enabled: false }; // an owner dialog must not depend on the host's idle state
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  git(w.project, "checkout", "-q", "-b", "feature");
  const a = await w.adapter("startup");
  await a.command("ceremony", "standard");
  await a.writeLedger("# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [x] V. fresh-eyes verification passed\n");
  return { w, a };
}

const work = (w: World, name = "src/a/big.ts", n = 100) => {
  fs.mkdirSync(path.dirname(path.join(w.project, name)), { recursive: true });
  fs.writeFileSync(path.join(w.project, name), lines(n));
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", `work ${name}`);
};

interface Started {
  blocked: string | null;
  id: string;
  input: Record<string, unknown>;
}
async function launch(a: Rig, agent: string, task: string, extra: Record<string, unknown> = {}): Promise<Started> {
  const id = `h${Math.random().toString(36).slice(2, 8)}`;
  const input: Record<string, unknown> = { agent, task, ...extra };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  if (res?.block) return { blocked: res.reason ?? "blocked", id, input };
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  return { blocked: null, id, input };
}
const end = async (a: Rig, s: Started, agent: string, output: string): Promise<void> => {
  a.endRunAs(s.id, agent, output);
  await tick(120);
};
const settle = async (a: Rig): Promise<string> => {
  const r = (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as Settle;
  return (r?.entries ?? []).find((e) => e.customType === "pi-foreman-ceremony-gate")?.content ?? "";
};
const pr = async (a: Rig): Promise<string> => (await a.checkCall(PR_TOOL, {}))?.reason ?? "";
/** What the adapter adds to a successful PR tool result: the due-review reminder, "" when none. */
const prNote = async (a: Rig): Promise<string> => {
  const r = (await a.fire("tool_result", { toolName: PR_TOOL, toolCallId: `pn${Math.random()}`, input: {}, details: {}, content: [{ type: "text", text: "created" }], isError: false })) as { content?: { text?: string }[] } | undefined;
  return (r?.content ?? []).map((c) => c.text ?? "").filter((x) => x !== "created").join("\n");
};
const builder = async (a: Rig, extra: Record<string, unknown> = {}) => end(a, await launch(a, "builder", "build the widget", extra), "builder", "done");
const normal = async (a: Rig, verdict: "PASS" | "FAIL", task = "[pre-pr] review the branch") => {
  const s = await launch(a, "reviewer", task);
  if (s.blocked === null) await end(a, s, "reviewer", `Overall verdict: ${verdict}`);
  return s;
};
const hsPass = async (a: Rig, verdict: "PASS" | "FAIL", findings = "") => {
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change");
  if (s.blocked === null) await end(a, s, "reviewer", `${findings}\nOverall verdict: ${verdict}`);
  return s;
};
const traces = async (w: World, event: string) => (await w.traceEvents()).filter((e) => e.event === event);
/** A builder tagged `design`, then the normal pre-pr PASS: the risky change is built and reviewed. */
const built = async (w: World, a: Rig) => {
  work(w);
  await builder(a, TAGGED);
  await normal(a, "PASS");
};

// ---------------------------------------------------------------- items 1, 2, 5: launch

test("item 2/5: the launch refusals: no model, not single, resume of a run, early, done", async (t) => {
  const off = await setup(t, null);
  work(off.w);
  const unset = await launch(off.a, "reviewer", "[high-stakes] review");
  assert.match(unset.blocked ?? "", /\[high_stakes_unset\]/);
  assert.deepEqual((await traces(off.w, "review_high_stakes_refused")).map((e) => e.reason), ["high_stakes_unset"]);

  const f = await setup(t);
  work(f.w);
  const early = await launch(f.a, "reviewer", "[high-stakes] review");
  assert.match(early.blocked ?? "", /\[high_stakes_early\]/, "no normal PASS stands");
  await builder(f.a);
  await normal(f.a, "PASS");
  f.w.state.answer = "allow once";
  const group = await launch(f.a, "reviewer", "ignored", { tasks: [{ agent: "reviewer", task: "[high-stakes] one" }, { agent: "reviewer", task: "two" }] });
  assert.match(group.blocked ?? "", /\[high_stakes_single\]/, "refused inside a multi-child launch");
  const first = await launch(f.a, "reviewer", "[high-stakes] review");
  assert.equal(first.blocked, null);
  const concurrent = await launch(f.a, "reviewer", "[high-stakes] review again");
  assert.match(concurrent.blocked ?? "", /\[high_stakes_done\]/, "refused while one is running");
  await end(f.a, first, "reviewer", "Overall verdict: PASS");
  const again = await launch(f.a, "reviewer", "[high-stakes] review once more");
  assert.match(again.blocked ?? "", /\[high_stakes_done\]/, "used up after a PASS");
});

test("item 5: the resume of a high-stakes run is refused (the model equals the role map's, so only the high-stakes check can refuse it)", async (t) => {
  const { w, a } = await setup(t, { model: "fake/reviewer" });
  await built(w, a);
  const first = await launch(a, "reviewer", "[high-stakes] review");
  assert.equal(first.blocked, null, String(first.blocked));
  const resume = await launch(a, "reviewer", "x", { action: "resume", id: `run-${first.id}` });
  assert.match(resume.blocked ?? "", /\[high_stakes_resume\]/);
  await end(a, first, "reviewer", "Overall verdict: FAIL\n1. FAIL a");
  const after = await launch(a, "reviewer", "x", { action: "resume", id: `run-${first.id}` });
  assert.match(after.blocked ?? "", /\[high_stakes_resume\]/, "also after it ended");
  assert.deepEqual((await traces(w, "review_high_stakes_refused")).map((e) => e.reason), ["high_stakes_resume", "high_stakes_resume"]);
});

test("item 2: the model as set, also when equal to the foreman's id; an explicit model: is replaced; no item marks, not a panel gate", async (t) => {
  for (const model of [MODEL, "fake/foreman"]) {
    const { w, a } = await setup(t, { model });
    await built(w, a);
    const s = await launch(a, "reviewer", "[high-stakes] review", { model: "fake/other" });
    assert.equal(s.blocked, null, String(s.blocked));
    assert.equal(String(s.input.model).split(":")[0], model);
    assert.match(String(s.input.task), /occasion: high-stakes \(the whole change against [0-9a-f]{12}/);
    assert.deepEqual(await traces(w, "rung_up"), [], "no climb");
    const occ = await traces(w, "review_occasion");
    assert.equal(occ.at(-1)?.occasion, "high-stakes");
    await end(a, s, "reviewer", "Overall verdict: PASS");
    assert.deepEqual((await traces(w, "review_high_stakes")).map((e) => e.verdict), ["pass"]);
  }
});

test("item 2: no security or repeat-fail climb for the high-stakes entry, research markers have no effect", async (t) => {
  const { w, a } = await setup(t);
  work(w, "src/a/auth.ts", 100);
  fs.writeFileSync(path.join(w.project, "src/a/auth.ts"), `${lines(100)}eval(input)\n`);
  await builder(a, TAGGED);
  await normal(a, "PASS");
  const s = await launch(a, "reviewer", "[high-stakes] [research] [fact-critical] review");
  assert.equal(s.blocked, null, String(s.blocked));
  assert.equal(String(s.input.model).split(":")[0], MODEL);
  assert.deepEqual((await traces(w, "rung_up")).filter((e) => String(e.role) === "reviewer"), []);
});

test("item 1: highStakes.model replaces the model of no other reviewer launch (item, [pre-pr], [plan-review], [second-opinion])", async (t) => {
  const { w, a } = await setup(t);
  work(w);
  await builder(a);
  for (const task of ["review items 1", "[pre-pr] review the branch", "[plan-review] review x", "[second-opinion] advice"]) {
    const s = await launch(a, "reviewer", task);
    assert.equal(s.blocked, null, `${task}: ${s.blocked}`);
    assert.equal(String(s.input.model).split(":")[0], "fake/reviewer", task);
    await end(a, s, "reviewer", task.startsWith("[pre-pr]") ? "Overall verdict: PASS" : "Overall verdict: FAIL");
  }
  assert.deepEqual(await traces(w, "review_stakes_model"), []);
});

// ---------------------------------------------------------------- items 3, 4, 8: trigger, PR gate, finish gate

test("item 4/8: a risky change: the PR gate refuses until the pass ran; the trigger is traced once; the PASS opens the gate and writes no normal review record", async (t) => {
  const { w, a } = await setup(t);
  await built(w, a);
  assert.equal(await pr(a), "", "a due review refuses nothing");
  assert.match(await prNote(a), /a \[high-stakes\] review is due \(risk tag design\); launch it if the change warrants it/);
  const fired = await traces(w, "review_stakes");
  assert.equal(fired.length, 1, "traced once");
  assert.deepEqual(fired[0], { ...fired[0], level: "high", reasons: "design" });
  assert.equal("lines" in fired[0] || "modules" in fired[0] || "files" in fired[0] || "base" in fired[0], false, "no size facts");
  assert.match(await settle(a), /a \[high-stakes\] review is due \(risk tag design\); launch it if the change warrants it; otherwise finish again/, "the finish gate holds once with the reminder");
  // the record of the normal PASS is written by an async chain (git calls); wait for it so a late write is not counted as the pass's
  const stop = Date.now() + 15000;
  while ((await traces(w, "review_recorded")).length < 1 && Date.now() < stop) await tick(100);
  assert.equal((await traces(w, "review_recorded")).length, 1, "the normal PASS wrote its record");
  await hsPass(a, "PASS");
  await tick(500);
  assert.equal((await traces(w, "review_recorded")).length, 1, "the high-stakes verdict writes no normal review record");
  assert.equal((await traces(w, "review_high_stakes")).length, 1);
  assert.equal(await pr(a), "");
  assert.doesNotMatch(await settle(a), /high-stakes/);
  assert.deepEqual((await traces(w, "review_stakes")).map((e) => e.reasons), ["design", "foreman"], "the foreman's own launch adds its reason once");
});

// the parser tag alone and an untagged large change (900 lines, 6 modules) ask nothing, with sizing on and off: asserted in highstakes-wiring-risk-gaps.test.ts
test("item 4: with reviewBeforePr false there is no PR check; with no model nothing is required", async (t) => {
  const off = await setup(t, { model: MODEL }, { reviewBeforePr: false });
  await built(off.w, off.a);
  assert.doesNotMatch(await pr(off.a), /high_stakes/);

  const none = await setup(t, null);
  await built(none.w, none.a);
  assert.equal(await pr(none.a), "");
  assert.deepEqual(await traces(none.w, "review_stakes"), []);
  assert.doesNotMatch(await settle(none.a), /high-stakes/);
});

// ---------------------------------------------------------------- item 6: FAIL, second pass

test("item 6: a FAIL: the PR gate and the finish gate hold, a normal reviewer waits for the revision and gets the findings, then the second pass is required", async (t) => {
  const { w, a } = await setup(t);
  await built(w, a);
  const first = await hsPass(a, "FAIL", "1. FAIL src/a/big.ts:1 broken");
  assert.equal(first.blocked, null);
  assert.match(await pr(a), /\[pr_refused:high_stakes_failed\]/);
  assert.match(await settle(a), /revise or answer the high-stakes findings, then pass the normal reviewer/);
  const early = await launch(a, "reviewer", "[pre-pr] review the branch");
  assert.equal(early.blocked, null, "a fresh normal reviewer is never refused for a missing revision");
  assert.match(String(early.input.task), /\[pi-foreman high-stakes findings\]/, "it gets the findings");
  await end(a, early, "reviewer", "no verdict"); // a run that ends without a verdict clears nothing
  const resumeEarly = await launch(a, "reviewer", "x", { action: "resume", id: "run-other" });
  assert.equal(resumeEarly.blocked === null || /unrevised|resume/.test(resumeEarly.blocked), true);
  const second = await launch(a, "reviewer", "[high-stakes] again");
  assert.match(second.blocked ?? "", /\[high_stakes_early\]/, "any head refused while a FAIL is uncleared");
  work(w, "src/a/fix.ts", 3);
  await builder(a);
  const ok = await launch(a, "reviewer", "[pre-pr] review the branch");
  assert.equal(ok.blocked, null, String(ok.blocked));
  assert.match(String(ok.input.task), /\[pi-foreman high-stakes findings\]/);
  assert.match(String(ok.input.task), /1\. FAIL src\/a\/big\.ts:1 broken/);
  await end(a, ok, "reviewer", "Overall verdict: PASS");
  // handed once: the next normal launch carries no block
  const later = await launch(a, "reviewer", "[second-opinion] ok");
  assert.doesNotMatch(String(later.input.task), /high-stakes findings/);
  await end(a, later, "reviewer", "Overall verdict: PASS");
  assert.equal(await pr(a), "", "the second pass is due: no refusal");
  assert.match(await prNote(a), /a \[high-stakes\] review is due/);
  assert.match(await settle(a), /a \[high-stakes\] review is due/, "the finish holds once for the second pass");
  const pass = await hsPass(a, "PASS");
  assert.equal(pass.blocked, null, String(pass.blocked));
  assert.equal(await pr(a), "");
  const third = await launch(a, "reviewer", "[high-stakes] third");
  assert.match(third.blocked ?? "", /\[high_stakes_done\]/);
});

test("item 6: a second FAIL is handled like the first; the normal PASS after its revision opens the gate; a third pass is refused", async (t) => {
  const { w, a } = await setup(t);
  await built(w, a);
  await hsPass(a, "FAIL", "1. FAIL one");
  work(w, "src/a/fix1.ts", 2);
  await builder(a);
  await normal(a, "PASS");
  await hsPass(a, "FAIL", "1. FAIL two");
  assert.match(await pr(a), /high_stakes_failed/);
  work(w, "src/a/fix2.ts", 2);
  await builder(a);
  await normal(a, "PASS");
  assert.equal(await pr(a), "");
  assert.doesNotMatch(await settle(a), /high-stakes/);
  assert.match((await launch(a, "reviewer", "[high-stakes] third")).blocked ?? "", /\[high_stakes_done\]/);
});

// ---------------------------------------------------------------- item 7: reload; model unset

test("item 7: after a reload the state holds: a FAIL still gates, no deadlock, a run ending after the reload is recognised by its run id", async (t) => {
  const { w, a } = await setup(t);
  await built(w, a);
  await hsPass(a, "FAIL", "1. FAIL a");
  const b = await w.adapter("reload");
  assert.match(await pr(b), /high_stakes_failed/);
  assert.match(await settle(b), /revise or answer the high-stakes findings/);
});

test("item 7: a high-stakes run whose completion notice arrives after a reload is recognised by its persisted run id and marks no item (a run of another id does)", async (t) => {
  const { w, a } = await setup(t);
  await built(w, a);
  await a.writeLedger("# Ledger: x\nTier: standard\n\n- [ ] 2. second\n- [ ] 3. third\n- [x] V. fresh-eyes verification passed\n");
  const run = await launch(a, "reviewer", "[high-stakes] review");
  assert.equal(run.blocked, null, String(run.blocked));
  const b = await w.adapter("reload");
  const notice = (id: string, item: string) => `Background task completed: **reviewer**\n\nOverall verdict: PASS\n${item}. PASS fine\n\nRetention-managed async directory: /x/async/${id}\n`;
  const ledger = () => fs.readFileSync(path.join(w.project, ".workflow", "LEDGER-x.md"), "utf8");
  await b.fire("message_end", { message: { role: "custom", customType: "subagent-notify", content: notice(`run-${run.id}`, "2") } });
  await tick(300);
  assert.match(ledger(), /- \[ \] 2\. second/, "the high-stakes run marked nothing");
  await b.fire("message_end", { message: { role: "custom", customType: "subagent-notify", content: notice("run-other", "3") } });
  await tick(300);
  assert.match(ledger(), /- \[x\] 3\. third/, "control: a notice of another run marks");
});

test("item 7: an old state entry without the list loads", async (t) => {
  const { w, a } = await setup(t);
  await built(w, a);
  const stop = Date.now() + 8000;
  const entryOf = () => w.ceremonyEntries().at(-1)?.data as { reviews?: unknown[]; highStakes?: unknown } | undefined;
  while (Date.now() < stop && !((entryOf()?.reviews?.length ?? 0) > 0 && entryOf()?.highStakes !== undefined)) await tick(50);
  const e = entryOf()!;
  assert.ok((e.reviews?.length ?? 0) > 0 && e.highStakes !== undefined, "the persisted entry carries the review and the state");
  delete e.highStakes;
  const b = await w.adapter("reload");
  assert.doesNotMatch(await pr(b), /high_stakes/, "nothing is measured again: a state without the entry asks for nothing");
});

test("item 4/6: every check is silent once the model is unset after a FAIL", async (t) => {
  const { w, a } = await setup(t);
  await built(w, a);
  await hsPass(a, "FAIL", "1. FAIL a");
  await a.down();
  const cfgFile = path.join(w.project, "..", "agent", "foreman.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as { ceremony: Record<string, unknown> };
  cfg.ceremony.highStakes = { model: null };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const b = await w.adapter("reload");
  assert.doesNotMatch(await pr(b), /high_stakes/);
  assert.doesNotMatch(await settle(b), /high-stakes/);
  const n = await launch(b, "reviewer", "[pre-pr] review the branch");
  assert.doesNotMatch(n.blocked ?? "", /high_stakes/);
  const r = await launch(b, "reviewer", "[high-stakes] x");
  assert.match(r.blocked ?? "", /\[high_stakes_unset\]/, "the traced refusal is the one voice");
});
