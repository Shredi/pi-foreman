import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { countingView, entryOccasions, occasionOf, reviewLaunchOf, reviewResultsOfRunEnd } from "../occasion.ts";
import { applyPanel, composePanelBlock } from "../panel.ts";
import { onReviewRunEnd, type RecordRunner } from "../findings.ts";
import { OnFindClimb } from "../reviewerclimb.ts";
import { sanitizeTrace } from "../trace.ts";
import { reviewVerdictsOfRunEnd } from "../bound.ts";
import { reviewsOfRunEnd } from "../reviews.ts";
import { reviewerPassOfRunEnd } from "../reviewmarks.ts";

const PANEL = { ladder: { reviewPanel: { shadows: ["p/m-a:high", "p/m-b"], gates: ["pre-pr"], visible: true } } };
const panelOpts = (config: Record<string, unknown> = PANEL, rewrite = true) => ({ config, foreman: "p/m-opus", maxThinking: "medium", childMaxThinking: undefined, refused: (m: string) => m.startsWith("p/m-b"), rewrite });
const ok = (agent: string, output: string, model?: string) => ({ agent, status: "completed", success: true, output, ...(model ? { model } : {}) });

test("occasionOf: markers select the occasion; second-opinion wins; none is item", () => {
  assert.equal(occasionOf("check it [plan-review]"), "plan-review");
  assert.equal(occasionOf("whole branch [PRE-PR]"), "pre-pr");
  assert.equal(occasionOf("[pre-pr] [second-opinion]"), "second-opinion");
  assert.equal(occasionOf("review items 1-3", "second-opinion"), "second-opinion");
  assert.equal(occasionOf("review items 1-3"), "item");
  assert.equal(occasionOf(undefined), "item");
});

test("second-opinion and shadow verdicts do not count: no item marks, gate verdicts, PR heads or climb", async () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "branch [pre-pr]", model: "p/m-haiku" };
  const occ = entryOccasions(input);
  const p = applyPanel(input, occ, panelOpts());
  const launch = reviewLaunchOf(input, occ, p.shadows, { started: 0, files: ["a.ts"], panel: p.panel })!;
  const data = { runId: "r1", results: [ok("reviewer", "1. PASS\nVerdict: PASS", "p/m-haiku"), ok("reviewer", "1. FAIL a.ts:3\nVerdict: FAIL"), ok("reviewer", "1. FAIL\nVerdict: FAIL")] };
  const results = reviewResultsOfRunEnd(data, launch);
  assert.deepEqual(results.map((r) => [r.primary, r.counts, r.occasion, r.shadow]), [[true, true, "pre-pr", null], [false, false, "pre-pr", "p/m-a:high"], [false, false, "pre-pr", "p/m-b"]]);
  const view = countingView(data, results);
  assert.deepEqual(reviewVerdictsOfRunEnd(view), ["pass"]);
  assert.equal(reviewsOfRunEnd(view).length, 1);
  // a single second-opinion run: nothing is left for the consumers, not even the event itself
  const so: Record<string, unknown> = { agent: "reviewer", task: "again [second-opinion]" };
  const soLaunch = reviewLaunchOf(so, entryOccasions(so), new Map(), { started: 0, files: [], panel: null });
  const single = { runId: "r2", agent: "reviewer", status: "completed", success: true, output: "1. PASS\nVerdict: PASS" };
  const soView = countingView(single, reviewResultsOfRunEnd(single, soLaunch));
  assert.deepEqual(reviewVerdictsOfRunEnd(soView), []);
  assert.equal(reviewerPassOfRunEnd(soView), "");
  assert.equal(reviewsOfRunEnd(soView).length, 0);
  // the climb is fed only by the counting primary
  const climb = new OnFindClimb();
  climb.rungs = ["p/m-haiku", "p/m-sonnet"];
  const run: RecordRunner = async () => ({ ok: true, text: JSON.stringify({ findings: [{ id: "f1", file: "a.ts", line: 3, class: "logic", note: "n" }] }) });
  const soOut = await onReviewRunEnd({ results: reviewResultsOfRunEnd(single, soLaunch), launch: soLaunch, context: ctx("r2"), tmpDir: tmp(), climb, ledger: "L", visible: true }, run);
  assert.equal(soOut.traces.filter((t) => t.event === "rung_up" || t.event === "climb_done").length, 0);
});

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "pf-occ-"));
const ctx = (runId: string) => ({ session: "S", agentDir: "/agent", runId, cwd: "/repo", head: "abc", rungs: ["p/m-haiku", "p/m-sonnet"], live: "p/m-haiku", now: 5000 });

