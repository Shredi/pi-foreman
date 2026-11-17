import test from "node:test";
import assert from "node:assert/strict";
import { spaceGroups } from "./model.js";

const ag = (address, space, space_name) => ({ address, space, space_name });
const shape = (gs) => gs.map((g) => [g.space, g.members.map((a) => a.address)]);

test("A,B,A gives two groups, A keeps both members in order", () => {
  const gs = spaceGroups([ag("a1", "A", "alpha"), ag("b1", "B", "beta"), ag("a3", "A", "alpha")]);
  assert.deepEqual(shape(gs), [["A", ["a1", "a3"]], ["B", ["b1"]]]);
  assert.equal(gs[0].label, "alpha");
  assert.equal(gs[0].id, "sp-A");
});

test("same label with different ids stays two groups", () => {
  const gs = spaceGroups([ag("x1", "1", "work"), ag("y1", "2", "work"), ag("x2", "1", "work")]);
  assert.deepEqual(shape(gs), [["1", ["x1", "x2"]], ["2", ["y1"]]]);
});

test("groups follow first appearance and members keep list order", () => {
  const gs = spaceGroups([ag("c1", "C", "c"), ag("a1", "A", "a"), ag("c2", "C", "c"), ag("b1", "B", "b"), ag("a2", "A", "a")]);
  assert.deepEqual(shape(gs), [["C", ["c1", "c2"]], ["A", ["a1", "a2"]], ["B", ["b1"]]]);
});

test("empty and bad input give no groups", () => {
  assert.deepEqual(spaceGroups([]), []);
  assert.deepEqual(spaceGroups(null), []);
});
