import test from "node:test";
import assert from "node:assert/strict";
import { parseStrip, parseRadarDoc, sparkHeights, fillFraction, markerFraction, cutMiddle, resetText, stripRows, stripSummary } from "./model.js";

const doc = (strip, extra = {}) => JSON.stringify({ v: 1, roots: [], ...(strip === undefined ? {} : { strip }), ...extra });
const full = () => ({
  version: 1, at: "2026-11-20T10:00:00Z", sampleSeconds: 10,
  cpu: { pct: 42, history: [0, 50, 100], tone: "neutral" },
  mem: { pct: 71, usedMB: 1, totalMB: 2, tone: "amber" },
  level: { level: "ok", reasons: [] },
  disks: [{ label: "/", usedPct: 78, freeGB: 52.1, tone: "neutral" }, { label: "D:", missing: true }],
  quotas: [{ key: "claude:7d", label: "Claude week", used: 0.41, pace: 0.52, resetsAt: "2026-11-26T20:00:00Z", tone: "green" }, { key: "t:*", label: "team", used: null, tone: "neutral" }],
});
const text = (segs) => segs.map((s) => s.text).join("");

test("parseStrip: absent or foreign input gives null, stale gives the stale marker", () => {
  for (const v of [undefined, null, 3, "x", [], {}, { version: 2 }]) assert.equal(parseStrip(v), null);
  assert.deepEqual(parseStrip({ stale: true }), { stale: true });
});

test("parseStrip: bounds, clamping, unknown tones", () => {
  const raw = full();
  raw.cpu = { pct: 400, history: Array.from({ length: 500 }, (_, i) => (i === 499 ? -5 : 1000)), tone: "purple" };
  raw.mem = { pct: -3, tone: "green" };
  raw.disks = Array.from({ length: 30 }, (_, i) => ({ label: `d${i}`, usedPct: 150, freeGB: -4, tone: "x" }));
  raw.quotas = Array.from({ length: 40 }, () => ({ label: "q".repeat(200), used: 9, pace: 3, tone: "blue" }));
  raw.level = { level: "high", reasons: Array.from({ length: 20 }, () => "load") };
  const s = parseStrip(raw);
  assert.equal(s.cpu.pct, 100);
  assert.equal(s.cpu.history.length, 60);
  assert.ok(s.cpu.history.every((v) => v >= 0 && v <= 100));
  assert.equal(s.cpu.tone, "neutral");
  assert.equal(s.mem.pct, 0);
  assert.equal(s.mem.tone, "neutral", "green is no load tone");
  assert.equal(s.disks.length, 8);
  assert.equal(s.disks[0].usedPct, 100);
  assert.equal(s.disks[0].freeGB, 0);
  assert.equal(s.quotas.length, 12);
  assert.equal(s.quotas[0].used, 2);
  assert.equal(s.quotas[0].pace, 1);
  assert.equal(s.quotas[0].label.length, 40);
  assert.equal(s.quotas[0].tone, "neutral");
  assert.equal(s.level.reasons.length, 6);
});

test("parseStrip: a missing cpu pct stays null and parts that are off stay off", () => {
  const s = parseStrip({ version: 1, at: "2026-11-20T10:00:00Z", cpu: { history: [1] } });
  assert.equal(s.cpu.pct, null);
  assert.equal(s.mem, null);
  assert.equal(s.level, null);
  assert.deepEqual(s.disks, []);
  assert.deepEqual(s.quotas, []);
  assert.match(text(stripRows(s)[0].segs), /cpu .*—/);
});

test("sparkHeights: one px height per value, 1 to 12, oldest left, flat and empty histories", () => {
  assert.deepEqual(sparkHeights([0, 50, 100]), [1, 6, 12]);
  assert.deepEqual(sparkHeights([-9, 900, "x"]), [1, 12, 1]);
  assert.deepEqual(sparkHeights([0, 0, 0]), [1, 1, 1], "a flat zero history keeps visible bars");
  assert.deepEqual(sparkHeights([50, 50, 50]), [6, 6, 6]);
  assert.deepEqual(sparkHeights([]), []);
  assert.deepEqual(sparkHeights(null), []);
  assert.deepEqual(sparkHeights(Array.from({ length: 40 }, (_, i) => i)).length, 16, "only the newest 16");
  assert.deepEqual(sparkHeights([10, 100], 20), [2, 20]);
});

