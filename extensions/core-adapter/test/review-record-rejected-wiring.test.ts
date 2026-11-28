// A rejected review record through the real wiring (index.ts run end): the message names the reason, the finish refusal and the pr_create cwd refusal repeat it,
// a failed run sends nothing, plan-review and second-opinion runs send it too, an unknown finding class is accepted.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { commitIn, end, launch, setup, settle, tick, worktree } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";
import { bindingOf } from "./_verdict-rig.ts";

type Sent = { message: { customType: string; content: string }; options: unknown }[];
const REJ = "pi-foreman-review-record-rejected";
const rejected = (sent: Sent) => sent.filter((m) => m.message.customType === REJ).map((m) => m.message.content);

async function rig(t: Parameters<typeof setup>[0], cfg: Record<string, unknown> = {}) {
  const sent: Sent = [];
  const s = await setup(t, { world: { sent }, cfg });
  return { ...s, sent };
}
/** Launches a reviewer with `task`, leaves `raw` as its record file and ends the run with `status`. */
async function review(a: Rig, task: string, raw: (launchId: string) => string, status = "completed", cwd?: string) {
  const l = await launch(a, "reviewer", task, cwd ? { cwd } : {});
  assert.equal(l.blocked, null, String(l.blocked));
  const b = bindingOf(a.inputOf(l.id));
  assert.ok(b?.verdictDir, "the launch has a record folder");
  fs.writeFileSync(path.join(b.verdictDir, "verdict.json"), raw(b.launchId));
  const ok = status === "completed";
  a.endEvent({ runId: `run-${l.id}`, agent: "reviewer", success: ok, status, results: [{ agent: "reviewer", status, success: ok, output: "report", ...(cwd ? { cwd } : {}) }] });
  await tick(300);
  return l;
}
const notJson = () => "{not json";
const unknownClass = (launchId: string) => JSON.stringify({ v: 1, launchId, verdict: "fail", items: [], findings: [{ kind: "defect", text: "x", file: "a.ts", line: 1, class: "future-class" }], at: new Date().toISOString() });

test("a completed item review with a rejected record sends the message with the reason and the hint", async (t) => {
  const { a, sent } = await rig(t);
  await review(a, "review item 1", notJson);
  const m = rejected(sent);
  assert.equal(m.length, 1);
  assert.match(m[0], /counts as no verdict.*rejected: not_json; run the reviewer again/);
  assert.doesNotMatch(m[0], /reload/);
});

test("a rejected schema record also names the reload hint", async (t) => {
  const { a, sent } = await rig(t);
  await review(a, "review item 1", (id) => JSON.stringify({ v: 1, launchId: id, verdict: "maybe", items: [], findings: [], at: new Date().toISOString() }));
  assert.match(rejected(sent)[0] ?? "", /rejected: schema; the session may run older harness code than its reviewer: reload it \(\/reload\)/);
});

test("a failed run sends nothing", async (t) => {
  const { a, sent } = await rig(t);
  await review(a, "review item 1", notJson, "failed");
  assert.deepEqual(rejected(sent), []);
});

test("a plan-review and a second-opinion run with a rejected record send the message", async (t) => {
  for (const task of ["[plan-review] review .workflow/scratch/plan-widget.md", "[second-opinion] look at the change"]) {
    const { a, sent } = await rig(t);
    await review(a, task, notJson);
    assert.equal(rejected(sent).length, 1, task);
    assert.match(rejected(sent)[0], /rejected: not_json/, task);
  }
});

test("a record with an unknown finding class is accepted: no message, the verdict counts", async (t) => {
  const { a, sent, w } = await rig(t);
  await review(a, "review item 1", unknownClass);
  assert.deepEqual(rejected(sent), []);
  const events = await w.traceEvents();
  assert.ok(!events.some((e) => e.event === "review_record_invalid"));
  assert.ok(events.some((e) => e.event === "review_done" && e.decision === "fail"));
});

test("the finish refusal names the rejected record", async (t) => {
  const { a, w } = await rig(t);
  fs.writeFileSync(path.join(w.project, "widget.ts"), "export {};\n");
  const b = await launch(a, "builder", "build the widget");
  await end(a, b, "builder", "done");
  await review(a, "review item 1", notJson);
  assert.match(await settle(a), /finish refused.*rejected: not_json; run the reviewer again/);
});

test("the pr_create cwd refusal of a sibling checkout names the rejected record", async (t) => {
  const { a, w } = await rig(t, { tools: { pr: true } });
  const wt = worktree(w, "sib");
  commitIn(wt, "sib.txt");
  await review(a, "review item 1", notJson, "completed", wt);
  const r = (await a.tool("pr_create")!.execute("id", { title: "t", body: "b", cwd: wt }, undefined, undefined, a.ctx)) as { content: { text: string }[]; details: { reason?: string } };
  const refusal = r.content.map((c) => c.text).join("\n");
  assert.equal(r.details.reason, "cwd_unreviewed", refusal);
  assert.match(refusal, /pr_refused:cwd_unreviewed.*\(record of run \S+ rejected: not_json; run the reviewer again\)/, refusal);
});
