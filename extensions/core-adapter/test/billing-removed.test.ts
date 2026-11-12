// `providers.<p>.cache.billing` (and a byModel row's `billing`) is accepted and ignored: the policy, the footer bar and
// the doctor behave as without it, and the doctor warns once per key. `keepalive.enabled: false` is the switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCachePolicy, resolveWarmPolicy } from "../cachepolicy.ts";
import { cacheViewOf, type CacheSource } from "../footer.ts";
import { cacheDoctorLines, deprecatedKeepaliveLines } from "../doctorcache.ts";

const P = "claude-bridge";
const cfg = (cache: Record<string, unknown>) => ({ providers: { [P]: { cache } } });
const ROW = { match: "gpt-*", ttlSeconds: 600 };

test("billing at provider level and on a byModel row changes nothing in the policy", () => {
  for (const base of [{ ttlSeconds: 300 }, { ttlSeconds: 300, keepalive: { enabled: true } }, { byModel: [ROW] }]) {
    const want = resolveWarmPolicy(cfg(base), P, "gpt-6");
    const wantCache = resolveCachePolicy(cfg(base), P, "gpt-6");
    for (const billing of ["request", "token"]) {
      const withProvider = { ...base, billing };
      const withRow = { ...base, byModel: [{ ...ROW, billing }] };
      for (const c of [withProvider, ...("byModel" in base ? [withRow] : [])]) {
        const got = resolveWarmPolicy(cfg(c), P, "gpt-6");
        assert.deepEqual(got, want, JSON.stringify(c));
        assert.deepEqual(resolveCachePolicy(cfg(c), P, "gpt-6"), wantCache, JSON.stringify(c));
        assert.ok(!("billing" in got));
        assert.equal(got.keepaliveOwned, want.keepaliveOwned);
      }
    }
  }
});

test("a byModel row with billing request does not switch its model off", () => {
  const c = cfg({ ttlSeconds: 300, keepalive: { enabled: true }, byModel: [{ ...ROW, billing: "request" }] });
  const p = resolveWarmPolicy(c, P, "gpt-6");
  assert.equal(p.active, true);
  assert.equal(p.keepaliveOwned, true);
});

test("the cache bar shows for a config that sets billing request", () => {
  const policy = resolveWarmPolicy(cfg({ ttlSeconds: 300, billing: "request" }), P, "claude-opus-5-5");
  const T0 = 1_700_000_000_000;
  const src: CacheSource = {
    policy, now: T0, lastTouch: T0, stretchStartAt: T0, nextWarmAt: T0 + 270_000, spanEndAt: T0 + 570_000,
    warmsLeft: 2, warmsFresh: 2, tier: "half", running: false, downshifted: false, idleRung: null, enabled: true, symbols: "unicode",
  };
  assert.notEqual(cacheViewOf(src), null);
});

test("the doctor warns once per billing key and adds no other line", () => {
  assert.deepEqual(deprecatedKeepaliveLines(cfg({ ttlSeconds: 300 })), []);
  const one = deprecatedKeepaliveLines(cfg({ billing: "request" }));
  assert.equal(one.length, 1);
  assert.match(one[0], /^WARN providers\.claude-bridge\.cache\.billing is deprecated and ignored: .*keepalive\.enabled: false/);
  const rows = deprecatedKeepaliveLines(cfg({ billing: "token", byModel: [{ match: "a", billing: "request" }, { match: "b", ttlSeconds: 60 }, { match: "c", billing: "token" }] }));
  assert.equal(rows.length, 3);
  assert.ok(rows[0].includes("providers.claude-bridge.cache.billing "));
  assert.ok(rows[1].includes("providers.claude-bridge.cache.byModel[0].billing "));
  assert.ok(rows[2].includes("providers.claude-bridge.cache.byModel[2].billing "));
  const two = deprecatedKeepaliveLines({ providers: { a: { cache: { billing: "x" } }, b: { cache: { billing: "y" } } } });
  assert.equal(two.length, 2);
  const policy = resolveWarmPolicy(cfg({ ttlSeconds: 3600, billing: "request", keepalive: { enabled: true } }), P, "m");
  const input = { provider: P, policy, promptCache: { short: 3600 }, retention: undefined, selfWarmMissed: false, hasIdleRung: true };
  assert.deepEqual(cacheDoctorLines(input), []);
});

