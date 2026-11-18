import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, buildTree, joinAgents, enrichPrs, chipPrs, prState } from "./model.js";

// After pane-resume the hc terminal's pid is the shell's (SHELL_PID); pi runs below it and the radar node carries pi's pid.
const SHELL_PID = 3457;
const PI_PID = 18312;
const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const ok = [{ n: "ci", state: "ok" }];
const url = (n) => `https://github.com/acme/app/pull/${n}`;
const agent = (address, pid) => ({ address, foreground: { pid } });
const session = (over = {}) => ({
  key: "fm-a", kind: "session", name: "a", state: "working", sym: "working", own: cost, tot: cost, age_s: 1, children: [],
  hcTerminal: "t1", pid: PI_PID, repo: "acme/app", branch: "feat", waits: [], ...over,
});
const prWait = { id: "pr_watch", kind: "pr", note: "1 pr watch", age_s: 0, left_s: 0, prs: [7] };
// The tracked entry is the only feed entry: the PR search is off.
const tracked = { number: 7, repo: "acme/app", title: "t", url: url(7), state: "open", author: "me", checks: ok, headRefName: "feat", tracked: true };
const radar = (roots, openPrs = []) => parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs }));

test("a live node joins its resumed agent by the terminal address, though the pids differ", () => {
  const doc = radar([session({ waits: [prWait] })], [tracked]);
  const node = joinAgents([agent("t1", SHELL_PID)], buildTree(doc.nodes)).get("t1");
  assert.equal(node?.key, "fm-a");
  // The row's PR pills: the render enriches the node's PRs from the feed, then takes the chips.
  const pills = chipPrs(enrichPrs(node.prs, doc.openPrs)).chips;
  assert.deepEqual(pills.map((p) => p.number), [7]);
  assert.equal(prState(pills[0]), "ok");
});

test("a stale node with another pid does not join by the address", () => {
  const doc = radar([session({ state: "stale" })]);
  assert.equal(joinAgents([agent("t1", SHELL_PID)], buildTree(doc.nodes)).size, 0);
  assert.equal(joinAgents([agent("t1", PI_PID)], buildTree(doc.nodes)).get("t1")?.key, "fm-a");
});

test("a lost node with another pid does not join by the address", () => {
  const doc = radar([session({ state: "lost" })]);
  assert.equal(joinAgents([agent("t1", SHELL_PID)], buildTree(doc.nodes)).size, 0);
  assert.equal(joinAgents([agent("t1", PI_PID)], buildTree(doc.nodes)).get("t1")?.key, "fm-a");
});

test("a live node with the same pid joins as before", () => {
  const doc = radar([session()]);
  assert.equal(joinAgents([agent("t1", PI_PID)], buildTree(doc.nodes)).get("t1")?.key, "fm-a");
  assert.equal(joinAgents([{ address: "t1" }], buildTree(doc.nodes)).get("t1")?.key, "fm-a");
});
