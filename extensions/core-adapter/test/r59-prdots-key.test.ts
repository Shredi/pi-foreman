import { test } from "node:test";
import assert from "node:assert/strict";
import { PrDots, prDotsEnabled } from "../prdots.ts";
import type { PrDotsDeps } from "../prdots.ts";

test("tools.prDots false disables the poller; true or absent keeps it", () => {
  assert.equal(prDotsEnabled(true, false, false), false);
  assert.equal(prDotsEnabled(true, false, true), true);
  assert.equal(prDotsEnabled(true, false, undefined), true);
  assert.equal(prDotsEnabled(false, false, true), false);
  assert.equal(prDotsEnabled(true, true, true), false);
});

function rig(prDots: unknown) {
  let ran = 0;
  let timers = 0;
  const deps: PrDotsDeps = {
    enabled: () => prDotsEnabled(true, false, prDots),
    preflight: async () => undefined,
    branch: async () => {
      ran++;
      return "";
    },
    run: async () => {
      ran++;
      return { kind: "ran", result: { ok: true } };
    },
    watched: () => [],
    watchChecks: () => null,
    intervalMs: () => 60_000,
    trace: () => {},
    timers: {
      set: () => {
        timers++;
        return 0;
      },
      clear: () => {},
    },
  };
  return { dots: new PrDots(deps), count: () => ({ ran, timers }) };
}

test("PrDots does not schedule a poll when tools.prDots is false", () => {
  const off = rig(false);
  off.dots.start();
  assert.equal(off.count().timers, 0);
  const on = rig(undefined);
  on.dots.start();
  assert.ok(on.count().timers > 0);
  const on2 = rig(true);
  on2.dots.start();
  assert.ok(on2.count().timers > 0);
});
