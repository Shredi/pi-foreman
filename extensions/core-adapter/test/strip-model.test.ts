import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOUR_MS, WEEK_MS, arrangeRows, claudeValues, cpuPercent, diskDoc, diskPathOf, forecastRed, memDoc, paceOf, parseClaudeHeaders, parseSourceOutput,
  parseTime, periodOf, pushHistory, quotaDoc, quotaTone, recordSample, sampleSpacingMs, samplesOf, stripConfigOf, toneFree, toneLoad,
} from "../strip-model.ts";
import type { CpuTimes, QuotaValue, Sample } from "../strip-model.ts";

const cpu = (...cores: [number, number][]): CpuTimes[] => cores.map(([busy, idle]) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }));

test("cpu: delta of two snapshots over all cores; no base or no change gives no value", () => {
  assert.equal(cpuPercent(null, cpu([10, 90])), null);
  assert.equal(cpuPercent(cpu([10, 90]), cpu([10, 90])), null);
  assert.equal(cpuPercent(cpu([0, 0], [0, 0]), cpu([50, 50], [0, 100])), 25);
  assert.equal(cpuPercent(cpu([0, 0]), cpu([5, 5], [1, 1])), null, "core count changed");
  assert.equal(cpuPercent(cpu([0, 0]), cpu([100, 0])), 100);
});

test("cpu history is capped at the sparkline length", () => {
  let h: number[] = [];
  for (let i = 0; i < 20; i++) h = pushHistory(h, i, 12);
  assert.equal(h.length, 12);
  assert.deepEqual(h.slice(-2), [18, 19]);
});

test("memory used percent and tone: below the minimum amber, below half red", () => {
  assert.deepEqual(memDoc(16384, 4754, 1024), { pct: 71, usedMB: 11630, totalMB: 16384, tone: "neutral" });
  assert.equal(memDoc(16384, 1000, 1024)?.tone, "amber");
  assert.equal(memDoc(16384, 511, 1024)?.tone, "red");
  assert.equal(memDoc(0, 1, 1024), null);
  assert.equal(toneFree(1024, 1024), "neutral");
});

test("cpu tone from the 1-minute load: over the limit amber, over twice red, none neutral", () => {
  assert.equal(toneLoad(1.5, 1.5), "neutral");
  assert.equal(toneLoad(1.6, 1.5), "amber");
  assert.equal(toneLoad(3.1, 1.5), "red");
  assert.equal(toneLoad(undefined, 1.5), "neutral");
});

test("disk: used percent, free GB, tone; a probe that fails or returns junk is missing", () => {
  const gb = 1024 ** 3;
  const d = diskDoc("/", () => ({ bsize: 4096, blocks: (100 * gb) / 4096, bfree: (22 * gb) / 4096, bavail: (22 * gb) / 4096 }), 5);
  assert.deepEqual(d, { label: "/", usedPct: 78, freeGB: 22, tone: "neutral" });
  assert.equal(diskDoc("/", () => ({ bsize: 4096, blocks: (100 * gb) / 4096, bfree: (4 * gb) / 4096, bavail: (4 * gb) / 4096 }), 5).tone, "amber");
  assert.equal(diskDoc("/", () => ({ bsize: 4096, blocks: (100 * gb) / 4096, bfree: (2 * gb) / 4096, bavail: (2 * gb) / 4096 }), 5).tone, "red");
  assert.deepEqual(diskDoc("D:", () => { throw new Error("ENOENT"); }, 5), { label: "D:", missing: true });
  assert.deepEqual(diskDoc("D:", () => ({ bsize: 0, blocks: 0, bfree: 0, bavail: 0 }), 5), { label: "D:", missing: true });
});

test("a bare drive letter becomes its root on win32 only", () => {
  assert.equal(diskPathOf("C:", "win32"), "C:\\");
  assert.equal(diskPathOf("C:\\data", "win32"), "C:\\data");
  assert.equal(diskPathOf("C:", "linux"), "C:");
  assert.equal(diskPathOf("/data", "darwin"), "/data");
});

