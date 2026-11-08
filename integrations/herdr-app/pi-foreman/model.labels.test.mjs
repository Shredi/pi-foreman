import test from "node:test";
import assert from "node:assert/strict";
import { clashingTabs, agentLabel } from "./model.js";

const a = (address, tab_name, title, space = "s1") => ({ address, space, tab_name, title });

test("a unique tab name stays the label", () => {
  const list = [a("t1", "work", "π x"), a("t2", "other", "π y")];
  const c = clashingTabs(list);
  assert.equal(c.size, 0);
  assert.deepEqual(list.map((x) => agentLabel(x, c)), ["work", "other"]);
});

test("rows sharing a tab name are labelled by the agent's own title", () => {
  const list = [a("t1", "work", "π one"), a("t2", "work", "π two"), a("t3", "solo", "π three")];
  const c = clashingTabs(list);
  assert.deepEqual(list.map((x) => agentLabel(x, c)), ["π one", "π two", "solo"]);
});

test("a clash without a title falls back to the tab name; the same name in another space is no clash", () => {
  const c = clashingTabs([a("t1", "work", ""), a("t2", "work", undefined)]);
  assert.equal(agentLabel(a("t1", "work", ""), c), "work");
  assert.equal(clashingTabs([a("t1", "work", "x", "s1"), a("t2", "work", "y", "s2")]).size, 0);
});

test("numeric or missing tab names are no label and never clash; the title is used", () => {
  const list = [a("t1", "1", "π a"), a("t2", "1", "π b"), a("t3", undefined, "π c")];
  const c = clashingTabs(list);
  assert.equal(c.size, 0);
  assert.deepEqual(list.map((x) => agentLabel(x, c)), ["π a", "π b", "π c"]);
  assert.equal(clashingTabs(null).size, 0);
});
