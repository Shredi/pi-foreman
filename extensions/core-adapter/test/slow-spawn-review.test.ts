// A host with slow process starts (Windows) must not change what a review launch reads: the high-stakes FAIL of a run end is recorded in reviewSync
// (git calls), and an untagged reviewer launched right after reads its findings, so it is no repeat of the PASS in main (D30). Shims make git and python slow on POSIX.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { build, commitIn, end, git, hsRun, launch, setup, worktree } from "./_hsrig.ts";
import { rmTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const sized = (risk: string[]) => ({ size: { files: ["src/a/x.ts"] }, risk });

test("a slow git does not make a reviewer launched right after a high-stakes FAIL a repeat of the PASS in main", { skip: posixOnly }, async (t) => {
  const real = (await import("node:child_process")).execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), "pf-slow-git-"));
  t.after(() => rmTestTmp(shim));
  fs.writeFileSync(path.join(shim, "git"), `#!/bin/sh\nsleep 0.25\nexec ${real} "$@"\n`, { mode: 0o755 });
  const { w, a } = await setup(t, { onMain: true });
  w.state.answer = "allow once";
  const wt = worktree(w, "gone");
  commitIn(wt, "src/a/x.ts");
  await build(a, sized(["design"]), wt);
  git(w.project, "merge", "-q", "--ff-only", "gone");
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
  const before = process.env.PATH;
  process.env.PATH = `${shim}${path.delimiter}${before}`;
  t.after(() => { process.env.PATH = before; });
  await hsRun(a, "FAIL", wt);
  git(w.project, "worktree", "remove", "--force", wt);
  const r = await launch(a, "reviewer", "review the change");
  assert.equal(r.blocked, null, String(r.blocked));
  assert.ok(String(r.input.task).startsWith("[pi-foreman high-stakes findings]"), "it gets the findings");
});