test("run end: the record call gets the report on stdin and a file list; a PASS with a finding climbs (rung_up on_find)", async () => {
  const dir = tmp();
  const input: Record<string, unknown> = { agent: "reviewer", task: "items 1", model: "p/m-haiku" };
  const launch = reviewLaunchOf(input, entryOccasions(input), new Map(), { started: 1000, files: ["src/a.ts", "src/b.ts"], panel: null })!;
  const data = { runId: "r1", results: [ok("reviewer", "1. PASS\nVerdict: PASS but src/a.ts:12 leaks", "p/m-haiku")] };
  const calls: { args: string[]; input: string; files: string }[] = [];
  const run: RecordRunner = async (args, stdin) => {
    calls.push({ args, input: stdin, files: fs.readFileSync(args[args.indexOf("--files-from") + 1], "utf8") });
    return { ok: true, text: JSON.stringify({ verdict: "pass", findings: [{ id: "abc123", file: "src/deep/a.ts", line: 12, class: "leak", note: "n" }] }) };
  };
  const climb = new OnFindClimb();
  climb.rungs = ["p/m-haiku", "p/m-sonnet"];
  const out = await onReviewRunEnd({ results: reviewResultsOfRunEnd(data, launch), launch, context: ctx("r1"), tmpDir: dir, climb, ledger: "L", visible: true }, run);
  const a = calls[0].args;
  for (const [k, v] of [["--gate", "item"], ["--model", "p/m-haiku"], ["--rung", "0"], ["--primary", "1"], ["--source", "live"], ["--role", "reviewer"], ["--run-id", "r1"], ["--verdict", "PASS"], ["--head", "abc"], ["--secs", "4.0"], ["--session", "S"]]) assert.equal(a[a.indexOf(k) + 1], v, k);
  assert.match(calls[0].input, /leaks/);
  assert.equal(calls[0].files, "src/a.ts\nsrc/b.ts\n");
  assert.deepEqual(fs.readdirSync(dir), []); // the list is removed
  const finding = out.traces.find((t) => t.event === "finding")!;
  assert.deepEqual(sanitizeTrace(finding), { event: "finding", role: "reviewer", findingId: "abc123", model: "p/m-haiku", gate: "item", class: "leak", file: "a.ts", line: 12, primary: true });
  assert.ok(out.traces.some((t) => t.event === "rung_up" && t.reason === "on_find" && t.item === "1"));
  assert.equal(climb.launchRung(), 1);
});

test("run end fail-soft: a failed or garbled record call is zero findings, no throw, no extra trace", async () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "items 1", model: "p/m-haiku" };
  const launch = reviewLaunchOf(input, entryOccasions(input), new Map(), { started: 0, files: [], panel: null })!;
  const data = { runId: "r1", results: [ok("reviewer", "1. PASS\nVerdict: PASS")] };
  for (const run of [async () => ({ ok: false, text: "timed out" }), async () => ({ ok: true, text: "not json" }), async () => { throw new Error("boom"); }] as RecordRunner[]) {
    const climb = new OnFindClimb();
    climb.rungs = ["p/m-haiku", "p/m-sonnet"];
    const out = await onReviewRunEnd({ results: reviewResultsOfRunEnd(data, launch), launch, context: ctx("r1"), tmpDir: tmp(), climb, ledger: "L", visible: true }, run);
    assert.deepEqual(out.traces.map((t) => [t.event, t.reason]), [["climb_done", "clean"]]);
  }
});

