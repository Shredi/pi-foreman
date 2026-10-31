import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { buildTree } = await import("./model.js");
const { sess, run, treeOf } = await import("./fixtures.mjs");

const term = (address, name, over = {}) => ({ address, name, state: "live", status: "idle", parent: "a/1", ...over });

// One paned agent; hc children: c/1 (working) with children c/3 (working), c/4 (idle); c/2 (idle) after it.
function render(radarRoot = null, addr = "a/1") {
  stubs.world.agents = [{ address: addr, pane: "p1", space: 1, space_name: "s", status: "idle", program: { name: "pi" } }];
  stubs.world.terminals = [
    { address: addr, state: "live" },
    term("c/1", "one", { status: "working", parent: addr }), term("c/2", "two", { parent: addr }),
    term("c/3", "three", { parent: "c/1", status: "working" }), term("c/4", "four", { parent: "c/1" }),
  ];
  const mod = Object.create(Mod.prototype);
  mod.changed = {}; mod.feed = []; mod.folded = new Set();
  mod.radar = new Map(radarRoot ? [["local", { ok: true, tree: [radarRoot], openPrs: [], tried: Date.now() }]] : []);
  mod.busy = new Map(); mod.recs = new Map(); mod.childPi = new Set();
  mod.poll = () => {};
  return { mod, root: mod.render({}) };
}

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  return out;
};
const conns = (root, kind) => walk(root).filter((e) => String(e.props.id ?? "").startsWith(`conn:${kind}:`)).map((e) => e.props.id);

test("middle children get a tee, the last child an elbow, continuing ancestors pass cells", () => {
  const { root } = render();
  assert.deepEqual(conns(root, "tee"), ["conn:tee:hc:c/1", "conn:tee:hc:c/3"]);
  assert.deepEqual(conns(root, "elbow"), ["conn:elbow:hc:c/4", "conn:elbow:hc:c/2"]);
  // c/1 and c/3 have later siblings: their column carries the line down past their rows and descendants
  assert.deepEqual(conns(root, "pass"), ["conn:pass:hc:c/1", "conn:pass:hc:c/3"]);
});

test("connector cells are 14px wide, stretch to the row's full height, 1px muted lines", () => {
  const { root } = render();
  const cols = walk(root).filter((e) => e.kind === "v_flex" && e.props.w === 14 && e.props.self_stretch);
  assert.ok(cols.length >= 4);
  const lines = walk(root).filter((e) => e.kind === "div" && e.props.w === 1 && e.props.absolute);
  assert.ok(lines.length > 0);
  for (const l of lines) assert.match(l.props.bg, /66$/);
  const elbow = walk(root).find((e) => e.props.rounded_bl === 4);
  assert.equal(elbow.props.border_l, 1);
  assert.equal(elbow.props.border_b, 1);
});

test("chevron on a parent, none on a leaf", () => {
  const { root } = render();
  const chev = walk(root).filter((e) => e.kind === "svg" && /chevron/.test(e.src));
  assert.equal(chev.length, 2, "agent row and c/1");
});

test("folding a parent closes its children", () => {
  const { mod } = render();
  mod.folded.add("hc:c/1");
  const root = mod.render({});
  const closed = walk(root).filter((e) => e.kind === "Collapsible" && typeof e.contentEl === "object" && e.props.open === false);
  assert.equal(closed.length, 1, "only c/1 is folded: " + closed.map((c) => c.kids[0]?.props.id));
  assert.equal(closed[0].kids[0].props.id, "row:hc:c/1");
});

test("a joined radar node is the agent's row: no second session row under it", () => {
  const f = treeOf(sess("f", "foreman-x", { hcTerminal: "t5", cost: 2 }, [run("b", "builder")]));
  const { root } = render(f, "t5");
  const b = walk(root).find((e) => e.kind === "Collapsible");
  const rows = walk(b).filter((e) => String(e.props.id ?? "").startsWith("row:"));
  assert.ok(!rows.some((e) => e.props.id === "row:foreman-x" || e.props.id === `row:${f.key}`), "root session row is gone");
  assert.ok(walk(b.kids[0]).some((e) => e === "$2.00" || e.kids?.includes?.("$2.00")), "cost sits on the agent row");
  assert.ok(rows.some((e) => /\/a0$/.test(e.props.id)), "its builder agent is still a row");
});

test("main.js has no box-drawing characters", () => {
  assert.ok(!/[\u2500-\u257f]/.test(readFileSync(new URL("./main.js", import.meta.url), "utf8")));
});
