import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, joinAgents, sessionTree, shownKeys } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const sess = (key, over = {}, children = []) => ({
  key, kind: "session", name: key, state: "working", sym: "working", own: cost, tot: cost, age_s: 1, waits: [], children, ...over,
});
const feedPr = { repo: "acme/widgets", number: 7, title: "t7", url: "https://example.test/acme/widgets/pull/7", state: "open", author: "o", checks: [{ n: "ci", state: "run", label: "ci" }], headRefName: "feat/7" };

// Parent P (space s1) lists C as a radar child (no hc terminal); C also runs in an agent pane of space s2 and is joined there.
const agents = [
  { address: "tp", pane: "pp", status: "working", space: "s1", tab_name: "1" },
  { address: "tc", pane: "pc", status: "working", space: "s2", tab_name: "1" },
];
const roots = [
  sess("p", { hcTerminal: "tp" }, [sess("c", { repo: "acme/widgets", branch: "feat/7" })]),
  sess("c", { hcTerminal: "tc", repo: "acme/widgets", branch: "feat/7" }),
];

test("a radar child drawn as a joined row elsewhere is not drawn again under its parent", () => {
  const tops = buildTree(parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs: [feedPr] })).nodes);
  const joined = joinAgents(agents, tops);
  const skip = new Set(joined.values());
  const skipKeys = new Set([...skip].map((n) => n.key));
  const top = sessionTree(joined.get("tp"), { skip, skipKeys });
  const row = sessionTree(joined.get("tc"), { skip, skipKeys });
  const all = (i) => [i, ...i.children.flatMap(all)];
  const items = [...all(top), ...all(row)].filter((i) => i.type === "session");
  const cs = items.filter((i) => i.label === "c");
  assert.equal(cs.length, 1);
  assert.equal(cs[0], row);
  assert.equal(top.children.some((i) => i.label === "c"), false);
  assert.equal(items.some((i) => i.elsewhere), false);
  assert.equal(row.prs.length, 1);
  assert.equal(items.reduce((n, i) => n + i.prs.length, 0), 1);
  assert.equal(shownKeys([top, row]).has("c"), true);
});