test("times and periods: week, month by calendar, periodStart, seconds, no reset gives none", () => {
  assert.equal(parseTime("2026-12-01T00:00:00Z"), Date.UTC(2026, 11, 1));
  assert.equal(parseTime(1_795_000_000), 1_795_000_000_000);
  assert.equal(parseTime(1_795_000_000_000), 1_795_000_000_000);
  assert.equal(parseTime("nope"), null);
  assert.equal(parseTime(-1), null);
  const reset = Date.UTC(2026, 11, 1);
  assert.equal(periodOf("7d", undefined, reset), WEEK_MS);
  assert.equal(periodOf("5h", undefined, reset), 5 * HOUR_MS);
  assert.equal(periodOf("day", undefined, reset), 24 * HOUR_MS);
  assert.equal(periodOf("month", undefined, reset), 30 * 24 * HOUR_MS, "november has 30 days");
  assert.equal(periodOf("month", undefined, Date.UTC(2026, 2, 1)), 28 * 24 * HOUR_MS);
  assert.equal(periodOf(3600, undefined, reset), HOUR_MS);
  assert.equal(periodOf(undefined, "2026-11-24T00:00:00Z", reset), 7 * 24 * HOUR_MS);
  assert.equal(periodOf("7d", undefined, null), null);
  assert.equal(periodOf(undefined, undefined, reset), null);
});

test("pace is the share of the period passed, clamped; none without reset or period", () => {
  const reset = 1_000_000;
  assert.equal(paceOf(reset - 500, reset, 1000), 0.5);
  assert.equal(paceOf(reset + 5, reset, 1000), 1);
  assert.equal(paceOf(reset - 5000, reset, 1000), 0);
  assert.equal(paceOf(5, null, 1000), null);
  assert.equal(paceOf(5, reset, null), null);
});

const week = (used: number, resetsAt: number | null, periodMs: number | null = WEEK_MS): QuotaValue => ({ key: "claude:7d", label: "Claude week", used, resetsAt, periodMs });

test("quota tone: green below pace, amber more than 10 points ahead, red at 100 %, no marker neutral", () => {
  const now = Date.UTC(2026, 10, 21);
  const reset = now + WEEK_MS / 2;
  assert.equal(quotaDoc(week(0.55, reset), now, []).tone, "green");
  assert.equal(quotaDoc(week(0.6, reset), now, []).tone, "green", "exactly 10 points is not ahead");
  assert.equal(quotaDoc(week(0.61, reset), now, []).tone, "amber");
  assert.equal(quotaDoc(week(1, reset), now, []).tone, "red");
  assert.equal(quotaDoc(week(1.3, reset), now, []).tone, "red");
  assert.equal(quotaDoc(week(1.3, reset), now, []).used, 1.3, "the real number is kept");
  assert.equal(quotaDoc(week(0.2, null, null), now, []).tone, "neutral");
  assert.equal(quotaDoc(week(0.2, null, null), now, []).pace, undefined);
  assert.equal(quotaDoc(week(0.2, reset), now, []).pace, 0.5);
  assert.equal(quotaTone(1.5, null, false), "red");
});

test("a value whose reset has passed, or without a value, is a dash row", () => {
  const now = Date.UTC(2026, 10, 21);
  assert.deepEqual(quotaDoc(week(0.5, now - 1), now, []), { key: "claude:7d", label: "Claude week", used: null, tone: "neutral" });
  assert.equal(quotaDoc({ ...week(0.5, now + 1), used: null }, now, []).used, null);
});

test("forecast: a steep recent slope turns the week red, a slow one does not, too little history never", () => {
  const now = Date.UTC(2026, 10, 21);
  const reset = now + 3 * 24 * HOUR_MS;
  const win = WEEK_MS / 7;
  const at = (offsetMs: number): number => Math.round((now - offsetMs) / 1000);
  const steep: Sample[] = [[at(win - 1000), 0.4], [at(win / 2), 0.5], [at(0), 0.6]];
  assert.equal(forecastRed(steep, 0.6, now, reset, WEEK_MS), true);
  assert.equal(quotaDoc(week(0.6, reset), now, steep).tone, "red");
  const slow: Sample[] = [[at(win - 1000), 0.4], [at(win / 2), 0.401], [at(0), 0.402]];
  assert.equal(forecastRed(slow, 0.402, now, reset, WEEK_MS), false);
  assert.equal(forecastRed([[at(10), 0.2]], 0.9, now, reset, WEEK_MS), false, "one point");
  assert.equal(forecastRed([[at(60_000), 0.1]], 0.9, now, reset, WEEK_MS), false, "span under half the window");
  assert.equal(forecastRed([], 0.9, now, reset, WEEK_MS), false);
  const falling: Sample[] = [[at(win - 1000), 0.6], [at(0), 0.5]];
  assert.equal(forecastRed(falling, 0.5, now, reset, WEEK_MS), false);
});

