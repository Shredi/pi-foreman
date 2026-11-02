import test from "node:test";
import assert from "node:assert/strict";
import { parseRadar, buildTree } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const prsOf = (dots) => buildTree(parseRadar(JSON.stringify({
  roots: [{ key: "s", kind: "session", name: "s", state: "idle", sym: "waiting", glyph: "⏸", own: cost, tot: cost, children: [], waits: [], tasks: [], dots }],
})))[0].prs;
const dot = (n, state, over = {}) => ({ n, state, label: `#${n}`, src: "pr", ...over });
const ck = (...states) => states.map((state, i) => ({ name: `c${i}`, state }));

test("chip: 3 ok + 1 run gives three green dots and one pending dot, pending first", () => {
  const [pr] = prsOf([dot(7, "run", { checks: ck("ok", "ok", "run", "ok") })]);
  assert.deepEqual(pr.checks, ["pending", "ok", "ok", "ok"]);
});

test("chip: failing first, then running, then green", () => {
  const [pr] = prsOf([dot(7, "fail", { checks: ck("ok", "run", "fail", "ok", "fail") })]);
  assert.deepEqual(pr.checks, ["fail", "fail", "pending", "ok", "ok"]);
});

test("chip: counts expand the same way, at most 12 dots", () => {
  const [pr] = prsOf([dot(7, "fail", { counts: { fail: 1, run: 2, ok: 40 } })]);
  assert.equal(pr.checks.length, 12);
  assert.deepEqual(pr.checks.slice(0, 4), ["fail", "pending", "pending", "ok"]);
});

test("chip: the old shape (no checks) still renders one dot of the overall state", () => {
  assert.deepEqual(prsOf([dot(7, "ok")])[0].checks, ["ok"]);
  assert.deepEqual(prsOf([dot(7, "fail", { checks: [] })])[0].checks, ["fail"]);
  assert.deepEqual(prsOf([dot(7, "run", { checks: [{ name: "x", state: "bogus" }, 5] })])[0].checks, ["pending"]);
});
