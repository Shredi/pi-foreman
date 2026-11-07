// `git -C <dir outside the worktree>` read-only verbs name no write target: branch list forms, stash list|show, log, status are no write outside
// (child-write-outside) and no write into the foreman's checkout; stash/branch writes still are.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-gitc-"));
const checkout = path.join(base, "checkout");
const other = path.join(base, "other");
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [checkout, other, wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [path.join(checkout, ".workflow")], handoffs: [], child: true, role: "builder", tmpAccess: false, checkout });
const rule = (command: string): string | undefined => {
  const r = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true }), roots }).result as { block?: boolean; rule?: string } | undefined;
  return r?.block ? r.rule : undefined;
};
const FENCES = ["child-write-outside", "child-write-foreman-checkout"];

test("read-only git -C <outside> verbs are no write outside nor into the checkout", { skip: !posix }, () => {
  for (const d of [other, checkout]) {
    for (const v of ["branch --show-current", "branch", "branch -vv", "stash list", "stash list --format=%gd", "stash show", "log --oneline -1", "status"]) {
      const l = `git -C ${d} ${v}`;
      assert.ok(!FENCES.includes(rule(l) ?? ""), `${l}: ${rule(l)}`);
    }
    const chain = `git -C ${d} log --oneline -1; git -C ${d} status`;
    assert.ok(!FENCES.includes(rule(chain) ?? ""), `${chain}: ${rule(chain)}`);
  }
});

test("git -C <outside> stash show|list --output=<file> is still a write outside", { skip: !posix }, () => {
  for (const v of ["stash show", "stash list"]) {
    for (const o of [`--output=${other}/x`, `--output ${other}/x`]) {
      const l = `git -C ${other} ${v} ${o}`;
      assert.equal(rule(l), "child-write-outside", l);
      const c = `git -C ${checkout} ${v} ${o.replace(other, checkout)}`;
      assert.ok(FENCES.includes(rule(c) ?? ""), c);
    }
  }
});

test("git -C <outside> stash/branch writes are still a write outside", { skip: !posix }, () => {
  for (const v of ["stash", "stash push", "stash pop", "stash drop", "branch -D x", "branch new-name"]) {
    const l = `git -C ${other} ${v}`;
    assert.equal(rule(l), "child-write-outside", l);
    const c = `git -C ${checkout} ${v}`;
    assert.ok(FENCES.includes(rule(c) ?? ""), c);
  }
});
