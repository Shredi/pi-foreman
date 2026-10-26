// The live gate eval with an injected fake model: statistics, answers-file shape and verdict parsing. No real model is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { liveEval, percentile } from "../gateevallive.ts";
import type { EvalCase } from "../gateevallive.ts";
import { evalMain } from "../../../scripts/foreman_perms.mjs";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fixture = path.join(pkgRoot, "tests", "fixtures", "gate-eval.jsonl");
const cases: EvalCase[] = fs.readFileSync(fixture, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

/** A registry whose model answers every call with `reply` and reports fixed usage. */
function fake(reply: string, calls: { n: number } = { n: 0 }) {
  return {
    find: (p: string, m: string) => (p === "fake" && m === "m" ? { id: m } : undefined),
    hasConfiguredAuth: () => true,
    complete: async () => {
      calls.n++;
      return { content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 100, output: 7 } };
    },
  } as never;
}
const deny = JSON.stringify({ verdict: "deny", entry: "no-matching-entry", reason: "x" });

test("live allows against deny or ask expectations are listed as false allows; the summary prints the counts", async () => {
  const allow = JSON.stringify({ verdict: "allow", entry: "read-only-inspection", reason: "x" });
  const { answers, stats } = await liveEval(cases, fake(allow), "fake/m", pkgRoot);
  const expected = (src: string): string[] => cases.filter((c) => c.source === src && c.expect !== "allow" && answers[c.id]?.verdict === "allow").map((c) => c.id);
  assert.ok(stats.falseAllows.import.length > 0);
  assert.deepEqual(stats.falseAllows.import, expected("import"));
  assert.deepEqual(stats.falseAllows.log, expected("log"));
  const { stats: none } = await liveEval(cases, fake(deny), "fake/m", pkgRoot);
  assert.deepEqual(none.falseAllows, { import: [], log: [] });
  const origErr = console.error;
  const msgs: string[] = [];
  console.error = (s: string) => void msgs.push(String(s));
  try {
    assert.equal(await evalMain(["--model", "fake/m"], { registry: fake(allow) }), 0);
  } finally {
    console.error = origErr;
  }
  assert.match(msgs.at(-1) as string, new RegExp(`false-allows\\(import\\)=${stats.falseAllows.import.length} false-allows\\(log\\)=${stats.falseAllows.log.length}`));
});

test("placeholders reach the model as concrete paths; $UNSET stays literal", async () => {
  const prompts: string[] = [];
  const reg = {
    find: () => ({}),
    complete: async (_m: unknown, ctx: { messages: { content: unknown }[] }) => {
      prompts.push(JSON.stringify(ctx));
      return { content: [{ type: "text", text: deny }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  } as never;
  await liveEval(cases, reg, "fake/m", pkgRoot);
  assert.ok(prompts.length > 5);
  for (const p of prompts) {
    assert.doesNotMatch(p, /\$(WT|SCR|OTHER|AGENT|HOME|PARENT|TMP|INSTALL)\b/);
    assert.doesNotMatch(p, /pf41\/(home|other)/);
  }
  assert.ok(prompts.some((p) => /other-repo/.test(p)));
  assert.ok(prompts.some((p) => /\$UNSET/.test(p)));
});

test("percentile is nearest rank", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([40, 10, 30, 20], 95), 40);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);
});

test("a valid reply is recorded per case; tokens, calls and percentiles add up", async () => {
  const calls = { n: 0 };
  const { answers, stats } = await liveEval(cases, fake(deny, calls), "fake/m", pkgRoot);
  const ids = Object.keys(answers);
  assert.ok(ids.length > 5);
  for (const id of ids) assert.deepEqual(answers[id], { verdict: "deny", entry: "no-matching-entry" });
  assert.equal(stats.modelCalls, calls.n);
  assert.equal(stats.modelCalls, ids.length);
  assert.equal(stats.inputTokens, 100 * calls.n);
  assert.equal(stats.outputTokens, 7 * calls.n);
  assert.equal(stats.reviewCases, stats.modelCalls + stats.cacheHits + stats.unreachable);
  assert.ok(stats.latencyP95Ms >= stats.latencyP50Ms);
  assert.equal(stats.invalid, 0);
});

test("an invalid reply (wrong-section entry, not JSON) is recorded as invalid and counted", async () => {
  const wrong = JSON.stringify({ verdict: "deny", entry: "read-only-inspection", reason: "x" });
  for (const reply of [wrong, "not json"]) {
    const { answers, stats } = await liveEval(cases, fake(reply), "fake/m", pkgRoot);
    assert.ok(stats.invalid > 0);
    assert.equal(stats.invalid, Object.keys(answers).length);
    for (const a of Object.values(answers)) assert.deepEqual(a, { verdict: "invalid", entry: "" });
  }
});

test("a throwing model counts as unreachable and leaves no answer", async () => {
  const reg = { find: () => ({}), complete: async () => { throw new Error("boom"); } } as never;
  const { answers, stats } = await liveEval(cases, reg, "fake/m", pkgRoot);
  assert.deepEqual(answers, {});
  assert.ok(stats.unreachable > 0);
});

test("evalMain writes the answers file, rejects bad arguments and unknown models", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-live-"));
  const origErr = console.error;
  const msgs: string[] = [];
  console.error = (s: string) => void msgs.push(String(s));
  try {
    const out = path.join(dir, "answers.json");
    assert.equal(await evalMain(["--model", "fake/m", "--out", out], { registry: fake(deny) }), 0);
    const written = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.ok(Object.keys(written).length > 5);
    assert.match(msgs.at(-1) as string, /^eval: review-cases=\d+ model-calls=\d+ .*latency-p50=\d+ms latency-p95=\d+ms tokens-in=\d+ tokens-out=\d+/);
    assert.equal(await evalMain([], { registry: fake(deny) }), 2);
    assert.equal(await evalMain(["--model", "nomodel"], { registry: fake(deny) }), 2);
    assert.equal(await evalMain(["--model", "fake/other"], { registry: fake(deny) }), 1);
  } finally {
    console.error = origErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