test("panel: a single pre-pr reviewer launch becomes 3 parallel entries; shadows carry policy_override; traced", () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "branch [pre-pr]", model: "p/m-haiku", async: true };
  const occ = entryOccasions(input);
  const p = applyPanel(input, occ, panelOpts());
  const tasks = input.tasks as Record<string, unknown>[];
  assert.equal(input.agent, undefined);
  assert.equal(input.async, true);
  assert.deepEqual(tasks.map((t) => [t.agent, t.task, t.model, t.policy_override]), [["reviewer", "branch [pre-pr]", "p/m-haiku", undefined], ["reviewer", "branch [pre-pr]", "p/m-a:medium", true], ["reviewer", "branch [pre-pr]", "p/m-b", true]]);
  assert.deepEqual(p.traces, [{ event: "panel", role: "reviewer", gate: "pre-pr", models: "p/m-a,p/m-b", primary: "p/m-haiku", policy_override: true }]);
  assert.deepEqual(p.panel, { gate: "pre-pr", primary: "p/m-haiku", shadows: ["p/m-a", "p/m-b"] });
});

test("panel unsupported (pinned pi-subagents, the default): the launch stays unchanged, traced decision unsupported", () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "branch [pre-pr]", model: "p/m-haiku" };
  const occ = entryOccasions(input);
  const { rewrite: _, ...opts } = panelOpts();
  const p = applyPanel(input, occ, opts);
  assert.deepEqual(input, { agent: "reviewer", task: "branch [pre-pr]", model: "p/m-haiku" });
  assert.deepEqual(p.traces, [{ event: "panel", role: "reviewer", gate: "pre-pr", models: "p/m-a,p/m-b", primary: "p/m-haiku", policy_override: true, decision: "unsupported" }]);
  assert.equal(p.panel, null);
  assert.equal(p.shadows.size, 0);
  assert.deepEqual(reviewLaunchOf(input, occ, p.shadows, { started: 0, files: [], panel: p.panel })!.entries.map((e) => [e.model, e.shadow]), [["p/m-haiku", null]]);
});

test("panel off: no shadows, or the occasion is not a gate", () => {
  for (const [config, task] of [[{ ladder: { reviewPanel: { shadows: [], gates: ["pre-pr"] } } }, "x [pre-pr]"], [PANEL, "items 1-3"], [PANEL, "x [second-opinion]"]] as const) {
    const input: Record<string, unknown> = { agent: "reviewer", task, model: "p/m-haiku" };
    const p = applyPanel(input, entryOccasions(input), panelOpts(config as Record<string, unknown>));
    assert.equal(input.tasks, undefined);
    assert.equal(input.agent, "reviewer");
    assert.deepEqual(p.traces, []);
  }
});

test("composePanelBlock: primary first, shadows by model, dedupe within 3 lines with also-found-by; visible:false hides shadows", () => {
  const f = (file: string, line: number | null, cls: string, note = "n") => ({ file, line, class: cls, note });
  const primary = { model: "p/m-haiku", findings: [f("a.ts", 10, "logic", "off by one")] };
  const shadows = [
    { model: "p/m-a", findings: [f("a.ts", 13, "logic"), f("b.ts", 5, "leak", "fd leak")] },
    { model: "p/m-b", findings: [f("a.ts", 14, "logic"), f("b.ts", 7, "leak"), f("c.ts", null, "race", "race")] },
  ];
  assert.equal(composePanelBlock(primary, shadows, true), ["pi-foreman review panel", "Review findings, primary (p/m-haiku):", "- a.ts:10 [logic] off by one (also found by p/m-a)", "Shadow findings (do not block):", "p/m-a:", "- b.ts:5 [leak] fd leak (also found by p/m-b)", "p/m-b:", "- a.ts:14 [logic] n", "- c.ts [race] race"].join("\n"));
  assert.equal(composePanelBlock(primary, shadows, false), ["pi-foreman review panel", "Review findings, primary (p/m-haiku):", "- a.ts:10 [logic] off by one"].join("\n"));
  assert.equal(composePanelBlock({ model: "p/m-haiku", findings: [] }, shadows, false), "");
});
