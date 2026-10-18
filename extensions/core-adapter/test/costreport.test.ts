import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { costReport } from "../costreport.ts";
import { parseLines } from "../usage.ts";
import { loadPrices } from "../cost.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

test("cost_json_usage_fixture_priced_to_cent", () => {
  const lines = parseLines(fs.readFileSync(path.join(here, "fixtures", "cost-usage.jsonl"), "utf8"));
  assert.equal(lines.length, 4);
  const r = costReport(lines, loadPrices(path.join(here, "..", "..", "..")), "session fx");
  const usd = (rows: { role?: string; model?: string; usd: number }[]) => Object.fromEntries(rows.map((x) => [x.role ?? x.model, x.usd]));
  // builder 0.0123 recorded + 0.54 repriced = 0.5523; reviewer 0.06 (long tier); autoreview 0.002; total 0.6143
  assert.deepEqual(usd(r.byRole), { autoreview: 0, builder: 0.55, reviewer: 0.06 });
  assert.deepEqual(usd(r.byModel), { "anthropic/claude-haiku-5-5": 0.06, "anthropic/claude-sonnet-5-5": 0.55 });
  assert.equal(r.byRoleModel.length, 3);
  assert.equal(r.total.usd, 0.61);
  assert.equal(r.total.calls, 4);
  assert.equal(r.total.recorded, 1);
  assert.equal(r.total.repriced, 3);
  assert.equal(r.total.longContext, 1);
  assert.equal(r.total.estimatedTokens, 1);
  assert.equal(r.byRole.find((x) => x.role === "reviewer")!.longContext, 1);
  assert.equal(r.byRole.find((x) => x.role === "builder")!.cacheRead, 403000);
  assert.equal(r.scope, "session fx");
});
