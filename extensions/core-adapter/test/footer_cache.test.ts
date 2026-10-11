import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_STATUS_KEY, cacheStatus } from "../footer.ts";
import { symbolSet } from "../symbols.ts";

const rec = (mode: string | undefined) => {
  const calls: [string, string | undefined][] = [];
  return { calls, ctx: { mode, ui: { setStatus: (k: string, v: string | undefined) => void calls.push([k, v]) } } };
};

test("cacheStatus sets the glyph while active and clears it after, tui and rpc only", () => {
  for (const mode of ["tui", "rpc"]) {
    const r = rec(mode);
    cacheStatus(r.ctx, true, "♨");
    cacheStatus(r.ctx, false, "♨");
    assert.deepEqual(r.calls, [[CACHE_STATUS_KEY, "♨"], [CACHE_STATUS_KEY, undefined]], mode);
  }
  for (const mode of ["print", "json", undefined]) {
    const r = rec(mode);
    cacheStatus(r.ctx, true, "♨");
    assert.deepEqual(r.calls, [], String(mode));
  }
});

test("cacheStatus never throws on a stale ui", () => {
  assert.doesNotThrow(() => cacheStatus({ mode: "tui", ui: { setStatus: () => { throw new Error("stale"); } } }, true, "♨"));
});

test("symbols: keepalive glyph for both sets, unknown set falls back to unicode", () => {
  assert.equal(symbolSet("unicode").keepalive, "\u2668");
  assert.equal(symbolSet("nerd").keepalive, "\uf06d");
  assert.equal(symbolSet("bogus").keepalive, "\u2668");
});
