// The parent side of the review verdict record (plan structured-verdicts §7): the record is read once per run end and cached, an invalid record is
// traced and counts as no verdict, a PASS marks the items the record names (V only when the launch named it), the completion notice after the run end
// marks nothing twice, a FAIL keeps its failed ids for the next review, and a resume keeps the first launch's record folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { bindingOf } from "./_verdict-rig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

type T = Parameters<typeof r11Rig>[0];
const ledgerText = `# SV\n\n${Array.from({ length: 4 }, (_, i) => `- [ ] ${i + 1}. item ${i + 1}`).join("\n")}\n- [ ] V. verify\n`;
const settle = (ms = 800): Promise<void> => new Promise((r) => setTimeout(r, ms));
const done = (text: string, n: number | string): boolean => new RegExp(`- \\[x\\] ${n}\\. `).test(text);

/** A rig with the ledger bound (written through the foreman's write tool) and a way to launch a reviewer and end it. */
async function world(t: T) {
  const entries: unknown[] = [];
  const base = reviewAllowOpts();
  const sessionManager = { getSessionId: () => process.env.PI_INTERCOM_SESSION_ID ?? "", getSessionFile: () => undefined, getEntries: () => entries, getBranch: () => entries };
  const a = await r11Rig(t, { default: "standard" }, {
    ...base,
    ctx: { ...base.ctx, sessionManager },
    piExtra: { appendEntry: (customType: string, data: unknown) => void (customType === "pi-foreman-ledger-route" && entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) })) },
  });
  const ledger = path.join(a.project, ".workflow", "LEDGER-sv.md");
  await a.toolDoing("write", { path: ledger }, () => fs.writeFileSync(ledger, ledgerText));
  let n = 0;
  return {
    a,
    ledger,
    text: () => fs.readFileSync(ledger, "utf8"),
    /** Launches a reviewer; the record folder comes from its binding. */
    async review(extra: Record<string, unknown> = {}, task = "review item 1") {
      const input: Record<string, unknown> = { agent: "reviewer", task, ...extra };
      const l = await a.launch(input);
      if (l.res) return { refused: l.res.reason ?? "", input, runId: "", dir: "", launchId: "" };
      const runId = `sv-run-${++n}`;
      await a.started(l.id, input, runId);
      const b = bindingOf(input);
      return { refused: "", input, runId, dir: b?.verdictDir ?? "", launchId: b?.launchId ?? "" };
    },
    end: (runId: string, status = "completed") => a.end({ runId, agent: "reviewer", status, success: status === "completed", results: [{ agent: "reviewer", status, success: status === "completed", output: "see the record" }] }),
  };
}

const noticeOf = (runId: string): string => `Background task completed: **reviewer**\n\nsee the record\n\nRetention-managed async directory: /tmp/x/${runId}\n`;

test("a PASS record marks its items once; the record is read once and the notice after the run end takes the cache", { skip }, async (t) => {
  const w = await world(t);
  const r = await w.review();
  assert.ok(r.dir, "a reviewer launch has a record folder");
  assert.ok(w.a.record(r.runId, { verdict: "pass", items: [{ id: 1, result: "pass" }, { id: 2, result: "open", note: "not run" }] }));
  w.end(r.runId);
  await settle();
  assert.ok(done(w.text(), 1) && !done(w.text(), 2), w.text());
  assert.equal(fs.existsSync(path.join(r.dir, "verdict.json")), false, "the run end consumed the live file");
  assert.ok(fs.readdirSync(r.dir).some((f) => f === `verdict.${r.runId}.json`), fs.readdirSync(r.dir).join(","));
  // a later file in the folder is never read for this run: the cache answers
  assert.ok(w.a.record(r.runId, { verdict: "fail", findings: [{ kind: "defect", text: "late", file: "a.ts", line: 1 }] }));
  await w.a.notice(noticeOf(r.runId));
  await settle(300);
  assert.equal(w.a.events("ledger_mark_by_review").length, 1, "marked once");
  assert.equal(fs.existsSync(path.join(r.dir, "verdict.json")), true, "the notice did not read the live file again");
  assert.equal(w.a.events("review_done").filter((e) => e.runId === r.runId).map((e) => e.decision).join(), "pass");
});

test("an invalid record (wrong launch id, an item the launch does not hold, not JSON) is traced and counts as no verdict", { skip }, async (t) => {
  const w = await world(t);
  const wrong = await w.review({}, "review item 1");
  const unknown = await w.review({}, "review item 2");
  const bad = await w.review({}, "review item 3");
  const rec = (launchId: string, items: unknown[]) => JSON.stringify({ v: 1, launchId, at: new Date().toISOString(), verdict: "pass", items, findings: [] });
  fs.writeFileSync(path.join(wrong.dir, "verdict.json"), rec("another-launch", [{ id: 1, result: "pass" }]));
  fs.writeFileSync(path.join(unknown.dir, "verdict.json"), rec(unknown.launchId, [{ id: 99, result: "pass" }]));
  fs.writeFileSync(path.join(bad.dir, "verdict.json"), "{not json");
  for (const r of [wrong, unknown, bad]) w.end(r.runId);
  await settle();
  const invalid = Object.fromEntries(w.a.events("review_record_invalid").map((e) => [String(e.runId), String(e.reason)]));
  assert.deepEqual(invalid, { [wrong.runId]: "launch_mismatch", [unknown.runId]: "schema", [bad.runId]: "not_json" });
  assert.deepEqual(w.a.events("review_done").map((e) => e.decision), ["no-verdict", "no-verdict", "no-verdict"]);
  assert.ok(![1, 2, 3].some((n) => done(w.text(), n)), w.text());
});

