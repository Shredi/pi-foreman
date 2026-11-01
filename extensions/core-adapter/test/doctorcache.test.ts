import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWarmPolicy } from "../cachepolicy.ts";
import { cacheDoctorLines, type CacheDoctorInput } from "../doctorcache.ts";

const cfg = (cache: object) => ({ providers: { p: { cache } } });
const input = (over: Partial<CacheDoctorInput> = {}, cache: object = { ttlSeconds: 3600, billing: "token", keepalive: { enabled: true } }): CacheDoctorInput => ({
  provider: "p",
  policy: resolveWarmPolicy(cfg(cache), "p", "m"),
  promptCache: { short: 300, long: 3600 },
  retention: "long",
  cacheWarmingIdle: true,
  selfWarmMissed: false,
  hasIdleRung: true,
  ...over,
});

test("matching tier, idle warming, idle rung: no line", () => {
  assert.deepEqual(cacheDoctorLines(input()), []);
});

test("tier mismatch warns for the active retention only", () => {
  const l = cacheDoctorLines(input({ retention: undefined }));
  assert.equal(l.length, 1);
  assert.match(l[0], /^WARN Pi promptCache\.short .* is 300 s but cache\.ttlSeconds is 3600/);
  assert.deepEqual(cacheDoctorLines(input({ promptCache: { short: 300 } })).map((x) => x.slice(0, 40)), ["WARN Pi promptCache.long for p is unset "]);
});

test("no declared promptCache leaves the tier check to the existing prerequisite warning", () => {
  assert.deepEqual(cacheDoctorLines(input({ promptCache: undefined })), []);
});

test("cacheWarming not idle warns for a self-warm policy", () => {
  const l = cacheDoctorLines(input({ cacheWarmingIdle: false }));
  assert.equal(l.length, 1);
  assert.match(l[0], /^WARN Pi cacheWarming is not "idle"/);
});

test("cacheWarming for a Pi-warm policy stays with the existing prerequisite check", () => {
  const short = { ttlSeconds: 300, billing: "token" };
  assert.deepEqual(cacheDoctorLines(input({ cacheWarmingIdle: false, promptCache: { short: 300 }, retention: undefined }, short)), []);
});

test("a recorded self-warm miss warns", () => {
  assert.match(cacheDoctorLines(input({ selfWarmMissed: true }))[0], /^WARN a self-warm .*self_warm_miss/);
});

test("an unset idle rung is INFO", () => {
  const l = cacheDoctorLines(input({ hasIdleRung: false }));
  assert.equal(l.length, 1);
  assert.match(l[0], /^INFO no providers\.p\.roles\.foreman\.idle/);
});

test("a provider without a cache entry only reports the idle rung", () => {
  const l = cacheDoctorLines(input({ policy: resolveWarmPolicy({}, "p", "m"), hasIdleRung: false }));
  assert.deepEqual(l.map((x) => x.split(" ")[0]), ["INFO"]);
});

test("an idle rung on a provider without a cache entry or TTL warns; one with a TTL does not", () => {
  const rung = (c: object | null) => ({ spec: "q/small", provider: "q", policy: resolveWarmPolicy(c ? { providers: { q: { cache: c } } } : {}, "q", "small") });
  for (const c of [null, { billing: "token" }]) {
    const l = cacheDoctorLines(input({ idleRung: rung(c) }));
    assert.equal(l.length, 1);
    assert.match(l[0], /^WARN idle rung q\/small: provider q has no cache entry \(ttl unknown\): no cache bar and no warms while downshifted/);
  }
  assert.deepEqual(cacheDoctorLines(input({ idleRung: rung({ ttlSeconds: 1800, billing: "token" }) })), []);
});
