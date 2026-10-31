import test from "node:test";
import assert from "node:assert/strict";
import { parseRadar, buildTree, nodeStatus, sessionRows, treeItems, glyphSpec } from "./model.js";

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const session = (key, over = {}) => ({
  key, kind: "session", name: key, state: "idle", sym: "idle", glyph: "idle", hcTerminal: null, pid: null, own: cost, tot: cost,
  children: [], waits: [], tasks: [], ...over,
});
const run = (name, over = {}) => ({ key: `run:${name}`, kind: "run", name, role: name, state: "working", glyph: "working", own: cost, tot: cost, ended_s: null, children: [], ...over });
const node = (over) => buildTree(parseRadar(JSON.stringify({ roots: [session("s", over)] })))[0];

test("nodeStatus: hc root status decides", () => {
  assert.equal(nodeStatus(node({}), "working"), "working");
  assert.equal(nodeStatus(node({}), "blocked"), "blocked");
  assert.equal(nodeStatus(node({}), "done"), "done");
  assert.equal(nodeStatus(node({}), "idle"), "idle");
});

test("nodeStatus: blocked beats working", () => {
  assert.equal(nodeStatus(node({ sym: "needs-you" }), "working"), "blocked");
  assert.equal(nodeStatus(node({ asks: [{ n: 1, topic: "x" }] }), "working"), "blocked");
  assert.equal(nodeStatus(node({ children: [run("b")] }), "blocked"), "blocked");
});

test("nodeStatus: radar done is hidden, hc done is done", () => {
  assert.equal(nodeStatus(node({ state: "done" }), "working"), "hidden");
  assert.equal(nodeStatus(node({ state: "done" })), "hidden");
  assert.equal(nodeStatus(node({ state: "idle" }), "done"), "done");
});

test("nodeStatus: agents, bg and waiting in that order", () => {
  const all = { children: [run("builder")], tasks: [{ label: "npm test", ageSeconds: 70 }], waits: [{ note: "ci", kind: "ci", age_s: 5 }], sym: "waiting-external" };
  assert.equal(nodeStatus(node(all), "idle"), "agents");
  assert.equal(nodeStatus(node({ ...all, children: [run("old", { ended_s: 3, state: "done" })] }), "idle"), "bg");
  assert.equal(nodeStatus(node({ ...all, children: [], tasks: [] }), "idle"), "waiting");
  assert.equal(nodeStatus(node({ sym: "waiting-external" })), "waiting");
  assert.equal(nodeStatus(node({ waits: [{ kind: "t" }] })), "waiting");
  assert.equal(nodeStatus(node(all), "working"), "working");
});

test("nodeStatus: no join falls back to the radar state", () => {
  assert.equal(nodeStatus(node({ glyph: "working" })), "working");
  assert.equal(nodeStatus(node({ glyph: "starting" })), "working");
  assert.equal(nodeStatus(node({ glyph: "blocked" })), "blocked");
  assert.equal(nodeStatus(node({ state: "ask" })), "blocked");
  assert.equal(nodeStatus(node({})), "idle");
  assert.equal(nodeStatus(null), "idle");
});

test("glyphSpec: new states", () => {
  assert.deepEqual(glyphSpec("agents"), { kind: "spin", tone: "working", hollow: true, ms: 1800 });
  assert.deepEqual(glyphSpec("bg"), { kind: "square", tone: "working", hollow: false });
  assert.deepEqual(glyphSpec("waiting"), { kind: "dot", tone: "muted", hollow: true });
  assert.deepEqual(glyphSpec("nope"), { kind: "dot", tone: "dim", hollow: false });
});

test("sessionRows: text priority ask > agents > bg > wait", () => {
  const base = { children: [run("builder"), run("reviewer")], tasks: [{ label: "npm test", ageSeconds: 130 }], waits: [{ note: "ci", kind: "ci", age_s: 5 }] };
  assert.equal(sessionRows(node({ ...base, asks: [{ n: 2, topic: "ok?" }] })).ask, "ask 2: ok?");
  assert.equal(sessionRows(node(base)).ask, "2 agents: builder, reviewer");
  assert.equal(sessionRows(node({ ...base, children: [run("builder")] })).ask, "1 agent: builder");
  assert.equal(sessionRows(node({ ...base, children: [] })).ask, "bg: npm test 2m");
  assert.equal(sessionRows(node({ ...base, children: [], tasks: [] })).ask, "wait: ci 5s");
  assert.equal(sessionRows(node(base), "working").status, "working");
});

test("treeItems: ended sessions are hidden, other states are drawn", () => {
  const top = buildTree(parseRadar(JSON.stringify({ roots: [session("top", { children: [
    session("gone", { state: "done" }), session("live", { tasks: [{ label: "x", ageSeconds: 1 }] }),
  ] })] })))[0];
  const items = treeItems(top);
  assert.deepEqual(items.map((i) => i.label), ["live"]);
  assert.equal(items[0].status, "bg");
});
