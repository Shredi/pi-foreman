import test from "node:test";
import assert from "node:assert/strict";

const { placeCard, prCardHeight, prCard } = await import("./model.js");

const view = { w: 1200, h: 800 };
const card = { w: 300, h: 200 };
const chip = (x, y) => ({ x, y, w: 60, h: 18 });

// The rectangle the card takes for an anchor (the host pins the named corner to the chip, then clamps into the window).
function cardRect(anchor, r, v = view) {
  let x, y;
  if (anchor === "top_center") { x = r.x + r.w / 2 - card.w / 2; y = r.y + r.h; }
  else if (anchor === "bottom_center") { x = r.x + r.w / 2 - card.w / 2; y = r.y - card.h; }
  else if (anchor === "left_center") { x = r.x + r.w; y = r.y + r.h / 2 - card.h / 2; }
  else { x = r.x - card.w; y = r.y + r.h / 2 - card.h / 2; }
  x = Math.min(Math.max(x, 8), v.w - card.w - 8);
  y = Math.min(Math.max(y, 8), v.h - card.h - 8);
  return { x, y, w: card.w, h: card.h };
}
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("room below: the card goes below the chip", () => {
  assert.equal(placeCard(chip(200, 100), view, card), "top_center");
});

test("near the bottom: above the chip", () => {
  assert.equal(placeCard(chip(200, 770), view, card), "bottom_center");
});

test("no room above or below: beside the chip, to its right when there is room, else its left", () => {
  const short = { w: 1200, h: 300 };
  assert.equal(placeCard(chip(100, 140), short, card), "left_center");
  assert.equal(placeCard(chip(1000, 140), short, card), "right_center");
});

test("the card never covers its chip, wherever the chip is", () => {
  for (let y = 0; y <= 780; y += 20) for (const x of [0, 150, 600, 1100, 1140]) {
    const r = chip(x, y);
    const a = placeCard(r, view, card);
    assert.ok(!overlaps(cardRect(a, r), r), `chip at ${x},${y} -> ${a}`);
  }
  const short = { w: 1200, h: 300 };
  for (let y = 0; y <= 280; y += 20) for (const x of [0, 600, 1140]) {
    const r = chip(x, y);
    const a = placeCard(r, short, card);
    assert.ok(!overlaps(cardRect(a, r, short), r), `short window, chip at ${x},${y} -> ${a}`);
  }
});

test("missing geometry falls back to below", () => {
  assert.equal(placeCard(null, view), "top_center");
  assert.equal(placeCard(chip(0, 0), { w: 0, h: 0 }), "top_center");
});

test("the card height estimate grows with the content", () => {
  const small = prCardHeight({ ...prCard({ number: 1, checks: [] }), more: "" });
  const big = prCardHeight({ ...prCard({ number: 1, title: "t", bodyText: "x ".repeat(80), mergeable: "CONFLICTING", checks: ["fail", "ok", "pending"] }), more: "also #2" });
  assert.ok(small > 60 && big > small + 80);
});

const { placeCardBox } = await import("./model.js");
const liveCard = () => ({
  ...prCard({ number: 132, title: "feat: real terminal rendering (colours, native scrollback, stable reading position)", bodyText: "word ".repeat(60), checks: [] }), more: "",
});

test("the live case (window 1866x1143, chip y 887 h 18, long wrapping title) puts the card above, bounded to fit", () => {
  const c = liveCard();
  const r = { x: 323, y: 887, w: 37, h: 18 };
  const { anchor, maxH } = placeCardBox(r, { w: 1866, h: 1143 }, { w: 300, h: prCardHeight(c) });
  assert.equal(anchor, "bottom_center");
  assert.ok(maxH <= r.y - 8 && maxH >= prCardHeight(c));
});

test("a chip high in the window keeps the card below", () => {
  const { anchor } = placeCardBox({ x: 323, y: 100, w: 37, h: 18 }, { w: 1866, h: 1143 }, { w: 300, h: prCardHeight(liveCard()) });
  assert.equal(anchor, "top_center");
});

test("the card max height never exceeds the room on its side", () => {
  const v = { w: 1200, h: 800 };
  for (let y = 0; y <= 780; y += 10) for (const h of [120, 300, 500, 900]) {
    const r = chip(300, y);
    const { anchor, maxH } = placeCardBox(r, v, { w: 300, h });
    const room = anchor === "top_center" ? v.h - 8 - (r.y + r.h) : anchor === "bottom_center" ? r.y - 8 : v.h - 16;
    assert.ok(maxH <= room, `y ${y} h ${h} ${anchor} ${maxH} > ${room}`);
  }
});

test("the estimate counts wrapped title lines", () => {
  const one = prCardHeight({ ...prCard({ number: 1, title: "short", checks: [] }), more: "" });
  const two = prCardHeight({ ...prCard({ number: 1, title: "x".repeat(120), checks: [] }), more: "" });
  assert.ok(two >= one + 32);
});
