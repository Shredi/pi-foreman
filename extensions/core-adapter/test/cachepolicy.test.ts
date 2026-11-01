import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUILTIN_CACHE, PI_IDLE_CAP_MINUTES, SELF_WARM_MIN_TTL_SECONDS, resolveCachePolicy, resolveWarmPolicy } from "../cachepolicy.ts";

const withCache = (provider: string, cache: unknown) => ({ providers: { [provider]: { cache } } });

test("bridge defaults", () => {
  const p = resolveCachePolicy({}, "claude-bridge");
  assert.deepEqual(p, {
    active: true, ttlSeconds: 300, billing: "token", intervalSeconds: 270,
    windowMinutes: 45, effectiveWindowMinutes: 30, warmCompact: true,
  });
  assert.equal(PI_IDLE_CAP_MINUTES, 30);
});

test("copilot is request-billed", () => {
  const p = resolveCachePolicy({}, "github-copilot");
  assert.equal(p.active, false);
  assert.equal(p.skip, "billing_request");
});

test("unknown provider, missing provider and junk config give no_entry", () => {
  assert.equal(resolveCachePolicy({}, "other").skip, "no_entry");
  assert.equal(resolveCachePolicy(null, undefined).skip, "no_entry");
  assert.equal(resolveCachePolicy({ providers: { other: { cache: 5 } } }, "other").skip, "no_entry");
});

test("long ttl, unknown ttl and disabled", () => {
  assert.equal(resolveCachePolicy(withCache("x", { ttlSeconds: 3600, billing: "token" }), "x").skip, "ttl_long");
  assert.equal(resolveCachePolicy(withCache("x", { billing: "token" }), "x").skip, "ttl_unknown");
  assert.equal(resolveCachePolicy(withCache("x", { ttlSeconds: null, billing: "token" }), "x").skip, "ttl_unknown");
  const off = resolveCachePolicy(withCache("claude-bridge", { keepalive: { enabled: false } }), "claude-bridge");
  assert.deepEqual([off.active, off.skip], [false, "disabled"]);
});

test("interval override and minimum 30", () => {
  assert.equal(resolveCachePolicy(withCache("claude-bridge", { keepalive: { intervalSeconds: 100 } }), "claude-bridge").intervalSeconds, 100);
  assert.equal(resolveCachePolicy(withCache("claude-bridge", { ttlSeconds: 20 }), "claude-bridge").intervalSeconds, 30);
});

test("window 60 is capped to 30 effective; warmCompact override", () => {
  const p = resolveCachePolicy(withCache("claude-bridge", { keepalive: { windowMinutes: 60 }, warmCompact: false }), "claude-bridge");
  assert.deepEqual([p.windowMinutes, p.effectiveWindowMinutes, p.warmCompact], [60, 30, false]);
  assert.equal(resolveCachePolicy(withCache("claude-bridge", { keepalive: { windowMinutes: 10 } }), "claude-bridge").effectiveWindowMinutes, 10);
});

test("config overrides the built-in ttl; enabled true on a long ttl still skips", () => {
  const p = resolveCachePolicy(withCache("claude-bridge", { ttlSeconds: 600 }), "claude-bridge");
  assert.deepEqual([p.active, p.ttlSeconds, p.intervalSeconds], [true, 600, 540]);
  assert.equal(resolveCachePolicy(withCache("claude-bridge", { ttlSeconds: 3600, keepalive: { enabled: true } }), "claude-bridge").skip, "ttl_long");
});

test("the claude-bridge preset equals the built-in entry", () => {
  const preset = JSON.parse(readFileSync(new URL("../../../config/presets/claude-bridge.json", import.meta.url), "utf8"));
  const c = preset.providers["claude-bridge"].cache;
  assert.equal(c.billing, BUILTIN_CACHE["claude-bridge"].billing);
  assert.equal("ttlSeconds" in c, false); // it would shadow the derived bridge TTL
  assert.equal(c.keepalive.enabled, true); // round 32: self-warm keeps the 1 h cache warm
  assert.equal(resolveCachePolicy(preset, "claude-bridge", "claude-sonnet-5-5", 3600).ttlSeconds, 3600);
});

test("self-warm takeover: Pi warms 1000 s, the self-warmer owns 1001 s, 1800 s and 2001 s", () => {
  assert.equal(SELF_WARM_MIN_TTL_SECONDS, 1001);
  const rows: [number, boolean][] = [[1000, false], [1001, true], [1800, true], [2001, true]];
  for (const [ttl, own] of rows) {
    const p = resolveWarmPolicy(withCache("x", { ttlSeconds: ttl, billing: "token", keepalive: { enabled: true } }), "x");
    assert.equal(p.selfWarm, own, `ttl ${ttl}`);
  }
});
