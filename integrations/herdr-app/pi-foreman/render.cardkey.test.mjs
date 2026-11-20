import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc } = await import("./model.js");

const openPrs = Array.from({ length: 40 }, (_, i) => ({
  repo: `example-org/r${i % 5}`, number: 100 + i, title: `Change ${i}`, state: "open", mergeable: "MERGEABLE", mergeState: "clean", bodyText: `Description ${i}`,
  url: `https://example.test/example-org/alpha/pull/${100 + i}`, checks: [{ n: "build", state: "fail" }],
}));

function mod() {
  stubs.world.agents = [];
  stubs.world.terminals = [];
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [], openPrs, openPrsAt: "2026-11-17T10:00:00Z" }));
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.vp = { width: 1200, height: 900 };
  m.radar = new Map([["local", { ok: true, tree: doc.nodes, openPrs: doc.openPrs, openPrsAt: Date.now(), tried: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  m.hotCard = null; m.seenChips = new Set();
  return m;
}
const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.kind === "HoverCard") walk(el.props.trigger, out);
  return out;
};
const cards = (root) => walk(root).filter((e) => e.kind === "HoverCard" && e.cardId !== "legend-card");

test("a render with 40 PR lines stringifies no card and builds the card content of no line before a hover", () => {
  const m = mod();
  const real = JSON.stringify;
  const dumped = [];
  JSON.stringify = (v, ...rest) => { if (v && typeof v === "object" && "excerpt" in v && "groups" in v) dumped.push(v); return real(v, ...rest); };
  let root;
  try { root = m.render({}); } finally { JSON.stringify = real; }
  assert.equal(cards(root).length, 40);
  assert.equal(dumped.length, 0, "no card object is stringified");
  assert.equal(cards(root).filter((c) => c.contentEl && c.contentEl.kind !== "div").length, 0, "no card view is built");
  assert.ok(cards(root).every((c) => c.props.trigger.props.tooltip.startsWith("#1")), "every line keeps its tooltip");
});

const idOf = (root, n) => cards(root).find((c) => c.cardId.includes(`-${n}-`)).cardId;

test("only the hot line builds its card view; the id follows the card's data", () => {
  const m = mod();
  let root = m.render({});
  const ev = { bounds: { width: 40, height: 16 }, position: { x: 100, y: 200 }, local_position: { x: 5, y: 5 } };
  cards(root).find((c) => c.cardId.includes("-103-")).props.trigger.props.on_mouse_move(ev, { notify() {} });
  root = m.render({});
  const built = cards(root).filter((c) => c.contentEl.kind !== "div");
  assert.equal(built.length, 1);
  assert.ok(built[0].cardId.includes("-103-"));
  const before = idOf(root, 103);
  assert.equal(idOf(m.render({}), 103), before, "the same data keeps the id");
  openPrs[3].title = "Renamed";
  try { assert.notEqual(idOf(mod().render({}), 103), before, "changed data is a new card"); } finally { openPrs[3].title = "Change 3"; }
});
