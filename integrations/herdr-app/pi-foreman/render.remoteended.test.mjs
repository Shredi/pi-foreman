import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { attachName } = await import("./model.js");
const { sess, treeOf } = await import("./fixtures.mjs");

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  return out;
};
const byId = (root, prefix) => walk(root).filter((e) => String(e.props.id ?? "").startsWith(prefix));
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const count = (root, text) => texts(root).filter((x) => x === text).length;

// Remote registry children of the local session p (listed as t5). Each follows the remote terminal `box1/<t>`; its local mirror
// terminal is `hc run --name` (parent t5), with the argv of its attach or without (then only its name tells it apart).
const KA = "fm-alpha-a1b2c3";
const KB = "fm-bravo-d4e5f6";
const child = (key, label, state, target) => sess(key, `${label}@box1`, { machine: "box1", hcTerminal: target, state, parent: "p" });
const mirror = (address, key, target, { argv = true, state = "live" } = {}) => ({
  address, state, name: attachName("box1", key), parent: "t5", agent: "pi", status: "done", ...(argv ? { argv: ["/x/hc", "attach", target] } : {}),
});

function render({ kids, mirrors = [] }) {
  stubs.world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } }];
  stubs.world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }, ...mirrors];
  stubs.world.spaces = [{ id: 1, machine: null }];
  stubs.world.execCalls = [];
  stubs.world.runCalls = [];
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map([
    ["local", { ok: true, tree: [treeOf(sess("p", "parent", { pid: 7, hcTerminal: "t5" }, kids))], openPrs: [], tried: Date.now() }],
    ["box1", { ok: false, tree: [], openPrs: [], tried: Date.now() }],
  ]);
  mod.busy = new Map(); mod.recs = new Map(); mod.childPi = new Set();
  mod.poll = () => {};
  return { mod, root: mod.render({}) };
}

// (a) The screenshot shape: two remote children, `idle` and `result delivered, idle` (the radar's state after a delivered result),
// each with its mirror terminal (agent pi, done). One row each, no fm- row, the header counts the parent and both children.
for (const argv of [true, false]) test(`(a) two remote children with mirrors (argv: ${argv}) are two rows, no fm- row, 3 sessions`, () => {
  const { root } = render({
    kids: [child(KA, "alpha-inventory", "idle", "box1/t1k"), child(KB, "bravo-prechecks", "result delivered, idle", "box1/t1m")],
    mirrors: [mirror("t3", KA, "box1/t1k", { argv }), mirror("t4", KB, "box1/t1m", { argv })],
  });
  assert.equal(count(root, "alpha-inventory@box1"), 1);
  assert.equal(count(root, "bravo-prechecks@box1"), 1);
  assert.equal(texts(root).filter((x) => x.startsWith("fm-")).length, 0);
  assert.equal(count(root, "3 sessions"), 1);
});

// (b) An ended remote child (closed, finished, lost) whose mirror terminal is still live: one dimmed row named as the session,
// with the machine chip, clicking it focuses the mirror. A live sibling is there so the header shows the count without the ended one.
for (const state of ["closed", "finished", "lost"]) for (const argv of [true, false]) test(`(b) a ${state} remote child with a live mirror (argv: ${argv}) is one dimmed row with its chip and address`, () => {
  const { root } = render({
    kids: [child(KA, "alpha-inventory", state, "box1/t1k"), child(KB, "bravo-prechecks", "working", "box1/t1m")],
    mirrors: [mirror("t3", KA, "box1/t1k", { argv })],
  });
  assert.equal(count(root, "alpha-inventory@box1"), 1, "the one row");
  const [row] = byId(root, "row:hc:t3");
  assert.ok(texts(row).includes("box1"), "its machine chip");
  assert.equal(texts(root).filter((x) => x.startsWith("fm-")).length, 0);
  const [name] = byId(root, "name:hc:t3");
  assert.equal(name.props.text_color, "#dim", "dimmed");
  name.props.on_click({}, { spawn: (fn) => fn() });
  assert.deepEqual(stubs.world.runCalls, [["terminal.peek", { terminal: "t3" }]]);
  assert.equal(count(root, "2 sessions"), 1, "the ended child is not counted");
});

// (c) An ended remote child with no live mirror: no row at all (as before the mirror rule); a closed mirror is no live one either.
for (const mirrors of [[], [mirror("t3", KA, "box1/t1k", { state: "closed" })]]) test(`(c) an ended remote child without a live mirror (${mirrors.length} mirror terminal) has no row`, () => {
  const { root } = render({
    kids: [child(KA, "alpha-inventory", "closed", "box1/t1k"), child(KB, "bravo-prechecks", "working", "box1/t1m")],
    mirrors,
  });
  assert.equal(count(root, "alpha-inventory@box1"), 0);
  assert.equal(texts(root).filter((x) => x.startsWith("fm-")).length, 0);
  assert.equal(count(root, "bravo-prechecks@box1"), 1);
});

// (d) A local child session (no machine, its hc terminal joined to it): one row, its registry row, as before.
test("(d) a local child session is one row, joined to its terminal", () => {
  const local = sess("fm-loc-a1b2c3", "local-child", { hcTerminal: "t9", state: "working", sym: "working", parent: "p" });
  const { root } = render({ kids: [local], mirrors: [{ address: "t9", state: "live", parent: "t5" }] });
  assert.equal(count(root, "local-child"), 1);
  assert.equal(byId(root, "row:hc:t9").length, 1, "its one row is joined to the terminal");
  assert.equal(byId(root, "name:hc:t9").length, 1, "one name, no second row of its terminal");
});

// (f) An ended remote node that keeps a live session below it keeps its dimmed registry row; the live mirror draws no second one.
test("(f) an ended remote node with a live session below it and a live mirror is one row, no fm- text", () => {
  const live = sess(KB, "bravo-prechecks", { state: "working", sym: "working", parent: KA });
  const kept = sess(KA, "alpha-inventory@box1", { machine: "box1", hcTerminal: "box1/t1k", state: "closed", parent: "p" }, [live]);
  const { root } = render({ kids: [kept], mirrors: [mirror("t3", KA, "box1/t1k")] });
  assert.equal(count(root, "alpha-inventory@box1"), 1);
  assert.equal(texts(root).filter((x) => x.startsWith("fm-")).length, 0);
});
