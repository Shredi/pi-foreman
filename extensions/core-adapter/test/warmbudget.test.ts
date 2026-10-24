// Warm budget math (warmbudget.ts) and the rate source order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WarmBudget, warmRates } from "../warmbudget.ts";
import type { PriceTable } from "../cost.ts";

const TABLE: PriceTable = { models: { "claude-x": { input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 } } };
const REG = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const near = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("table rates first: 5m write rate for a short TTL, 1h for TTL >= 3600", () => {
  const short = warmRates({ table: TABLE, registry: REG, model: "claude-bridge/claude-x", promptTokens: 1000, ttlSeconds: 300 });
  const long = warmRates({ table: TABLE, registry: REG, model: "claude-x", promptTokens: 1000, ttlSeconds: 3600 });
  assert.equal(short?.cacheWrite, 6.25);
  assert.equal(long?.cacheWrite, 10);
});

test("zero-cost registry model with list prices in the table is priced from the table; registry used when the table lacks the model", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(warmRates({ table: TABLE, registry: zero, model: "claude-x", promptTokens: 1, ttlSeconds: 300 })?.cacheWrite, 6.25);
  assert.deepEqual(warmRates({ table: TABLE, registry: REG, model: "other", promptTokens: 1, ttlSeconds: 300 }), REG);
  assert.equal(warmRates({ table: TABLE, registry: zero, model: "other", promptTokens: 1, ttlSeconds: 300 }), null);
  assert.equal(warmRates({ table: null, registry: undefined, model: "claude-x", promptTokens: 1, ttlSeconds: 300 }), null);
});

test("registry rate is one cacheWrite for any TTL", () => {
  assert.equal(warmRates({ table: null, registry: REG, model: "m", promptTokens: 1, ttlSeconds: 3600 })?.cacheWrite, 3.75);
});

test("check: cold = P x cacheWrite; first tick = P x cacheRead + 1 output token; refuses once spent + next exceeds the share", () => {
  const r = warmRates({ table: TABLE, registry: null, model: "claude-x", promptTokens: 100_000, ttlSeconds: 300 })!;
  const b = new WarmBudget();
  b.reset(100_000);
  const c0 = b.check(r, 0.5)!;
  near(c0.cold, 0.625);
  near(c0.next, 100_000 * 0.5e-6 + 25e-6);
  assert.equal(c0.ok, true);
  // each completed warm is repriced at its real size: here 0.2 USD per warm, so a third one (0.6 > 0.3125) is refused
  b.note({ input: 0, output: 0, cacheRead: 400_000, cacheWrite: 0 });
  const c1 = b.check(r, 0.5)!;
  near(c1.spent, 0.2);
  near(c1.next, 0.2, );
  assert.equal(c1.ok, false);
});

test("spent is repriced with the same rates: a 1h rate changes cold but not the read-only spent", () => {
  const r5 = warmRates({ table: TABLE, registry: null, model: "claude-x", promptTokens: 1000, ttlSeconds: 300 })!;
  const r1 = warmRates({ table: TABLE, registry: null, model: "claude-x", promptTokens: 1000, ttlSeconds: 3600 })!;
  const b = new WarmBudget();
  b.reset(1_000_000);
  b.note({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 });
  near(b.check(r5, 1)!.cold, 6.25);
  near(b.check(r1, 1)!.cold, 10);
  near(b.check(r5, 1)!.spent, b.check(r1, 1)!.spent);
});

test("reset starts a new idle: spent cleared; without a prompt size the budget is unavailable", () => {
  const r = warmRates({ table: TABLE, registry: null, model: "claude-x", promptTokens: 1000, ttlSeconds: 300 })!;
  const b = new WarmBudget();
  assert.equal(b.check(r, 0.5), null, "no request yet");
  b.reset(1000);
  b.note({ input: 0, output: 0, cacheRead: 1000, cacheWrite: 0 });
  assert.ok(b.check(r, 0.5)!.spent > 0);
  b.reset(2000);
  assert.equal(b.check(r, 0.5)!.spent, 0);
  b.reset(0);
  assert.equal(b.check(r, 0.5), null, "compaction or model change");
  assert.equal(b.check(null, 0.5), null, "no rates");
});
