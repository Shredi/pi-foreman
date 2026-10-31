// r79 item 4 (gate-log false positives, 2026-10-31): config-keys and git-config ignore files and repos under the child's own OS-temp scratch.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { lineFloors, pathFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

// real directories: the git-config exemption decides by the config file git resolves (a `.git` dir, a gitfile, a symlink), so the repos exist
const real = fs.realpathSync(mkTestTmp("pf79-scr-"));
const RSCR = path.join(real, "pi-foreman-scratch", "sess", "run");
const OUTREPO = path.join(real, "outside-repo");
for (const d of [path.join(RSCR, "repo", ".git"), path.join(OUTREPO, ".git", "worktrees", "w1"), path.join(RSCR, "linked"), path.join(RSCR, "gf"), path.join(RSCR, "sym")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(OUTREPO, ".git", "worktrees", "w1", "commondir"), "../..\n");
fs.writeFileSync(path.join(RSCR, "linked", ".git"), `gitdir: ${path.join(OUTREPO, ".git", "worktrees", "w1")}\n`);
fs.writeFileSync(path.join(RSCR, "gf", ".git"), `gitdir: ${OUTREPO}/.git\n`);
fs.rmSync(path.join(RSCR, "sym"), { recursive: true });
fs.symlinkSync(OUTREPO, path.join(RSCR, "sym"));
after(() => fs.rmSync(real, { recursive: true, force: true }));
const renv: FloorEnv = { cwd: path.join(real, "w"), home: "/h/me", writeRoots: [path.join(real, "w"), RSCR], scratch: [RSCR], protectedBranches: [], currentBranch: () => "feature/x", remoteHead: () => "trunk" };

const SCR = "/var/folders/zz/T/pi-foreman-scratch/sess/run";
const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", SCR], scratch: [SCR], protectedBranches: [], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const floor = (line: string, e: FloorEnv = env): string | null => lineFloors(line, parseShell(line, { cwd: e.cwd }), e)?.rule ?? null;

test("config-keys: a scratch copy of the schema or config is not a live config file", () => {
  assert.equal(floor(`sed -i 's/"gate"/"gate2"/' ${SCR}/x/config/foreman.schema.json`), null);
  assert.equal(floor(`sed -i 's/"gate"/"gate2"/' ${SCR}/x/config/foreman.json`), null);
  assert.equal(floor(`echo '{"gate":{}}' > ${SCR}/x/config/foreman.schema.json`), null);
  assert.equal(pathFloors({ path: `${SCR}/x/config/foreman.schema.json`, content: '{"gate":{}}' }, env, "write"), null);
});

test("config-keys: live config files still fire", () => {
  assert.equal(floor(`sed -i 's/"gate"/"gate2"/' /w/repo/config/foreman.schema.json`), "floor-config-keys");
  assert.equal(floor(`echo '{"gate":{}}' > /h/me/.pi/agent/foreman.json`), "floor-config-keys");
  assert.equal(pathFloors({ path: "/w/repo/config/foreman.schema.json", content: '{"gate":{}}' }, env, "write")?.rule, "floor-config-keys");
  assert.equal(floor(`sed -i 's/"gate"/"gate2"/' /var/folders/zz/T/other/pi-foreman-scratch/s/r/../../../../../../../../w/repo/config/foreman.json`), "floor-config-keys");
});

test("git-config: a repo under the own scratch is not the repo's config", () => {
  const f = (line: string, e: FloorEnv = renv): string | null => lineFloors(line, parseShell(line, { cwd: e.cwd }), e)?.rule ?? null;
  assert.equal(f(`git -C ${RSCR}/repo config user.email a@b`), null);
  assert.equal(f(`git -C ${RSCR}/repo config core.hooksPath /x`), null);
  assert.equal(f(`cd ${RSCR}/repo && git config user.name x`), null);
  assert.equal(f(`git --git-dir=${RSCR}/repo/.git config user.name x`), null);
  assert.equal(f(`git config --file ${RSCR}/repo/cfg user.name x`), null);
  assert.equal(f("git config user.email a@b", { ...renv, cwd: path.join(RSCR, "repo") }), null);
});

test("git-config: a linked worktree, a gitfile or a symlink under the scratch writes the real repo's shared config, so no exemption", () => {
  const f = (line: string): string | null => lineFloors(line, parseShell(line, { cwd: renv.cwd }), renv)?.rule ?? null;
  assert.equal(f(`git -C ${RSCR}/linked config core.hooksPath /x`), "floor-git-config");
  assert.equal(f(`cd ${RSCR}/linked && git config core.hooksPath /x`), "floor-git-config");
  assert.equal(f(`git -C ${RSCR}/gf config core.hooksPath /x`), "floor-git-config");
  assert.equal(f(`git -C ${RSCR}/sym config core.hooksPath /x`), "floor-git-config");
  assert.equal(f(`git --git-dir=${RSCR}/gf/.git config core.hooksPath /x`), "floor-git-config");
  // a repo that does not exist (yet) has no config file to judge: floored
  assert.equal(f(`git -C ${RSCR}/nothing config core.hooksPath /x`), "floor-git-config");
  // a plain key stays allowed everywhere
  assert.equal(f(`git -C ${RSCR}/linked config user.name x`), null);
});

test("git-config: the worktree, the global and the system config are unchanged", () => {
  assert.equal(floor("git config core.hooksPath /x"), "floor-git-config");
  assert.equal(floor("git config user.email a@b"), null);
  assert.equal(floor(`git -C /w/repo config core.hooksPath ${SCR}/h`), "floor-git-config");
  assert.equal(floor("git config --global core.hooksPath /x"), "floor-git-config");
  assert.equal(floor("git config --system credential.helper x"), "floor-git-config");
  assert.equal(floor(`git -C ${SCR}/repo config --global core.hooksPath /x`), "floor-git-config");
});
