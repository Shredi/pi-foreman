// Plan readonly-target v11, C: the two floor narrowings. GIT_CONFIG_GLOBAL=/dev/null is the only allowed GIT_CONFIG_* assignment;
// a read-only child may read the `.git/config` of a clone inside its own scratch dir (never a live one), through the shared helper scratchGitConfigRead.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { lineFloors, scratchGitConfigRead, secretPath, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const real = fs.realpathSync(mkTestTmp("pf-ro-floor-"));
const RSCR = path.join(real, "pi-foreman-scratch", "sess", "run");
const LIVE = path.join(real, "live");
for (const d of [path.join(RSCR, "clone", ".git"), path.join(LIVE, ".git")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(RSCR, "clone", ".git", "config"), "[core]\n");
fs.writeFileSync(path.join(LIVE, ".git", "config"), "[core]\n");
fs.symlinkSync(path.join(LIVE, ".git"), path.join(RSCR, "clone", "link"));
after(() => fs.rmSync(real, { recursive: true, force: true }));

const base: FloorEnv = { cwd: path.join(real, "w"), home: "/h/me", writeRoots: [path.join(real, "w"), RSCR], scratch: [RSCR], protectedBranches: [], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const ro: FloorEnv = { ...base, readOnlyChild: true };
const floor = (line: string, e: FloorEnv = base): string | null => lineFloors(line, parseShell(line, { cwd: e.cwd }), e)?.rule ?? null;

test("git-config floor: only the exact GIT_CONFIG_GLOBAL=/dev/null passes", () => {
  assert.notEqual(floor("GIT_CONFIG_GLOBAL=/dev/null git status"), "danger-git-config");
  // the quoted spelling reaches the floor with its quotes masked, so it stays floored (stricter than the regex alone)
  assert.equal(floor('GIT_CONFIG_GLOBAL="/dev/null" git status'), "danger-git-config");
  for (const l of ["GIT_CONFIG_GLOBAL=/tmp/x git status", "GIT_CONFIG_GLOBAL=/dev/nullx git status", "GIT_CONFIG_SYSTEM=/dev/null git status", "GIT_CONFIG_COUNT=1 git status", "GIT_CONFIG_GLOBAL=$HOME/.gitconfig git status"]) {
    assert.equal(floor(l), "danger-git-config", l);
  }
});

test("scratchGitConfigRead: only a read-only child, only a literal path under its own scratch", () => {
  const own = path.join(RSCR, "clone", ".git", "config");
  assert.equal(scratchGitConfigRead(own, ro), true);
  assert.equal(scratchGitConfigRead(own, base), false);
  assert.equal(scratchGitConfigRead(path.join(LIVE, ".git", "config"), ro), false);
  assert.equal(scratchGitConfigRead(path.join(RSCR, "clone", "link", "config"), ro), false);
  assert.equal(scratchGitConfigRead(path.join(RSCR, "clone", "..", "..", "x", ".git", "config"), ro), false);
  assert.equal(scratchGitConfigRead(`${RSCR}/clone/.git/conf*`, ro), false);
  assert.equal(scratchGitConfigRead(".git/config", ro), false, "relative with no known segment cwd");
  assert.equal(scratchGitConfigRead(".git/config", { ...ro, segCwd: path.join(RSCR, "clone") }), true);
  assert.equal(scratchGitConfigRead(".git/config", { ...ro, segCwd: LIVE }), false);
});

test("secretPath: the scratch config read exemption needs a read and a read-only child", () => {
  const own = path.join(RSCR, "clone", ".git", "config");
  assert.equal(secretPath(own, ro, true), null);
  assert.notEqual(secretPath(own, ro, false), null);
  assert.notEqual(secretPath(own, base, true), null);
  assert.notEqual(secretPath(path.join(LIVE, ".git", "config"), ro, true), null);
});
