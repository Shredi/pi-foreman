import test from "node:test";
import assert from "node:assert/strict";
import { parseStrip, parseRadarDoc, sparkHeights, fillFraction, markerFraction, cutMiddle, resetText, stripRows, stripSummary, diskName } from "./model.js";

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
  const cpu = stripRows(s).rows[0];
  assert.equal(cpu.name, "CPU");
  assert.equal(cpu.value.text, "—");
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
  const row = stripRows(parseStrip({ version: 1, quotas: [{ label: "Week", used: 1.6, pace: 0.5, tone: "red" }] })).rows[0];
  assert.deepEqual(row.bar, { frac: 1, marker: 0.5 });
  assert.equal(row.value.text, "160%");
  assert.equal(row.value.tone, "red");
});

test("resetText: weekday and time within 7 days, else day and month", () => {
  const now = new Date(2026, 10, 20, 12, 0).getTime();
  assert.equal(resetText(new Date(2026, 10, 26, 21, 5).getTime(), now), "Thu 21:05");
  assert.equal(resetText(new Date(2026, 10, 27, 12, 0).getTime(), now), "Fri 12:00", "exactly 7 days is within");
  assert.equal(resetText(new Date(2026, 11, 1, 9, 0).getTime(), now), "1 Dec");
  assert.equal(resetText(null, now), "");
});

test("stripRows: head, then cpu, memory, disk and quota rows in columns with dash rows", () => {
  const now = new Date(2026, 10, 20, 12, 0).getTime();
  const { head, rows } = stripRows(parseStrip(full()), now);
  assert.deepEqual(head, { level: { text: "● ok", tone: "neutral" }, reasons: "", stale: false });
  assert.deepEqual(rows.map((r) => r.id), ["cpu", "mem", "disk:0", "disk:1", "quota:0", "quota:1"]);
  assert.deepEqual(rows.map((r) => r.kind), ["cpu", "mem", "disk", "disk", "quota", "quota"]);
  assert.deepEqual(rows.map((r) => r.name), ["CPU", "Memory", "Disk /", "Disk D:", "Claude week", "team"]);
  assert.deepEqual(rows[0].spark, [1, 6, 12]);
  assert.equal(rows[0].bar, null);
  assert.deepEqual(rows[0].value, { text: "42%", tone: "neutral", measured: true });
  assert.deepEqual(rows[1].bar, { frac: 0.71, marker: null });
  assert.deepEqual(rows[1].value, { text: "71%", tone: "amber", measured: true });
  assert.equal(rows[1].extra, "0 / 0 GB");
  assert.deepEqual(rows[2].bar, { frac: 0.78, marker: null });
  assert.equal(rows[2].value.text, "78%");
  assert.equal(rows[2].extra, "52 GB free");
  assert.equal(rows[3].bar, null, "a missing disk has an empty bar cell");
  assert.deepEqual(rows[3].value, { text: "—", tone: "neutral", measured: false });
  assert.equal(rows[3].extra, "not found");
  assert.deepEqual(rows[4].bar, { frac: 0.41, marker: 0.52 });
  assert.equal(rows[4].value.text, "41%");
  assert.match(rows[4].extra, /^\w{3} \d\d:\d\d$|^\d+ \w{3}$/);
  assert.equal(rows[5].bar, null);
  assert.deepEqual(rows[5].value, { text: "—", tone: "neutral", measured: false });
  assert.equal(rows[5].extra, "");
});

test("stripRows: the memory extra reads used and total in GB, empty without sizes", () => {
  const mem = (m) => stripRows(parseStrip({ version: 1, mem: m })).rows[0].extra;
  assert.equal(mem({ pct: 81, usedMB: 26 * 1024, totalMB: 32 * 1024, tone: "neutral" }), "26 / 32 GB");
  assert.equal(mem({ pct: 81, tone: "neutral" }), "");
});

test("stripRows: the head is there with the level off, with only disks and with only quotas", () => {
  const off = stripRows(parseStrip({ version: 1, cpu: { pct: 1, history: [], tone: "neutral" } }));
  assert.equal(off.head.level, null, "the head reads Status");
  assert.equal(off.rows[0].spark, null, "no history, no sparkline");
  const disks = stripRows(parseStrip({ version: 1, disks: [{ label: "/", usedPct: 5, freeGB: 1, tone: "neutral" }] }));
  assert.equal(disks.head.level, null);
  assert.deepEqual(disks.rows.map((r) => r.id), ["disk:0"]);
  const quotas = stripRows(parseStrip({ version: 1, quotas: [{ label: "Week", used: 0.2, tone: "green" }] }));
  assert.equal(quotas.head.level, null);
  assert.deepEqual(quotas.rows.map((r) => r.id), ["quota:0"]);
  assert.equal(stripRows(parseStrip({ version: 1 })), null, "nothing to draw");
});

test("level dot: neutral when ok, amber at high and red at critical, with the reasons beside it", () => {
  const mk = (level, reasons) => stripRows(parseStrip({ version: 1, level: { level, reasons } })).head;
  assert.deepEqual(mk("ok", ["load"]), { level: { text: "● ok", tone: "neutral" }, reasons: "", stale: false });
  const high = mk("high", ["load", "mem"]);
  assert.deepEqual(high.level, { text: "● high", tone: "amber" });
  assert.equal(high.reasons, "load, mem");
  const crit = mk("critical", []);
  assert.deepEqual(crit.level, { text: "● critical", tone: "red" });
  assert.equal(crit.reasons, "");
});

