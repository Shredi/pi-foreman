import test from "node:test";
import assert from "node:assert/strict";
import { sessionTree, hcChildItems, isEnded, parseAttachTarget, sessionCount, nestedAgents } from "./model.js";
import { sess, treeOf } from "./fixtures.mjs";

test("finished and lost children are ended and not drawn", () => {
  assert.equal(isEnded({ state: "finished" }), true);
  const t = sessionTree(treeOf(sess("r", "r", {}, [sess("a", "a", { state: "finished" }), sess("b", "b", { state: "lost" }), sess("c", "c", { hcTerminal: "t1" })])));
  assert.deepEqual(t.children.filter((c) => c.type === "session").map((c) => c.label), ["c"]);
  assert.equal(sessionCount(treeOf(sess("r", "r", {}, [sess("a", "a", { state: "finished" })]))), 1);
});

test("parseAttachTarget reads a hand-made hc attach terminal", () => {
  assert.equal(parseAttachTarget(JSON.stringify({ argv: ["sh", "-c", "hc attach box1/t7"] })), "box1/t7");
  assert.equal(parseAttachTarget(JSON.stringify({ foreground: { argv: ["hc", "attach", "box1/t7"] } })), "box1/t7");
  assert.equal(parseAttachTarget(JSON.stringify({ argv: ["pi"] })), "");
  assert.equal(parseAttachTarget("nope"), "");
});

const all = [
  { address: "t1", state: "live" },
  { address: "t3", parent: "t1", state: "live", program: { name: "Pi" } },
  { address: "box1/t7", state: "live", name: "fm-fug-se-0f65f9" },
];

test("an attach of a known remote session shows as its label, marked attach", () => {
  const items = hcChildItems(all, "t1", () => ({ attach: "box1/t7" }));
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "fug-se@box1");
  assert.equal(items[0].attach, true);
});

test("an attach of a session already drawn (drawnTargets) is hidden, else shown as its label", () => {
  const resolve = () => ({ attach: "box1/t7" });
  assert.deepEqual(hcChildItems(all, "t1", resolve, { drawnTargets: new Set(["box1/t7"]) }), []);
  assert.deepEqual(hcChildItems(all, "t1", resolve, { drawnTargets: new Set(["box1/t9"]) }).map((i) => i.label), ["fug-se@box1"]);
});

test("an attach of an unknown target, or no target, shows no anonymous Pi row when the target is unknown", () => {
  assert.deepEqual(hcChildItems(all, "t1", () => ({ attach: "box1/t99" })), []);
  assert.equal(hcChildItems(all, "t1", () => ({}))[0].label, "Pi");
});

test("the real hc get / hc ls shapes of a hand-made attach terminal resolve to the remote session's attach", () => {
  const get = JSON.stringify({ address: "t3g", argv: ["sh", "-c", "hc attach box1/t7"], foreground: { argv: ["hc", "attach", "box1/t7"], name: "herdr-core", pid: 3665 }, name: null, parent: "t1m", state: "live", status: { app: "pi", state: "done" }, title: "npm install ..." });
  const ls = [
    { address: "t1m", state: "live" },
    { address: "t3g", agent: "pi", parent: "t1m", state: "live", status: "done" },
    { address: "box1/t7", agent: "pi", name: "fm-fug-se-0f65f9", state: "live" },
  ];
  const attach = parseAttachTarget(get);
  assert.equal(attach, "box1/t7");
  const items = hcChildItems(ls, "t1m", () => ({ attach, status: "idle" }));
  assert.deepEqual(items.map((i) => [i.label, i.attach]), [["fug-se@box1", true]]);
  assert.deepEqual(hcChildItems(ls.slice(0, 2), "t1m", () => ({ attach, status: "idle" })), []);
});

test("a listed agent t3g (hand-made attach, title of the remote) nested under t1m draws as the remote session's attach, or not at all", () => {
  const t3g = { address: "t3g", argv: ["sh", "-c", "hc attach box1/t7"], foreground: { argv: ["hc", "attach", "box1/t7"], pid: 1 }, name: null, parent: "t1m", state: "live", status: "done", program: { name: "Pi" } };
  const remote = { address: "box1/t7", name: "fm-fug-se-0f65f9", state: "live" };
  const all = [{ address: "t1m", state: "live" }, t3g, remote];
  const list = [{ address: "t1m" }, { address: "t3g", title: "npm install ..." }];
  assert.deepEqual([...nestedAgents(list, all)], ["t3g"]);
  const resolve = (term) => ({ node: null, recs: [], own: term.status, label: "npm install ...", status: "idle", pane: 3 });
  const items = hcChildItems(all, "t1m", resolve);
  assert.deepEqual(items.map((i) => [i.label, i.attach]), [["fug-se@box1", true]]);
  assert.deepEqual(hcChildItems([all[0], t3g], "t1m", resolve), []);
  assert.equal(parseAttachTarget(t3g), "box1/t7");
});

for (const state of ["closed", "lost", "finished"]) {
  test(`an ended (${state}) hc child with a live child session stays, dimmed, with the live child`, () => {
    const terms = [
      { address: "t1", parent: "p", state: "live", name: "ended" },
      { address: "t2", parent: "t1", state: "live", name: "alive" },
    ];
    const resolve = (term) => (term.address === "t1" ? { node: treeOf(sess("a", "a", { state })), status: "idle" } : { status: "working" });
    const items = hcChildItems(terms, "p", resolve);
    assert.equal(items.length, 1);
    assert.equal(items[0].dim, true);
    assert.deepEqual(items[0].children.map((c) => c.label), ["alive"]);
  });

  test(`an ended (${state}) hc child with nothing below drops`, () => {
    const terms = [{ address: "t1", parent: "p", state: "live", name: "ended" }];
    assert.deepEqual(hcChildItems(terms, "p", () => ({ node: treeOf(sess("a", "a", { state })), status: "idle" })), []);
  });
}
