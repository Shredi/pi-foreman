// Warm budget per tier (warmbudget.ts, selfwarm.ts tierShare) and the presence time the grace counts from (presence.ts awaySince).
import { test } from "node:test";
import assert from "node:assert/strict";
import { WarmBudget, warmRates } from "../warmbudget.ts";
import { tierShare } from "../selfwarm.ts";
import { Presence } from "../presence.ts";
import type { CachePolicy } from "../cachepolicy.ts";

const RATES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 };
const pol = (budgetShare = 0.5) => ({ budgetShare }) as CachePolicy;

/** Warms that fit under a share: each costs 100_000 x cacheRead + 1 output token, a cold re-cache 100_000 x 10 = 1.0. */
function warmsUnder(share: number, rates = RATES): number {
  const b = new WarmBudget();
  b.reset(100_000);
  let n = 0;
  for (; n < 100; n++) {
    if (!b.check(rates, share)?.ok) break;
    b.note({ input: 0, output: 1, cacheRead: 100_000, cacheWrite: 0 });
  }
  return n;
}

test("tier shares: the half tier is budgetShare, the quarter tier half of it", () => {
  assert.equal(tierShare(pol(0.5), "half"), 0.5);
  assert.equal(tierShare(pol(0.5), "quarter"), 0.25);
  assert.equal(tierShare(pol(0.2), "quarter"), 0.1);
  assert.equal(tierShare(null, "half"), 0.5);
});

test("the quarter share stops the warms at 25% of a cold re-cache, the half share at 50%", () => {
  // one warm = 0.05 + 25e-6 = 0.050025
  assert.equal(warmsUnder(tierShare(pol(), "quarter")), 4);
  assert.equal(warmsUnder(tierShare(pol(), "half")), 9);
});

test("a cold re-cache is priced at max(cacheWrite, input): a model with cacheWrite 0 uses its input rate", () => {
  const b = new WarmBudget();
  b.reset(1_000_000);
  assert.equal(b.check({ ...RATES, cacheWrite: 0 }, 0.5)!.cold, 5);
  assert.equal(b.check({ ...RATES, cacheWrite: 10 }, 0.5)!.cold, 10);
  assert.equal(b.check({ ...RATES, input: 20, cacheWrite: 10 }, 0.5)!.cold, 20);
  assert.deepEqual(warmRates({ table: null, registry: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, model: "m", promptTokens: 1, ttlSeconds: 300 }), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
  assert.equal(warmRates({ table: null, registry: { input: 0, output: 15, cacheRead: 0.3, cacheWrite: 0 }, model: "m", promptTokens: 1, ttlSeconds: 300 }), null);
});

test("no budget without rates or a prompt size: check is null", () => {
  const b = new WarmBudget();
  assert.equal(b.check(RATES, 0.5), null, "prompt size 0 (an errored request fed zero usage)");
  b.reset(1000);
  assert.equal(b.check(null, 0.5), null);
});

test("awaySince comes from the probe's idle seconds, exact when the probe runs late", async () => {
  const clock = { t: 5_000_000 };
  const p = new Presence({
    now: () => clock.t,
    timers: { set: () => ({}), clear: () => undefined },
    config: () => ({ enabled: true, awayAfterMinutes: 11, command: null }),
    probe: async () => 3600, // an hour of idle input, sampled 54 minutes after the owner's last request
    trace: () => undefined,
  });
  assert.equal(p.awaySince(), null, "no sample yet");
  await p.refresh();
  assert.equal(p.away(), true);
  assert.equal(p.awaySince(), clock.t - 3600 * 1000 + 11 * 60_000);
});

test("awaySince is null while the owner is present", async () => {
  const p = new Presence({
    now: () => 1_000_000,
    timers: { set: () => ({}), clear: () => undefined },
    config: () => ({ enabled: true, awayAfterMinutes: 11, command: null }),
    probe: async () => 30,
    trace: () => undefined,
  });
  await p.refresh();
  assert.equal(p.awaySince(), null);
});
