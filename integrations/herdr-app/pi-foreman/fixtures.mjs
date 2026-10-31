// Shared fixtures of the preview tests: radar nodes as `parseRadarDoc` reads them.
import { parseRadarDoc, buildTree } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
export const sess = (key, name, over = {}, children = []) => ({ key, kind: "session", name, state: "idle", sym: "idle", own: { ...cost, cost: over.cost ?? 0 }, tot: cost, age_s: 100, children, ...over });
export const run = (key, role, over = {}) => ({ key, kind: "run", name: role, role, state: "working", sym: "working", own: cost, tot: cost, age_s: 10, children: [], model: "claude-bridge/claude-haiku-5-5:medium", ...over });

/** The tree top of radar roots. */
export function treeOf(root) {
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [root] }));
  return buildTree(doc.nodes)[0];
}
