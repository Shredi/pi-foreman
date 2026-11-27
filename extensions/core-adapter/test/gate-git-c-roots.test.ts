// D222: `git -C <dir>` classifies like the plain form for every subcommand when <dir> lies in the read roots (the one list, `readRootsOfGate`); any other dir is judge-first
// (`danger-git`). A push keeps its own checks.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-gitc-roots-"));
const wt = path.join(base, "wt");
const extra = path.join(base, "extra-read");
const other = path.join(base, "other");
for (const d of [wt, extra, other]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [], tmp: [], owned: [], readDirs: [extra], install: [], roundFlow: [], handoffs: [], child, role: "builder", tmpAccess: false });
const run = (command: string, child: boolean) => {
  const o = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child }), roots: () => roots(child) });
  return { result: JSON.stringify(o.result ?? null), dangers: o.dangers ?? [] };
};

for (const child of [true, false]) {
  const who = child ? "child" : "main";

  test(`${who}: git -C <the worktree or an additionalDirectories folder> follows the plain form`, { skip: posixOnly }, () => {
    for (const sub of ["log --oneline -1", "status", "verify-commit HEAD", "stash list", "fetch origin", "add x", "push origin feature"]) {
      const plain = run(`git ${sub}`, child);
      for (const dir of [wt, extra]) {
        const c = run(`git -C ${dir} ${sub}`, child);
        assert.deepEqual(c.dangers, plain.dangers, `${who}: git -C ${dir} ${sub}`);
        if (dir === wt && !sub.startsWith("push")) assert.equal(c.result, plain.result, `${who}: git -C ${dir} ${sub}`);
        // a read-only root (additionalDirectories) gets the read defaults, never a write default
        if (dir === extra && !sub.startsWith("push")) {
          const read = /^(log|status|verify-commit|stash list)/.test(sub);
          assert.ok(read ? c.result === plain.result : c.result === "null" || c.result.includes('"block":true'), `${who}: git -C ${dir} ${sub}: ${c.result}`);
        }
      }
    }
    assert.match(run(`git -C ${wt} log --oneline -1`, child).result, /default-git-read/);
  });

  test(`${who}: git -C <a folder outside the read roots> is judge-first for every subcommand`, { skip: posixOnly }, () => {
    for (const sub of ["log --oneline -1", "status", "verify-commit HEAD", "stash list", "branch", "push origin feature", "fetch origin"]) {
      const o = run(`git -C ${other} ${sub}`, child);
      // a child's write outside its worktree is refused by its own floor before the label
      assert.ok(o.dangers.includes("danger-git") || o.result.includes('"block":true'), `${who}: git -C ${other} ${sub}: ${o.result}`);
    }
    assert.ok(run(`git -C "$UNSET" log`, child).dangers.includes("danger-git") || run(`git -C "$UNSET" log`, child).result !== "null");
  });
}

test("a stash pop or apply is judge-first, a plain stash list is not (child)", { skip: posixOnly }, () => {
  for (const l of ["git stash pop", "git stash apply", "git stash pop stash@{0}", `git -C ${wt} stash apply stash@{2}`]) assert.ok(run(l, true).dangers.includes("danger-git"), l);
  assert.deepEqual(run("git stash list", true).dangers, []);
});
