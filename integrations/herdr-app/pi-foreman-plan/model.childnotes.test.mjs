import test from "node:test";
import assert from "node:assert/strict";
import { childPlans, hasUnseen, pageStamp, tabDot, newPage, buildTree } from "./model.js";

const node = (key, show, children = [], parent = "") => ({ key, kind: "session", name: key, parent, show, children });

test("a child with a show folder is a child tab, hint or not; a child without one is not", () => {
  const top = buildTree([node("fm", { dir: "/s/fm", plan: 1 }, [
    node("noteonly", { dir: "/s/n", note: 2 }, [], "fm"),
    node("bare", { dir: "/s/b" }, [], "fm"),
    node("nodir", { plan: 1 }, [], "fm"),
    node("none", undefined, [], "fm"),
  ])])[0];
  assert.deepEqual(childPlans(top).map((c) => c.label), ["noteonly", "bare"]);
  assert.equal(childPlans(top)[0].node.key, "noteonly");
});

test("hasUnseen: a page never opened counts as unseen; a page opened at its stamp does not", () => {
  const plan = { id: "plan", version: 3, state: "draft", at: 1000 };
  const note = { id: "note-1", version: 1, state: "shown", at: 2000 };
  const pages = [plan, note];
  const stamps = { plan: pageStamp(plan), "note-1": pageStamp(note) };
  assert.equal(hasUnseen(pages, () => undefined), true);
  assert.equal(hasUnseen(pages, (id) => stamps[id]), false);
  assert.equal(hasUnseen(pages, (id) => (id === "plan" ? pageStamp({ ...plan, version: 2 }) : stamps[id])), true, "a newer plan than the one opened");
  assert.equal(hasUnseen([], () => undefined), false, "no page, nothing unseen");
  assert.equal(hasUnseen(undefined, () => undefined), false);
});

test("tabDot: only while the tab is not on screen", () => {
  const pages = [{ id: "plan", version: 1, state: "draft", at: 1 }];
  assert.equal(tabDot(pages, false, () => undefined), true);
  assert.equal(tabDot(pages, true, () => undefined), false);
});

test("newPage: a new id or a higher version, not a state change", () => {
  const prev = new Map([["plan", 2], ["note-1", 1]]);
  assert.equal(newPage(prev, [{ id: "plan", version: 2 }, { id: "note-1", version: 1 }]), false);
  assert.equal(newPage(prev, [{ id: "plan", version: 3 }]), true);
  assert.equal(newPage(prev, [{ id: "plan", version: 1 }]), false, "an older version is not new");
  assert.equal(newPage(prev, [{ id: "note-2", version: 1 }]), true);
  assert.equal(newPage(new Map(), [{ id: "plan", version: 0 }]), true);
});
