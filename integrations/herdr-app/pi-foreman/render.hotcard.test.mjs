import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc } = await import("./model.js");

// Open PRs 100.. (example names) over `repos` repositories; `edit` may change an entry.
function feed(prs, repos = 1, edit = () => {}) {
  const openPrs = [];
  for (let i = 0; i < prs; i++) {
    const n = 100 + i;
    const e = { repo: `example-org/repo-${i % repos}`, number: n, title: `Change ${n}`, state: "open", headRefName: `feat/${n}`, mergeable: "MERGEABLE",
      url: `https://example.test/example-org/repo-${i % repos}/pull/${n}`, checks: [{ n: "build", state: "ok" }, { n: "lint", state: "fail" }] };
    edit(e);
    openPrs.push(e);
  }
  return parseRadarDoc(JSON.stringify({ v: 1, roots: [], openPrs, openPrsAt: "2026-11-17T10:00:00Z" })).openPrs;
}

function mod(openPrs) {
  stubs.world.agents = [];
  stubs.world.terminals = [];
  stubs.world.notices = [];
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.vp = { width: 1200, height: 900 };
  m.radar = new Map([["local", { ok: true, tree: [], openPrs, openPrsAt: Date.now(), tried: Date.now() }]]);
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
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const cardOf = (root, n) => cards(root).find((c) => texts(c.props.trigger).includes(`⎇ #${n}`));
const fullCards = (root) => cards(root).filter((c) => texts(c.contentEl).length > 0);
const counter = () => { const cx = { n: 0, notify() { cx.n++; } }; return cx; };
const hover = (root, n, cx, ev = {}) => cardOf(root, n).props.trigger.props.on_mouse_move(ev, cx);
// A pointer event over a chip: bounds, window position and position inside the chip.
const ev = (x, y) => ({ bounds: { width: 40, height: 16 }, position: { x: 100 + x, y: 200 + y }, local_position: { x, y } });

test("before any hover no chip holds a built card", () => {
  const root = mod(feed(4)).render({});
  assert.equal(cards(root).length, 4);
  assert.equal(fullCards(root).length, 0);
});

test("the hot chip's card holds the title and the jobs, no other card does", () => {
  const m = mod(feed(4));
  const cx = counter();
  hover(m.render({}), 101, cx);
  const root = m.render({});
  assert.deepEqual(fullCards(root).map((c) => c.props.trigger.props.id), [cardOf(root, 101).props.trigger.props.id]);
  const t = texts(cardOf(root, 101).contentEl);
  assert.ok(t.includes("Change 101"), "title");
  assert.ok(t.includes("lint") && t.includes("build"), "jobs");
});

test("the card id is the same for the same data and changes when the data changes", () => {
  const id = (openPrs) => { const m = mod(openPrs); hover(m.render({}), 100, counter()); return cardOf(m.render({}), 100).cardId; };
  const a = id(feed(2));
  assert.equal(id(feed(2)), a);
  assert.notEqual(id(feed(2, 1, (e) => { e.title = "Another title"; })), a);
});

test("the hot id follows the chip after a data change", () => {
  const m = mod(feed(3));
  hover(m.render({}), 101, counter());
  const before = cardOf(m.render({}), 101);
  m.radar.get("local").openPrs = feed(3, 1, (e) => { e.checks = [{ n: "build", state: "ok" }]; });
  const after = cardOf(m.render({}), 101);
  assert.notEqual(after.cardId, before.cardId, "content changed");
  assert.equal(after.props.trigger.props.id, before.props.trigger.props.id, "same chip id");
  assert.equal(m.hotCard, after.props.trigger.props.id);
  assert.ok(texts(after.contentEl).includes("Change 101"), "still built");
});

test("a hot id whose chip is gone is cleared by the next render", () => {
  const m = mod(feed(3));
  hover(m.render({}), 102, counter());
  assert.ok(m.hotCard);
  m.radar.get("local").openPrs = feed(2);
  const root = m.render({});
  assert.equal(m.hotCard, null);
  assert.equal(fullCards(root).length, 0);
});

test("moving the pointer to another chip moves the hot card", () => {
  const m = mod(feed(3));
  hover(m.render({}), 100, counter());
  assert.deepEqual(fullCards(m.render({})).map((c) => texts(c.props.trigger)[0]), ["⎇ #100"]);
  hover(m.render({}), 102, counter());
  assert.deepEqual(fullCards(m.render({})).map((c) => texts(c.props.trigger)[0]), ["⎇ #102"]);
});

test("one notify per hot change: repeated moves in the same chip with the same anchor stay quiet", () => {
  const m = mod(feed(3));
  const cx = counter();
  hover(m.render({}), 100, cx, ev(5, 5));
  assert.equal(cx.n, 1, "first rest on the chip");
  hover(m.render({}), 100, cx, ev(6, 5));
  hover(m.render({}), 100, cx, ev(7, 6));
  assert.equal(cx.n, 1, "same chip, same anchor");
  hover(m.render({}), 101, cx, ev(5, 5));
  assert.equal(cx.n, 2, "another chip");
});
