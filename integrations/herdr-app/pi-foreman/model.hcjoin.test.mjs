import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, joinAgents, joinChildren, sessionTree, hcChildItems, workerStatus, agentStatus } from "./model.js";
import { sess, run } from "./fixtures.mjs";

// A pane-less child session: its radar node has an hcTerminal and a pid (pi's), its terminal record has the pid of the launch shell.
const AGENT = { address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } };
const parentTerm = { address: "t5", state: "live", foreground: { pid: 7 } };
const kidTerm = (over = {}) => ({ address: "t1c", state: "live", parent: "t5", foreground: { pid: 400 }, ...over });

function build({ kid = {}, term = kidTerm(), runs = [] } = {}) {
  const roots = [sess("f", "foreman-x", { hcTerminal: "t5", pid: 7 }, [sess("k", "kid", { hcTerminal: "t1c", pid: 500, state: "working", sym: "working", ...kid }, runs)])];
  const tops = buildTree(parseRadarDoc(JSON.stringify({ v: 1, roots })).nodes);
  const joined = joinAgents([AGENT], tops);
  const kids = [term];
  const childJoined = joinChildren(kids, tops, null, new Set(joined.values()));
  const skip = new Set([...joined.values(), ...childJoined.values()]);
  const skipKeys = new Set([...skip].map((n) => n.key));
  const resolve = (t) => {
    const node = childJoined.get(t.address) ?? null;
    const own = workerStatus(t.status, undefined);
    return { node, recs: [], own, status: agentStatus(own, node, []) };
  };
  const live = hcChildItems([parentTerm, term], "t5", resolve, { skip, skipKeys });
  const root = sessionTree(joined.get("t5"), { skip, skipKeys, extra: live });
  return { childJoined, root, tops };
}

const sessionRows = (root) => {
  const all = (i) => [i, ...i.children.flatMap(all)];
  return root.children.flatMap(all).filter((i) => i.type === "session");
};

test("a live pane-less child joins its terminal by the address, whatever the pids", () => {
  const { childJoined, tops } = build();
  const kidNode = tops[0].children.find((c) => c.key === "k");
  assert.equal(childJoined.get("t1c"), kidNode);
});

test("the pane-less child is one clickable row with the terminal's address and no bare terminal row", () => {
  const { root } = build();
  const rows = sessionRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, "t1c");
  assert.equal(rows[0].label, "kid");
  assert.ok(rows[0].node, "the row carries the radar node");
});

test("a stale node with another pid does not join by address (the bare terminal row stays)", () => {
  const { childJoined, root } = build({ kid: { state: "stale" } });
  assert.equal(childJoined.size, 0);
  const rows = sessionRows(root);
  assert.equal(rows.some((r) => r.address === "t1c" && r.node === null), true);
});

test("a stale node whose pid equals the terminal's pid joins through the pid path", () => {
  const { childJoined } = build({ kid: { state: "stale", pid: 400 } });
  assert.equal(childJoined.get("t1c")?.key, "k");
});

test("a live node with another pid joins by its terminal address (D100); a stale one does not", () => {
  const node = { key: "a", kind: "session", state: "working", hcTerminal: "t9", pid: 1, machine: "", sessions: [] };
  assert.equal(joinAgents([{ address: "t9", foreground: { pid: 2 } }], [node]).get("t9"), node);
  const stale = { ...node, state: "stale" };
  assert.equal(joinAgents([{ address: "t9", foreground: { pid: 2 } }], [stale]).size, 0);
});

test("a resumed pane-less child whose terminal says done shows the run state of its radar node", () => {
  const { root } = build({ term: kidTerm({ status: "done" }), runs: [run("r1", "scout")] });
  const rows = sessionRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "agents");
});
