// The `suites` field of review_verdict (verdict.ts): the schema, the record file, the run-end result, the saved review records and the suites line of the verdict file.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkVerdictCall, makeRecordDir, MAX_SUITES, parseRecord, readRecordFile, recordOf, SUITE_COMMAND_MAX, writeRecord } from "../verdict.ts";
import { reviewResultsOfRunEnd } from "../occasion.ts";
import { appendHeadLine, reviewsOfEntry, suitesLine } from "../reviews.ts";
import type { ReviewRecord } from "../reviews.ts";
import { buildCeremonyState, latestCeremonyState, CEREMONY_ENTRY } from "../planstate.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-suites-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const SUITES = [{ command: "npm test", result: "pass" }, { command: "npm run test:node", result: "fail" }, { command: "ruff check .", result: "skip" }];
const pass = (extra: Record<string, unknown> = {}) => checkVerdictCall({ verdict: "pass", ...extra }, []);

test("schema: suites are accepted, may be omitted, and come back in the call", () => {
  const c = pass({ suites: SUITES });
  assert.ok("call" in c);
  assert.deepEqual("call" in c ? c.call.suites : null, SUITES);
  const none = pass();
  assert.ok("call" in none);
  assert.equal("call" in none ? "suites" in none.call : true, false, "no field, no key");
  assert.ok("call" in pass({ suites: [] }));
  assert.ok("call" in pass({ suites: [{ command: "  npm test  ", result: "pass" }] }));
});

test("schema: a bad shape is refused with the field named", () => {
  const bad: [string, unknown][] = [
    ["a result outside pass, fail, skip", [{ command: "npm test", result: "ok" }]],
    ["no result", [{ command: "npm test" }]],
    ["more than the cap", Array.from({ length: MAX_SUITES + 1 }, (_, i) => ({ command: `c${i}`, result: "pass" }))],
    ["a long command", [{ command: "x".repeat(SUITE_COMMAND_MAX + 1), result: "pass" }]],
    ["a newline in the command", [{ command: "npm test\nrm -rf /", result: "pass" }]],
    ["a carriage return in the command", [{ command: "npm test\r", result: "pass" }]],
    ["an HTML comment opener", [{ command: "npm test <!-- x", result: "pass" }]],
    ["an HTML comment closer", [{ command: "npm test --> x", result: "pass" }]],
    ["an empty command", [{ command: "  ", result: "pass" }]],
    ["a non-list", "npm test"],
    ["a non-object entry", ["npm test"]],
  ];
  for (const [why, suites] of bad) {
    const c = pass({ suites });
    assert.ok("error" in c, `${why}: refused`);
    assert.match("error" in c ? c.error : "", /suite/, why);
  }
  assert.ok("call" in pass({ suites: Array.from({ length: MAX_SUITES }, (_, i) => ({ command: `c${i}`, result: "pass" })) }), "the cap itself is fine");
});

test("record: suites survive the write and the read-back; a record without them reads back without them", () => {
  const dir = path.join(base, "rec");
  makeRecordDir(dir);
  const c = pass({ suites: SUITES });
  assert.ok("call" in c);
  writeRecord(dir, recordOf("L1", (c as { call: Parameters<typeof recordOf>[1] }).call));
  const back = readRecordFile(dir, "L1", []);
  assert.ok(back && "record" in back);
  assert.deepEqual("record" in back ? back.record.suites : null, SUITES);
  const raw = JSON.stringify({ v: 1, launchId: "L1", verdict: "pass", items: [], findings: [], at: "t" });
  const plain = parseRecord(raw, "L1", []);
  assert.ok(plain && "record" in plain && !("suites" in plain.record));
  const evil = parseRecord(JSON.stringify({ v: 1, launchId: "L1", verdict: "pass", items: [], findings: [], at: "t", suites: [{ command: "a\nb", result: "pass" }] }), "L1", []);
  assert.deepEqual(evil, { invalid: "schema" });
});

test("run end: the review result carries the record's suites, [] without a record or field", () => {
  const data = { agent: "reviewer", status: "completed", success: true, output: "report" };
  const rec = recordOf("L", { verdict: "pass", items: [], findings: [], suites: SUITES as never });
  assert.deepEqual(reviewResultsOfRunEnd(data, null, rec)[0].suites, SUITES);
  assert.deepEqual(reviewResultsOfRunEnd(data, null, recordOf("L", { verdict: "pass", items: [], findings: [] }))[0].suites, []);
  assert.deepEqual(reviewResultsOfRunEnd(data, null, null)[0].suites, []);
});

test("saved review records: run and suites survive a save and a reload; a bad saved list is dropped; old records lack them", () => {
  const rec: ReviewRecord = { role: "reviewer", verdict: "pass", head: "a".repeat(40), kind: "code", occasion: "pre-pr", run: "run-1", suites: SUITES as never };
  const old: ReviewRecord = { role: "reviewer", verdict: "pass", head: "b".repeat(40), kind: "code" };
  const saved = buildCeremonyState({ plan: null, lineages: [], planPhase: false, reviews: [rec, old] });
  const entry = [{ type: "custom", customType: CEREMONY_ENTRY, data: JSON.parse(JSON.stringify(saved)) }];
  const back = latestCeremonyState(entry)?.reviews ?? [];
  assert.equal(back[0].run, "run-1");
  assert.deepEqual(back[0].suites, SUITES);
  assert.equal("run" in back[1], false);
  assert.equal("suites" in back[1], false);
  const broken = reviewsOfEntry([{ ...rec, suites: [{ command: "a\nb", result: "pass" }] }, { ...rec, suites: "x", run: 5 }]);
  assert.equal(broken.length, 2);
  assert.ok(broken.every((r) => !("suites" in r) && (r.run === "run-1" || !("run" in r))));
});

test("suitesLine: the named suites; `none named` for a [pre-pr] PASS only; nothing for an item review", () => {
  assert.equal(suitesLine(SUITES as never, true), "suites: npm test (pass), npm run test:node (fail), ruff check . (skip)");
  assert.equal(suitesLine(SUITES as never, false), "suites: npm test (pass), npm run test:node (fail), ruff check . (skip)");
  assert.equal(suitesLine(undefined, true), "suites: none named by the pre-pr reviewer");
  assert.equal(suitesLine([], true), "suites: none named by the pre-pr reviewer");
  assert.equal(suitesLine(undefined, false), null);
});

test("verdict file: the suites line comes just before the Head line, which stays last", () => {
  const f = path.join(base, "out.md");
  fs.writeFileSync(f, "Overall verdict: PASS");
  assert.ok(appendHeadLine(f, { head: "c".repeat(40) }, "suites: npm test (pass)"));
  assert.equal(fs.readFileSync(f, "utf8"), `Overall verdict: PASS\nsuites: npm test (pass)\nHead: ${"c".repeat(40)}\n`);
  const g = path.join(base, "plain.md");
  fs.writeFileSync(g, "Overall verdict: PASS\n");
  assert.ok(appendHeadLine(g, { head: "d".repeat(40) }, null));
  assert.equal(fs.readFileSync(g, "utf8"), `Overall verdict: PASS\nHead: ${"d".repeat(40)}\n`);
});
