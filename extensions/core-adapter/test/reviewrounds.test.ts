// Review rounds per change (reviewrounds.ts): the round rule, the PR join and the result lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionFileOf } from "../findings.ts";
import { closeLines, parseSince, readStore, roundsLine, roundsOf } from "../reviewrounds.ts";
import type { StoreRow } from "../reviewrounds.ts";

const WS = "proj-1a2b3c4d";
let seq = 0;
const at = (min: number): string => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();

function rv(run: string, over: Partial<Record<string, unknown>> = {}): StoreRow {
  return { type: "review", session: "s1", gate: "item", primary: true, runId: run, verdict: "PASS", workspace: WS, branch: "feat", ts: at(seq), seq: seq++, ...over };
}
function pr(number: number, over: Partial<Record<string, unknown>> = {}): StoreRow {
  return { type: "pr", session: "s1", workspace: WS, branch: "feat", number, ts: at(seq), seq: seq++, ...over };
}
const one = (rows: StoreRow[], filter = {}) => {
  const out = roundsOf(rows, filter);
  assert.equal(out.length, 1, JSON.stringify(out));
  return out[0];
};

test("counts fail and pass rounds, one per run", () => {
  const c = one([rv("r1", { verdict: "FAIL" }), rv("r2"), rv("r3", { verdict: "FAIL", gate: "pre-pr" }), rv("r4", { gate: "pre-pr" })]);
  assert.deepEqual([c.rounds, c.fail, c.pass, c.highStakes, c.planReviews, c.pr], [4, 2, 2, 0, 0, null]);
  assert.equal(c.line, "Review rounds: 4 (2 fail, 2 pass)");
});

test("leaves out second opinions, panel shadow rows and gates that are no round", () => {
  const c = one([rv("r1"), rv("r2", { gate: "second-opinion" }), rv("r3", { primary: false }), rv("r4", { primary: false, verdict: "FAIL" }), rv("r5", { gate: "other" })]);
  assert.deepEqual([c.rounds, c.fail, c.pass], [1, 0, 1]);
});

test("several primary rows of one run are one round, a fail when one of them fails", () => {
  const c = one([rv("r1", { verdict: "PASS" }), rv("r1", { verdict: "FAIL" }), rv("r1", { verdict: "PASS" }), rv("r2"), rv("r2")]);
  assert.deepEqual([c.rounds, c.fail, c.pass], [2, 1, 1]);
});

test("names high-stakes rounds and counts them as rounds", () => {
  const c = one([rv("r1"), rv("r2", { gate: "high-stakes", verdict: "FAIL" }), rv("r2", { gate: "pre-pr" })]);
  assert.deepEqual([c.rounds, c.fail, c.highStakes, c.highStakesRuns], [2, 1, 1, ["r2"]]);
  assert.equal(c.line, "Review rounds: 2 (1 fail, 1 pass; 1 high-stakes)");
});

test("plan reviews are counted apart by the same run rule", () => {
  const c = one([rv("r1"), rv("p1", { gate: "plan-review", verdict: "FAIL" }), rv("p1", { gate: "plan-review" }), rv("p2", { gate: "plan-review" }), rv("p3", { gate: "plan-review", primary: false })]);
  assert.deepEqual([c.rounds, c.planReviews], [1, 2]);
  assert.equal(c.line, "Review rounds: 1 (0 fail, 1 pass), plan reviews 2");
  assert.deepEqual(roundsOf([rv("p1", { gate: "plan-review" })]), [], "plan reviews alone are no entry");
});

test("the PR number joins from the pr row of the same workspace and branch", () => {
  const rows = [rv("r1"), pr(301), rv("r2"), pr(55, { branch: "other" }), pr(56, { workspace: "x-00000000" })];
  const c = one(rows);
  assert.equal(c.pr, 301);
  assert.equal(c.line, "Review rounds: 2 (0 fail, 2 pass), PR #301");
});

test("a pr row without a branch joins no change", () => {
  const c = one([rv("r1"), pr(9, { branch: null })]);
  assert.equal(c.pr, null);
  assert.ok(!/PR/.test(c.line));
});

test("a branch with two PRs: rounds before the later row belong to the earlier PR", () => {
  const rows = [rv("r1"), pr(10), rv("r2", { verdict: "FAIL" }), rv("r3"), pr(11), rv("r4"), rv("r5")];
  const out = roundsOf(rows);
  assert.deepEqual(out.map((c) => [c.pr, c.rounds, c.fail]), [[10, 3, 1], [11, 2, 0]]);
  assert.deepEqual(roundsOf(rows, { pr: 11 }).map((c) => c.rounds), [2]);
  assert.deepEqual(roundsOf(rows, { pr: 12 }), []);
  // the same number twice is one PR
  assert.deepEqual(roundsOf([rv("r1"), pr(10), pr(10), rv("r2")]).map((c) => [c.pr, c.rounds]), [[10, 2]]);
});