test("fillFraction: share of the track, clamped at overrun", () => {
  assert.equal(fillFraction(0), 0);
  assert.equal(fillFraction(71), 0.71);
  assert.equal(fillFraction(250), 1);
  assert.equal(fillFraction(-1), 0);
  assert.equal(fillFraction(0.4, 1), 0.4);
  assert.equal(fillFraction(1.6, 1), 1);
});

test("markerFraction: pace position on the track, null without pace", () => {
  assert.equal(markerFraction(0.5), 0.5);
  assert.equal(markerFraction(0), 0);
  assert.equal(markerFraction(3), 1);
  assert.equal(markerFraction(null), null);
  assert.equal(markerFraction(undefined), null);
});

test("quota overrun: full fill, red, real percent text, marker at pace", () => {
  const rows = stripRows(parseStrip({ version: 1, quotas: [{ label: "Week", used: 1.6, pace: 0.5, tone: "red" }] }));
  const bar = rows[0].segs.find((g) => g.bar);
  assert.deepEqual(bar.bar, { frac: 1, marker: 0.5 });
  assert.equal(bar.tone, "red");
  const pct = rows[0].segs.find((g) => g.text === "160%");
  assert.equal(pct.tone, "red");
});

test("resetText: weekday and time within 7 days, else day and month", () => {
  const now = new Date(2026, 10, 20, 12, 0).getTime();
  assert.equal(resetText(new Date(2026, 10, 26, 21, 5).getTime(), now), "resets Thu 21:05");
  assert.equal(resetText(new Date(2026, 10, 27, 12, 0).getTime(), now), "resets Fri 12:00", "exactly 7 days is within");
  assert.equal(resetText(new Date(2026, 11, 1, 9, 0).getTime(), now), "resets 1 Dec");
  assert.equal(resetText(null, now), "");
});

test("stripRows: head line, disk rows with dashes, quota rows with dash rows", () => {
  const now = new Date(2026, 10, 20, 12, 0).getTime();
  const rows = stripRows(parseStrip(full()), now);
  assert.deepEqual(rows.map((r) => r.id), ["head", "disk:0", "disk:1", "quota:0", "quota:1"]);
  const head = rows[0].segs;
  assert.equal(text(head), "cpu 42%mem 71%● ok");
  assert.deepEqual(head.find((g) => g.spark).spark, [1, 6, 12]);
  assert.deepEqual(head.find((g) => g.bar).bar, { frac: 0.71, marker: null });
  assert.equal(head.find((g) => g.text === "71%").tone, "amber");
  assert.deepEqual(head.map((g) => g.group), ["cpu", "cpu", "cpu", "mem", "mem", "mem", "level", "level"]);
  assert.match(text(rows[1].segs), /^\/ +78%52 GB free$/);
  assert.equal(rows[1].segs.find((g) => g.bar).bar.frac, 0.78);
  assert.match(text(rows[2].segs), /^D: +—$/);
  assert.match(text(rows[3].segs), /^Claude week +41%resets /);
  assert.deepEqual(rows[3].segs.find((g) => g.bar).bar, { frac: 0.41, marker: 0.52 });
  assert.match(text(rows[4].segs), /^team +—$/);
});

test("level dot: neutral when ok, amber at high and red at critical, with the reasons", () => {
  const mk = (level, reasons) => stripRows(parseStrip({ version: 1, level: { level, reasons } }))[0].segs;
  assert.deepEqual(mk("ok", []).map((s) => s.tone), ["neutral", "neutral"]);
  const high = mk("high", ["load", "mem"]);
  assert.equal(high[0].tone, "amber");
  assert.equal(text(high), "● load, mem");
  const crit = mk("critical", []);
  assert.equal(crit[0].tone, "red");
  assert.equal(text(crit), "● critical");
});

test("stale strip: one line with dashes, folded and unfolded", () => {
  const s = parseStrip({ stale: true });
  const rows = stripRows(s);
  assert.equal(rows.length, 1);
  assert.match(text(rows[0].segs), /^status: no main session measuring/);
  assert.match(text(rows[0].segs), /—/);
  assert.equal(text(stripSummary(s)), "status: no main session measuring");
  assert.deepEqual(stripRows(null), []);
  assert.deepEqual(stripSummary(null), []);
});