test("sample spacing is a 200th of the period (one hour without), the newest 200 are kept", () => {
  assert.equal(sampleSpacingMs(WEEK_MS), WEEK_MS / 200);
  assert.equal(sampleSpacingMs(5 * HOUR_MS), (5 * HOUR_MS) / 200);
  assert.equal(sampleSpacingMs(null), HOUR_MS);
  let s: Sample[] = [];
  s = recordSample(s, 1000, 0.1, 5 * HOUR_MS);
  s = recordSample(s, 1060, 0.2, 5 * HOUR_MS);
  assert.equal(s.length, 1, "60 s is under the 90 s spacing");
  s = recordSample(s, 1091, 0.2, 5 * HOUR_MS);
  assert.equal(s.length, 2);
  let big: Sample[] = [];
  for (let i = 0; i < 300; i++) big = recordSample(big, i * 10_000, 0.1, WEEK_MS);
  assert.equal(big.length, 200);
  assert.equal(big[199][0], 299 * 10_000);
});

test("claude headers: 7d and 5h, unknown window by its raw name, bad values and half pairs make no row", () => {
  const h = {
    "anthropic-ratelimit-unified-7d-utilization": "0.06",
    "anthropic-ratelimit-unified-7d-reset": "1795000000",
    "Anthropic-Ratelimit-Unified-5h-Utilization": "0.5",
    "Anthropic-Ratelimit-Unified-5h-Reset": "1794990000",
    "anthropic-ratelimit-unified-opus-utilization": "0.2",
    "anthropic-ratelimit-unified-opus-reset": "1795000000",
    "anthropic-ratelimit-unified-bad-utilization": "41",
    "anthropic-ratelimit-unified-bad-reset": "1795000000",
    "anthropic-ratelimit-unified-nores-utilization": "0.1",
    "anthropic-ratelimit-unified-onlyreset-reset": "1795000000",
    "anthropic-ratelimit-unified-overage-reset": "1795000000",
    "anthropic-ratelimit-unified-overage-utilization": "0.1",
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-UP PER-utilization": "0.1",
    "anthropic-ratelimit-unified-neg-utilization": "-0.1",
    "anthropic-ratelimit-unified-neg-reset": "1795000000",
  };
  assert.deepEqual(parseClaudeHeaders(h), {
    "7d": { used: 0.06, resetsAt: 1795000000 },
    "5h": { used: 0.5, resetsAt: 1794990000 },
    opus: { used: 0.2, resetsAt: 1795000000 },
  });
  assert.deepEqual(parseClaudeHeaders({}), {});
  assert.deepEqual(parseClaudeHeaders(null), {});
  assert.deepEqual(parseClaudeHeaders({ "anthropic-ratelimit-unified-7d-utilization": "2.5", "anthropic-ratelimit-unified-7d-reset": "1795000000" }), {}, "above 2 is rejected, never rescaled");
  assert.deepEqual(Object.keys(parseClaudeHeaders({ "anthropic-ratelimit-unified-7d-utilization": "1.3", "anthropic-ratelimit-unified-7d-reset": "1795000000" })), ["7d"], "1.3 is an overrun");
});

test("claude rows: labels, periods and order", () => {
  const rows = claudeValues({ opus: { used: 0.1, resetsAt: 1795000000 }, "7d": { used: 0.2, resetsAt: 1795000000 }, "5h": { used: 0.3, resetsAt: 1795000000 }, "7d-opus": { used: 0.4, resetsAt: 1795000000 }, "Bad Name": { used: 0.1, resetsAt: 1 } });
  assert.deepEqual(rows.map((r) => [r.key, r.label, r.periodMs]), [
    ["claude:5h", "Claude 5h", 5 * HOUR_MS], ["claude:7d", "Claude week", WEEK_MS], ["claude:7d-opus", "7d-opus", WEEK_MS], ["claude:opus", "opus", null],
  ]);
});

