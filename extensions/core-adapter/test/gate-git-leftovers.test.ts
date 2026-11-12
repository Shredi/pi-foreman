// gate-git-leftovers: one reader of git's global options (floors.ts gitGlobalWidth, used by gitCall and gitParts), one option-spelling function
// (gitOptSpellings), shortened spellings of the subagent-only long options, the tag value word, and the floor message of the clone form.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { dangerMatch } from "../defaults.ts";
import type { DangerEnv, GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import { gitGlobalWidth, gitOptSpellings, lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-ggl-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const tmpDir = path.join(base, "tmp");
for (const d of [wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [tmpDir, "/tmp"], scratchBase: path.join(tmpDir, "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
const facts: GitFacts = { currentBranch: () => "round/x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false, ownBranches: () => [] };
const denv = (child: boolean): DangerEnv => ({ roots: roots(child), platform: process.platform, cwd: wt, facts });
const segs = (line: string) => parseShell(line, { cwd: wt, env: { FOREMAN_SCRATCH: scr } });
const danger = (line: string, child: boolean): string | null => dangerMatch({ tool: "bash", input: { command: line }, text: line, segments: segs(line) }, denv(child))?.name ?? null;
const U = "https://example.com/r.git";

const fenv: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/s/scr", "/tmp"], protectedBranches: ["release"], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const floorHit = (line: string) => lineFloors(line, parseShell(line, { cwd: fenv.cwd }), fenv);

const isDanger = (line: string, child: boolean): boolean => danger(line, child) === "danger-git";

test("item 1: every value-taking global option of git is known to the shared reader", () => {
  for (const o of ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source", "--exec-path", "--config-env"]) assert.equal(gitGlobalWidth([o, "x"], 0), 2, o);
  for (const o of ["--attr-source=x", "--bare", "-p", "-cx", "--no-pager", "--"]) assert.equal(gitGlobalWidth([o, "x"], 0), 1, o);
});

test("item 1: git --attr-source / --config-env / --super-prefix before fetch --upload-pack is in the dangerous class, main and child", () => {
  for (const l of [
    "git --attr-source HEAD fetch --upload-pack=x origin",
    "git --attr-source=HEAD fetch --upload-pack=x origin",
    "git --config-env user.name=E fetch --upload-pack=x origin",
    "git --super-prefix p fetch --upload-pack=x origin",
    "git --namespace n fetch --upload-pack=x origin",
    "git --attr-source HEAD reset --hard",
  ]) for (const child of [false, true]) assert.equal(isDanger(l, child), true, `${l} child=${child}`);
});

test("item 1: neighbours of the shared reader keep their class", () => {
  for (const child of [false, true]) {
    for (const l of ["git status", "git fetch origin", "git --attr-source HEAD status", "git --attr-source HEAD log", "git --config-env user.name=E status", "git -C . fetch origin"]) assert.equal(isDanger(l, child), false, `${l} child=${child}`);
    assert.equal(isDanger("git fetch --upload-pack=x origin", child), true);
    assert.equal(isDanger("git -- fetch --upload-pack=x", child), true);
  }
});

test("item 5: one spelling function: long prefix, glued value, short cluster, up to --", () => {
  const sp = (w: string[], o: Parameters<typeof gitOptSpellings>[2] = {}) => gitOptSpellings(w, "--config", o);
  assert.deepEqual(sp(["--config=a", "--conf", "b", "--c"], { consume: true }), ["a", "b", ""]);
  assert.deepEqual(sp(["--conf", "b"]), [undefined]);
  assert.deepEqual(sp(["--cx", "-c", "k=v"], { short: "c" }), [undefined]);
  assert.deepEqual(sp(["-nccore.x=1", "-c", "k=v"], { short: "c", consume: true }), ["core.x=1", "k=v"]);
  assert.deepEqual(sp(["-bc", "x"], { short: "c" }), []);
  assert.deepEqual(sp(["--", "--config=a"]), []);
  assert.deepEqual(sp(["--config=a"], { min: 8 }), ["a"]);
  assert.deepEqual(sp(["--conf=a"], { min: 8 }), []);
});

test("item 2: shortened spellings of the subagent-only long options are judged for a subagent only", () => {
  // git accepts these (checked with git 2.54): switch --force-c.. --force-create, branch --forc/--force, --mo/--move, tag --d../--delete
  for (const l of [
    "git switch --force-create main", "git switch --force-creat main", "git switch --force-cre main", "git switch --force-c main", "git switch --force- main", "git switch --force-create=x main",
    "git branch --force main HEAD", "git branch --forc main HEAD", "git branch --fo main HEAD",
    "git branch --move a b", "git branch --mov a b", "git branch --mo a b",
    "git tag --delete v1", "git tag --delet v1", "git tag --del v1", "git tag --d v1",
  ]) {
    assert.equal(isDanger(l, true), true, `child ${l}`);
    assert.equal(isDanger(l, false), false, `main ${l}`);
  }
});

test("item 2: git switch --force is another option and stays out of the class; so does a prefix of it", () => {
  for (const l of ["git switch --force main", "git switch --forc main", "git switch --fo main", "git switch --f main"]) for (const child of [false, true]) assert.equal(isDanger(l, child), false, `${l} child=${child}`);
  for (const l of ["git branch --merged", "git branch --me", "git tag --contains HEAD", "git tag --list"]) assert.equal(isDanger(l, true), false, l);
});

test("item 3: the value word of --sort and --format is not a flag, for a subagent", () => {
  for (const l of ["git tag -l --sort -creatordate", "git tag --sort -creatordate", "git tag --format -d", "git tag --sort=-creatordate", "git tag -l", "git tag", "git tag v1"]) assert.equal(isDanger(l, true), false, l);
});

test("item 3: tag deletion stays judged for a subagent, a value word does not hide a later flag", () => {
  for (const l of ["git tag -d x", "git tag --delete x", "git tag -m -d x", "git tag -ld x", "git tag --sort -creatordate -d x", "git tag --sort --format -d x", "git tag --format x --delete y"]) {
    assert.equal(isDanger(l, true), true, `child ${l}`);
    assert.equal(isDanger(l, false), false, `main ${l}`);
  }
});

test("item 3: --sort / --format is a value only where it can start an option: not after a value-taking flag", () => {
  for (const l of ["git tag -l --sort -creatordate", "git tag --sort -creatordate", "git tag --format -d", "git tag -l -i --sort -creatordate", "git tag -l 'v*' --sort -creatordate", "git tag -n --sort -creatordate", "git tag -n5 --sort -creatordate"]) {
    assert.equal(isDanger(l, true), false, `child ${l}`);
    assert.equal(isDanger(l, false), false, `main ${l}`);
  }
  for (const l of [
    "git tag -m --sort -d v1", "git tag -F --sort -d v1", "git tag -u --format -d v1", "git tag -am --sort -d v1", "git tag --message --sort -d v1",
    "git tag --cleanup --format -d v1", "git tag --cleanup --sort -d v1", "git tag --sort --sort -d v1", "git tag -l --sort -creatordate -d v1",
    "git tag -d v1", "git tag --delete v1", "git tag -m -d v1",
  ]) {
    assert.equal(isDanger(l, true), true, `child ${l}`);
    assert.equal(isDanger(l, false), false, `main ${l}`);
  }
});

test("item 3: a forced tag move is unchanged", () => {
  for (const l of ["git tag -f x", "git tag -f x HEAD~1"]) for (const child of [false, true]) assert.equal(isDanger(l, child), false, `${l} child=${child}`);
});

test("item 4: the floor message names the form used; the -c / --config-env text is byte-identical", () => {
  const global = "pi-foreman: denied by the permission floor (git-config). Setting 'core.sshcommand' with -c or --config-env changes where code is fetched or pushed, which program git runs or which credentials it uses. Run git without it. No review, policy entry or dialog lifts this floor.";
  for (const l of ["git -c core.sshcommand=x fetch", `git -c core.sshcommand=x clone ${U}`]) assert.equal(floorHit(l)?.reason, global, l);
  const clone = global.replace("with -c or --config-env", "with git clone -c or --config");
  for (const l of [`git clone -c core.sshcommand=x ${U}`, `git clone --config core.sshcommand=x ${U}`, `git clone --conf=core.sshcommand=x ${U}`]) assert.equal(floorHit(l)?.reason, clone, l);
});
