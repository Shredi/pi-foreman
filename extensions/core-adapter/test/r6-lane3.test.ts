import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { costAt, loadPrices, priceRecord, tableRate } from "../cost.ts";
import { budgetCheck, failedItemsOf, prependReReview, reviewCapCheck, reviewRunsCap, budgetCap } from "../costguard.ts";
import { ChildRuns, UsageTail } from "../childwidget.ts";
import { footerText, zeroTotals, addMessage } from "../footer.ts";
import { LiveState } from "../livestate.ts";
import { aggregate, formatSummary, parseLines, pricedLine } from "../usage.ts";
import type { UsageLine } from "../usage.ts";
import { sanitizeTrace } from "../trace.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const prices = loadPrices(ROOT);
const rec = (role: string, launchId: string | null, model: string, t: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }, total = 0) =>
  ({ ts: "2026-10-12T00:00:00Z", workspace: "/w", foremanSession: "f", role, provider: "claude-bridge", model, launchId, kind: "first", stopReason: "stop", input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...t, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } }) as UsageLine;
const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 0.01;

// Fixture: three runs of different models, the bridge reported cost 0 for all of them.
const LINES: UsageLine[] = [
  rec("foreman", null, "claude-opus-5-5", { input: 1000, cacheRead: 200000, cacheWrite: 10000, output: 3000 }),
  rec("builder", "L1", "claude-sonnet-5-5", { input: 2000, cacheRead: 100000, cacheWrite: 20000, output: 8000 }),
  rec("builder", "L1", "claude-sonnet-5-5", { input: 500, cacheRead: 120000, cacheWrite: 0, output: 2000 }),
  rec("reviewer", "L2", "claude-opus-5-5", { input: 300, cacheRead: 50000, cacheWrite: 5000, output: 1500 }),
  rec("explorer", "L3", "claude-haiku-5-5", { input: 1000, cacheRead: 150000, cacheWrite: 0, output: 1000 }), // 151k prompt: long-context tier
  rec("explorer", "L3", "claude-haiku-5-5", { input: 1000, cacheRead: 10000, cacheWrite: 0, output: 1000 }), // base tier
  rec("autoreview", null, "claude-haiku-5-5", { input: 800, output: 100 }),
];
const expected = (l: UsageLine): number => {
  const r = tableRate(prices, l.model, l.input + l.cacheRead + l.cacheWrite)!;
  return (l.input * r.input! + l.cacheRead * r.cacheRead! + l.cacheWrite * r.cacheWrite! + l.output * r.output!) / 1e6;
};

test("3a: the price table lives in config/ and bench/ no longer carries it", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "config", "prices.json")));
  assert.equal(fs.existsSync(path.join(ROOT, "bench", "prices.json")), false);
  assert.ok(prices && prices.models["claude-haiku-5-5"]);
});

test("3a: a record without cost is priced from the table (5m cache write), marked estimated; a reported cost is kept", () => {
  const sonnet = rec("builder", "L", "claude-sonnet-5-5", { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 });
  const p = priceRecord(sonnet, prices);
  assert.equal(p.estimated, true);
  assert.ok(near(p.cost.total, 2.0 + 0.1 + 2.5 + 10.0), String(p.cost.total));
  const given = priceRecord({ ...sonnet, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42 } }, prices);
  assert.deepEqual([given.estimated, given.cost.total], [false, 0.42]);
  assert.equal(priceRecord(rec("x", null, "unknown-model", { input: 10 }), prices).cost.total, 0, "an unpriced model stays 0");
});

test("3a: registry rate first when non-zero, else the table; provider prefix and date suffix tolerated", () => {
  const r = rec("builder", "L", "claude-sonnet-5-5", { input: 1e6 });
  assert.equal(priceRecord(r, prices, { input: 7, output: 0 }).cost.total, 7);
  assert.equal(priceRecord(r, prices, { input: 0, output: 0 }).cost.total, 2, "a zero registry rate falls to the table");
  assert.equal(tableRate(prices, "anthropic/claude-sonnet-5-5-20261001", 0)?.input, 2);
  const line = pricedLine(r, prices, { input: 7, output: 1 });
  assert.equal(line.costEstimated, true);
  assert.equal(line.cost.total, 7);
});

