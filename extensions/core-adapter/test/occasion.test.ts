import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { countingView, entryOccasions, occasionOf, reviewLaunchOf, reviewResultsOfRunEnd } from "../occasion.ts";
import { composePanelBlock, parseShadowMarker, PendingPanels, primaryPanel, shadowInstruction, shadowLaunch, type PendingView } from "../panel.ts";
import { onReviewRunEnd, type RecordRunner } from "../findings.ts";
import { sanitizeTrace } from "../trace.ts";
import { reviewVerdictsOfRunEnd } from "../bound.ts";
import { reviewsOfRunEnd } from "../reviews.ts";
import { reviewerPassOfRunEnd } from "../reviewmarks.ts";

const PANEL = { ladder: { reviewPanel: { shadows: ["p/m-a:high", "p/m-b"], gates: ["pre-pr"], visible: true } } };
const shadowOpts = (config: Record<string, unknown> = PANEL) => ({ config, isChild: false, maxThinking: "medium", childMaxThinking: undefined, refused: (m: string) => (m.startsWith("p/m-b") ? "rank says no" : null) });
const pending = (id: string, over: Partial<PendingView> = {}): PendingView => ({ id, gate: "pre-pr", primary: "p/m-haiku", task: `branch ${id} [pre-pr]`, expected: ["p/m-a", "p/m-b"], launched: new Set(), ...over });
const ok = (agent: string, output: string, model?: string) => ({ agent, status: "completed", success: true, output, ...(model ? { model } : {}) });

test("occasionOf: markers select the occasion; second-opinion wins; none is item", () => {
  assert.equal(occasionOf("check it [plan-review]"), "plan-review");
  assert.equal(occasionOf("whole branch [PRE-PR]"), "pre-pr");
  assert.equal(occasionOf("[pre-pr] [second-opinion]"), "second-opinion");
  assert.equal(occasionOf("review items 1-3", "second-opinion"), "second-opinion");
  assert.equal(occasionOf("review items 1-3"), "item");
  assert.equal(occasionOf(undefined), "item");
});

test("second-opinion and shadow verdicts do not count: no item marks, gate verdicts or PR heads", () => {
  const [a, b] = [{ agent: "reviewer", task: "branch [pre-pr]", model: "p/m-a:medium" }, { agent: "reviewer", task: "branch [pre-pr]", model: "p/m-b" }];
  const input: Record<string, unknown> = { tasks: [{ agent: "reviewer", task: "branch [pre-pr]", model: "p/m-haiku" }, a, b] };
  const occ = entryOccasions(input);
  const launch = reviewLaunchOf(input, occ, new Map([[a, "p/m-a:high"], [b, "p/m-b"]]), { started: 0, files: ["a.ts"], panel: { gate: "pre-pr", primary: "p/m-haiku", shadows: ["p/m-a", "p/m-b"] } })!;

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
});

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "pf-occ-"));
const ctx = (runId: string) => ({ session: "S", agentDir: "/agent", runId, cwd: "/repo", head: "abc", live: "p/m-haiku", now: 5000 });

test("run end: the record call gets the report on stdin and a file list; a finding is traced; a climbed launch records rung 1", async () => {
  const dir = tmp();
  const input: Record<string, unknown> = { agent: "reviewer", task: "items 1", model: "p/m-haiku" };
  const launch = reviewLaunchOf(input, entryOccasions(input), new Map(), { started: 1000, files: ["src/a.ts", "src/b.ts"], panel: null })!;
  const data = { runId: "r1", results: [ok("reviewer", "1. PASS\nVerdict: PASS but src/a.ts:12 leaks", "p/m-haiku")] };
  const calls: { args: string[]; input: string; files: string }[] = [];
  const run: RecordRunner = async (args, stdin) => {
    calls.push({ args, input: stdin, files: fs.readFileSync(args[args.indexOf("--files-from") + 1], "utf8") });
    return { ok: true, text: JSON.stringify({ verdict: "pass", findings: [{ id: "abc123", file: "src/deep/a.ts", line: 12, class: "leak", note: "n" }] }) };
  };
  const out = await onReviewRunEnd({ results: reviewResultsOfRunEnd(data, launch), launch, context: ctx("r1"), tmpDir: dir }, run);
  const a = calls[0].args;
  for (const [k, v] of [["--gate", "item"], ["--model", "p/m-haiku"], ["--rung", "0"], ["--primary", "1"], ["--source", "live"], ["--role", "reviewer"], ["--run-id", "r1"], ["--verdict", "PASS"], ["--head", "abc"], ["--secs", "4.0"], ["--session", "S"]]) assert.equal(a[a.indexOf(k) + 1], v, k);
  assert.match(calls[0].input, /leaks/);
  assert.equal(calls[0].files, "src/a.ts\nsrc/b.ts\n");
  assert.deepEqual(fs.readdirSync(dir), []); // the list is removed
  const finding = out.traces.find((t) => t.event === "finding")!;
  assert.deepEqual(sanitizeTrace(finding), { event: "finding", role: "reviewer", findingId: "abc123", model: "p/m-haiku", gate: "item", class: "leak", file: "a.ts", line: 12, primary: true });
  // raised to the strong rung by repeat-fail or security: --rung 1
  const climbed = reviewLaunchOf(input, entryOccasions(input), new Map(), { started: 1000, files: [], panel: null, climbed: new Set([input]) })!;
  await onReviewRunEnd({ results: reviewResultsOfRunEnd(data, climbed), launch: climbed, context: ctx("r2"), tmpDir: dir }, run);
  assert.equal(calls[1].args[calls[1].args.indexOf("--rung") + 1], "1");
});

