// A9: a child's shell write into the foreman's checkout (roots.checkout, FOREMAN_CHECKOUT) is the parsed child deny `child-write-foreman-checkout`;
// `git -C <checkout> <write verb>` and `git clone` into it too; the parent's .workflow/ is not exempt. Reads are never fenced, the child's own
// scratch and worktree are plain write-ins. Shapes redacted from the #69 review findings.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-a9-"));
const checkout = path.join(base, "checkout");
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [path.join(checkout, ".workflow"), path.join(checkout, "nested-wt"), wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (worktree: string, co: string | undefined): GateRoots => ({ worktree, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [path.join(checkout, ".workflow")], handoffs: [], child: true, role: "builder", tmpAccess: false, ...(co ? { checkout: co } : {}) });
const rule = (command: string, o: { worktree?: string; co?: string | null } = {}): string | undefined => {
  const worktree = o.worktree ?? wt;
  const r = gateEvaluate("bash", { command }, worktree, { env: (cwd) => baseFloorEnv(cwd, { child: true }), roots: () => roots(worktree, o.co === null ? undefined : (o.co ?? checkout)) }).result as { block?: boolean; rule?: string } | undefined;
  return r?.block ? r.rule : undefined;
};
const FENCE = "child-write-foreman-checkout";

test("a child redirect into the parent checkout and into its .workflow is the checkout fence", { skip: !posix }, () => {
  assert.equal(rule(`echo x > ${checkout}/notes.md`), FENCE);
  assert.equal(rule(`echo x > ${checkout}/.workflow/plan.md`), FENCE);
  assert.equal(rule(`cat ${wt}/a >> ${checkout}/.workflow/result.md`), FENCE);
  assert.equal(rule(`cp ${wt}/a ${checkout}/.workflow/scratch/a`), FENCE);
});

test("git -C <checkout> write verbs, git clone into it and git run from it are the checkout fence", { skip: !posix }, () => {
  for (const l of [`git -C ${checkout} commit -m x`, `git -C ${checkout} add .`, `git -C ../checkout stash`, `git clone https://example.org/r.git ${checkout}/sub`, `cd ${checkout} && git add .`, `git --git-dir=${checkout}/.git --work-tree=${checkout} add .`]) assert.equal(rule(l), FENCE, l);
});

test("reads are never fenced, and git read verbs on the checkout are no write", { skip: !posix }, () => {
  for (const l of [`cat ${checkout}/.workflow/plan.md`, `ls ${checkout}`, `git -C ${checkout} status`, `git -C ${checkout} log --oneline`, `grep -r x ${checkout}/.workflow`]) assert.notEqual(rule(l), FENCE, l);
});

test("a heredoc or redirect into the child's own scratch and a write in its worktree are plain write-ins", { skip: !posix }, () => {
  for (const l of [`cat > ${scr}/m.txt <<EOF\nhi\nEOF`, `echo x > ${scr}/a.txt`, `echo x > ${wt}/a.txt`, "git add .", `git -C ${wt} add .`]) assert.equal(rule(l), undefined, l);
});

test("a worktree nested in the checkout is the child's own: its writes are no write into the checkout", { skip: !posix }, () => {
  const nested = path.join(checkout, "nested-wt");
  assert.equal(rule(`echo x > ${nested}/a.txt`, { worktree: nested }), undefined);
  assert.equal(rule("git add .", { worktree: nested }), undefined);
  assert.equal(rule(`echo x > ${checkout}/a.txt`, { worktree: nested }), FENCE);
});

test("the checkout given through a symlink is the same checkout", { skip: !posix }, () => {
  const link = path.join(base, "lnk");
  fs.symlinkSync(checkout, link);
  assert.equal(rule(`echo x > ${link}/a.txt`), FENCE);
  assert.equal(rule(`echo x > ${checkout}/a.txt`, { co: link }), FENCE);
});

test("without the launch binding (tasks / chain) there is no checkout fence: the write is still outside", { skip: !posix }, () => {
  assert.equal(rule(`echo x > ${checkout}/notes.md`, { co: null }), "child-write-outside");
});