test("3a: Haiku 5.5 long-context tier applies per request above 100k prompt tokens", () => {
  const base = tableRate(prices, "claude-haiku-5-5", 100000)!;
  const lc = tableRate(prices, "claude-haiku-5-5", 100001)!;
  assert.equal(lc.input, base.input! * 5);
  assert.equal(lc.output, base.output! * 5);
  assert.equal(costAt({ input: 1e6 }, lc).total, 0.5);
  assert.equal(tableRate(prices, "claude-sonnet-5-5", 900000)?.input, 2, "no tier for Sonnet 5.5");
});

test("3b: three runs: per-run cost, presence runs[].cost, status line and /foreman cost agree with the priced records", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "l3-"));
  const f = path.join(d, "u.jsonl");
  fs.writeFileSync(f, LINES.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const byRun = (id: string) => LINES.filter((l) => l.launchId === id).reduce((a, l) => a + expected(l), 0);
  const runsTotal = byRun("L1") + byRun("L2") + byRun("L3");
  const foremanTotal = expected(LINES[0]);
  const tail = new UsageTail(f, prices);
  tail.refresh();
  assert.ok(near(tail.by.get("L1")!.cost, byRun("L1")));
  assert.ok(near(tail.by.get("L3")!.cost, byRun("L3")), "the Haiku long-context request is priced at the higher tier");
  const runs = new ChildRuns(tail);
  for (const [i, id] of ["L1", "L2", "L3"].entries()) {
    runs.onLaunchCall(`c${i}`, { launchId: id, role: ["builder", "reviewer", "explorer"][i], rung: null, model: null });
    runs.onLaunched(`c${i}`, `run${i}`, [], 1000);
  }
  const views = runs.views();
  const summed = views.reduce((a, r) => a + r.cost, 0);
  assert.ok(near(summed, runsTotal), `${summed} vs ${runsTotal}`);
  // presence file
  const live = LiveState.start({ agentDir: d, sessionId: "s", cwd: d, mode: "rpc", env: {} }, () => runs.views(), () => ({ tokensIn: 0, tokensOut: 0, cost: foremanTotal }));
  assert.ok(live);
  const snap = live!.snapshot();
  live!.stop();
  assert.ok(near(snap.runs.reduce((a, r) => a + r.cost, 0), runsTotal), "presence runs[].cost sums to the priced records");
  // status line
  const t = zeroTotals();
  addMessage(t, { provider: "claude-bridge", model: "claude-opus-5-5", usage: { input: 1000, cacheRead: 200000, cacheWrite: 10000, output: 3000, cost: { total: 0 } } }, undefined, prices);
  assert.ok(near(t.cost, foremanTotal));
  const text = footerText(t, 3, null, summed);
  const shown = Number(/all \$(\d+\.\d+) est/.exec(text)?.[1]);
  assert.ok(Math.abs(shown - (foremanTotal + runsTotal)) <= (foremanTotal + runsTotal) * 0.01 + 0.005, text);
  // /foreman cost
  const sum = aggregate(parseLines(fs.readFileSync(f, "utf8")), prices);
  const all = LINES.reduce((a, l) => a + expected(l), 0);
  assert.ok(near(sum.total.cost.total, all));
  const wholeRuns = sum.total.cost.total - foremanTotal - expected(LINES[6]);
  assert.ok(near(wholeRuns, runsTotal));
});

