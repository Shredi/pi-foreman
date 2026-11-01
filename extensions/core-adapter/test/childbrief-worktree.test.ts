import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRootsBlock, rootsBlock } from "../childbrief.ts";
import type { PiRoots } from "../orient.ts";

const roots: PiRoots = { installRoot: "/pi", typesFile: "/pi/types.d.ts", npmRoot: "/npm", pkgRoot: "/pkg" } as unknown as PiRoots;
const LINE = "You run in your own worktree (your cwd). The plan and ledger above live in the foreman's checkout: read them there, never cd into or edit that checkout; the commit goes on your worktree's branch.";
const files = { plan: "/f/.workflow/scratch/plan.md", ledger: "/f/.workflow/LEDGER.md" };

test("rootsBlock: the worktree line only when asked", () => {
  assert.ok(rootsBlock(roots, { ...files, worktree: true }).includes(LINE));
  assert.ok(!rootsBlock(roots, files).includes(LINE));
  assert.ok(!rootsBlock(roots).includes(LINE));
});

test("applyRootsBlock: the line for worktree entries only, top-level and per step", () => {
  const single = { agent: "builder", task: "a", worktree: true };
  applyRootsBlock(single, roots, files);
  assert.ok((single.task as string).includes(LINE));
  const plain = { agent: "builder", task: "a" };
  applyRootsBlock(plain, roots, files);
  assert.ok(!(plain.task as string).includes(LINE));
  const tasks = { tasks: [{ agent: "builder", task: "a", worktree: true }, { agent: "builder", task: "b" }] };
  applyRootsBlock(tasks, roots, files);
  assert.ok((tasks.tasks[0].task as string).includes(LINE));
  assert.ok(!(tasks.tasks[1].task as string).includes(LINE));
  const chain = { chain: [{ agent: "builder", task: "a" }, { parallel: [{ agent: "builder", task: "b", worktree: true }] }] };
  applyRootsBlock(chain, roots, files);
  assert.ok(!(chain.chain[0].task as string).includes(LINE));
  assert.ok(((chain.chain[1] as { parallel: { task: string }[] }).parallel[0].task).includes(LINE));
});
