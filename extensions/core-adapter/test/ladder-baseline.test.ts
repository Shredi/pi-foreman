import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildLadder } from "../ladder.ts";

const u = (input: number) => ({ input, cacheRead: 0, cacheWrite: 0 });

test("a first call above strongAbove is not steered", () => {
  const l = new ChildLadder({ strongAbove: 100000, bottom: true });
  assert.equal(l.onUsage(u(137000)), null);
});

test("growth below strongAbove over the first call is not steered", () => {
  const l = new ChildLadder({ strongAbove: 100000, bottom: true });
  assert.equal(l.onUsage(u(137000)), null);
  assert.equal(l.onUsage(u(160000)), null);
});

test("growth above strongAbove over the first call steers once with the baseline", () => {
  const l = new ChildLadder({ strongAbove: 100000, bottom: true });
  assert.equal(l.onUsage(u(68000)), null);
  const s = l.onUsage(u(169000));
  assert.ok(s);
  assert.equal(s.trigger, "context");
  assert.match(s.text, /RUNG_UP: context/);
  assert.equal(s.count, 169000);
  assert.equal(s.baseline, 68000);
  assert.equal(l.onUsage(u(300000)), null);
});

test("a first call without usage does not pin the baseline at 0", () => {
  const l = new ChildLadder({ strongAbove: 100000, bottom: true });
  assert.equal(l.onUsage(u(0)), null);
  assert.equal(l.onUsage(u(137000)), null);
  assert.equal(l.onUsage(u(160000)), null);
  const s = l.onUsage(u(240000));
  assert.equal(s?.trigger, "context");
  assert.equal(s?.baseline, 137000);
});

test("the top rung never context-steers", () => {
  const l = new ChildLadder({ strongAbove: 100000, bottom: false });
  assert.equal(l.onUsage(u(1000)), null);
  assert.equal(l.onUsage(u(900000)), null);
});

test("the turns trigger still fires past maxTurns", () => {
  const l = new ChildLadder({ maxTurns: 2, bottom: true });
  assert.equal(l.onUsage(u(1)), null);
  assert.equal(l.onUsage(u(1)), null);
  const s = l.onUsage(u(1));
  assert.equal(s?.trigger, "turns");
});