test("3d: /foreman cost shows every role with its priced total, estimates marked", () => {
  const out = formatSummary(aggregate(LINES, prices), "T");
  for (const role of ["foreman", "builder", "reviewer", "explorer", "autoreview"]) {
    const row = out.split("\n").find((l) => l.startsWith(role));
    assert.ok(row, role);
    assert.match(row!, /[1-9]\.\d{3}\d~$|0\.\d*[1-9]\d*~$/, `${role} has a priced total: ${row}`);
  }
  assert.match(out, /~ = estimated/);
  const builder = aggregate(LINES, prices).byRole.get("builder")!;
  assert.ok(near(builder.cost.total, expected(LINES[1]) + expected(LINES[2])));
  assert.equal(aggregate(LINES).total.cost.total, 0, "without a table the cost stays as reported");
});

test("3c: budget guard fires on the summed estimate, not the foreman's own", () => {
  assert.equal(budgetCheck(0.4, 0.3, null, false), null, "unset = off");
  assert.equal(budgetCheck(0.4, 0.3, 2, false), null);
  const over = budgetCheck(0.9, 1.2, 2, false);
  assert.equal(over?.kind, "refuse");
  assert.match(over!.text, /budget_exceeded/);
  assert.match(over!.text, /\$2\.10/);
  assert.match(over!.text, /\$2\.00/);
  assert.equal(budgetCheck(0.9, 0, 2, false)?.kind, undefined, "the foreman alone is under the cap");
  const warn = budgetCheck(0.8, 0.9, 2, false);
  assert.equal(warn?.kind, "warn");
  assert.equal(budgetCheck(0.8, 0.9, 2, true), null, "the warning comes once");
  assert.equal(budgetCap(0), null);
  assert.equal(budgetCap(2.5), 2.5);
});

test("3e: review cap per prompt names the count; reviewRuns defaults to 3", () => {
  assert.equal(reviewRunsCap(undefined), 3);
  assert.equal(reviewRunsCap(5), 5);
  assert.equal(reviewCapCheck(2, 1, 3), null);
  const r = reviewCapCheck(3, 1, 3);
  assert.equal(r?.reason, "review_cap");
  assert.match(r!.text, /3 review run\(s\)/);
  assert.equal(reviewCapCheck(3, 0, 3), null, "a launch without a review is no concern of the cap");
});

test("3e: a re-review after FAIL gets [re-review items: N, M] from the failed items of the last FAIL", () => {
  const fail = "1. PASS ok\n2. FAIL no test\n3. PASS\n4. FAIL wrong\nverdict: FAIL";
  assert.deepEqual(failedItemsOf(fail), ["2", "4"]);
  assert.deepEqual(failedItemsOf("1. PASS\nverdict: PASS"), []);
  const task = prependReReview("Review the diff.", failedItemsOf(fail));
  assert.ok(task.startsWith("[re-review items: 2, 4]\n"));
  assert.match(task, /must list each of them/);
  assert.ok(task.endsWith("Review the diff."));
  assert.equal(prependReReview(task, ["9"]), task, "idempotent");
  assert.equal(prependReReview("t", []), "t");
});

test("3h: the trace keeps reason, role and a command up to 200 chars", () => {
  const long = "x".repeat(300);
  assert.equal("command" in sanitizeTrace({ event: "recheck_budget", action: "warn", command: "x" }), false, "only a deny keeps its command");
  const r = sanitizeTrace({ event: "recheck_budget", action: "deny", reason: "r", role: "foreman", command: long });
  assert.equal(r.command?.toString().length, 200);
  assert.equal(r.role, "foreman");
  assert.equal(sanitizeTrace({ event: "e", reason: long }).reason?.toString().length, 120);
});

test("3f/3g/3h: index wiring: role_launched at launch, role_result at run end, review_done at run end, deny fields", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf8");
  assert.match(src, /event: "role_launched", role/);
  assert.match(src, /event: "role_result", role, runId/);
  assert.equal(src.includes('event: "review_done", role, decision: verdict'), false, "no review_done at the completion notice any more");
  assert.match(src, /event: "review_done", role: d\.role, decision: d\.decision, runId/);
  assert.match(src, /\.\.\.denyFields\(d\.reason, toolName, input, role\)/);
  assert.match(src, /denyFields\(d\.reason, toolName, input, "foreman"\)/);
  assert.match(src, /reason: bd\.reason/);
});
