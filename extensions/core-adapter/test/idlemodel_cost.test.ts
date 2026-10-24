// /foreman cost keep-alive line: the (pi N, foreman M) split appears only when the log carries a source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, formatSummary, type UsageLine } from "../usage.ts";

const ka = (source?: "pi" | "foreman"): UsageLine =>
  ({ ts: "2026-01-01T00:00:00.000Z", workspace: "w", foremanSession: "s", role: "foreman", launchId: null, provider: "p", model: "m", kind: "keepalive", stopReason: null, input: 0, cacheRead: 100, cacheWrite: 0, output: 1, cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 }, ...(source ? { source } : {}) }) as unknown as UsageLine;

test("keep-alive line counts calls by source", () => {
  const text = formatSummary(aggregate([ka("pi"), ka("pi"), ka("foreman")]), "T");
  assert.match(text, /^keep-alive: 3 call\(s\), \$[0-9.]+ \(pi 2, foreman 1\)$/m);
});

test("a log without pi-foreman sends keeps the old line", () => {
  const text = formatSummary(aggregate([ka(), ka("pi")]), "T");
  assert.match(text, /^keep-alive: 2 call\(s\), \$[0-9.]+$/m);
});
