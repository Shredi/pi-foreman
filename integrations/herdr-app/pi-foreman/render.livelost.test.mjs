import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { isEnded, parseRadarDoc, buildTree } = await import("./model.js");

// Shape of the real radar JSON and `hc ls` terminals: a pi-foreman session (t1m) with a child session whose terminal t52 is a
// pane-less live hc child. The child's heartbeat is late: radar says state "lost", glyph lost, no runs, no waits.
const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const child = (over = {}) => ({
  key: "fm-copilot-token-cache-33d451", kind: "session", name: "copilot-token-cache", role: null, rung: null, state: "lost", sym: "lost", glyph: "?",
  paneId: null, hcTerminal: "t52", pid: 71302, cwd: "/work/copilot-token-cache", age_s: 400, blocked_s: null, own: cost, tot: cost,
  done_children: 0, sid: "01a1b79c-3b3f-7143-a3ef-603957eba7a3", waits: [], started: 1794081833.968, children: [], ...over,
});
const top = (kid) => ({
  key: "01a15cfa", kind: "session", name: "pi-foreman", state: "idle", sym: "idle", glyph: "o", paneId: null, hcTerminal: "t1m", pid: 100,
  cwd: "/work/pi-foreman", age_s: 5, blocked_s: null, own: cost, tot: cost, sid: "s-top", waits: [], started: 1794000000, children: [kid],
});
const TERMS = [
  { address: "t1m", agent: "pi", cwd: "/work/pi-foreman", state: "live", status: "done", turn: 901, where: "pi-foreman / 1", foreground: { pid: 100 } },
  { address: "t52", agent: "pi", cwd: "/work/copilot-token-cache", name: "fm-copilot-token-cache-33d451", parent: "t1m", state: "live", status: "done", turn: 17 },
];

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  return out;
};
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const rowShown = (root) => walk(root).some((e) => String(e.props.id ?? "").startsWith("name:") && texts(e).includes("copilot-token-cache"));

function render(kid, terminals = TERMS) {
  stubs.world.agents = [{ address: "t1m", pane: "p1", space: 1, space_name: "s", status: "done", program: { name: "pi" } }];
  stubs.world.terminals = terminals;
  stubs.world.spaces = [];
  const d = parseRadarDoc(JSON.stringify({ v: 1, roots: [top(kid)] }));
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([["local", { ok: true, tree: buildTree(d.nodes), openPrs: [], tried: Date.now() }]]);
  mod.busy = new Map(); mod.recs = new Map(); mod.childPi = new Set(); mod.poll = () => {};
  return mod.render({});
}

test("(a) a lost child whose hc terminal is live stays in the sidebar", () => {
  assert.equal(rowShown(render(child())), true);
});

test("(b) a lost child with an open registry entry (regOpen) stays, with no live terminal", () => {
  const gone = TERMS.filter((t) => t.address !== "t52");
  assert.equal(rowShown(render(child({ regOpen: true }), gone)), true);
});

test("(c) a lost child with no live terminal and no open entry is still hidden", () => {
  const gone = TERMS.filter((t) => t.address !== "t52");
  assert.equal(rowShown(render(child(), gone)), false);
  assert.equal(rowShown(render(child(), [...gone, { ...TERMS[1], state: "dead" }])), false);
});

test("(d) a closed child is hidden even with a live terminal or regOpen", () => {
  assert.equal(rowShown(render(child({ state: "closed", sym: "idle" }))), false);
  assert.equal(rowShown(render(child({ state: "closed", sym: "idle", regOpen: true }))), false);
});

test("model: isEnded keeps a lost node that is liveHc or regOpen, ends the others", () => {
  assert.equal(isEnded({ state: "lost" }), true);
  assert.equal(isEnded({ state: "lost", liveHc: true }), false);
  assert.equal(isEnded({ state: "lost", regOpen: true }), false);
  assert.equal(isEnded({ state: "closed", regOpen: true, liveHc: true }), true);
  assert.equal(isEnded({ state: "finished", liveHc: true }), true);
});
