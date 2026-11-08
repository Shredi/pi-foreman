// `git -C <outside> worktree list | config reads | tag list forms` (and the same after `cd <dir> &&`) name no write target; mutating forms stay denied;
// `cd <dir> && echo x > out.txt` is judged against the cd target; an opaque segment never passes silently.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-gitc2-"));
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

const READS = [
  "worktree list", "worktree list --porcelain", "worktree list -v", "worktree list --verbose -z", "worktree list --expire=1.day",
  "config --get user.name", "config --get-all remote.origin.fetch", "config --get-regexp ^user", "config --list", "config -l", "config user.name",
  "config --show-origin --list", "config --show-scope --get user.name", "config --name-only --list",
  "tag", "tag -l", "tag --list 'v*'", "tag -n", "tag -n5", "tag --contains HEAD", "tag --no-contains HEAD", "tag --points-at HEAD", "tag --merged", "tag --no-merged main",
  "tag --sort=-creatordate", "tag --format=%(refname)", "tag --column", "tag -i -l 'V*'",
];

test("new read forms under -C <outside> are no write outside nor into the checkout", { skip: !posix }, () => {
  for (const d of [other, checkout]) {
    for (const v of READS) {
      for (const l of [`git -C ${d} ${v}`, `git -C ${d} ${v} | grep x`, `git -C ${d} ${v} | tail -3`, `cd ${d} && git ${v}`, `cd ${d} && git ${v} | grep x`]) {
        assert.ok(!FENCES.includes(rule(l) ?? ""), `${l}: ${rule(l)}`);
      }
    }
  }
});

test("mutating -C forms stay denied outside and into the checkout", { skip: !posix }, () => {
  const MUT = ["commit -m x", "checkout x", "reset --hard", "worktree add x", "worktree remove x", "worktree prune", "worktree list --bogus", "branch -D x",
    "stash push", "stash pop", "config user.name x", "config --unset x", "config --add a b", "config --edit", "tag v1", "tag -d v1", "tag -a v1 -m x", "tag -f v1", "tag -l -d v1", "fetch"];
  for (const v of MUT) {
    const l = `git -C ${other} ${v}`;
    // an earlier floor (git config --edit) may deny first: any denial counts, the fences are the expected ones otherwise
    assert.ok(rule(l) === "child-write-outside" || /^floor-/.test(rule(l) ?? ""), `${l}: ${rule(l)}`);
    const c = `git -C ${checkout} ${v}`;
    assert.ok(FENCES.includes(rule(c) ?? "") || /^floor-/.test(rule(c) ?? ""), `${c}: ${rule(c)}`);
    const cd = `cd ${other} && git ${v}`;
    assert.ok(rule(cd) === "child-write-outside" || /^floor-/.test(rule(cd) ?? ""), `${cd}: ${rule(cd)}`);
  }
});

test("a --output file option on a read form stays a write", { skip: !posix }, () => {
  const l = `git -C ${other} tag --list --output=${other}/x`;
  assert.equal(rule(l), "child-write-outside", l);
});

test("cd <dir> && redirect is judged against the cd target", { skip: !posix }, () => {
  assert.equal(rule(`cd ${other} && echo x > out.txt`), "child-write-outside");
  assert.ok(!FENCES.includes(rule(`cd ${wt} && echo x > out.txt`) ?? ""), String(rule(`cd ${wt} && echo x > out.txt`)));
});

test("an opaque segment does not pass silently", { skip: !posix }, () => {
  for (const l of [`cd $(echo ${other}) && git commit -m x`, `cd ${other} && git worktree list; eval "git commit"`]) {
    assert.equal(rule(l), "child-write-outside", l);
  }
});
