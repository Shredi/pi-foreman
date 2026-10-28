import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { shPath } from "./_shpath.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/s/scr", "/tmp"], protectedBranches: ["release"], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const hit = (line: string, e: FloorEnv = env) => lineFloors(line, parseShell(line, { cwd: e.cwd }), e);

test("core.attributesFile: outside .workflow/ with merge is a floor deny that names the alternative", () => {
  for (const p of ["/w/other/attrs", "/tmp/attrs", "attrs", "/w/repo/src/attrs", "/w/repo/.workflow/../attrs", "$UNSET/attrs"]) {
    const h = hit(`git -c core.attributesFile=${p} merge origin/main`);
    assert.equal(h?.rule, "floor-git-attributes-file", p);
    assert.match(h?.reason ?? "", /under the repo's \.workflow\//);
  }
  assert.equal(hit("git -ccore.attributesfile=/tmp/a merge origin/main")?.rule, "floor-git-attributes-file");
});

test("core.attributesFile: a verb other than merge is a floor deny even under .workflow/", () => {
  for (const verb of ["rebase origin/main", "checkout round/41-x", "diff", "status", "cherry-pick abc"]) {
    const h = hit(`git -c core.attributesFile=/w/repo/.workflow/scratch/u-attrs ${verb}`);
    assert.equal(h?.rule, "floor-git-attributes-file", verb);
    assert.match(h?.reason ?? "", /only merge/);
  }
});

test("core.attributesFile: merge with the file under .workflow/ is not floored", () => {
  assert.equal(hit("git -c core.attributesFile=/w/repo/.workflow/scratch/u-attrs merge origin/main"), null);
  assert.equal(hit("git -c core.attributesFile=.workflow/u-attrs merge origin/main"), null);
});

test("core.attributesFile: the main checkout's .workflow/ counts for a linked worktree", () => {
  // native realpath: the long form of the temp dir (no 8.3 `RUNNER~1`; a word with a tilde is never a literal path)
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-attr-")));
  try {
    const main = path.join(base, "main");
    const wt = path.join(base, "wt");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    fs.mkdirSync(path.join(main, ".workflow"), { recursive: true });
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
    const e: FloorEnv = { ...env, cwd: wt, writeRoots: [wt] };
    assert.equal(hit(`git -c core.attributesFile=${shPath(main)}/.workflow/a merge x`, e), null);
    assert.equal(hit(`git -c core.attributesFile=${shPath(wt)}/.workflow/a merge x`, e), null);
    assert.equal(hit(`git -c core.attributesFile=${shPath(base)}/a merge x`, e)?.rule, "floor-git-attributes-file");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