test("stale strip: the no-session line, no rows, folded and unfolded", () => {
  const s = parseStrip({ stale: true });
  const { head, rows } = stripRows(s);
  assert.equal(head.stale, true);
  assert.equal(head.level.text, "● no session measuring");
  assert.equal(head.level.tone, "neutral");
  assert.deepEqual(rows, []);
  assert.equal(text(stripSummary(s)), "● no session measuring");
  assert.equal(stripRows(null), null);
  assert.deepEqual(stripSummary(null), []);
});

test("folded summary: the level dot, cpu, memory and the first disk", () => {
  const sum = stripSummary(parseStrip(full()));
  assert.equal(text(sum), "● ok  CPU 42%  Mem 71%  Disk 78%");
  assert.equal(sum[4].tone, "amber");
  const high = stripSummary(parseStrip({ ...full(), level: { level: "high", reasons: ["load"] } }));
  assert.equal(high[0].tone, "amber");
  assert.equal(text(stripSummary(parseStrip({ version: 1, mem: { pct: 5 } }))), "Mem 5%");
  assert.equal(text(stripSummary(parseStrip({ ...full(), disks: [{ label: "/x", missing: true }] }))), "● ok  CPU 42%  Mem 71%  Disk —");
  assert.equal(text(stripSummary(parseStrip({ version: 1, quotas: [{ label: "Week", used: 0.2, tone: "green" }] }))), "Status", "none of the parts is on");
});

test("parseRadarDoc keeps the strip of the local document and ignores a remote one", () => {
  assert.equal(parseRadarDoc(doc(full())).strip.cpu.pct, 42);
  assert.deepEqual(parseRadarDoc(doc({ stale: true })).strip, { stale: true });
  assert.equal("strip" in parseRadarDoc(doc(full()), "remote-box"), false);
  assert.equal("strip" in parseRadarDoc(doc(undefined)), false);
  assert.equal("strip" in parseRadarDoc(doc("junk")), false);
});

test("disk rows are named by a short name, never by the path", () => {
  const row = (label, auto) => stripRows({ ...full(), cpu: null, mem: null, level: null, quotas: [], disks: [{ label, usedPct: 10, freeGB: 1, tone: "neutral", ...(auto ? { auto: true } : {}) }] }).rows[0].name;
  assert.equal(row("/home/user/Documents/git/repo", true), "Disk");
  assert.equal(row("/home/user/Documents/git/repo", false), "Disk repo");
  assert.equal(row("/", false), "Disk /");
});

test("a disk keeps its auto flag through parse; a long path keeps its real end", () => {
  const path = "/home/user/src/project.worktrees/status-strip";
  const s = parseStrip({ version: 1, disks: [{ label: path, usedPct: 87, freeGB: 119, tone: "neutral", auto: true }, { label: "/", missing: true }] });
  assert.equal(s.disks[0].label, path, "parse does not cut a path from its start");
  assert.equal(s.disks[0].auto, true);
  assert.equal(s.disks[1].auto, false);
  const huge = parseStrip({ version: 1, disks: [{ label: `/start/${"x".repeat(400)}/real-end`, usedPct: 1, freeGB: 1 }] }).disks[0].label;
  assert.ok(huge.length <= 200 && huge.endsWith("/real-end") && huge.startsWith("/start"));
});

test("diskName: auto is empty, drive forms and WSL mounts are C:, else the last folder", () => {
  assert.equal(diskName("/anything/at/all", true), "");
  assert.equal(diskName("/"), "/");
  for (const raw of ["C:", "c:", "c:/", "C:\\", "/mnt/c", "/mnt/c/", "/mnt/C"]) assert.equal(diskName(raw), "C:", raw);
  assert.equal(diskName("/mnt/d/"), "D:");
  assert.equal(diskName("D:\\data"), "data");
  assert.equal(diskName("\\\\server\\share"), "share");
  assert.equal(diskName("/mnt/wsl/build"), "build");
  assert.equal(diskName("/home/user/src/project.worktrees/sidebar-strip"), "sidebar-strip");
  assert.equal(diskName("/Volumes/data/"), "data");
});

test("cutMiddle: short text stays, long text keeps both ends", () => {
  assert.equal(cutMiddle("abc", 18), "abc");
  assert.equal(cutMiddle("abcdefghijklmnopqrstuvwxyz", 10), "abc…uvwxyz");
});

test("a null cpu or memory percent is a dim dash in the rows and the summary", () => {
  const s = parseStrip({ ...full(), cpu: { pct: null, history: [], tone: "neutral" }, mem: { pct: null, tone: "neutral" } });
  const rows = stripRows(s).rows;
  for (const r of rows.slice(0, 2)) assert.deepEqual(r.value, { text: "—", tone: "neutral", measured: false });
  assert.equal(rows[1].bar, null);
  const sum = stripSummary(s);
  assert.equal(text(sum), "● ok  CPU —  Mem —  Disk 78%");
  assert.equal(sum.filter((x) => x.text === "—").length, 2);
  assert.ok(sum.filter((x) => x.text === "—").every((x) => x.value !== true));
});

test("folded summary: labels are neutral, numbers and the level dot are values", () => {
  const sum = stripSummary(parseStrip({ ...full(), disks: [] }));
  assert.deepEqual(sum.map((g) => [g.text, !!g.value]), [["● ok", true], ["  CPU ", false], ["42%", true], ["  Mem ", false], ["71%", true]]);
});
