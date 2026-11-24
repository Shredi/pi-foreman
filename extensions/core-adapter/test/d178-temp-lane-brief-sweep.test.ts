// D178: a brief kept in the temp-folder lane (no worktree scratch base) is removed by the 7-day sweep; a younger lane stays.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { ChildScratch, storeBrief, sweepOldScratch, sweepScratch } from "../childscratch.ts";
import type { ScratchHost } from "../childscratch.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-d178t-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const tmp = path.join(base, "tmp");
fs.mkdirSync(tmp);
const work = path.join(base, "work");
fs.mkdirSync(work);
const deps = { tmpdir: () => tmp };
const host = (id: string): ScratchHost => ({ id, cwd: work, config: { config: {} }, scratch: new ChildScratch(), scratchWt: null });

test("temp-lane brief survives shutdown, stays under 7 days, goes after 30", { skip: posixOnly }, () => {
  const h = host("sess-t1");
  const file = storeBrief(h, "run-1", "findings", deps)!;
  assert.ok(file.startsWith(tmp));
  sweepScratch(h, deps);
  assert.ok(fs.existsSync(file));
  assert.equal(sweepOldScratch(host("sess-t1"), Date.now() + 86400000, deps), 0);
  assert.ok(fs.existsSync(file));
  assert.equal(sweepOldScratch(host("sess-t1"), Date.now() + 30 * 86400000, deps), 1);
  assert.equal(fs.existsSync(file), false);
});
