// R5 P2 S2 (ledger 11, R1 regression): <main>/.workflow/* is named as an owned READ root for a round worktree.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mainWorkflowReadable } from "../roundsurface.ts";

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-s2-ml-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const main = path.join(base, "repo");
const rt = path.join(base, "repo.worktrees", "round");
for (const d of [path.join(main, ".workflow"), rt]) fs.mkdirSync(d, { recursive: true });

test("mainWorkflowReadable names only the sibling main checkout's .workflow of a round worktree", () => {
  // rt/main are native temp paths, so name the host platform (a "linux" argument would not treat C:\ paths as absolute)
  const flow = path.join(main, ".workflow");
  assert.deepEqual(mainWorkflowReadable([rt], process.platform), [flow, `${flow}/*`]);
  assert.deepEqual(mainWorkflowReadable([path.join(base, "plain")], process.platform), []);
});
