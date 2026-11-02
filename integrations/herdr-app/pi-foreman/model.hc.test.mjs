import test from "node:test";
import assert from "node:assert/strict";
import { sessionTree, hcChildItems, bareChildren, displayStatus } from "./model.js";
import { sess, run, treeOf } from "./fixtures.mjs";

// Foreman session "f" (paned agent p/1): own agent builder, radar child c1; pane-less hc terminals h1 (joined to node hc-debug,
// which has its own agent explorer and wait), h2 (bare, one record), h3 (child of h1, bare).
const f = () => treeOf(sess("f", "f", { hcTerminal: "p/1", waits: [{ kind: "ci", note: "ci", age_s: 4 }] }, [
  run("b", "builder"),
  sess("c1", "c1", { age_s: 300 }),
  sess("hd", "hc-debug", { hcTerminal: "p/h1", age_s: 40, waits: [{ kind: "ci", note: "ci", age_s: 4 }] }, [run("e", "explorer", { age_s: 5 })]),
]));
const terms = [
  { address: "p/h1", parent: "p/1", state: "live", name: "fm-hc-debug", status: "idle" },
  { address: "p/h2", parent: "p/1", state: "live", name: "fm-sampler", status: "working", program: { name: "pi" } },
  { address: "p/h3", parent: "p/h1", state: "live", name: "fm-deep", status: "idle" },
  { address: "p/x", parent: "p/other", state: "live", name: "stranger", status: "idle" },
];

function items(tree) {
  const root = tree();
  const hd = root.sessions.find((s) => s.name === "hc-debug");
  const skip = new Set([hd]);
  const resolve = (term) => ({
    node: term.address === "p/h1" ? hd : null,
    recs: term.address === "p/h2" ? [{ title: "scout", state: "working", msg: "reading" }] : [],
    own: term.status,
    status: term.status,
  });
  return { root, skip, live: hcChildItems(terms, "p/1", resolve, { skip }) };
}

const all = (i) => [i, ...i.children.flatMap(all)];

test("hc children nest by parent, a joined one carries its node's agents, a bare one its record agents", () => {
  const { live } = items(f);
  assert.deepEqual(live.map((i) => i.address).sort(), ["p/h1", "p/h2"]);
  const h1 = live.find((i) => i.address === "p/h1");
  assert.equal(h1.label, "hc-debug");
  assert.deepEqual(h1.children.map((c) => c.label).sort(), ["explorer haiku-5-5:medium", "fm-deep"].sort());
  const h2 = live.find((i) => i.address === "p/h2");
  assert.deepEqual(h2.children.map((c) => [c.type, c.label]), [["agent", "scout · reading"]]);
  assert.ok(!all({ children: live }).some((i) => i.address === "p/x"));
});

test("own agents, radar children and hc children are siblings in one list; no double drawing", () => {
  const { root, skip, live } = items(f);
  const t = sessionTree(root, { skip, extra: live });
  assert.deepEqual(t.children.map((c) => c.label).sort(), ["builder haiku-5-5:medium", "c1", "hc-debug", "fm-sampler"].sort());
  assert.equal(all(t).filter((i) => i.label === "hc-debug").length, 1);
  assert.equal(t.children.find((c) => c.label === "hc-debug").top, false);
});

test("a joined hc child keeps its waits and has no summary", () => {
  const { live } = items(f);
  const h1 = live.find((i) => i.address === "p/h1");
  assert.equal(h1.node.waits.length, 1);
  assert.equal(h1.summary, "");
});

test("folding an hc child shows the most urgent status below it", () => {
  const live = hcChildItems(terms, "p/1", (term) => ({ node: null, recs: term.address === "p/h1" ? [{ title: "a", state: "blocked", msg: "" }] : [], status: "idle" }));
  const h1 = live.find((i) => i.address === "p/h1");
  assert.equal(h1.status, "idle");
  assert.equal(displayStatus(h1, new Set()), "idle");
  assert.equal(displayStatus(h1, new Set([h1.id])), "blocked");
});

test("a paned agent without a node: record agents and hc children as siblings", () => {
  const live = hcChildItems(terms, "p/1", () => ({ status: "idle" }));
  const kids = bareChildren([{ title: "r", state: "working", msg: "" }], live);
  assert.deepEqual(kids.map((k) => k.label).sort(), ["fm-hc-debug", "fm-sampler", "r"].sort());
});

test("no output string contains box-drawing characters", () => {
  const { root, skip, live } = items(f);
  const t = sessionTree(root, { skip, extra: live });
  const strings = [];
  const walk = (v) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(t);
  for (const s of strings) assert.doesNotMatch(s, /[│└├┌─]/u);
  assert.ok(strings.length > 0);
});
