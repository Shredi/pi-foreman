import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUILTIN_CACHE, PI_IDLE_CAP_MINUTES, resolveCachePolicy } from "../cachepolicy.ts";

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
  assert.deepEqual({ ttlSeconds: c.ttlSeconds, billing: c.billing }, BUILTIN_CACHE["claude-bridge"]);
  assert.equal(c.keepalive.enabled, false); // lane 6: keep-alive off in the preset
  assert.equal(resolveCachePolicy(preset, "claude-bridge", "claude-sonnet-5-5").ttlSeconds, 600);
});
