import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { world } = stubs;

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  return out;
};
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const idOf = (e) => String(e.props?.id ?? "");

const strip = { version: 1, at: "2026-11-20T10:00:00Z", cpu: { pct: 42, history: [10, 90], tone: "neutral" }, mem: { pct: 71, tone: "neutral" },
  level: { level: "high", reasons: ["load"] }, disks: [{ label: "/", usedPct: 78, freeGB: 52, tone: "neutral" }] };

function view(stripDoc) {
  world.agents = []; world.terminals = []; world.spaces = []; world.notices = [];
  const doc = parseRadarDoc(JSON.stringify({ v: 1, roots: [], ...(stripDoc === undefined ? {} : { strip: stripDoc }) }));
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  m.hotCard = null; m.seenChips = new Set(); m.vp = { width: 1200, height: 900 };
  m.radar = new Map([["local", { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: doc.openPrs, openPrsAt: null, strip: doc.strip ?? null, tried: Date.now() }]]);
  return m;
}

test("strip: drawn above the list, unfolded with the head line and the disk row", () => {
  const root = view(strip).render({});
  const all = walk(root);
  const at = all.findIndex((e) => idOf(e) === "strip");
  assert.ok(at > 0, "the strip is drawn");
  assert.ok(at < all.findIndex((e) => idOf(e) === "foreman-list"), "above the session list");
  const t = texts(all[at]).join("|");
  assert.match(t, /cpu /);
  assert.match(t, /71%/);
  assert.match(t, /load/, "the reason shows at high");
  assert.ok(all.some((e) => idOf(e) === "strip-disk:0"));
});

test("strip: a click on the head folds it to the summary, a second one opens it", () => {
  const m = view(strip);
  const head = (r) => walk(r).find((e) => idOf(e) === "strip-head");
  head(m.render({})).props.on_click({}, { notify() {} });
  assert.ok(m.folded.has("strip"));
  const folded = m.render({});
  assert.equal(walk(folded).some((e) => idOf(e) === "strip-disk:0"), false);
  assert.match(texts(head(folded)).join(""), /cpu 42%.*mem 71%.*● high/);
  head(folded).props.on_click({}, { notify() {} });
  assert.equal(m.folded.has("strip"), false);
});

test("strip: stale draws the one line, a missing strip draws nothing", () => {
  assert.match(texts(view({ stale: true }).render({})).join(""), /status: no main session measuring/);
  assert.equal(walk(view(undefined).render({})).some((e) => idOf(e) === "strip"), false);
});

test("strip: text parts are separate non-shrinking elements, bars are boxes, the head line wraps", () => {
  const doc = { ...strip, quotas: [{ key: "q", label: "Week", used: 1.6, pace: 0.5, resetsAt: "2026-11-26T20:00:00Z", tone: "red" }] };
  const root = view(doc).render({});
  const all = walk(root);
  const line = all.find((e) => idOf(e) === "strip-line");
  assert.ok(line.props.flex_wrap, "the head line wraps whole groups");
  const groups = line.kids;
  assert.equal(groups.length, 3, "cpu, mem and level are groups");
  for (const g of groups) assert.ok(g.props.flex_none);
  const textEls = (el) => walk(el).filter((e) => (e.kids ?? []).some((k) => typeof k === "string"));
  for (const e of [...textEls(line), ...textEls(all.find((x) => idOf(x) === "strip-disk:0")), ...textEls(all.find((x) => idOf(x) === "strip-quota:0"))]) {
    assert.ok(e.props.flex_none, `text ${JSON.stringify(e.kids)} does not shrink`);
  }
  const mem = groups[1];
  const track = mem.kids.find((k) => k.props.bg);
  assert.ok(track.props.bg && track.props.h === 6, "the track is a box");
  assert.equal(track.kids[0].props.w, "71%", "the fill is a box of the used share");
  assert.equal(texts(mem).join(""), "mem 71%");
  const spark = groups[0].kids.find((k) => k.kids.length === 2 && typeof k.kids[0] !== "string");
  assert.deepEqual(spark.kids.map((k) => k.props.h), [1, 11]);
  assert.equal(walk(root).some((e) => texts(e).some((s) => /[█░▁▂▃▄▅▆▇]/.test(s))), false, "no block glyphs");
  const q = all.find((x) => idOf(x) === "strip-quota:0");
  const qt = q.kids.find((k) => k.props.bg);
  assert.equal(qt.kids[0].props.w, "100%", "an overrun fills the track");
  assert.equal(qt.kids[1].props.w, 2, "the pace marker is 2 px wide");
  assert.equal(qt.kids[1].props.left, "50%");
  assert.ok(qt.props.flex_1 && qt.props.min_w === 24, "the usage bar takes the remaining width");
  assert.match(texts(q).join("|"), /160%/);
});
