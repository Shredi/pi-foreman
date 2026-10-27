// r71: the claude-bridge TTL derived from bridge.promptCacheTtl and the built-in github-copilot rows, driven by the
// fixture tests/fixtures/bridge_ttl_cases.json that tests/test_bridge_ttl.py reads too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUILTIN_BY_MODEL, BUILTIN_CACHE, resolveCachePolicy, resolveWarmPolicy } from "../cachepolicy.ts";
import { bridgeTtlSetting, derivedBridgeTtlS } from "../bridgettl.ts";
import { cacheBar, formatLeft } from "../cachebar.ts";

interface Case {
  name: string;
  provider: string;
  model: string | null;
  isChild: boolean;
  env: Record<string, string>;
  cfg: { bridge?: { promptCacheTtl?: unknown } };
  expect: { ttlSeconds: number | null; billing: string | null; skip: string | null; selfWarm: boolean };
}
const CASES = (JSON.parse(readFileSync(new URL("../../../tests/fixtures/bridge_ttl_cases.json", import.meta.url), "utf8")) as { cases: Case[] }).cases;

test("shared cases", () => {
  assert.ok(CASES.length > 20);
  for (const c of CASES) {
    const bridgeTtlS = derivedBridgeTtlS(bridgeTtlSetting(c.cfg.bridge?.promptCacheTtl), c.isChild, c.env);
    const p = resolveWarmPolicy(c.cfg, c.provider, c.model, bridgeTtlS);
    assert.equal(p.skip ?? null, c.expect.skip, `${c.name}: skip`);
    assert.equal(p.ttlSeconds, c.expect.ttlSeconds, `${c.name}: ttlSeconds`);
    assert.equal(p.billing, c.expect.billing, `${c.name}: billing`);
    assert.equal(!!p.selfWarm, c.expect.selfWarm, `${c.name}: selfWarm`);
  }
});

test("a call without the bridge TTL behaves as before", () => {
  const p = resolveCachePolicy({}, "claude-bridge");
  assert.equal(p.ttlSeconds, 300);
  assert.equal(p.active, true);
  assert.equal(resolveCachePolicy({}, "claude-bridge", "claude-opus-5-5", null).ttlSeconds, 300);
});

test("the bridge TTL does not touch other providers", () => {
  assert.equal(resolveCachePolicy({}, "github-copilot", "gpt-5", 3600).ttlSeconds, 1800);
  assert.equal(resolveCachePolicy({ providers: { x: { cache: { billing: "token" } } } }, "x", "m", 3600).ttlSeconds, null);
});

test("BUILTIN_CACHE keeps its literal; copilot rows live in BUILTIN_BY_MODEL", () => {
  assert.deepEqual(BUILTIN_CACHE, { "claude-bridge": { ttlSeconds: 300, billing: "token" }, "github-copilot": { ttlSeconds: null, billing: "request" } });
  assert.deepEqual(BUILTIN_BY_MODEL["github-copilot"].map((r) => [r.match, r.ttlSeconds]), [["claude-*", 300], ["gpt-*", 1800], ["o1*", 1800], ["o3*", 1800], ["o4*", 1800]]);
});

test("footer countdown starts at 57:00 with the derived 3600", () => {
  const ttl = resolveWarmPolicy({}, "claude-bridge", "claude-opus-5-5", derivedBridgeTtlS(bridgeTtlSetting(undefined), false, {})).ttlSeconds;
  assert.equal(ttl, 3600);
  const now = 1_000_000_000;
  const bar = cacheBar({ now, lastTouch: now, ttlSeconds: ttl as number, nextWarmAt: null, windowEndAt: now, tickMs: 3_240_000, budget: null, away: null });
  assert.equal(formatLeft(bar.leftMs as number), "57:00");
});
