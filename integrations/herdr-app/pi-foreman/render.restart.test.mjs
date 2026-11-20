import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");

const cost = { in: 0, out: 0, cost: 0, uncached: 0 };
const node = (over) => ({ kind: "session", role: null, rung: null, glyph: "?", paneId: null, hcTerminal: null, pid: null, cwd: "/w", age_s: 5, blocked_s: null, own: cost, tot: cost, sid: "s", waits: [], started: 1794000000, children: [], ...over });
const kid = (over = {}) => node({ key: "fm-kid-1", name: "kid", state: "closed", sym: "done", restartable: true, child: "fm-kid-1", ...over });
const top = (k) => node({ key: "top", name: "top", state: "idle", sym: "idle", hcTerminal: "t1m", children: [k] });

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  return out;
};

function render(k) {
  stubs.world.agents = [{ address: "t1m", pane: "p1", space: 1, space_name: "s", status: "done", program: { name: "pi" } }];
  stubs.world.terminals = [{ address: "t1m", agent: "pi", cwd: "/w", state: "live", status: "done", turn: 1, foreground: { pid: 1 } }];
  stubs.world.spaces = [];
  stubs.world.execCalls = [];
  const d = parseRadarDoc(JSON.stringify({ v: 1, roots: [top(k)] }));
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([["local", { ok: true, tree: buildTree(d.nodes), openPrs: [], tried: Date.now() }]]);
  mod.busy = new Map(); mod.recs = new Map(); mod.childPi = new Set(); mod.poll = () => {}; mod.pressed = new Map();
  return { mod, root: mod.render({}) };
}
const buttons = (root) => walk(root).filter((e) => String(e.props.id ?? "").startsWith("restart:"));

test("an ended restartable child row has a Restart action that runs `foreman session restart <child id>`", async () => {
  const { root } = render(kid());
  const [b] = buttons(root);
  assert.ok(b, "a Restart element");
  assert.deepEqual(b.kids, ["Restart"]);
  const spawned = [];
  b.props.on_click(null, { spawn: (f) => spawned.push(f()), stop_propagation() {}, notify() {} });
  await Promise.all(spawned);
  assert.equal(stubs.world.execCalls.length, 1);
  const [, args] = stubs.world.execCalls[0];
  assert.deepEqual(args, ["session", "restart", "fm-kid-1"]);
});

test("a row without the radar flag, and a live one, have no Restart action", () => {
  assert.equal(buttons(render(kid({ restartable: false })).root).length, 0);
  assert.equal(buttons(render(kid({ state: "working", sym: "working", hcTerminal: "t9" })).root).length, 0);
});
