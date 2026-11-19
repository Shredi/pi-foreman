// D82: the child scratch lives under the worktree root (`<root>/.foreman/scratch/<session>/<launch>`), the temp folder is the fallback.
// Module-level rig: fake repos (a `.git` dir or file, no git process), the real root resolver and the real creation and removal code.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { ChildScratch, createScratch, finishScratch, launchScratch, removeScratch, sweepOldLanes, sweepOldScratch, sweepScratch, wtScratchBase } from "../childscratch.ts";
import type { ScratchHost, ScratchWt } from "../childscratch.ts";
import { literalOwnedDirs, ownedRoots } from "../owned.ts";
import { pathDecide, type GateRoots } from "../pathrules.ts";
import { sessionScratchRoot } from "../worktreeroot.ts";
import type { LaunchBinding } from "../usage.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-d82-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const posix = process.platform !== "win32";
const tmp = path.join(base, "tmp");
fs.mkdirSync(tmp);
const deps = { tmpdir: () => tmp };
const tmpScratch = path.join(tmp, "pi-foreman-scratch");

let n = 0;
/** A fake main checkout `<base>/<name>` (a `.git` dir with HEAD), name unique per call. */
function mainRepo(): string {
  const dir = path.join(base, `repo${++n}`);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}
/** A fake linked worktree `dir` of the repo `main` (`.git` file, admin dir with `commondir`). */
function linked(main: string, dir: string): string {
  const admin = path.join(main, ".git", "worktrees", path.basename(dir));
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
  fs.writeFileSync(path.join(admin, "HEAD"), "ref: refs/heads/x\n");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${admin}\n`);
  return dir;
}
const wtOf = (root: string): ScratchWt => ({ root, base: wtScratchBase(root), failed: false });
const host = (repo: string, wt: ScratchWt | null, keep = false): ScratchHost & { events: Record<string, unknown>[] } => {
  const events: Record<string, unknown>[] = [];
  return { id: "sess-d82", cwd: repo, config: { config: { ceremony: { childScratch: { keep } } } }, trace: { emit: (r) => events.push(r) }, scratch: new ChildScratch(), scratchWt: wt, events };
};
const binding = (repo: string, launchId: string): LaunchBinding => ({ foremanSession: "sess-d82", workspace: repo, role: "builder", launchId, kind: "first", model: null });

test("default close.worktreeDir in a main checkout: the lane is under ../<repo>.worktrees/.foreman/scratch/<session>/<launch>, the root is made", () => {
  const repo = mainRepo();
  const root = sessionScratchRoot(repo, undefined);
  assert.equal(root, path.join(base, `${path.basename(repo)}.worktrees`));
  assert.equal(fs.existsSync(root!), false, "computing the base writes nothing");
  const dir = createScratch("sess-d82", "L1", deps, wtOf(root!))!;
  assert.equal(dir, path.join(root!, ".foreman", "scratch", "sess-d82", "L1"));
  assert.ok(fs.statSync(dir).isDirectory());
  if (posix) for (const d of [path.join(root!, ".foreman"), path.join(root!, ".foreman", "scratch"), path.dirname(dir), dir]) assert.equal(fs.statSync(d).mode & 0o777, 0o700, d);
});

test("a custom close.worktreeDir: the lane is under that root", () => {
  const repo = mainRepo();
  const custom = path.join(base, `custom${n}`);
  const root = sessionScratchRoot(repo, `../${path.basename(custom)}`);
  assert.equal(root, custom);
  assert.equal(createScratch("s", "L1", deps, wtOf(root!)), path.join(custom, ".foreman", "scratch", "s", "L1"));
});

test("a session in a linked worktree takes the same root as the main checkout", () => {
  const repo = mainRepo();
  const lw = linked(repo, path.join(base, `${path.basename(repo)}.worktrees`, "round1"));
  assert.equal(sessionScratchRoot(lw, undefined), sessionScratchRoot(repo, undefined));
  const custom = `../shared${n}`;
  assert.equal(sessionScratchRoot(lw, custom), path.join(base, `shared${n}`));
  assert.equal(sessionScratchRoot(lw, custom), sessionScratchRoot(repo, custom));
});

test("a collision with another repo's worktrees falls back to the default root", () => {
  const repo = mainRepo();
  const other = mainRepo();
  const shared = path.join(base, `shared-c${n}`);
  linked(other, path.join(shared, "theirs"));
  assert.equal(sessionScratchRoot(repo, `../${path.basename(shared)}`), path.join(base, `${path.basename(repo)}.worktrees`));
  // a refused value (absolute without <repo>) is the default root too
  assert.equal(sessionScratchRoot(repo, path.join(base, "abs-no-placeholder")), path.join(base, `${path.basename(repo)}.worktrees`));
});

test("no git top, or a root inside a git work tree: no worktree base (the temp folder is used)", () => {
  const plain = path.join(base, "plain");
  fs.mkdirSync(plain);
  assert.equal(sessionScratchRoot(plain, undefined), null);
  const repo = mainRepo();
  const inner = mainRepo();
  assert.equal(sessionScratchRoot(repo, path.join(inner, "<repo>")), null);
});

test("symlinked .foreman: this and every later launch use the temp folder", { skip: !posix }, () => {
  const repo = mainRepo();
  const root = sessionScratchRoot(repo, undefined)!;
  const elsewhere = path.join(base, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(root);
  fs.symlinkSync(elsewhere, path.join(root, ".foreman"));
  const wt = wtOf(root);
  const dir = createScratch("s", "L1", deps, wt)!;
  assert.equal(dir, path.join(tmpScratch, "s", "L1"));
  assert.equal(wt.failed, true);
  assert.equal(createScratch("s", "L2", deps, wt), path.join(tmpScratch, "s", "L2"));
  assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing was written through the link");
});

test("an existing worktree root keeps its mode", { skip: !posix }, () => {
  const repo = mainRepo();
  const root = sessionScratchRoot(repo, undefined)!;
  fs.mkdirSync(root, { mode: 0o755 });
  fs.chmodSync(root, 0o755);
  assert.ok(createScratch("s", "L1", deps, wtOf(root)));
  assert.equal(fs.statSync(root).mode & 0o777, 0o755);
});

test("legacy temp lanes are still removed by run-end removal and by the session sweep", () => {
  const repo = mainRepo();
  const root = sessionScratchRoot(repo, undefined)!;
  const legacy = createScratch("sess-d82", "OLD1", deps)!;
  const legacy2 = createScratch("sess-d82", "OLD2", deps)!;
  assert.equal(path.dirname(path.dirname(legacy)), tmpScratch);
  const h = host(repo, wtOf(root));
  h.scratch.add("OLD1", legacy, "builder");
  finishScratch(h, "OLD1", { ...deps });
  assert.equal(fs.existsSync(legacy), false, "run-end removal accepts a lane under the temp base");
  assert.equal(h.events.at(-1)?.action, "removed");
  const b = binding(repo, "NEW1");
  launchScratch(h, {}, b, deps);
  assert.equal(b.scratch, path.join(root, ".foreman", "scratch", "sess-d82", "NEW1"));
  sweepScratch(h, deps);
  assert.equal(fs.existsSync(legacy2), false, "the session sweep removes the temp lane");
  assert.equal(fs.existsSync(path.join(root, ".foreman", "scratch", "sess-d82")), false, "and the worktree lane");
  assert.ok(fs.existsSync(path.join(root, ".foreman", "scratch")), "the base stays");
});

test("removeScratch: a lane strictly inside either base, never the base itself or a path outside", () => {
  const repo = mainRepo();
  const root = sessionScratchRoot(repo, undefined)!;
  const wt = wtOf(root);
  const lane = createScratch("s", "L1", deps, wt)!;
  const d = { ...deps, wtBase: wt.base };
  assert.deepEqual(removeScratch(wt.base, [repo], d), { removed: false, reason: "outside_root" });
  assert.deepEqual(removeScratch(root, [repo], d), { removed: false, reason: "outside_root" });
  assert.deepEqual(removeScratch(lane, [repo], deps), { removed: false, reason: "outside_root" }, "without the base it is not accepted");
  assert.deepEqual(removeScratch(lane, [repo], d), { removed: true });
});

test("session start removes session lanes older than 7 days, not newer ones", { skip: !posix }, () => {
  const repo = mainRepo();
  const root = sessionScratchRoot(repo, undefined)!;
  const wt = wtOf(root);
  const oldLane = createScratch("old-session", "L1", deps, wt)!;
  const newLane = createScratch("new-session", "L1", deps, wt)!;
  const oldSession = path.dirname(oldLane);
  const past = new Date(Date.now() - 8 * 86400000);
  fs.utimesSync(oldSession, past, past);
  const youngish = new Date(Date.now() - 6 * 86400000);
  fs.utimesSync(path.dirname(newLane), youngish, youngish);
  const stray = path.join(wt.base, "stray-file");
  fs.writeFileSync(stray, "x");
  fs.utimesSync(stray, past, past);
  const h = host(repo, wt);
  assert.equal(sweepOldScratch(h), 1);
  assert.equal(fs.existsSync(oldSession), false);
  assert.ok(fs.existsSync(newLane));
  assert.ok(fs.existsSync(stray), "only directories go");
  assert.equal(sweepOldScratch(host(repo, null)), 0, "a session on the temp folder sweeps nothing here");
  // a symlink at lane depth is never followed
  const outside = path.join(base, "outside-lane");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "x");
  fs.symlinkSync(outside, path.join(wt.base, "linked-session"));
  fs.lutimesSync(path.join(wt.base, "linked-session"), past, past);
  assert.equal(sweepOldLanes(wt.base, [repo], Date.now(), { ...deps }), 0);
  assert.ok(fs.existsSync(path.join(outside, "keep")));
});

test("a child writes its own lane under the new root and not another lane; the foreman's defaults do not reach the base", () => {
  const repo = mainRepo();
  const root = sessionScratchRoot(repo, undefined)!;
  const wt = wtOf(root);
  const mine = createScratch("s", "mine", deps, wt)!;
  const theirs = createScratch("s", "theirs", deps, wt)!;
  const owned = ownedRoots({ agentDir: path.join(base, "agent"), workspaceRoot: repo, tmpRoot: tmp, scratchBase: wt.base });
  assert.equal(owned.childScratchRoot, wt.base);
  assert.equal(owned.tmpScratchRoot, tmpScratch);
  assert.ok(owned.readWrite.includes(root), "the worktree root is an owned read-write root");
  const roots = (o: Partial<GateRoots>): GateRoots => ({
    worktree: path.join(root, "round1"), scratch: [], tmp: [tmp], scratchBase: owned.childScratchRoot, scratchBases: [owned.tmpScratchRoot], owned: [...owned.readWrite, ...owned.readOnly],
    install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true, ...o,
  });
  const rule = (r: GateRoots, tool: string, p: string): string | undefined => pathDecide(tool, { path: p }, r.worktree, r)?.rule;
  const child = roots({ child: true, role: "builder", scratch: [mine], tmpAccess: false });
  assert.equal(rule(child, "write", path.join(mine, "f.txt")), "path-write-scratch");
  assert.equal(rule(child, "write", path.join(theirs, "f.txt")), undefined, "another lane is no default");
  assert.equal(rule(child, "read", path.join(theirs, "f.txt")), undefined);
  const foreman = roots({});
  assert.equal(rule(foreman, "read", path.join(root, "other-round", "a.ts")), "path-read-owned", "the rest of the owned root is still readable");
  assert.equal(rule(foreman, "read", path.join(theirs, "f.txt")), undefined, "no default read into <root>/.foreman/scratch");
  assert.equal(rule(foreman, "read", path.join(wt.base, "x")), undefined);
  assert.equal(rule(roots({ scratch: [mine] }), "read", path.join(mine, "f.txt")), "path-read-scratch", "the foreman's own live lane is still readable");
  assert.equal(rule(foreman, "read", path.join(tmpScratch, "s", "x")), undefined, "the legacy temp base stays excluded");
});

test("literal owned dirs for the shell write guard: the worktree root without <root>/.foreman/scratch", () => {
  const repo = mainRepo();
  const root = sessionScratchRoot(repo, undefined)!;
  const wt = wtOf(root);
  assert.ok(createScratch("s", "L1", deps, wt));
  fs.mkdirSync(path.join(root, "round1"));
  fs.mkdirSync(path.join(root, ".foreman", "other"));
  const handoffs = path.join(base, "agent", "handoffs");
  const plain = literalOwnedDirs([handoffs, root]);
  assert.deepEqual(plain, [handoffs, root], "without a scratch base nothing changes");
  const carved = literalOwnedDirs([handoffs, root], wt.base).sort();
  assert.deepEqual(carved, [handoffs, path.join(root, ".foreman", "other"), path.join(root, "round1")].sort());
  assert.ok(!carved.some((d) => d === root || d === wt.base || wt.base.startsWith(d + path.sep)), "no dir holds the scratch base");
  // the temp base is never inside an owned root: unchanged
  assert.deepEqual(literalOwnedDirs([handoffs, root], tmpScratch), [handoffs, root]);
});
