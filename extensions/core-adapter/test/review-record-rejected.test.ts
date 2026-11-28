import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { rejectedNote } from "../bound.ts";
import { CEREMONY_ENTRY, latestCeremonyState, persistedGate } from "../planstate.ts";
import { gatesRejected, gatesVerdict, openHint } from "../reviewgates.ts";
import { prGateRefusal } from "../reviews.ts";
import { checkVerdictCall, parseRecord } from "../verdict.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const rec = (findings: unknown[]) => JSON.stringify({ v: 1, launchId: "L1", verdict: "fail", items: [{ id: 1, result: "fail" }], findings, at: "2026-11-28T00:00:00.000Z" });

test("parseRecord drops an unknown finding class and keeps the finding", () => {
  const r = parseRecord(rec([{ kind: "defect", text: "x", class: "future-class" }, { kind: "later", text: "y", class: "other" }]), "L1", [1]);
  assert.ok(r && "record" in r);
  assert.deepEqual(r.record.findings, [{ kind: "defect", text: "x" }, { kind: "later", text: "y", class: "other" }]);
});

test("parseRecord stays strict on every other field", () => {
  assert.deepEqual(parseRecord(rec([{ kind: "nope", text: "x", class: "future-class" }]), "L1", [1]), { invalid: "schema" });
  assert.deepEqual(parseRecord(rec([{ kind: "defect", text: "x", class: 5 }]), "L1", [1]), { record: { v: 1, launchId: "L1", verdict: "fail", items: [{ id: 1, result: "fail" }], findings: [{ kind: "defect", text: "x" }], at: "2026-11-28T00:00:00.000Z" } });
  assert.deepEqual(parseRecord(rec([{ kind: "defect", text: "" }]), "L1", [1]), { invalid: "schema" });
  assert.deepEqual(parseRecord(rec([]).replace('"fail"', '"maybe"'), "L1", [1]), { invalid: "schema" });
  assert.deepEqual(parseRecord(rec([]), "L1", [2]), { invalid: "schema" });
});

test("checkVerdictCall (the child's tool) still refuses an unknown class", () => {
  const c = checkVerdictCall({ verdict: "fail", items: [{ id: 1, result: "fail" }], findings: [{ kind: "defect", text: "x", class: "future-class" }] }, [1]);
  assert.ok("error" in c);
});

test("a rejected record's reason reaches the finish hint and the pr_create cwd_unreviewed text", async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rej-")));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    const key = "/work/a";
    let g = gatesVerdict({}, [key], [null], 1, "run12345-abcd");
    g = gatesRejected(g, [key], { runId: "run12345-abcd", reason: "schema" });
    const note = rejectedNote(g[key]);
    assert.match(note, /run12345 rejected: schema.*\/reload/);
    assert.match(openHint(g, { cwd: "/work", own: key }), /rejected: schema/);
    assert.match(openHint({ ...g, "/work/b": { last: null, revised: true } }, { cwd: "/work", own: "/work/b" }), /a: no review yet \(record of run run12345 rejected: schema/);
    // a later verdict clears it
    assert.equal(gatesVerdict(g, [key], ["pass"], 2, "r2")[key].rejected, undefined);
    const top = fs.realpathSync.native(dir);
    const refusal = await prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [], cwd: os.tmpdir(), input: {}, checkout: { cwd: dir, records: [], rejected: (t) => (t === top ? note : null) } });
    assert.equal(refusal?.reason, "cwd_unreviewed");
    assert.match(refusal?.message ?? "", /rejected: schema/);
    const plain = await prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [], cwd: os.tmpdir(), input: {}, checkout: { cwd: dir, records: [] } });
    assert.doesNotMatch(plain?.message ?? "", /rejected/);
  } finally {
    rmTestTmp(dir);
  }
});

test("the rejected note survives the persisted gate state and still shows in the hint", () => {
  const key = "/work/a";
  let g = gatesVerdict({}, [key], [null], 1, "run12345-abcd");
  g = gatesRejected(g, [key], { runId: "run12345-abcd", reason: "schema" });
  const data = JSON.parse(JSON.stringify({ v: 1, gate: persistedGate({ builder: 0, reviewer: 0 } as never, g, {}) }));
  const loaded = latestCeremonyState([{ type: "custom", customType: CEREMONY_ENTRY, data }]);
  const lg = loaded?.gate?.reviewGates ?? {};
  assert.deepEqual(lg[key]?.rejected, { runId: "run12345-abcd", reason: "schema" });
  assert.match(openHint(lg, { cwd: "/work", own: key }), /run12345 rejected: schema/);
  // old state without the field, and a malformed one, still load
  delete data.gate.reviewGates[key].rejected;
  assert.equal(latestCeremonyState([{ type: "custom", customType: CEREMONY_ENTRY, data }])?.gate?.reviewGates?.[key]?.rejected, undefined);
  data.gate.reviewGates[key].rejected = { runId: 1 };
  assert.equal(latestCeremonyState([{ type: "custom", customType: CEREMONY_ENTRY, data }])?.gate?.reviewGates?.[key]?.rejected, undefined);
});
