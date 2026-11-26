// An editor-backup delete (`*~`, `*.bak`, `*.orig`, `*.swp`, `.#*`) is an ordinary delete (owner 2026-11-24): inside a helper's own folders it runs like any own write,
// outside them it keeps today's outcome. Replaces effects-backups, effects-backups2 and editorbackup-shell (the special check is gone).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { classify, effectCtx } from "../effects.ts";
import { gateOracle, makeLayout } from "./_gate-gen.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-backupdel-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
fs.mkdirSync(path.join(base, ".git"));
fs.mkdirSync(path.join(base, "build"));
const c = effectCtx(base);
const layout = makeLayout(path.join(base, "gate"));
const oracle = gateOracle(layout);

test("a backup delete in the own folder is write-in like any rm", () => {
  for (const cmd of ["rm foo.ts~", "rm -f src/a.bak", "rm x.swp", "cd build && rm -f a.orig", "rm build/out.js"]) assert.equal(classify(cmd, c), "write-in", cmd);
});

test("a glob delete is classed like the same glob on any other name", () => {
  assert.equal(classify("rm -f *.orig", c), classify("rm -f *.txt", c));
});

test("a read of a backup name is a read, not a delete", () => {
  assert.equal(classify("ls foo~", c), "read");
});

test("a helper's backup delete in its own worktree and scratch runs; outside its own folders it keeps today's outcome", { skip: posixOnly }, () => {
  const wt = layout.worktree;
  const scratch = layout.scratch[0];
  for (const role of ["builder", "reviewer"] as const) {
    assert.equal(oracle(`rm ${scratch}/a.ts~`, role), "silent", `${role}: scratch backup`);
  }
  for (const cmd of [`rm ${wt}/src/a.ts~`, `rm -f ${wt}/a.bak`, `rm -- ${wt}/.#a`]) assert.equal(oracle(cmd, "builder"), "silent", `builder: ${cmd}`);
  for (const cmd of ["rm /elsewhere/a.ts~", "rm -f /elsewhere/a.bak"]) {
    for (const role of ["builder", "reviewer"] as const) assert.equal(oracle(cmd, role), "block", `${role}: ${cmd}`);
  }
});
