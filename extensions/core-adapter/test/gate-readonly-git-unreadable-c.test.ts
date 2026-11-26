// B2: a git write whose `-C` target cannot be read (`git -C "$D" commit`) has no folder to compare with the worktree root. A read-only role gets
// child-readonly-write (not child-write-outside naming the worktree as "outside"); a builder is refused by child-write-outside.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-ro-gitc-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const run = (command: string, role: string, ro: boolean): { block?: boolean; rule?: string; reason?: string } | undefined =>
  gateEvaluate("bash", { command }, wt, {
    env: (c) => baseFloorEnv(c, { child: true }),
    roots: () => ({ worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role, tmpAccess: false, ...(ro ? { roundReadOnly: true } : {}) }),
  }).result as { block?: boolean; rule?: string; reason?: string } | undefined;

test("git -C \"$D\" commit: the read-only roles get child-readonly-write, never the worktree named as an outside target", () => {
  for (const role of ["reviewer", "explorer"]) {
    const v = run('git -C "$D" commit -m x', role, true);
    assert.equal(v?.rule, "child-readonly-write", role);
    assert.ok(!/compared with the worktree root/.test(v?.reason ?? ""), role);
  }
});

test("git -C \"$D\" commit: a builder is refused by child-write-outside, and the text names the unreadable -C word, not the worktree", () => {
  const v = run('git -C "$D" commit -m x', "builder", false);
  assert.equal(v?.rule, "child-write-outside");
  assert.match(v?.reason ?? "", /Refused: "?\$D"?, compared/);
});

test("the outside-target text never names the worktree itself", () => {
  for (const line of ['git -C "$D" commit -m x', 'git -C "$D" clean -fd', 'cd "$X" && touch f', "touch /etc/x"]) {
    const m = /Refused: (.*?), compared with the worktree root (.*?)\. Sanctioned/.exec(run(line, "builder", false)?.reason ?? "");
    assert.ok(m, line);
    assert.notEqual(m[1], m[2], line);
  }
});

test("a builder's `cd \"$D\" && git commit`: the text names the unreadable cd word, not the worktree", () => {
  for (const line of ['cd "$D" && git commit -m x', 'cd "$D"; git clean -fd', 'cd "$A" && cd "$B" && git commit -m x']) {
    const m = /Refused: (.*?), compared with the worktree root (.*?)\. Sanctioned/.exec(run(line, "builder", false)?.reason ?? "");
    assert.ok(m, line);
    assert.match(m[1], /^"?\$[AD]"?$|^"?\$B"?$/, line);
    assert.notEqual(m[1], m[2], line);
  }
});