test("a run that did not complete ignores its record; a run with no record is a no-verdict", { skip }, async (t) => {
  const w = await world(t);
  const cut = await w.review({}, "review item 1");
  const none = await w.review({}, "review item 2");
  assert.ok(w.a.record(cut.runId, { verdict: "pass", items: [{ id: 1, result: "pass" }] }));
  w.end(cut.runId, "failed");
  w.end(none.runId);
  await settle();
  assert.equal(w.a.events("review_record_ignored").filter((e) => e.runId === cut.runId).length, 1);
  assert.ok(!done(w.text(), 1), "no mark from a run that did not complete");
  assert.deepEqual(w.a.events("review_done").map((e) => e.decision), ["no-verdict", "no-verdict"]);
});

test("V is marked only when the launch named it; a record naming V for a launch without it is invalid", { skip }, async (t) => {
  const w = await world(t);
  const bad = await w.review({ items: [1, 7] }, "review item 2");
  assert.match(bad.refused, /items 7 is not open on the ledger/);
  assert.equal(w.a.events("launch_refused").filter((e) => e.reason === "items_unknown").length, 1);
  const plain = await w.review({}, "review item 1");
  assert.ok(w.a.record(plain.runId, { verdict: "pass", items: [{ id: "V", result: "pass" }] }));
  w.end(plain.runId);
  await settle();
  assert.deepEqual(w.a.events("review_record_invalid").map((e) => e.reason), ["schema"]);
  assert.ok(!done(w.text(), "V"), w.text());
  const named = await w.review({ items: ["V"] }, "review the change");
  assert.ok(w.a.record(named.runId, { verdict: "pass", items: [{ id: "V", result: "pass" }] }));
  w.end(named.runId);
  await settle();
  assert.ok(done(w.text(), "V"), w.text());
});

test("a FAIL records the failed ids and the next item review defaults to them (re-review line); a PASS clears them", { skip }, async (t) => {
  const w = await world(t);
  const first = await w.review({}, "review item 1");
  assert.ok(w.a.record(first.runId, { verdict: "fail", items: [{ id: 2, result: "fail", note: "broken" }, { id: 3, result: "pass" }], findings: [{ kind: "defect", text: "broken", file: "src/a.ts", line: 3 }] }));
  w.end(first.runId);
  await settle();
  assert.deepEqual(w.a.events("review_done").map((e) => e.decision), ["fail"]);
  const again = await w.review({}, "review item 2");
  assert.equal(again.refused, "");
  assert.match(String(again.input.task), /\[pi-foreman re-review\]/);
  assert.deepEqual(bindingOf(again.input)?.items, [2], "the failed item that is still open");
  assert.ok(w.a.record(again.runId, { verdict: "pass", items: [{ id: 2, result: "pass" }] }));
  w.end(again.runId);
  await settle();
  assert.ok(done(w.text(), 2), w.text());
  const third = await w.review({}, "[pre-pr] review the change");
  assert.deepEqual(bindingOf(third.input)?.items, [1, 3, 4], "after a pass: every open item except V");
  assert.doesNotMatch(String(third.input.task), /\[pi-foreman re-review\]/);
});

test("an incomplete record counts as incomplete and marks nothing", { skip }, async (t) => {
  const w = await world(t);
  const r = await w.review();
  assert.ok(w.a.record(r.runId, { verdict: "incomplete", reason: "the tests do not start" }));
  w.end(r.runId);
  await settle();
  assert.deepEqual(w.a.events("review_done").map((e) => e.decision), ["incomplete"]);
  assert.ok(!done(w.text(), 1));
});

test("a resume keeps the first launch's record folder, made again if missing, and a consumed record stays consumed", { skip }, async (t) => {
  const w = await world(t);
  const r = await w.review({}, "review item 1");
  w.end(r.runId, "timed-out");
  await settle(300);
  fs.rmSync(r.dir, { recursive: true, force: true });
  const resume = { action: "resume", id: r.runId, message: "finish the review" };
  const l = await w.a.launch(resume);
  assert.equal(l.res, undefined, l.res?.reason);
  assert.ok(fs.existsSync(r.dir), "the folder is made again for the resumed child");
  await w.a.started(l.id, resume, "sv-resumed");
  assert.ok(w.a.record(r.runId, { verdict: "pass", items: [{ id: 1, result: "pass" }] }));
  w.end("sv-resumed");
  await settle();
  assert.ok(done(w.text(), 1), w.text());
});
