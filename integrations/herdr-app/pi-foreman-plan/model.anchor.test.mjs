import test from "node:test";
import assert from "node:assert/strict";
import { anchorAgent, childPlans, buildTree, joinAgents, planHint, noteHint, parseMeta, isReadablePath, dirOf, joinPath, isLight, isSafeHttpsUrl, openerArgv } from "./model.js";

const agent = (address, tab, pane) => ({ address, tab, pane });
const pane = (id, tab, terminal) => ({ pane: id, tab, terminal });

test("the tab's own agent is the anchor, wherever keyboard focus is", () => {
  const agents = [agent("t1", "tabA", "p1"), agent("t9", "tabB", "p9")];
  const panes = [pane("p1", "tabA", "t1"), pane("p9", "tabB", "t9")];
  assert.equal(anchorAgent(agents, panes, { tab: "tabA", pane: "p1", terminal: "t1" }), "t1");
  assert.equal(anchorAgent(agents, panes, { tab: "tabA", pane: null, terminal: "tFloat" }), "t1", "a floating window has no pane in the tab");
  assert.equal(anchorAgent(agents, panes, { tab: "tabB", pane: null, terminal: "tFloat", agent: "tFloat" }), "t9");
});

test("a pane-less agent (floating child) never owns the tab", () => {
  const agents = [agent("child", "tabA", ""), agent("child2", "tabA", undefined), agent("t1", "tabA", "p1")];
  assert.equal(anchorAgent(agents, null, { tab: "tabA", pane: null }), "t1");
  assert.equal(anchorAgent([agent("child", "tabA", "")], null, { tab: "tabA", pane: null }), null);
});

test("two agent panes in one tab: the focused pane's agent, else the previous anchor, else the first", () => {
  const agents = [agent("t1", "tabA", "p1"), agent("t2", "tabA", "p2")];
  assert.equal(anchorAgent(agents, null, { tab: "tabA", pane: "p2" }, "t1"), "t2");
  assert.equal(anchorAgent(agents, null, { tab: "tabA", pane: null }, "t2"), "t2");
  assert.equal(anchorAgent(agents, null, { tab: "tabA", pane: null }, "gone"), "t1");
});

test("a pane the panes() list does not place in the tab does not count; bad input answers null", () => {
  assert.equal(anchorAgent([agent("t1", "tabA", "p1")], [pane("p1", "tabZ", "t1")], { tab: "tabA", pane: "p1" }), null);
  assert.equal(anchorAgent(undefined, undefined, { tab: "tabA" }), null);
  assert.equal(anchorAgent([agent("t1", "tabA", "p1")], [], null), null);
  assert.equal(anchorAgent([agent("t1", "tabA", "p1")], [], {}), null);
});

const radar = () => [
  { key: "fm", kind: "session", name: "foreman", hcTerminal: "t1", pid: 5, state: "working", show: { dir: "/s/fm", plan: 3 }, children: [
    { key: "c1", kind: "session", name: "guard-prefix", parent: "fm", state: "working", show: { dir: "/s/c1", plan: 1 }, children: [
      { key: "g1", kind: "session", name: "grandchild", parent: "c1", state: "idle", show: { dir: "/s/g1", plan: 2, note: 1 }, children: [] }] },
    { key: "c2", kind: "session", name: "no-plan", parent: "fm", state: "idle", show: { dir: "/s/c2" }, children: [] },
  ] },
  { key: "c3", kind: "session", name: "perms-lean", parent: "fm", state: "working", show: { dir: "/s/c3", plan: 4 }, children: [] },
];

test("child plans join by the radar parent field, nested or flat, in radar order, only those with a plan", () => {
  const [top] = buildTree(radar());
  assert.deepEqual(childPlans(top).map((c) => c.label), ["guard-prefix", "grandchild", "perms-lean"]);
  assert.equal(planHint(top), 3);
  assert.equal(planHint({ show: { dir: "/x" } }), null);
  assert.equal(noteHint(top.sessions[0].sessions[0]), 1);
  assert.deepEqual(childPlans(null), []);
});

test("the tab's agent joins its radar node; the floating child joins its own, which is below the foreman", () => {
  const tops = buildTree(radar());
  const joined = joinAgents([{ address: "t1", pid: 5 }], tops);
  assert.equal(joined.get("t1").key, "fm");
});

test("plan.json: checked fields, capped strings, unreadable text is null", () => {
  const m = parseMeta(JSON.stringify({ path: "/p/plan-x.md", title: "T", v: 3, at: "2026-11-06T10:00:00Z", hash: "h", ruledPath: "/p/plan-x.md", ruledHash: "r", prevHash: "p", fences: ["a", 1, "b"] }));
  assert.deepEqual([m.path, m.title, m.v, m.hash, m.ruledPath, m.ruledHash, m.prevHash, m.fences], ["/p/plan-x.md", "T", 3, "h", "/p/plan-x.md", "r", "p", ["a", "b"]]);
  assert.equal(m.at, Date.parse("2026-11-06T10:00:00Z"));
  assert.equal(parseMeta("nope"), null);
  assert.equal(parseMeta("[]"), null);
  assert.equal(parseMeta(JSON.stringify({ path: null })).path, null);
  assert.equal(parseMeta(JSON.stringify({ path: "x".repeat(5000) })).path, null);
});

test("a document path must be absolute, end in .md and hold no parent step", () => {
  for (const ok of ["/a/b/plan-x.md", "C:\\a\\plan.md", "/a/plan.MD"]) assert.equal(isReadablePath(ok), true, ok);
  for (const bad of ["plan.md", "/a/plan.txt", "/a/../b.md", "", null, 5, "/a/b.md/c"]) assert.equal(isReadablePath(bad), false, String(bad));
});

test("paths: either separator, theme by luminance, link rules reused", () => {
  assert.equal(dirOf("/a/b/c.md"), "/a/b");
  assert.equal(dirOf("C:\\a\\b.md"), "C:\\a");
  assert.equal(joinPath("/a/b/", "plan.json"), "/a/b/plan.json");
  assert.equal(joinPath("C:\\a\\b", "plan.json"), "C:\\a\\b\\plan.json");
  assert.equal(isLight("#ffffff"), true);
  assert.equal(isLight("#101418"), false);
  assert.equal(isLight("nonsense"), false);
  assert.equal(isSafeHttpsUrl("https://example.org/x"), true);
  assert.equal(isSafeHttpsUrl("http://example.org/x"), false);
  assert.equal(isSafeHttpsUrl("javascript:alert(1)"), false);
  assert.deepEqual(openerArgv("darwin", "https://example.org/x"), ["open", "https://example.org/x"]);
  assert.equal(openerArgv("darwin", "file:///etc/passwd"), null);
});
