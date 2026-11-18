// A due high-stakes review only reminds: the PR tools' answers, the finish gate (held once per reason set, then let go with a notice), a refusal for another
// step, a reload, the second pass after a cleared FAIL. An uncleared FAIL still blocks (highstakes-wiring*.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, commitIn, end, hsRun, launch, pr, prNote, REMINDER, setup, settle, traces } from "./_hsrig.ts";

const design = { size: { files: ["src/a/x.ts"] }, risk: ["design"] };
const security = { size: { files: ["src/a/x.ts"] }, risk: ["security"] };
const skipped = (w: Parameters<typeof traces>[0]) => traces(w, "high_stakes_skipped");

test("PR tools: no reminder when reviewBeforePr is off", async (t) => {
  const off = await setup(t, { ceremony: { reviewBeforePr: false } });
  await launch(off.a, "builder", "build it", design);
  assert.equal(await prNote(off.a), "", "the PR gate is off: no reminder");
});

test("a due review only reminds: PR tool answers, a refusal for another step (no hold spent), the finish held once per reason set (not counted as a refusal), then let go with an owner notice; a new reason holds again; a reload keeps the held set; the second pass after a cleared FAIL only reminds", async (t) => {
  const { w, a } = await setup(t);
  commitIn(w.project, "src/a/x.ts");
  const bld = await launch(a, "builder", "build it", design);
  await end(a, bld, "builder", "done");
  const early = await settle(a);
  assert.match(early, /requires reviewer/, "a refusal for another step carries the reminder");
  assert.match(early, REMINDER);
  assert.equal((await traces(w, "high_stakes_reminded")).length, 0, "no hold was spent");
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
  const first = await settle(a);
  assert.match(first, REMINDER);
  assert.match(first, /otherwise finish again/);
  assert.equal((await traces(w, "finish_refused")).length, 1, "a hold is no refusal: only the refusal for the missing review counted");
  assert.equal((await traces(w, "high_stakes_reminded")).length, 1);
  const other = (await a.fire("tool_result", { toolName: "open_merge_request", toolCallId: "o1", input: {}, details: {}, content: [{ type: "text", text: "ok" }], isError: false })) as { content?: { text?: string }[] } | undefined;
  assert.match((other?.content ?? []).map((c) => c.text).join("\n"), REMINDER, "every gated PR tool carries the reminder, and a due review refuses nothing");
  assert.equal(await pr(a), "");
  assert.match(await prNote(a), REMINDER);
  const failed = (await a.fire("tool_result", { toolName: "create_pull_request", toolCallId: "o2", input: {}, details: {}, content: [{ type: "text", text: "no" }], isError: true })) as unknown;
  assert.equal(failed, undefined, "an error result gets no reminder");
  assert.equal(await settle(a), "", "the second try goes through");
  assert.equal((await skipped(w)).length, 1);
  assert.ok(w.notes.some((n) => /finished while a high-stakes review is due \(design\)/.test(n)), "the owner is told");
  assert.equal(await settle(a), "");
  assert.equal((await skipped(w)).length, 1, "once per reason set");

  await build(a, security);
  assert.match(await settle(a), /review is due \(risk tag design, security\)/, "a new reason holds once more");
  assert.equal((await traces(w, "high_stakes_reminded")).length, 2);

  await a.down();
  const b = await w.adapter("reload");
  assert.equal(await settle(b), "", "the held reason set came back with the reload");

  const run = await hsRun(b, "FAIL");
  assert.ok(run.id);
  commitIn(w.project, "src/a/fix.ts");
  await build(b);
  assert.equal(await pr(b), "", "the FAIL is cleared; the second pass is only due");
  assert.match(await settle(b), /requested by the foreman/, "the foreman's own launch added a reason: held once more");
  assert.equal(await settle(b), "", "the second pass after a cleared FAIL only reminds: the next try goes through");
  assert.ok(w.notes.filter((n) => /finished while a high-stakes review is due \(design,foreman,security\)/.test(n)).length === 1);
});
