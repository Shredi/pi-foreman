// Floor narrowings of plan readonly-target C, every pin: RAW git-config (only GIT_CONFIG_GLOBAL=/dev/null passes), secretPath's scratch `.git/config` read
// for a read-only child (and what stays floored), readclear's relative-token rule, and the replay of both sighting lines of 2026-11-17.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { lineFloors, pathFloors, rawFloors, secretPath, type FloorEnv } from "../floors.ts";
import { readClearEntry } from "../readclear.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const real = fs.realpathSync(mkTestTmp("pf-ro-floor2-"));
const S = path.join(real, "pi-foreman-scratch", "sess", "run");
const W = path.join(real, "w");
const HOME = path.join(real, "home");
for (const d of [path.join(S, "c", ".git"), path.join(S, "a\\b", "o.git"), path.join(S, "sshclone", ".ssh", ".git"), path.join(W, ".git"), path.join(HOME, ".ssh"), path.join(HOME, ".git")]) fs.mkdirSync(d, { recursive: true });
for (const f of [path.join(S, "c", ".git", "config"), path.join(S, "sshclone", ".ssh", ".git", "config"), path.join(W, ".git", "config"), path.join(HOME, ".git", "config")]) fs.writeFileSync(f, "[core]\n");
fs.writeFileSync(path.join(HOME, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAA\n");
fs.mkdirSync(path.join(S, "d"));
fs.symlinkSync(path.join(W, ".git"), path.join(S, "d", ".git"));
after(() => fs.rmSync(real, { recursive: true, force: true }));

const base: FloorEnv = { cwd: W, home: HOME, writeRoots: [W, S], scratch: [S], protectedBranches: [], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const ro: FloorEnv = { ...base, readOnlyChild: true };
const segs = (line: string, cwd: string | undefined = W) => parseShell(line, { ...(cwd ? { cwd } : {}), env: { FOREMAN_SCRATCH: S } });
const rule = (line: string, e: FloorEnv = base, cwd: string | undefined = W): string | null => lineFloors(line, segs(line, cwd), e)?.rule ?? null;
const clears = (line: string, e: FloorEnv = ro, cwd: string | undefined = W): boolean => readClearEntry({ tool: "bash", text: line, segments: segs(line, cwd), dangers: ["danger-opaque"], shellBash: () => true }, e);

// ------------------------------------------------------------------ C.1

test("C.1 git-config: bare, single-quoted /dev/null pass, followed by whitespace, ; & | or the end", () => {
  for (const l of ["GIT_CONFIG_GLOBAL=/dev/null git status", "GIT_CONFIG_GLOBAL='/dev/null' git status", "GIT_CONFIG_GLOBAL=/dev/null; git status", "GIT_CONFIG_GLOBAL=/dev/null&& git status", "x=1 GIT_CONFIG_GLOBAL=/dev/null|cat", "GIT_CONFIG_GLOBAL=/dev/null"]) {
    assert.equal(rawFloors(l)?.rule ?? null, null, l);
  }
});

test("C.1 git-config: every other value and key stays floored", () => {
  for (const l of [
    "GIT_CONFIG_GLOBAL=/dev/nullx git x", "GIT_CONFIG_GLOBAL=/dev/null/x git x", 'GIT_CONFIG_GLOBAL="/tmp/g" git x', "GIT_CONFIG_GLOBAL=/tmp/g git x", "GIT_CONFIG_GLOBAL= git x", "GIT_CONFIG_GLOBAL=$HOME/.gitconfig git x",
    "GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=1 git x", "GIT_CONFIG_GLOBAL=/dev/null git a; GIT_CONFIG_GLOBAL=/tmp/g git b",
    "GIT_CONFIG_SYSTEM=/dev/null git x", "GIT_CONFIG_COUNT=1 git x", "GIT_CONFIG_KEY_0=a.b git x", "GIT_CONFIG_VALUE_0=v git x", "GIT_CONFIG_PARAMETERS='a=b' git x", "git --config-env=a.b=V x",
  ]) {
    assert.equal(rawFloors(l)?.rule, "floor-git-config", l);
  }
});

test("C.1 git-config: the quoted \"/dev/null\" stays floored (stricter than the regex alone: the scan sees the line with its quotes masked)", () => {
  assert.equal(rule('GIT_CONFIG_GLOBAL="/dev/null" git status'), "floor-git-config");
});

test("C.1 git-config: GIT_CONFIG_GLOBAL=/dev/null passes for every role (builder, main, read-only child)", () => {
  for (const e of [base, { ...base, child: true }, ro]) {
    assert.notEqual(rule("GIT_CONFIG_GLOBAL=/dev/null git status", e), "floor-git-config");
    assert.equal(rule("GIT_CONFIG_GLOBAL='/dev/null' git status", e), "floor-git-config", "a single-quoted value reaches the line scan masked, like the double-quoted one");
  }
});

// ------------------------------------------------------------------ C.2

const CFG = path.join(S, "c", ".git", "config");

test("C.2 a read-only child may read the .git/config of a copy in its own scratch (absolute, and relative to the segment's cwd)", () => {
  assert.equal(rule(`grep url ${CFG}`, ro), null);
  assert.equal(rule(`cd ${S} && grep url c/.git/config`, ro), null);
  assert.equal(rule(`cd ${S}/c && cat .git/config`, ro), null);
  assert.equal(secretPath(CFG, ro, true), null);
  assert.equal(pathFloors({ path: CFG }, ro, "read", "path", true), null);
});

test("C.2 stays floored: the same read by a builder and by the main session, a write, a write tool path, other places", () => {
  const read = `grep url ${CFG}`;
  assert.notEqual(rule(read, base), null, "main session");
  assert.notEqual(rule(read, { ...base, child: true }), null, "builder child");
  assert.notEqual(rule(`echo x >> ${CFG}`, ro), null, "redirect write");
  assert.notEqual(rule(`tee ${CFG}`, ro), null, "tee");
  assert.notEqual(pathFloors({ path: CFG, content: "x" }, ro, "write"), null, "write tool path");
  assert.notEqual(pathFloors({ path: CFG }, ro, "edit"), null, "edit tool path");
  assert.notEqual(rule(`grep url ${path.join(W, ".git", "config")}`, ro), null, "the live worktree");
  assert.notEqual(rule("grep url c/.git/config", ro, undefined), null, "relative, unknown cwd");
  assert.notEqual(rule(`grep url ${path.join(S, "d", ".git", "config")}`, ro), null, "a link in scratch to the live config");
  assert.equal(clears(`grep url ${path.join(S, "d", ".git", "config")}`), false, "the same through readclear");
  assert.notEqual(rule("cat ~/.git/config", ro), null, "~/.git/config");
  assert.notEqual(rule(`cat ${path.join(HOME, ".git", "config")}`, ro), null, "the home .git/config");
  assert.notEqual(rule(`cat ${path.join(S, "sshclone", ".ssh", ".git", "config")}`, ro), null, "a word that matches another secret pattern too");
  assert.notEqual(rule(`cat ${S}/c/../../w/.git/config`, ro), null, "a .. word");
});

test("C.2 env.cwd keeps its meaning: `cd ~ && cat .ssh/id_ed25519.pub` is the same verdict for a builder with and without the new fields", () => {
  const line = "cd ~ && cat .ssh/id_ed25519.pub";
  const plain = rule(line, base, W);
  assert.equal(rule(line, { ...base, readOnlyChild: false, segCwd: S }, W), plain);
  assert.equal(rule(line, { ...base, child: true }, W), rule(line, { ...base, child: true, readOnlyChild: false }, W));
});

// ------------------------------------------------------------------ C.2 readclear

test("C.2 readclear: a relative token is resolved by its own segments' cwd", () => {
  assert.equal(clears(`cd ${S} && grep url c/.git/config`), true, "same segment cwd: cleared");
  assert.equal(clears(`cd ${S} && grep url c/.git/config`, base), false, "a builder or the main session: not cleared");
  assert.equal(clears(`cd ${S} && grep url c/.git/config; cd ${W} && grep url c/.git/config`), false, "segments with different cwds: a hit");
  assert.equal(clears(`cd ${S} && grep url c/.git/config; grep -c x c/.git/config`), true, "the same cwd in every holder");
  assert.equal(clears("grep url c/.git/config", ro, undefined), false, "unknown cwd: a hit");
  assert.equal(clears(`cd ${S} && echo 'see c/.git/config'`), false, "a raw token that is in no segment's argv or redirects: a hit");
  assert.equal(clears(`grep url ${CFG}`), true, "an absolute token needs no cwd");
  assert.equal(clears(`grep url ${path.join(W, ".git", "config")}`), false, "the live worktree config is still a hit");
});

test("C.2 readclear: the SSH .pub exemption of the floors does not reach readclear", () => {
  const pub = path.join(HOME, ".ssh", "id_ed25519.pub");
  assert.equal(clears(`cat ${pub}`, ro), false);
  assert.equal(clears(`cat ${pub}`, base), false);
});

// ------------------------------------------------------------------ C.3

const L1 = `cd $FOREMAN_SCRATCH && mkdir 'a\\b' && git init -q --bare 'a\\b/o.git' && GIT_CONFIG_GLOBAL=/dev/null git clone -q "$PWD/a\\\\b/o.git" c 2>&1; grep url c/.git/config`;
const L2 = `cd ${S} && ls; git clone -q "$PWD/a\\\\b/o.git" c 2>&1; grep url c/.git/config`;

test("C.3 replay: both sighting lines get no floor verdict for a reviewer and pass readclear's token check", () => {
  for (const l of [L1, L2]) {
    assert.equal(rule(l, ro), null, l);
    assert.equal(clears(l, ro), true, l);
  }
});

test("C.3 replay: the same lines stay refused for a builder (the .git/config read) and L1 needs the GIT_CONFIG_GLOBAL narrowing", () => {
  for (const l of [L1, L2]) {
    assert.notEqual(rule(l, base), null, l);
    assert.equal(clears(l, base), false, l);
  }
  assert.equal(rawFloors(L1.replace("GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_GLOBAL=/tmp/g"))?.rule, "floor-git-config");
});
