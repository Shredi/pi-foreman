import test from "node:test";
import assert from "node:assert/strict";
import { joinAgents, nestedAgents, hcChildItems, sessionTree, shownKeys } from "./model.js";
import { sess, run, treeOf } from "./fixtures.mjs";

// Parent session in hc terminal t1m, child session x in hc terminal t1n (parent t1m), each with its own tab and agent.
const terms = [
  { address: "t1m", state: "live", name: "pi-foreman" },
  { address: "t1n", state: "live", name: "fm-x-1ec06c", parent: "t1m" },
];
const agents = [
  { address: "t1m", pane: "pm", status: "working", space: "s1", tab_name: "1" },
  { address: "t1n", pane: "pn", status: "working", space: "s1", tab_name: "4", title: "fm-x" },
];
const tree = (parentKids = []) => treeOf(sess("p", "pi-foreman", { hcTerminal: "t1m" }, [
  ...parentKids,
  sess("fm-x", "x", { hcTerminal: "t1n" }, [run("r", "reviewer")]),
]));

// What main.js does: join agents, drop nested ones from the top level, draw them through hcChildItems under their parent.
function draw(root) {
  const joined = joinAgents(agents, [root]);
  const skip = new Set(joined.values());
  const nested = nestedAgents(agents, terms);
  const byAddr = new Map(agents.map((a) => [a.address, a]));
  const resolve = (term) => {
    const a = byAddr.get(term.address);
    return { node: joined.get(a.address) ?? null, recs: [], own: a.status, status: a.status, pane: a.pane };
  };
  const live = hcChildItems(terms, "t1m", resolve, { skip });
  const top = sessionTree(joined.get("t1m"), { skip, extra: live });
  const tops = agents.filter((a) => !nested.has(a.address)).map((a) => a.address);
  return { top, tops, live };
}
const all = (i) => [i, ...i.children.flatMap(all)];

test("an hc child with its own tab is drawn once, nested under its parent, by its radar name", () => {
  const { top, tops } = draw(tree()); 
  assert.deepEqual(tops, ["t1m"]);
  const xs = all(top).filter((i) => i.type === "session" && i.label === "x");
  assert.equal(xs.length, 1);
  assert.equal(top.children.includes(xs[0]), true);
  assert.equal(xs[0].address, "t1n");
  assert.equal(xs[0].pane, "pn");
  assert.deepEqual(xs[0].children.map((c) => c.label.split(" ")[0]), ["reviewer"]);
  assert.equal(all(top).filter((i) => String(i.label).startsWith("fm-x")).length, 0);
  assert.ok(shownKeys([top]).has("fm-x"));
});

test("a child that is also a radar child of its parent appears once", () => {
  // the parent's node already lists x as a radar child (see tree()); the joined node is skipped there
  const { top } = draw(tree([run("b", "builder")]));
  assert.equal(all(top).filter((i) => i.type === "session" && i.label === "x").length, 1);
  assert.equal(all(top).filter((i) => i.type === "session" && i.label === "x")[0].address, "t1n");
});

test("nestedAgents ignores unrelated and missing parents", () => {
  assert.deepEqual([...nestedAgents(agents, [{ address: "t1n", state: "live", parent: "gone" }])], []);
  assert.deepEqual([...nestedAgents(agents, null)], []);
});