test("keepalive.enabled false still switches the keep-alive off", () => {
  for (const extra of [{}, { billing: "token" }, { billing: "request" }]) {
    const p = resolveWarmPolicy(cfg({ ttlSeconds: 300, keepalive: { enabled: false }, ...extra }), P, "m");
    assert.equal(p.keepaliveOwned, false);
    assert.equal(p.active, false);
    assert.equal(p.skip, "disabled");
  }
});

const CUSTOM = "my-proxy";
const customCfg = (cache: Record<string, unknown>) => ({ providers: { [CUSTOM]: { cache } } });

test("a provider outside the built-in table keeps the keep-alive off without keepalive.enabled", () => {
  for (const extra of [{}, { billing: "token" }, { billing: "request" }]) {
    const p = resolveWarmPolicy(customCfg({ ttlSeconds: 300, ...extra }), CUSTOM, "m");
    assert.equal(p.keepaliveOwned, false, JSON.stringify(extra));
    assert.equal(p.active, false);
    assert.equal(p.skip, "disabled");
  }
});

test("a provider outside the built-in table is on with keepalive.enabled true", () => {
  for (const extra of [{}, { billing: "token" }]) {
    const p = resolveWarmPolicy(customCfg({ ttlSeconds: 300, keepalive: { enabled: true }, ...extra }), CUSTOM, "m");
    assert.equal(p.keepaliveOwned, true, JSON.stringify(extra));
    assert.equal(p.active, true);
  }
});

test("built-in providers stay on without the key and go off with keepalive.enabled false", () => {
  for (const [prov, model] of [["claude-bridge", "m"], ["github-copilot", "claude-sonnet-5-5"]] as const) {
    const on = resolveWarmPolicy({}, prov, model);
    assert.equal(on.keepaliveOwned, true, prov);
    const off = resolveWarmPolicy({ providers: { [prov]: { cache: { keepalive: { enabled: false } } } } }, prov, model);
    assert.equal(off.keepaliveOwned, false, prov);
    assert.equal(off.skip, "disabled");
  }
});

test("the billing warning names both fixes", () => {
  const lines = [
    ...deprecatedKeepaliveLines(customCfg({ billing: "token" })),
    ...deprecatedKeepaliveLines(customCfg({ byModel: [{ match: "a", billing: "request" }] })),
  ];
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.ok(l.includes("keepalive.enabled: true"), l);
    assert.ok(l.includes("keepalive.enabled: false"), l);
  }
});

test("the idle-rung warning names keepalive.enabled for a provider outside the built-in table only", () => {
  const warn = (rungProvider: string) => {
    const lines = cacheDoctorLines({
      provider: P, policy: resolveWarmPolicy({}, P, "m"), promptCache: undefined, retention: undefined, selfWarmMissed: false, hasIdleRung: true,
      idleRung: { spec: `${rungProvider}/small`, provider: rungProvider, policy: resolveWarmPolicy({}, rungProvider, "small") },
    });
    return lines.find((l) => l.startsWith("WARN idle rung")) ?? "";
  };
  const custom = warn(CUSTOM);
  assert.match(custom, /^WARN idle rung my-proxy\/small: provider my-proxy has no cache entry \(ttl unknown\)/);
  assert.ok(custom.includes("set providers.my-proxy.cache.ttlSeconds and providers.my-proxy.cache.keepalive.enabled: true"), custom);
  const builtIn = warn("github-copilot");
  assert.match(builtIn, /^WARN idle rung github-copilot\/small: provider github-copilot has no cache entry/);
  assert.ok(builtIn.includes("set providers.github-copilot.cache.ttlSeconds (docs/ladder.md)"), builtIn);
  assert.ok(!builtIn.includes("keepalive.enabled"), builtIn);
});
