import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRadarDoc, buildTree, joinAgents, joinChildren, sessionTree, hcChildItems, openPrGroups, shownNodes, shownKeys } from "./model.js";

// radar-live.json is a small hand-written radar document; the terminal links it lacks are set here like the live herdr had them.
const doc = JSON.parse(readFileSync(new URL("./radar-live.json", import.meta.url), "utf8"));
const link = (n) => {
  if (n.name === "r78") n.hcTerminal = "t1";
  if (n.key === "k-sampler") n.hcTerminal = "t2";
  (n.children ?? []).forEach(link);
};
doc.roots.forEach(link);

test("live radar: every PR appears once, on its row or in the feed group", () => {
  const parsed = parseRadarDoc(JSON.stringify(doc));
  const tops = buildTree(parsed.nodes);
  const all = [{ address: "t1" }, { address: "t2", parent: "t1", state: "live", name: "sampler" }];
  const joined = joinAgents([{ address: "t1" }], tops);
  const childJoined = joinChildren(all.slice(1), tops, null, new Set(joined.values()));
  const skip = new Set([...joined.values(), ...childJoined.values()]);
  const live = hcChildItems(all, "t1", (term) => ({ node: childJoined.get(term.address) ?? null, recs: [], status: "idle" }), { skip });
  const root = sessionTree(joined.get("t1"), { skip, extra: live });
  const rowsOf = (it) => [it, ...it.children.flatMap(rowsOf)].filter((x) => x.type === "session");
  const placed = rowsOf(root).flatMap((r) => r.prs.map((p) => `${r.node.name}#${p.number}`)).sort();
  assert.deepEqual(placed, ["keep#55", "r78#50", "r78#55", "sampler#50"]);

  const shown = new Set([...shownNodes(new Map([...joined, ...childJoined])), ...shownKeys([root])]);
  const groups = openPrGroups(parsed.openPrs, tops, shown);
  assert.deepEqual(groups.map((g) => [g.repo, g.prs.map((p) => p.number).sort()]).sort(), [["owner/other", [1]], ["owner/repo", [51]]]);
});

test("live radar: shown-ness comes from the drawn keys alone", () => {
  const parsed = parseRadarDoc(JSON.stringify(doc));
  const tops = buildTree(parsed.nodes);
  const groups = openPrGroups(parsed.openPrs, tops, new Set(["k-r78", "k-sampler"]));
  const nums = groups.flatMap((g) => g.prs.map((p) => p.number));
  assert.equal(nums.filter((n) => n === 50).length, 0);
  assert.equal(nums.filter((n) => n === 55).length, 0);
});