test("source output: good rows, label cleaning, bad ids dropped, 8 rows, overrun and unit mistakes", () => {
  const rows = parseSourceOutput(JSON.stringify([
    { id: "credits-month", label: "Team credits", used: 0.41, resetsAt: "2026-12-01T00:00:00Z", period: "month" },
    { id: "BAD ID", label: "x", used: 0.1 },
    { id: "over", label: "Over\u0007run \u202e", used: 1.3 },
    { id: "unit", label: "Unit", used: 41 },
    { id: "neg", label: "Neg", used: -1 },
    { id: "nolabel", used: 0.1 },
    { id: "long", label: "a".repeat(60), used: 0.1 },
    { id: "credits-month", label: "dup", used: 0.9 },
    { label: "noid", used: 0.1 },
    "junk",
  ]));
  assert.ok(rows);
  assert.deepEqual(rows.map((r) => r.id), ["credits-month", "over", "unit", "neg", "nolabel", "long"]);
  assert.equal(rows[0].periodMs, 30 * 24 * HOUR_MS);
  assert.equal(rows[0].used, 0.41);
  assert.equal(rows[1].label, "Overrun");
  assert.equal(rows[1].used, 1.3);
  assert.equal(rows[2].used, null);
  assert.equal(rows[3].used, null);
  assert.equal(rows[4].label, "nolabel");
  assert.equal(rows[5].label.length, 24);
  const many = parseSourceOutput(JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, label: `R${i}`, used: 0.1 }))));
  assert.equal(many?.length, 8);
  assert.equal(parseSourceOutput("not json"), null);
  assert.equal(parseSourceOutput('{"id":"x"}'), null);
});

test("hide and order: hidden rows go, ordered keys first, the rest in source order", () => {
  const rows = ["a", "b", "c", "d"].map((key) => ({ key }));
  assert.deepEqual(arrangeRows(rows, [], []).map((r) => r.key), ["a", "b", "c", "d"]);
  assert.deepEqual(arrangeRows(rows, ["b"], []).map((r) => r.key), ["a", "c", "d"]);
  assert.deepEqual(arrangeRows(rows, [], ["d", "x", "b"]).map((r) => r.key), ["d", "b", "a", "c"]);
  assert.deepEqual(arrangeRows(rows, ["d"], ["d", "c"]).map((r) => r.key), ["c", "a", "b"]);
});

test("config: defaults and fall back on wrong types; sources capped and checked", () => {
  const d = stripConfigOf({});
  assert.deepEqual(d, { enabled: true, cpu: true, memory: true, level: true, disks: null, sampleSeconds: 10, sparkline: 12, claude: true, sources: [], hide: [], order: [] });
  const c = stripConfigOf({ sidebar: { strip: { enabled: false, disks: [], sampleSeconds: 2, sparkline: 500, quotas: { claude: false, hide: ["a", 3], sources: { Bad: { command: "x" }, ok: { command: "x --y", seconds: 10 }, ok2: { command: "z", seconds: 90 }, empty: { command: " " } } } } } });
  assert.equal(c.enabled, false);
  assert.deepEqual(c.disks, []);
  assert.equal(c.sampleSeconds, 10);
  assert.equal(c.sparkline, 12);
  assert.equal(c.claude, false);
  assert.deepEqual(c.hide, ["a"]);
  assert.deepEqual(c.sources, [{ name: "ok", command: "x --y", seconds: 300 }, { name: "ok2", command: "z", seconds: 90 }]);
});

test("stored samples: malformed entries are dropped and the lists are bounded", () => {
  const got = samplesOf({ a: [[1, 0.1], [2, "x"], "bad", [3, 5]], b: "no", c: Array.from({ length: 300 }, (_, i) => [i, 0.1]) });
  assert.deepEqual(got.a, [[1, 0.1]]);
  assert.equal(got.b, undefined);
  assert.equal(got.c.length, 200);
  assert.deepEqual(samplesOf(null), {});
});
