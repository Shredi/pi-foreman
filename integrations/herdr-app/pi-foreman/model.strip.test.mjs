import test from "node:test";
import assert from "node:assert/strict";
import { parseStrip, parseRadarDoc, sparkline, stripBar, quotaBar, resetText, stripRows, stripSummary } from "./model.js";

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

test("sparkline glyphs run from the lowest to the highest block", () => {
  assert.equal(sparkline([0, 100]), "▁█");
  assert.equal(sparkline([0, 14, 29, 43, 57, 71, 86, 100]), "▁▂▃▄▅▆▇█");
  assert.equal(sparkline([-9, 900, "x"]), "▁█▁");
  assert.equal(sparkline(null), "");
});

test("stripBar: 10 cells, rounded, clamped", () => {
  assert.equal(stripBar(0), "░░░░░░░░░░");
  assert.equal(stripBar(71), "███████░░░");
  assert.equal(stripBar(100), "██████████");
  assert.equal(stripBar(250), "██████████");
  assert.equal(stripBar(-1), "░░░░░░░░░░");
});

test("quotaBar: 15 cells, the pace marker takes the cell at pace", () => {
  assert.equal([...quotaBar(0.4, 0.5)].length, 15);
  assert.equal(quotaBar(0, 0), "│░░░░░░░░░░░░░░");
  assert.equal(quotaBar(0.4, 0.5), "██████░│░░░░░░░");
  assert.equal(quotaBar(0.4, 1), "██████░░░░░░░░│");
  assert.equal(quotaBar(0.4), "██████░░░░░░░░░", "no pace, no marker");
  assert.equal(quotaBar(0.4, null), "██████░░░░░░░░░");
});

test("quotaBar: an overrun is a full bar", () => {
  assert.equal(quotaBar(1.6), "███████████████");
  const rows = stripRows(parseStrip({ version: 1, quotas: [{ label: "Week", used: 1.6, pace: 0.5, tone: "red" }] }));
  assert.match(text(rows[0].segs), /160%/);
  assert.equal(rows[0].segs[1].tone, "red");
  assert.ok(rows[0].segs[1].text.startsWith("███████"));
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
  const head = text(rows[0].segs);
  assert.match(head, /cpu ▁▅█ +42%/);
  assert.match(head, /mem ███████░░░ 71%/);
  assert.match(head, /● ok/);
  assert.equal(rows[0].segs.find((s) => s.text.includes("71%")).tone, "amber");
  assert.match(text(rows[1].segs), /^\/ +████████░░ 78% +52 GB free$/);
  assert.match(text(rows[2].segs), /^D: +—$/);
  assert.match(text(rows[3].segs), /^Claude week +██████░│░░░░░░░ +41% +resets /);
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
  assert.equal(sum[1].tone, "amber");
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
