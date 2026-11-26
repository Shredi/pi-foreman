import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, joinAgents, joinChildren, sessionTree, hcChildItems, workerStatus, agentStatus } from "./model.js";
import { sess } from "./fixtures.mjs";

// The first seconds of `foreman session open`: the radar node has no hcTerminal and no pid yet (no live file), but the hc terminal is
// already listed, named by the node's key (the intercom id, hc_name of the registry child).
const AGENT = { address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } };
const parentTerm = { address: "t5", state: "live", foreground: { pid: 7 } };
const kidTerm = (over = {}) => ({ address: "t1c", name: "fm-kid-0ad045", state: "live", parent: "t5", foreground: { pid: 400 }, ...over });

function build({ kid = {}, term = kidTerm() } = {}) {
  const roots = [sess("f", "foreman-x", { hcTerminal: "t5", pid: 7 }, [sess("fm-kid-0ad045", "kid", { hcTerminal: null, pid: null, state: "starting", sym: "working", ...kid }, [])])];
  const tops = buildTree(parseRadarDoc(JSON.stringify({ v: 1, roots })).nodes);
  const joined = joinAgents([AGENT], tops);
  const childJoined = joinChildren([term], tops, null, new Set(joined.values()));
  const skip = new Set([...joined.values(), ...childJoined.values()]);
  const skipKeys = new Set([...skip].map((n) => n.key));
  const resolve = (t) => {
    const node = childJoined.get(t.address) ?? null;
    const own = workerStatus(t.status, undefined);
    return { node, recs: [], own, status: agentStatus(own, node, []) };
  };
  const live = hcChildItems([parentTerm, term], "t5", resolve, { skip, skipKeys });
  const root = sessionTree(joined.get("t5"), { skip, skipKeys, extra: live });
  return { childJoined, root };
}

const sessionRows = (root) => {
  const all = (i) => [i, ...i.children.flatMap(all)];
  return root.children.flatMap(all).filter((i) => i.type === "session");
};

test("a node without hcTerminal joins the terminal named by its key: one row named by the node, no elsewhere tag", () => {
  const { childJoined, root } = build();
  assert.equal(childJoined.get("t1c")?.key, "fm-kid-0ad045");
  const rows = sessionRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "kid");
  assert.equal(rows[0].address, "t1c");
  assert.equal(rows[0].elsewhere, "");
});

test("a terminal with another name does not join a node without hcTerminal", () => {
  const { childJoined } = build({ term: kidTerm({ name: "something-else" }) });
  assert.equal(childJoined.size, 0);
});

test("an ended node is not joined by name", () => {
  const { childJoined } = build({ kid: { state: "closed", sym: "idle" } });
  assert.equal(childJoined.size, 0);
});
