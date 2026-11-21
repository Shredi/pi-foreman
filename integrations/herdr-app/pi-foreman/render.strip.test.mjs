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

test("strip: traffic lights, a calm value draws green, dashes, a missing disk and the stale line stay dim", () => {
  const doc = { ...strip, level: { level: "ok", reasons: [] }, disks: [{ label: "/", usedPct: 78, freeGB: 52, tone: "neutral" }, { label: "/gone", missing: true, usedPct: null, freeGB: null, tone: "neutral" }],
    quotas: [{ key: "a", label: "Week", used: 0.3, pace: 0.5, resetsAt: null, tone: "neutral" }, { key: "b", label: "Five", used: null, pace: null, resetsAt: null, tone: "neutral" }] };
  const all = walk(view(doc).render({}));
  const byId = (id) => all.find((e) => idOf(e) === id);
  const green = (e) => {
    const els = walk(e);
    return {
      ink: els.find((x) => (x.kids ?? []).some((k) => typeof k === "string" && /%/.test(k)))?.props.text_color,
      bar: els.find((x) => x.props?.h === 6 && x.props?.bg)?.kids[0]?.props.bg,
      spark: els.find((x) => x.props?.items_end)?.kids[0]?.props.bg,
    };
  };
  const head = byId("strip-line");
  const cpu = green(head.kids[0]);
  const mem = green(head.kids[1]);
  const disk = green(byId("strip-disk:0"));
  const quota = green(byId("strip-quota:0"));
  const dim = byId("strip-disk:1").props.text_color;
  assert.ok(cpu.ink && cpu.ink !== dim, "cpu percent is not the muted grey");
  assert.equal(cpu.spark, cpu.ink, "the sparkline has the percent's colour");
  assert.equal(mem.bar, mem.ink);
  assert.equal(disk.bar, disk.ink);
  assert.equal(quota.bar, quota.ink);
  assert.equal(mem.ink, cpu.ink, "one green for all");
  const levelEls = walk(head.kids[2]).filter((e) => (e.kids ?? []).some((k) => typeof k === "string"));
  assert.ok(levelEls.length === 2 && levelEls.every((e) => e.props.text_color === cpu.ink), "the level dot and word at ok are green");
  for (const id of ["strip-disk:1", "strip-quota:1"]) {
    const dash = walk(byId(id)).filter((e) => (e.kids ?? []).includes("—"));
    assert.equal(dash.length, 1);
    assert.equal(dash[0].props.text_color, dim, `${id}: the dash stays dim`);
  }
  const stale = walk(view({ stale: true }).render({})).find((e) => (e.kids ?? []).some((k) => typeof k === "string" && /no main session/.test(k)));
  assert.equal(stale.props.text_color, dim, "the stale line stays dim");
});
