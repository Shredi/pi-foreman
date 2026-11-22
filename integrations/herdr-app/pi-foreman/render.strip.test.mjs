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

const strip = { version: 1, at: "2026-11-20T10:00:00Z", cpu: { pct: 42, history: [10, 90], tone: "neutral" }, mem: { pct: 71, usedMB: 26624, totalMB: 32768, tone: "neutral" },
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
  assert.match(t, /CPU/);
  assert.match(t, /71%/);
  assert.match(t, /26 \/ 32 GB/, "the memory row shows used and total");
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
  assert.match(texts(head(folded)).join(""), /● high.*CPU 42%.*Mem 71%.*Disk 78%/);
  head(folded).props.on_click({}, { notify() {} });
  assert.equal(m.folded.has("strip"), false);
});

test("strip: stale draws the one line, a missing strip draws nothing", () => {
  assert.match(texts(view({ stale: true }).render({})).join(""), /● no session measuring/);
  assert.equal(walk(view(undefined).render({})).some((e) => idOf(e) === "strip"), false);
});

test("strip: grid columns have fixed widths, names truncate, bars and the sparkline are boxes", () => {
  const doc = { ...strip, quotas: [{ key: "q", label: "Week", used: 1.6, pace: 0.5, resetsAt: "2026-11-26T20:00:00Z", tone: "red" }] };
  const root = view(doc).render({});
  const all = walk(root);
  const byId = (id) => all.find((e) => idOf(e) === id);
  for (const id of ["strip-cpu", "strip-mem", "strip-disk:0", "strip-quota:0"]) {
    const row = byId(id);
    assert.equal(row.props.min_w, 0, `${id}: the row can shrink`);
    assert.ok(row.props.overflow_hidden, `${id}: the row clips`);
    assert.equal(row.kids.length, 4, `${id}: name, bar, value, extra`);
    const [name, bar, value, extra] = row.kids;
    assert.equal(name.props.w, 74);
    assert.ok(name.props.truncate, `${id}: the name truncates`);
    assert.equal(value.props.w, 32);
    assert.ok(value.props.justify_end, `${id}: the value is right-aligned`);
    assert.equal(extra.props.w, 70);
    assert.ok(extra.props.truncate);
    assert.ok(bar.props.flex_1 && bar.props.min_w === 24, `${id}: the bar cell takes the rest`);
  }
  const memTrack = byId("strip-mem").kids[1];
  assert.ok(memTrack.props.bg && memTrack.props.h === 6, "the track is a box");
  assert.equal(memTrack.kids[0].props.w, "71%", "the fill is a box of the used share");
  assert.equal(texts(byId("strip-mem")).join("|"), "Memory|71%|26 / 32 GB");
  const spark = byId("strip-cpu").kids[1];
  assert.deepEqual(spark.kids.map((k) => k.props.h), [1, 11]);
  assert.equal(walk(root).some((e) => texts(e).some((s) => /[█░▁▂▃▄▅▆▇]/.test(s))), false, "no block glyphs");
  const q = byId("strip-quota:0");
  const qt = q.kids[1];
  assert.equal(qt.kids[0].props.w, "100%", "an overrun fills the track");
  assert.equal(qt.kids[1].props.w, 2, "the pace marker is 2 px wide");
  assert.equal(qt.kids[1].props.left, "50%");
  assert.match(texts(q).join("|"), /160%/);
  assert.equal(texts(q).join("|").includes("resets"), false, "the reset column has no label word");
});

test("strip: the head is found by field, so a strip of only disks or only quotas still draws its rows under a Status head", () => {
  const onlyDisks = walk(view({ version: 1, disks: [{ label: "/", usedPct: 5, freeGB: 1, tone: "neutral" }] }).render({}));
  assert.ok(onlyDisks.some((e) => idOf(e) === "strip-disk:0"), "the disk row is a row, not the head");
  assert.match(texts(onlyDisks.find((e) => idOf(e) === "strip-head")).join(""), /Status/);
  const onlyQuotas = walk(view({ version: 1, quotas: [{ key: "q", label: "Week", used: 0.2, tone: "green" }] }).render({}));
  assert.ok(onlyQuotas.some((e) => idOf(e) === "strip-quota:0"));
  assert.match(texts(onlyQuotas.find((e) => idOf(e) === "strip-head")).join(""), /Status/);
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
  const head = byId("strip-level");
  const cpu = green(byId("strip-cpu"));
  const mem = green(byId("strip-mem"));
  const disk = green(byId("strip-disk:0"));
  const quota = green(byId("strip-quota:0"));
  const dim = byId("strip-disk:1").props.text_color;
  assert.ok(cpu.ink && cpu.ink !== dim, "cpu percent is not the muted grey");
  assert.equal(cpu.spark, cpu.ink, "the sparkline has the percent's colour");
  assert.equal(mem.bar, mem.ink);
  assert.equal(disk.bar, disk.ink);
  assert.equal(quota.bar, quota.ink);
  assert.equal(mem.ink, cpu.ink, "one green for all");
  assert.equal(head.kids[0].props.text_color, cpu.ink, "the level dot and word at ok are green");
  for (const id of ["strip-disk:1", "strip-quota:1"]) {
    const dash = walk(byId(id)).filter((e) => (e.kids ?? []).includes("—"));
    assert.equal(dash.length, 1);
    assert.equal(dash[0].props.text_color, dim, `${id}: the dash stays dim`);
  }
  const stale = walk(view({ stale: true }).render({})).find((e) => (e.kids ?? []).some((k) => typeof k === "string" && /no session measuring/.test(k)));
  assert.equal(stale.props.text_color, dim, "the stale line stays dim");
});