test("a store with old rows (no workspace or branch) counts them nowhere; an empty store has no entry", () => {
  const rows = [rv("r1", { workspace: undefined, branch: undefined }), rv("r2", { branch: null }), rv("r3", { workspace: null }), rv("r4")];
  assert.deepEqual(roundsOf(rows).map((c) => c.rounds), [1]);
  assert.deepEqual(roundsOf([]), []);
  assert.deepEqual(roundsOf([{ type: "finding", seq: 0 }, { type: "dismiss", seq: 1 }]), []);
});

test("changes are told apart by workspace and branch; filters narrow them", () => {
  const rows = [rv("r1"), rv("r2", { branch: "other" }), rv("r3", { workspace: "x-00000000" })];
  assert.equal(roundsOf(rows).length, 3);
  assert.deepEqual(roundsOf(rows, { workspace: WS }).map((c) => c.branch), ["feat", "other"]);
  assert.deepEqual(roundsOf(rows, { workspace: WS, branch: "other" }).map((c) => c.rounds), [1]);
  assert.deepEqual(roundsOf(rows, { workspace: "nope" }), []);
  const dated = [rv("r1", { ts: "2026-01-01T00:00:00Z" }), rv("r2", { ts: "2026-03-01T00:00:00Z" })];
  assert.equal(one(dated, { since: Date.parse("2026-02-01T00:00:00Z") }).rounds, 1);
});

test("roundsLine omits the high-stakes, plan-review and PR parts when they are zero or unknown", () => {
  assert.equal(roundsLine({ rounds: 4, fail: 2, pass: 2, highStakes: 1, planReviews: 2, pr: 301 }), "Review rounds: 4 (2 fail, 2 pass; 1 high-stakes), plan reviews 2, PR #301");
  assert.equal(roundsLine({ rounds: 1, fail: 0, pass: 1, highStakes: 0, planReviews: 0, pr: null }), "Review rounds: 1 (0 fail, 1 pass)");
});

test("parseSince: 7d, 12h, 2w and ISO", () => {
  assert.equal(parseSince("7d", 1_000_000_000), 1_000_000_000 - 7 * 86_400_000);
  assert.equal(parseSince("12h", 1_000_000_000), 1_000_000_000 - 12 * 3_600_000);
  assert.equal(parseSince("2w", 1_000_000_000), 1_000_000_000 - 14 * 86_400_000);
  assert.equal(parseSince("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(parseSince("soon"), null);
});

function store(files: Record<string, StoreRow[] | string>): string {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "rounds-"));
  for (const [session, content] of Object.entries(files)) {
    const file = sessionFileOf(agent, session);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : content.map(({ seq: _s, ...r }) => JSON.stringify(r)).join("\n") + "\n");
  }
  return agent;
}

test("readStore reads every session file, skips torn lines and an unreadable directory", () => {
  const agent = store({ s1: [rv("r1"), pr(3)], s2: `${JSON.stringify({ type: "review", runId: "x" })}\n{torn\n\n` });
  try {
    assert.deepEqual(readStore(agent).map((r) => r.type), ["review", "pr", "review"]);
    assert.deepEqual(readStore(path.join(agent, "missing")), []);
  } finally {
    fs.rmSync(agent, { recursive: true, force: true });
  }
});

test("closeLines: one line per branch the session reviewed on, counting every session's rounds of that change", () => {
  const agent = store({
    s1: [rv("r1", { verdict: "FAIL" }), rv("r2", { branch: "other" }), pr(5)],
    s2: [rv("r3", { session: "s2" }), rv("r4", { session: "s2", branch: "unrelated" })],
  });
  try {
    assert.deepEqual(closeLines(agent, "s1"), ["feat: Review rounds: 2 (1 fail, 1 pass), PR #5", "other: Review rounds: 1 (0 fail, 1 pass)"]);
    assert.deepEqual(closeLines(agent, "s2"), ["feat: Review rounds: 2 (1 fail, 1 pass), PR #5", "unrelated: Review rounds: 1 (0 fail, 1 pass)"]);
  } finally {
    fs.rmSync(agent, { recursive: true, force: true });
  }
});

test("closeLines: a single branch gives the bare line; no counted review, a missing store give nothing", () => {
  const agent = store({ s1: [rv("r1")], s2: [rv("p1", { gate: "plan-review", session: "s2", branch: "plans" }), rv("r9", { gate: "second-opinion", session: "s2", branch: "plans" })], s3: [rv("r1", { session: "s3", primary: false })] });
  try {
    assert.deepEqual(closeLines(agent, "s1"), ["Review rounds: 1 (0 fail, 1 pass)"]);
    assert.deepEqual(closeLines(agent, "s2"), []);
    assert.deepEqual(closeLines(agent, "s3"), []);
    assert.deepEqual(closeLines(agent, "nobody"), []);
    assert.deepEqual(closeLines(path.join(agent, "missing"), "s1"), []);
  } finally {
    fs.rmSync(agent, { recursive: true, force: true });
  }
});
