// Ledger items 7c, 7e: round surfaces (own handoff dir, round worktrees from the manifest, bound ledger), the
// foreman's round worktree add, an isolation worktree as a child's own root.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { applyLedgerItems, reviewLedgerBlock } from "../ledgerblock.ts";
import { isolationDir, roundRoots, roundWorktreeAdd, roundWorktrees } from "../roundsurface.ts";
import { posix, posixOnly } from "./_platform.ts";

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-round-")));
after(async () => {
  await waitQuiet(path.join(base, "state"));
  rmTestTmp(base);
});
const main = path.join(base, "repo");
const rt = path.join(base, "repo.worktrees", "round");
const iso = path.join(base, "repo.worktrees", "worktrees", "round", "pi-worktree-1");
const handoff = path.join(base, "agent", "pi-foreman", "handoffs", "20260101-000000-demo");
for (const d of [path.join(main, ".git"), path.join(main, ".workflow", "scratch"), path.join(rt, ".workflow", "scratch"), path.join(iso, "src"), handoff]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(rt, ".git"), "gitdir: x\n");
fs.writeFileSync(path.join(iso, ".git"), "gitdir: y\n");
fs.writeFileSync(path.join(main, ".workflow", "LEDGER-topic.md"), "- [ ] 1. thing\n");
fs.writeFileSync(path.join(main, ".workflow", "scratch", "plan-x.md"), "plan\n");
fs.writeFileSync(path.join(rt, ".workflow", "scratch", "p.md"), "p\n");
fs.writeFileSync(path.join(iso, "src", "a.ts"), "a\n");

test("roundWorktrees: only the session's own unremoved worktree entries of the manifest", () => {
  const state = path.join(base, "state");
  fs.mkdirSync(path.join(state, "sessions", "S1"), { recursive: true });
  fs.writeFileSync(
    path.join(state, "sessions", "S1", "manifest.json"),
    JSON.stringify({ v: 1, entries: [{ path: "/repo.worktrees/round", kind: "worktree", owner: "S1" }, { path: "/repo.worktrees/gone", kind: "worktree", owner: "S1", removed: 1 }, { path: "/repo.worktrees/kid", kind: "worktree", owner: "launch-9" }, { path: "/x/scratch/t", kind: "scratch", owner: "S1" }] }),
  );
  if (posix) assert.deepEqual(roundWorktrees(state, "S1"), ["/repo.worktrees/round"]);
  assert.deepEqual(roundWorktrees(state, "S2"), []);
  assert.deepEqual(roundWorktrees(state, "../S1"), []);
  if (posix) assert.deepEqual(roundRoots(["/repo.worktrees/round"], "/repo.worktrees/round/src"), ["/repo.worktrees/round"]);
  if (posix) assert.equal(isolationDir("/repo.worktrees/round"), "/repo.worktrees/worktrees/round");
});

test("roundWorktreeAdd: the foreman's add of <repo>.worktrees/<round>, nothing else", { skip: posixOnly }, () => {
  const top = (d: string): string | null => (d.startsWith("/repo") ? "/repo" : null);
  const add = (cmd: string, cwd = "/repo"): string | null => roundWorktreeAdd(cmd, cwd, "linux", top);
  assert.equal(add("git worktree add ../repo.worktrees/round -b round main"), "/repo.worktrees/round");
  assert.equal(add("git -C /repo worktree add ../repo.worktrees/round -b round main", "/repo.worktrees/other"), "/repo.worktrees/round");
  assert.equal(add("git -C /repo worktree add /repo.worktrees/round"), "/repo.worktrees/round");
  for (const no of [
    "git worktree add ../elsewhere -b round main",
    "git worktree add ../repo.worktrees/a/b",
    "git worktree add ../repo.worktrees/round && rm -rf x",
    "git worktree add ../repo.worktrees/round > /tmp/x",
    "git worktree add --force ../repo.worktrees/round",
    "git worktree add ../repo.worktrees/../x",
    "git worktree add $HOME/repo.worktrees/round",
    "git worktree add ../repo.worktrees/round -b round main extra",
    "git worktree remove ../repo.worktrees/round",
  ]) assert.equal(add(no), null, no);
});

test("roundRoots: the round worktree a child sits in, or its own isolation worktree, is its root", { skip: posixOnly }, () => {
  const top = (d: string): string | null => (d.startsWith(iso) ? iso : null);
  assert.deepEqual(roundRoots([rt], rt, process.platform, top), [rt]);
  assert.deepEqual(roundRoots([rt], iso, process.platform, top), [iso]);
});

test("7c security: roundRoots of a child's own isolation worktree; the isolation dir and an outside dir give none", { skip: posixOnly }, () => {
  const top = (d: string): string | null => (d.startsWith(iso) ? iso : null);
  const isoDir = path.dirname(iso);
  assert.deepEqual(roundRoots([rt], iso, process.platform, top), [iso]);
  assert.deepEqual(roundRoots([rt], isoDir, process.platform, top), []);
  assert.deepEqual(roundRoots([rt], rt, process.platform, top), [rt]);
  assert.deepEqual(roundRoots([rt], path.join(base, "elsewhere"), process.platform, top), []);
});

test("ledger block: a review task names the ledger file's absolute path", () => {
  assert.match(reviewLedgerBlock("- [ ] 1. a\n", "review", "/w/.workflow/LEDGER-t.md"), /Ledger file \(absolute path, readable from any directory\): \/w\/\.workflow\/LEDGER-t\.md/);
  assert.match(reviewLedgerBlock("- [ ] 1. a\n", "check item 1", "/w/.workflow/LEDGER-t.md"), /^\[pi-foreman ledger items\]/);
  assert.doesNotMatch(reviewLedgerBlock("- [ ] 1. a\n", "review"), /Ledger file/);
  const e = { agent: "reviewer", task: "review" };
  const b = { agent: "builder", task: "do item 1" };
  applyLedgerItems({ tasks: [e, b] }, "- [ ] 1. a\n", new Set(), "/w/.workflow/LEDGER-t.md");
  assert.match(e.task, /\/w\/\.workflow\/LEDGER-t\.md/);
  assert.doesNotMatch(b.task, /Ledger file/);
});
