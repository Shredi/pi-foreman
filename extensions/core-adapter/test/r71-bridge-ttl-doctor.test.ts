// r71: foreman doctor lines for the claude-bridge TTL (doctorcache.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeCacheEnvLines, bridgeTtlDoctorLines, cacheDoctorLines } from "../doctorcache.ts";
import { bridgeTtlSetting, derivedBridgeTtlS } from "../bridgettl.ts";
import { resolveWarmPolicy } from "../cachepolicy.ts";

const DEFAULTS = bridgeTtlSetting(undefined);
const OLD_NOTE = "subscription within plan usage; 300 on extra-usage credits or API key";
const bridgeCache = (cache: unknown) => ({ providers: { "claude-bridge": { cache } } });

test("per-kind INFO line", () => {
  assert.deepEqual(bridgeTtlDoctorLines({}, DEFAULTS, {}), ["INFO bridge cache TTL: main 1h (3600 s), subagent 5m (300 s)"]);
});

test("inherit and forced 5m are shown as such", () => {
  const inh = bridgeTtlDoctorLines({}, bridgeTtlSetting({ main: "inherit" }), {})[0];
  assert.match(inh, /main inherit .*assumes 300 s/);
  const forced = bridgeTtlDoctorLines({}, DEFAULTS, { FORCE_PROMPT_CACHING_5M: "1" });
  assert.match(forced[0], /main forced 5m \(300 s\), subagent forced 5m \(300 s\)/);
});

test("FORCE_PROMPT_CACHING_5M and DISABLE_PROMPT_CACHING* warn", () => {
  assert.deepEqual(bridgeCacheEnvLines({}), []);
  assert.deepEqual(bridgeCacheEnvLines({ FORCE_PROMPT_CACHING_5M: "0", DISABLE_PROMPT_CACHING: "0" }), []);
  const force = bridgeCacheEnvLines({ FORCE_PROMPT_CACHING_5M: "1" });
  assert.equal(force.length, 1);
  assert.match(force[0], /^WARN FORCE_PROMPT_CACHING_5M is set/);
  const off = bridgeCacheEnvLines({ DISABLE_PROMPT_CACHING: "1", DISABLE_PROMPT_CACHING_HAIKU: "1" });
  assert.equal(off.length, 1);
  assert.match(off[0], /^WARN DISABLE_PROMPT_CACHING, DISABLE_PROMPT_CACHING_HAIKU set/);
  assert.equal(bridgeTtlDoctorLines({}, DEFAULTS, { DISABLE_PROMPT_CACHING_SONNET: "true" }).filter((l) => l.startsWith("WARN")).length, 1);
});

test("stale preset: the exact old row and ttlSeconds 300 warn", () => {
  const row = { match: "claude-*", ttlSeconds: 3600, note: OLD_NOTE };
  const both = bridgeTtlDoctorLines(bridgeCache({ ttlSeconds: 300, billing: "token", byModel: [row] }), DEFAULTS, {}).filter((l) => l.startsWith("WARN"));
  assert.equal(both.length, 1);
  assert.match(both[0], /ttlSeconds \(300\) and the claude-\* 3600 byModel row/);
  assert.match(both[0], /delete them/);
  assert.match(bridgeTtlDoctorLines(bridgeCache({ ttlSeconds: 300 }), DEFAULTS, {}).join("\n"), /WARN providers\.claude-bridge\.cache\.ttlSeconds \(300\) .*delete it/);
  assert.match(bridgeTtlDoctorLines(bridgeCache({ byModel: [row] }), DEFAULTS, {}).join("\n"), /WARN the claude-\* 3600 byModel row/);
});

test("a row or ttlSeconds set on purpose wins silently", () => {
  for (const cache of [{ ttlSeconds: 600 }, { ttlSeconds: 3600 }, { byModel: [{ match: "claude-*", ttlSeconds: 3600, note: "mine" }] }, { byModel: [{ match: "claude-*", ttlSeconds: 600, note: OLD_NOTE }] }]) {
    assert.deepEqual(bridgeTtlDoctorLines(bridgeCache(cache), DEFAULTS, {}).filter((l) => l.startsWith("WARN")), [], JSON.stringify(cache));
  }
});

test("the promptCache mismatch check is fed by the derived main TTL", () => {
  const input = (ttl: number | null) => ({
    provider: "claude-bridge",
    policy: resolveWarmPolicy({}, "claude-bridge", "claude-opus-5-5", ttl),
    promptCache: { short: 300, long: 3600 },
    retention: "long",
    cacheWarmingIdle: true,
    selfWarmMissed: false,
    hasIdleRung: true,
  });
  const main = derivedBridgeTtlS(DEFAULTS, false, {});
  assert.equal(main, 3600);
  assert.deepEqual(cacheDoctorLines(input(main)), []); // Pi's long tier 3600 equals the derived 3600
  const short = cacheDoctorLines({ ...input(main), retention: undefined });
  assert.equal(short.length, 1);
  assert.match(short[0], /promptCache\.short for claude-bridge is 300 s but cache\.ttlSeconds is 3600/);
  assert.match(cacheDoctorLines(input(null))[0], /promptCache\.long for claude-bridge is 3600 s but cache\.ttlSeconds is 300/);
});
