// A program no table models (`caffeinate`, `strace`, `taskset`) passes its words on. Behind `npx sh -c '...'` or `find -exec sh -c '...'` the string is a nested script: the same look-behind
// applies there, so a push or a git write outside the worktree in it never runs silent for any role. A harmless command in the same shape stays silent.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeLayout, matrixOracle } from "./_gate-gen.ts";
import { mkTestTmp } from "./_tmpbase.ts";

process.env.PI_OFFLINE = "1";

const base = fs.realpathSync(mkTestTmp("pf-nrw-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const oracle = matrixOracle(makeLayout(base));

const ROLES = ["main", "builder", "reviewer"] as const;
const RANK = { silent: 0, judge: 1, ask: 2, block: 3 } as const;
const RUNNERS = ["caffeinate", "strace -f", "taskset -c 0"];
const INNER = ["git push origin main", "git -C /opt/other stash push", "git rebase -x 'git push' main"];
const wrap = (kind: "npx" | "find", script: string): string =>
  kind === "npx" ? `npx sh -c '${script.replace(/'/g, `'\\''`)}'` : `find . -maxdepth 0 -exec sh -c '${script.replace(/'/g, `'\\''`)}' \\;`;

for (const kind of ["npx", "find"] as const) {
  for (const runner of RUNNERS) {
    for (const inner of INNER) {
      test(`${kind} sh -c: ${runner} ${inner} is not silent where the plain line is not`, () => {
        const plain = `${runner} ${inner}`;
        for (const role of ROLES) {
          const want = oracle(plain, role);
          const got = oracle(wrap(kind, plain), role);
          assert.ok(RANK[want] === 0 || RANK[got] >= RANK.judge, `${role}: ${wrap(kind, plain)} is ${got}, the plain line is ${want}`);
        }
      });
    }
  }
}

test("a sweep seed's shrunk lines go to the judge or block for a builder", () => {
  for (const l of [
    "npx sh -c 'caffeinate git push origin main'",
    "npx sh -c 'strace -f git -C /opt/other stash push'",
    "npx sh -c 'taskset -c 0 git -C /opt/other stash push'",
    "find . -maxdepth 0 -exec sh -c 'strace -f git -C /opt/other stash push' \\;",
    "find . -maxdepth 0 -exec sh -c 'caffeinate git rebase -x '\\''git push'\\'' main' \\;",
    "npx sh -c 'caffeinate git rebase -x '\\''git push'\\'' main'",
  ]) assert.notEqual(oracle(l, "builder"), "silent", l);
});

test("two runners deep in a nested string still look behind", () => {
  assert.notEqual(oracle("npx sh -c 'caffeinate taskset -c 0 git push origin main'", "builder"), "silent");
});

test("a harmless command in the same shape stays silent", () => {
  for (const l of ["npx sh -c 'caffeinate echo hi'", "find . -maxdepth 0 -exec sh -c 'taskset -c 0 ls' \\;"]) for (const role of ["main", "builder"] as const) assert.equal(oracle(l, role), "silent", `${role}: ${l}`);
});
