// The review facts of a run with no recorded checkout (a launch outside git) are filed under the session's own checkout, keyed as the gates key it (the realpath of
// its git toplevel, resolved at the session start), so a review of items there reads them.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { end, launch, setup } from "./_hsrig.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const LEDGER = "# Ledger: x\nTier: standard\n\n- [ ] 1. item\n- [ ] V. fresh-eyes verification passed\n";

test("a review result of a run with no recorded checkout is filed under the session's own checkout key and read by a review there", async (t) => {
  const { w, a } = await setup(t);
  w.state.answer = "allow once";
  await a.writeLedger(LEDGER);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-memkey-"));
  t.after(() => rmTestTmp(dir));
  const b = await launch(a, "builder", "build the widget", { cwd: dir });
  assert.equal(b.blocked, null, String(b.blocked));
  await end(a, b, "builder", "done", dir);
  const r = await launch(a, "reviewer", "review items of the widget", { cwd: dir });
  assert.equal(r.blocked, null, String(r.blocked));
  a.record(r.id, { verdict: "fail", items: [{ id: 1, result: "fail", note: "x" }], findings: [{ kind: "defect", text: "alpha defect", file: "src/x.ts", line: 1 }] });
  await a.endRunAs(r.id, "reviewer", "report", dir); // outside git no review record is written; the facts are filed at the run end
  const own = await launch(a, "reviewer", "review items of the widget", {});
  assert.equal(own.blocked, null, String(own.blocked));
  assert.match(String(own.input.task), /\[re-review items: 1\]/, String(own.input.task));
});

test("a session whose cwd is a subdirectory of its checkout files the facts of an outside-git run under the toplevel key and reads them from there", async (t) => {
  const { w, a } = await setup(t, { world: { subdir: "pkg/sub" } });
  assert.equal(path.basename(String(a.ctx.cwd)), "sub", "the session cwd is the subdirectory");
  w.state.answer = "allow once";
  await a.writeLedger(LEDGER);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-memkey-"));
  t.after(() => rmTestTmp(dir));
  const b = await launch(a, "builder", "build the widget", { cwd: dir });
  assert.equal(b.blocked, null, String(b.blocked));
  await end(a, b, "builder", "done", dir);
  const r = await launch(a, "reviewer", "review items of the widget", { cwd: dir });
  assert.equal(r.blocked, null, String(r.blocked));
  a.record(r.id, { verdict: "fail", items: [{ id: 1, result: "fail", note: "x" }], findings: [{ kind: "defect", text: "alpha defect", file: "src/x.ts", line: 1 }] });
  await a.endRunAs(r.id, "reviewer", "report", dir);
  const own = await launch(a, "reviewer", "review items of the widget", {}); // no cwd: the session's subdirectory, whose checkout is the toplevel
  assert.equal(own.blocked, null, String(own.blocked));
  assert.match(String(own.input.task), /\[re-review items: 1\]/, String(own.input.task));
});
