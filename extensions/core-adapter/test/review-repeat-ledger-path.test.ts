// D76: a direct write of the ledger counts when the tool path spells the file differently from the bound path (a symlinked directory here;
// on Windows an 8.3 short temp path such as RUNNER~1 or another drive-letter case, which fs.realpathSync does not fold and cannot be simulated off Windows).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { build, launch, setup, tick } from "./_hsrig.ts";

test("PASS, then a write of the ledger through a symlinked directory: the next reviewer launch is not refused", async (t) => {
  const { a, w } = await setup(t);
  await build(a);
  await tick(300);
  assert.match((await launch(a, "reviewer", "review the branch again")).blocked ?? "", /the last review passed/);
  const link = path.join(path.dirname(w.project), `${path.basename(w.project)}-link`);
  try {
    fs.symlinkSync(w.project, link, "junction");
  } catch {
    return t.skip("no symlink permission");
  }
  t.after(() => fs.rmSync(link, { force: true }));
  const file = path.join(link, ".workflow", "LEDGER-x.md");
  await a.fire("tool_result", { toolName: "write", toolCallId: "wr1", input: { path: file }, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
  assert.equal((await launch(a, "reviewer", "review the branch again")).blocked, null);
});
