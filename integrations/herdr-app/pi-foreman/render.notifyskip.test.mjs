import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");

const mod = () => {
  const m = Object.create(Mod.prototype);
  m.changed = {};
  return m;
};
const cx = () => { const c = { n: 0, notify() { c.n++; } }; return c; };

test("the 1 s tick redraws only when a clock's text changed", () => {
  const m = mod();
  const real = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    assert.equal(m.clock("a", (n) => `${Math.floor((n - 1_000_000) / 60000)}m`, now), "0m");
    const c = cx();
    now += 30_000; m.tickClocks(c);
    assert.equal(c.n, 0, "same text: no redraw");
    now += 31_000; m.tickClocks(c);
    assert.equal(c.n, 1, "the text moved to 1m");
  } finally { Date.now = real; }
});

test("the legend closes after the pointer left for a second, and a tick with nothing else redraws only then", () => {
  const m = mod();
  const real = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  try {
    m.legendHot = true; m.legendLeft = now;
    const c = cx();
    now += 500; m.tickClocks(c);
    assert.equal(c.n, 0); assert.equal(m.legendHot, true);
    now += 600; m.tickClocks(c);
    assert.equal(c.n, 1); assert.equal(m.legendHot, false);
  } finally { Date.now = real; }
});
