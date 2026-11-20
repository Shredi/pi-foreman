// The stale mark of the Open PRs header: tracked PRs exist and the tracked state time is missing or older than 90 s.
import test from "node:test";
import assert from "node:assert/strict";
import { parseRadarDoc, prsStaleText, PRS_STALE_MS, PR_STALE_WORDS } from "./model.js";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const rec = (over) => ({ ok: true, trackedN: 1, trackedAt: NOW - 10_000, ...over });

test("fresh trackedAt: no mark; older than 90 s: stale; missing with tracked PRs: stale", () => {
  assert.equal(prsStaleText([rec()], NOW), "");
  assert.equal(prsStaleText([rec({ trackedAt: NOW - PRS_STALE_MS })], NOW), "", "exactly 90 s is not yet stale");
  assert.equal(prsStaleText([rec({ trackedAt: NOW - PRS_STALE_MS - 1 })], NOW), "stale");
  assert.equal(prsStaleText([rec({ trackedAt: null })], NOW), "stale");
  assert.equal(prsStaleText([rec({ trackedAt: undefined })], NOW), "stale");
});

test("no tracked PRs, a failed record or an unknown now: no mark; one stale record among fresh ones is enough", () => {
  assert.equal(prsStaleText([rec({ trackedN: 0, trackedAt: null })], NOW), "");
  assert.equal(prsStaleText([rec({ ok: false, trackedAt: null })], NOW), "");
  assert.equal(prsStaleText([rec({ trackedAt: null })], NaN), "");
  assert.equal(prsStaleText([], NOW), "");
  assert.equal(prsStaleText([rec(), rec({ trackedAt: NOW - 600_000 })], NOW), "stale");
  assert.ok(PR_STALE_WORDS.startsWith("stale"));
});

test("parseRadarDoc passes trackedAt (ms) and trackedN through; absent or bad values are left out", () => {
  const base = { v: 1, now: "2026-11-21T12:00:00Z", roots: [], openPrs: [] };
  const a = parseRadarDoc(JSON.stringify({ ...base, trackedAt: "2026-11-21T11:59:00Z", trackedN: 3 }));
  assert.equal(a.trackedAt, Date.parse("2026-11-21T11:59:00Z"));
  assert.equal(a.trackedN, 3);
  const b = parseRadarDoc(JSON.stringify({ ...base, trackedAt: null, trackedN: -1 }));
  assert.equal(b.trackedAt, undefined);
  assert.equal(b.trackedN, undefined);
  const c = parseRadarDoc(JSON.stringify(base));
  assert.deepEqual([c.trackedAt, c.trackedN], [undefined, undefined]);
});