test("run end fail-soft: a failed or garbled record call is zero findings, no throw, no extra trace", async () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "items 1", model: "p/m-haiku" };
  const launch = reviewLaunchOf(input, entryOccasions(input), new Map(), { started: 0, files: [], panel: null })!;
  const data = { runId: "r1", results: [ok("reviewer", "1. PASS\nVerdict: PASS")] };
  for (const run of [async () => ({ ok: false, text: "timed out" }), async () => ({ ok: true, text: "not json" }), async () => { throw new Error("boom"); }] as RecordRunner[]) {
    const out = await onReviewRunEnd({ results: reviewResultsOfRunEnd(data, launch), launch, context: ctx("r1"), tmpDir: tmp() }, run);
    assert.deepEqual(out.traces, []);
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

test("primary panel: the gate reviewer stays one launch; expected shadows drop the primary's and the foreman's base; off without shadows or gate", () => {
  const input: Record<string, unknown> = { agent: "reviewer", task: "branch [pre-pr]", model: "p/m-haiku" };
  const cfg = { ladder: { reviewPanel: { shadows: ["p/m-a:high", "p/m-haiku", "p/m-opus", "p/m-b"], gates: ["pre-pr"] } } };
  assert.deepEqual(primaryPanel(input, entryOccasions(input), cfg, "p/m-opus"), { panel: { gate: "pre-pr", primary: "p/m-haiku", shadows: ["p/m-a", "p/m-b"] }, task: "branch [pre-pr]" });
  assert.deepEqual(input, { agent: "reviewer", task: "branch [pre-pr]", model: "p/m-haiku" });
  for (const [config, task] of [[{ ladder: { reviewPanel: { shadows: [], gates: ["pre-pr"] } } }, "x [pre-pr]"], [PANEL, "items 1-3"], [PANEL, "x [second-opinion]"]] as const) {
    const e: Record<string, unknown> = { agent: "reviewer", task, model: "p/m-haiku" };
    assert.equal(primaryPanel(e, entryOccasions(e), config as Record<string, unknown>, "p/m-opus"), null);
  }
  const text = shadowInstruction("pre-pr", ["p/m-a", "p/m-b"], 600);
  assert.match(text, /optional for the verdict and never block: skip them when the budget is tight/);
  assert.deepEqual(text.split("\n").slice(1), ['subagent {agent: "reviewer", task: "[panel-shadow:p/m-a] [pre-pr]"}', 'subagent {agent: "reviewer", task: "[panel-shadow:p/m-b] [pre-pr]"}']);
});

test("shadow launch: marker parsed, clamped configured model, bound to the newest open panel of its gate, task replaced by the primary's", () => {
  assert.equal(parseShadowMarker("[Panel-Shadow:p/m-a:high] [pre-pr]"), "p/m-a:high");
  assert.equal(parseShadowMarker("review [pre-pr]"), null);
  assert.deepEqual(shadowLaunch({ agent: "reviewer", task: "items 1" }, [pending("r1")], shadowOpts()), { kind: "none" });
  const done = pending("r3", { launched: new Set(["p/m-a"]) });
  const d = shadowLaunch({ agent: "reviewer", task: "[panel-shadow:p/m-a] [pre-pr]" }, [pending("r1"), pending("r2"), done], shadowOpts());
  assert.equal(d.kind, "launch");
  if (d.kind !== "launch") return;
  assert.equal(d.pending.id, "r2");
  assert.equal(d.model, "p/m-a:medium"); // configured p/m-a:high under maxThinking medium
  assert.equal(d.task, "[panel-shadow:p/m-a] branch r2 [pre-pr]");
  assert.deepEqual(d.trace, { event: "panel", role: "reviewer", gate: "pre-pr", models: "p/m-a", primary: "p/m-haiku", decision: "launched" });
});

test("shadow launch refusals: each with its reason and a panel trace", () => {
  const t = "[panel-shadow:p/m-a] [pre-pr]";
  const cases: [Record<string, unknown>, PendingView[], Record<string, unknown>, string][] = [
    [{ agent: "reviewer", task: t }, [pending("r1")], { isChild: true }, "child"],
    [{ tasks: [{ agent: "reviewer", task: t }] }, [pending("r1")], {}, "not_single"],
    [{ action: "resume", agent: "reviewer", task: t }, [pending("r1")], {}, "not_single"],
    [{ agent: "builder", task: t }, [pending("r1")], {}, "not_reviewer"],
    [{ agent: "reviewer", task: t }, [pending("r1")], { config: { ladder: { reviewPanel: { shadows: [] } } } }, "panel_off"],
    [{ agent: "reviewer", task: "[panel-shadow:p/m-z] [pre-pr]" }, [pending("r1")], {}, "not_configured"],
    [{ agent: "reviewer", task: t }, [], {}, "no_pending"],
    [{ agent: "reviewer", task: t }, [pending("r1", { expected: ["p/m-b"] })], {}, "no_pending"],
    [{ agent: "reviewer", task: "[panel-shadow:p/m-a] items 1" }, [pending("r1")], {}, "occasion"],
    [{ agent: "reviewer", task: t }, [pending("r1", { launched: new Set(["p/m-a"]) })], {}, "duplicate"],
    [{ agent: "reviewer", task: "[panel-shadow:p/m-b] [pre-pr]" }, [pending("r1")], {}, "rank_policy"],
  ];
  for (const [input, pendings, over, reason] of cases) {
    const d = shadowLaunch(input, pendings, { ...shadowOpts(), ...over });
    assert.equal(d.kind, "refused", reason);
    if (d.kind !== "refused") continue;
    assert.equal(d.reason, reason);
    assert.ok(d.message.includes(`[panel_refused:${reason}]`), d.message);
    assert.deepEqual([d.trace.event, d.trace.decision, d.trace.reason], ["panel", "refused", reason]);
  }
});

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("pending panel: composes once when every expected shadow ended; a failed shadow is listed as not run", async () => {
  const sent: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const panels = new PendingPanels({ send: (t) => sent.push(t), trace: (r) => traces.push(r) });
  const f = (file: string, line: number) => ({ file, line, class: "logic", note: "n" });
  panels.open({ id: "r1", gate: "pre-pr", primary: "p/m-haiku", task: "t", expected: ["p/m-a", "p/m-b"], primaryFindings: Promise.resolve([f("a.ts", 1)]), visible: true, waitMs: 60_000 });
  assert.equal(panels.views().length, 1);
  panels.ended("r1", "p/m-a", Promise.resolve([f("b.ts", 9)]));
  await settle();
  assert.deepEqual(sent, []);
  panels.ended("r1", "p/m-b", Promise.resolve(null));
  await settle();
  assert.deepEqual(sent, [["pi-foreman review panel", "Review findings, primary (p/m-haiku):", "- a.ts:1 [logic] n", "Shadow findings (do not block):", "p/m-a:", "- b.ts:9 [logic] n", "Not run: p/m-b"].join("\n")]);
  assert.equal(panels.views().length, 0);
  panels.ended("r1", "p/m-b", Promise.resolve([f("c.ts", 3)])); // after compose: nothing more
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual(traces, []);
});

test("pending panel timeout: composes without the missing shadow, traced decision timeout; clear() stops the timer", async () => {
  const sent: string[] = [];
  const traces: Record<string, unknown>[] = [];
  const panels = new PendingPanels({ send: (t) => sent.push(t), trace: (r) => traces.push(r) });
  panels.open({ id: "r1", gate: "pre-pr", primary: "p/m-haiku", task: "t", expected: ["p/m-a"], primaryFindings: Promise.resolve([]), visible: true, waitMs: 5 });
  await settle();
  assert.deepEqual(traces, [{ event: "panel", role: "reviewer", gate: "pre-pr", models: "p/m-a", primary: "p/m-haiku", decision: "timeout" }]);
  assert.deepEqual(sent, [["pi-foreman review panel", "Shadow findings (do not block):", "Not run: p/m-a"].join("\n")]);
  assert.equal(panels.views().length, 0);
  panels.open({ id: "r2", gate: "pre-pr", primary: "p/m-haiku", task: "t", expected: ["p/m-a"], primaryFindings: Promise.resolve([]), visible: true, waitMs: 5 });
  panels.clear();
  await settle();
  assert.equal(sent.length, 1);
});

test("panel: extra text (failed PR checks) is appended to the composed block, and a failing extra adds nothing", async () => {
  const sent: string[] = [];
  const open = (extra: () => Promise<string>) => {
    const panels = new PendingPanels({ send: (t) => sent.push(t), trace: () => {}, extra });
    panels.open({ id: "r1", gate: "pre-pr", primary: "p/m-haiku", task: "t", expected: ["p/m-a"], primaryFindings: Promise.resolve([]), visible: true, waitMs: 5 });
  };
  open(async () => "PR checks: 1 failed.");
  await settle();
  assert.match(sent[0], /\nPR checks: 1 failed\.$/);
  open(async () => {
    throw new Error("x");
  });
  await settle();
  assert.doesNotMatch(sent[1], /PR checks/);
});
