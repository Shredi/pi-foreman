import test from "node:test";
import assert from "node:assert/strict";
import { childPlans, partFor, hasUnseen, buildTree } from "./model.js";

const node = (key, show, children = [], parent = "") => ({ key, kind: "session", name: key, parent, show, children });

test("a child with only a note is a child tab; a child with neither is not", () => {
  const top = buildTree([node("fm", { dir: "/s/fm", plan: 1 }, [
    node("noteonly", { dir: "/s/n", note: 2 }, [], "fm"),
    node("bare", { dir: "/s/b" }, [], "fm"),
    node("both", { dir: "/s/x", plan: 1, note: 1 }, [], "fm"),
  ])])[0];
  assert.deepEqual(childPlans(top).map((c) => c.label), ["noteonly", "both"]);
  assert.equal(childPlans(top)[0].node.key, "noteonly");
});

test("partFor picks the plan when there is one, else the note; a picked part wins only when the session has it", () => {
  const planOnly = { show: { plan: 1 } };
  const noteOnly = { show: { note: 1 } };
  const both = { show: { plan: 1, note: 2 } };
  assert.equal(partFor(planOnly, undefined), "plan");
  assert.equal(partFor(noteOnly, undefined), "note");
  assert.equal(partFor(both, undefined), "plan");
  assert.equal(partFor(both, "note"), "note");
  assert.equal(partFor(planOnly, "note"), "plan", "a note pick is ignored where there is no note");
  assert.equal(partFor(noteOnly, "plan"), "note", "a plan pick is ignored where there is no plan");
});

test("hasUnseen: a part never shown counts as unseen; a part shown at its version or later does not", () => {
  const both = { show: { plan: 3, note: 2 } };
  const none = () => undefined;
  assert.equal(hasUnseen(both, none), true);
  assert.equal(hasUnseen(both, (p) => (p === "plan" ? 3 : 2)), false);
  assert.equal(hasUnseen(both, (p) => (p === "plan" ? 3 : 1)), true, "a newer note than the one shown");
  assert.equal(hasUnseen(both, (p) => (p === "plan" ? 2 : 2)), true, "a newer plan than the one shown");
  assert.equal(hasUnseen({ show: { dir: "/s" } }, none), false, "a session with no part has nothing unseen");
});
