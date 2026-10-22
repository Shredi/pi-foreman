// R24 item 1: the SECURITY exemption reads the full reviewer report of the run end, not the capped notice head.
import { test } from "node:test";
import assert from "node:assert/strict";
import { securityOf } from "../rounds.ts";
import { r11Rig } from "./_r11rig.ts";

const builder = { agent: "builder", task: "build it" };
const reviewer = { agent: "reviewer", task: "review items 1" };

test("securityOf: the report wins, the notice is the fallback", () => {
  assert.equal(securityOf("run-1", "no finding here"), "report");
  assert.equal(securityOf(null, "Overall verdict: FAIL\nSECURITY: x"), "notice");
  assert.equal(securityOf(null, "Overall verdict: FAIL"), null);
});

/** A builder, then a reviewer FAIL whose report holds `SECURITY:` after 2 500 characters; the notice shows only the head. */
async function failedReview(t: Parameters<typeof r11Rig>[0], security: boolean) {
  const a = await r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } });
  const b = await a.launch({ ...builder });
  assert.equal(b.res, undefined);
  await a.started(b.id, builder, "run-b");
  a.end({ runId: "run-b", agent: "builder", status: "completed", success: true, summary: "built" });
  const r = await a.launch({ ...reviewer });
  await a.started(r.id, reviewer, "run-r");
  const filler = Array.from({ length: 100 }, (_, i) => `${i + 1}. finding about something minor in file ${i}.ts`).join("\n");
  assert.ok(filler.length > 2500);
  const report = `Overall verdict: FAIL\n${filler}\n${security ? "SECURITY: src/a.ts:3 path traversal\n" : ""}`;
  a.end({ runId: "run-r", agent: "reviewer", status: "completed", success: true, output: report });
  await a.notice(`Background task completed: **reviewer**\n\n${report.slice(0, 2000)}`);
  return a;
}

test("a SECURITY line past the notice cap still exempts the next builder revision", async (t) => {
  const a = await failedReview(t, true);
  assert.deepEqual(a.events("security_exempt").map((e) => [e.runId, e.kind]), [["run-r", "report"]]);
  const next = await a.launch({ ...builder });
  assert.equal(next.res, undefined);
  assert.equal(a.events("revision_security_exempt").length, 1);
});

test("securityOf: a flag of another run than the notice names is stale", () => {
  assert.equal(securityOf("run-a", "Overall verdict: FAIL", ["run-b"]), null);
  assert.equal(securityOf("run-a", "Overall verdict: FAIL", ["run-a"]), "report");
});

test("a stale flag from run A does not exempt the notice of run B", async (t) => {
  const a = await r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } });
  const b = await a.launch({ ...builder });
  await a.started(b.id, builder, "run-b0");
  a.end({ runId: "run-b0", agent: "builder", status: "completed", success: true, summary: "built" });
  const r = await a.launch({ ...reviewer });
  await a.started(r.id, reviewer, "run-a");
  // run A ends with a SECURITY FAIL but its notice never arrives
  a.end({ runId: "run-a", agent: "reviewer", status: "completed", success: true, output: "Overall verdict: FAIL\nSECURITY: src/a.ts:3 path traversal\n" });
  const r2 = await a.launch({ ...reviewer });
  await a.started(r2.id, reviewer, "run-b");
  await a.notice("Background task completed: **reviewer**\n\nOverall verdict: FAIL\n1. minor nit\n\nRetention-managed async directory: /tmp/async/run-b");
  assert.deepEqual(a.events("security_exempt"), []);
});

test("without a SECURITY line nothing is exempt", async (t) => {
  const a = await failedReview(t, false);
  assert.deepEqual(a.events("security_exempt"), []);
  await a.launch({ ...builder });
  assert.deepEqual(a.events("revision_security_exempt"), []);
});