test("folded summary: cpu, memory and the level dot", () => {
  const sum = stripSummary(parseStrip(full()));
  assert.equal(text(sum), "cpu 42%  mem 71%  ● ok");
  assert.equal(sum[3].tone, "amber");
  const high = stripSummary(parseStrip({ ...full(), level: { level: "high", reasons: ["load"] } }));
  assert.equal(high.at(-1).tone, "amber");
  assert.equal(text(stripSummary(parseStrip({ version: 1, mem: { pct: 5 } }))), "mem 5%");
});

test("parseRadarDoc keeps the strip of the local document and ignores a remote one", () => {
  assert.equal(parseRadarDoc(doc(full())).strip.cpu.pct, 42);
  assert.deepEqual(parseRadarDoc(doc({ stale: true })).strip, { stale: true });
  assert.equal("strip" in parseRadarDoc(doc(full()), "remote-box"), false);
  assert.equal("strip" in parseRadarDoc(doc(undefined)), false);
  assert.equal("strip" in parseRadarDoc(doc("junk")), false);
});

test("stripRows: a long disk label is cut in the middle, a short one stays", () => {
  const path = "/home/user/Documents/git/repo";
  const rows = stripRows({ ...full(), disks: [{ label: path, usedPct: 10, freeGB: 1, tone: "neutral" }, { label: "/", usedPct: 1, freeGB: 1, tone: "neutral" }], quotas: [] });
  const label = rows.find((r) => r.id === "disk:0").segs[0].text.slice(0, -1);
  assert.equal(label.length, 18);
  assert.equal(label[0], "/");
  assert.ok(label.endsWith("git/repo"));
  assert.equal(label.split("…").length, 2);
  const short = rows.find((r) => r.id === "disk:1").segs[0].text;
  assert.equal(short, "/".padEnd(18) + " ");
  const fits = stripRows({ ...full(), disks: [{ label: "/Volumes/data", usedPct: 1, freeGB: 1, tone: "neutral" }], quotas: [] });
  assert.ok(fits.find((r) => r.id === "disk:0").segs[0].text.startsWith("/Volumes/data"));
  assert.ok(!fits.find((r) => r.id === "disk:0").segs[0].text.includes("…"));
});

test("a long disk path keeps its real end through parse and the middle cut", () => {
  const path = "/home/user/src/project.worktrees/status-strip";
  const s = parseStrip({ version: 1, disks: [{ label: path, usedPct: 87, freeGB: 119, tone: "neutral" }] });
  assert.equal(s.disks[0].label, path, "parse does not cut a path from its start");
  const label = stripRows(s).find((r) => r.id === "disk:0").segs[0].text.trim();
  assert.ok(label.endsWith("-strip"), label);
  assert.ok(label.endsWith("tatus-strip"), label);
  assert.equal(label.length, 18);
  assert.equal(label.split("…").length, 2);
  const huge = parseStrip({ version: 1, disks: [{ label: `/start/${"x".repeat(400)}/real-end`, usedPct: 1, freeGB: 1 }] }).disks[0].label;
  assert.ok(huge.length <= 200 && huge.endsWith("/real-end") && huge.startsWith("/start"));
});

test("cutMiddle: short text stays, long text keeps both ends", () => {
  assert.equal(cutMiddle("abc", 18), "abc");
  assert.equal(cutMiddle("abcdefghijklmnopqrstuvwxyz", 10), "abc…uvwxyz");
});

test("a null cpu or memory percent is a grey dash in the rows and the summary", () => {
  const s = parseStrip({ ...full(), cpu: { pct: null, history: [], tone: "neutral" }, mem: { pct: null, tone: "neutral" } });
  const head = stripRows(s).find((r) => r.id === "head").segs;
  for (const g of head.filter((x) => x.text === "—")) assert.notEqual(g.value, true);
  assert.ok(head.filter((x) => x.bar).every((x) => x.value !== true));
  const sum = stripSummary(s);
  assert.equal(text(sum), "cpu —  mem —  ● ok");
  assert.equal(sum.filter((x) => x.text === "—").length, 2);
  assert.ok(sum.filter((x) => x.text === "—").every((x) => x.value !== true));
});

test("folded summary: labels are neutral, numbers and the level dot are values", () => {
  const sum = stripSummary(parseStrip(full()));
  assert.deepEqual(sum.map((g) => [g.text, !!g.value]), [["cpu ", false], ["42%", true], ["  mem ", false], ["71%", true], ["  ●", true], [" ok", true]]);
});
