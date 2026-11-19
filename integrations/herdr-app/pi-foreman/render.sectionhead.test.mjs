import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

const cx = { timer: { every() {} }, spawn() {}, notify() {} };

// The sample window (props.sample), as render.samplemany.test.mjs builds it.
function sampleView() {
  stubs.world.props = { sample: true };
  stubs.world.execCalls = [];
  stubs.world.agentOrder = [];
  const m = Object.create(Mod.prototype);
  m.init({}, cx);
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
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const idOf = (e) => String(e.props?.id ?? "");
const isSpaceHead = (e) => /^sp-/.test(idOf(e)) && e.kind === "h_flex";
const isOpHead = (e) => idOf(e) === "op-head";
// The label element of a heading: the child div whose text is the label (the Open PRs age is a second child).
const labelOf = (head, label) => walk(head).find((e) => e.kind === "div" && texts(e).includes(label));

// Two spaces on the local machine, one agent each, and one PR nobody owns (so Open PRs has a row).
function twoSpaces() {
  world.agents = [
    { address: "t1", pane: "p1", space: 1, space_name: "alpha", status: "idle", program: { name: "pi" } },
    { address: "t2", pane: "p2", space: 2, space_name: "beta", status: "idle", program: { name: "pi" } },
  ];
  world.terminals = [];
  world.spaces = [{ id: 1, machine: null }, { id: 2, machine: null }];
  world.notices = [];
  const openPrs = [{ repo: "example-org/orphan", number: 9, title: "Change 9", state: "open", headRefName: "feat/9", mergeable: "MERGEABLE", mergeState: "clean",
    url: "https://example.test/example-org/orphan/pull/9", checks: [{ n: "build", state: "ok" }] }];
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [], openPrs, openPrsAt: "2026-11-17T10:00:00Z" }));
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  m.hotCard = null; m.seenChips = new Set(); m.vp = { width: 1200, height: 900 };
  m.radar = new Map([["local", { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: doc.openPrs, openPrsAt: Date.now(), tried: Date.now() }]]);
  return m;
}

const SECTION = (el) => {
  assert.equal(el.props.text_size, 12, "text_size 12");
  assert.equal(el.props.font_semibold, true, "semibold");
  assert.equal(el.props.px, 8);
  assert.equal(el.props.pt, 8);
  assert.equal(el.props.h, 30);
};

test("sample window: Open PRs and every space-group heading share the look: 12 px semibold, label in t.muted", () => {
  const root = sampleView().render({});
  const op = walk(root).find(isOpHead);
  const spaces = walk(root).filter(isSpaceHead);
  assert.ok(op, "the Open PRs heading is drawn");
  assert.ok(spaces.length >= 1, "the sample draws at least one space group");
  for (const h of [op, ...spaces]) {
    SECTION(h);
    const label = labelOf(h, h === op ? "Open PRs" : texts(h)[0]);
    assert.ok(label, `label of ${idOf(h)}`);
    assert.equal(label.props.text_color, "#muted", `${idOf(h)} label colour`);
  }
});

test("sample window: Open PRs always has the rule; the first space group has none", () => {
  const root = sampleView().render({});
  const op = walk(root).find(isOpHead);
  assert.equal(op.props.border_t, 1, "Open PRs has a top rule");
  assert.equal(op.props.border_color, "#border");
  assert.equal(op.props.mt, 10, "more space above the rule than a repo group");
  const [first] = walk(root).filter(isSpaceHead);
  assert.equal(first.props.border_t, undefined, "the first space group has no rule");
});

test("two space groups: the first has no rule, a later one has it; Open PRs keeps its rule", () => {
  const root = twoSpaces().render({});
  const spaces = walk(root).filter(isSpaceHead);
  assert.deepEqual(spaces.map(idOf), ["sp-1", "sp-2"]);
  for (const h of spaces) SECTION(h);
  assert.equal(spaces[0].props.border_t, undefined, "first group: no rule");
  assert.equal(spaces[1].props.border_t, 1, "later group: rule");
  assert.equal(spaces[1].props.border_color, "#border");
  assert.equal(spaces[1].props.mt, 10);
  const op = walk(root).find(isOpHead);
  assert.equal(op.props.border_t, 1, "Open PRs: rule");
  assert.equal(labelOf(spaces[1], "beta").props.text_color, "#muted", "space label in t.muted");
});

test("the space label keeps its truncate; the Open PRs age text stays as a second child", () => {
  const m = twoSpaces();
  m.radar.get("local").openPrsAt = Date.now() - 120000;
  const root = m.render({});
  const space = walk(root).filter(isSpaceHead)[1];
  assert.equal(labelOf(space, "beta").props.truncate, true, "space label truncates");
  const op = walk(root).find(isOpHead);
  assert.ok(texts(op).includes("Open PRs"));
  assert.ok(op.kids.length >= 2, "the age element is a child of the Open PRs heading");
});
