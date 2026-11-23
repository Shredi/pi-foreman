// D178: the explorer brief a builder is told to read survives the session's shutdown sweep (and a reload: a second host of the same
// session), is removed by the 7-day sweep, and a prepend path that no longer exists is left out.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { ChildScratch, createScratch, storeBrief, sweepOldScratch, sweepScratch, wtScratchBase } from "../childscratch.ts";
import type { ScratchHost, ScratchWt } from "../childscratch.ts";
import { ExplorerBrief, briefBlock } from "../builderbrief.ts";
import { sessionScratchRoot } from "../worktreeroot.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-d178-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const tmp = path.join(base, "tmp");
fs.mkdirSync(tmp);
const deps = { tmpdir: () => tmp };

const repo = path.join(base, "repo");
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
const root = sessionScratchRoot(repo, undefined)!;
const wt = (): ScratchWt => ({ root, base: wtScratchBase(root), failed: false });
const host = (): ScratchHost => ({ id: "sess-d178", cwd: repo, config: { config: {} }, scratch: new ChildScratch(), scratchWt: wt() });

test("the shutdown sweep keeps brief-* and removes the other folders of the lane; a reload still finds the brief; the 7-day sweep removes it", { skip: posixOnly }, () => {
  const h = host();
  const file = storeBrief(h, "run-1", "findings", deps)!;
  const other = createScratch("sess-d178", "L-review", deps, h.scratchWt)!;
  fs.writeFileSync(path.join(other, "x"), "x");
  sweepScratch(h, deps);
  assert.equal(fs.readFileSync(file, "utf8"), "findings");
  assert.equal(fs.existsSync(other), false);
  // reload: a new host of the same session sweeps the recent lane; the brief stays
  assert.equal(sweepOldScratch(host()), 0);
  assert.ok(fs.existsSync(file));
  assert.equal(sweepOldScratch(host(), Date.now() + 8 * 86400000), 1);
  assert.equal(fs.existsSync(file), false);
});

test("a lane without a brief is removed whole at shutdown", { skip: posixOnly }, () => {
  const h = { ...host(), id: "sess-nobrief" };
  const dir = createScratch("sess-nobrief", "L1", deps, h.scratchWt)!;
  sweepScratch(h, deps);
  assert.equal(fs.existsSync(path.dirname(dir)), false);
});

test("the builder prepend names a brief file that exists and leaves out a result or brief path that does not", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "b-"));
  const brief = path.join(dir, "explorer-brief.md");
  fs.writeFileSync(brief, "x");
  const present = briefBlock({ runId: "e1", summary: "s", resultPath: brief, briefPath: brief }, fs.existsSync);
  assert.match(present, /Full result: /);
  assert.match(present, /\[full brief at /);
  const gone = path.join(dir, "missing");
  const absent = briefBlock({ runId: "e1", summary: "s", resultPath: gone, briefPath: gone }, fs.existsSync);
  assert.doesNotMatch(absent, /Full result|full brief at/);
  const b = new ExplorerBrief();
  b.onRunEnd({ runId: "e2", status: "completed", role: "explorer", summary: "s", resultPath: gone } as never, undefined, () => gone);
  const input: Record<string, unknown> = { agent: "builder", task: "do" };
  assert.equal(b.apply(input, fs.existsSync)[0].action, "none");
  assert.doesNotMatch(String(input.task), /Full result|full brief at/);
});
