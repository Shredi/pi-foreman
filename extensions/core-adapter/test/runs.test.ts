import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildRuns, UsageTail, ageText, rungOf } from "../runs.ts";

const line = (launchId: string, input: number, output: number, total: number) => JSON.stringify({ role: "builder", launchId, input, cacheRead: 0, cacheWrite: 0, output, cost: { total } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));

test("usage tail sums per launch id incrementally and waits for a full line", () => {
  const d = tmp();
  const f = path.join(d, "u.jsonl");
  fs.writeFileSync(f, line("a", 100, 10, 0.5) + "\n" + line("a", 50, 5, 0.25) + "\n" + line("b", 1, 1, 1).slice(0, 20));
  const t = new UsageTail(f);
  t.refresh();
  assert.deepEqual(t.by.get("a"), { input: 150, output: 15, cost: 0.75 });
  assert.equal(t.by.has("b"), false);
  fs.appendFileSync(f, line("b", 1, 1, 1).slice(20) + "\n");
  t.refresh();
  assert.equal(t.by.get("b")?.cost, 1);
});

test("state: working -> done; a run never reads an ask state from permission events", () => {
  const d = tmp();
  const f = path.join(d, "u.jsonl");
  fs.writeFileSync(f, line("L1", 10, 2, 0.1) + "\n");
  const c = new ChildRuns(new UsageTail(f));
  c.onLaunchCall("call1", { launchId: "L1", role: "builder", rung: "model", model: "anthropic/claude-sonnet-5-5" });
  c.onLaunched("call1", "run1", [], 1000);
  assert.equal(c.views()[0].model, "anthropic/claude-sonnet-5-5");
  assert.equal(c.views()[0].state, "working");
  assert.equal(c.views()[0].tokensIn, 10);
  c.onRunEnd("run1", 2000);
  assert.equal(c.views()[0].state, "done");
  assert.deepEqual(c.info("run1"), { ms: 1000, cost: 0.1 });
  assert.equal(c.info("nope"), null);
});

test("a foreground run that ends before its launch result is done at once", () => {
  const c = new ChildRuns();
  c.onRunEnd("run9", 5);
  c.onLaunched("c", "run9", ["explorer"], 1);
  assert.deepEqual(c.views().map((v) => [v.role, v.state]), [["explorer", "done"]]);
});

test("rungOf: bottom is model, a role with a strong model is strong, else null", () => {
  assert.equal(rungOf({}, "builder", true), "model");
  assert.equal(rungOf({ builder: { strong: { model: "m" } } }, "builder", false), "strong");
  assert.equal(rungOf({ builder: {} }, "builder", false), null);
  assert.equal(rungOf(undefined, "builder", false), null);
});

test("ageText: seconds, minutes, hours, days", () => {
  assert.equal(ageText(5_000), "5s");
  assert.equal(ageText(90_000), "1m");
  assert.equal(ageText(7_200_000), "2h");
  assert.equal(ageText(3 * 86_400_000), "3d");
});
