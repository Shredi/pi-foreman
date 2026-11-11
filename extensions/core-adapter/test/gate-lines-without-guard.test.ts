// With the git guard gone, these shell lines meet only the gate: the PR forms of drop 15 and drop 3, the unreadable and false-alarm lines
// (dangerous class "opaque", no floor, no guard text), and `git commit` with any message. Gate level, main session and child as the gate sees them.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-noguard-"));
const wt = path.join(base, "wt");
fs.mkdirSync(wt, { recursive: true });
after(() => rmTestTmp(base));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [], tmp: [], scratchBase: path.join(base, "scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: false });
const run = (command: string, child: boolean) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, child ? { child: true } : {}), roots: () => roots(child) });
type Res = { allow?: boolean; block?: boolean; ask?: boolean; rule?: string; reason?: string };
const res = (o: ReturnType<typeof run>): Res => (o.result ?? {}) as Res;
const GUARD = /git[ -]?guard/i;

for (const child of [false, true]) {
  const who = child ? "child" : "main";

  test(`${who}: the unreadable lines sh -c "$X" and python3 -c naming git reach the mode step in the dangerous class, with no guard text`, { skip: !posix }, () => {
    for (const l of ['sh -c "$X"', "python3 -c \"import subprocess; subprocess.run(['git','status'])\""]) {
      const o = run(l, child);
      assert.equal(res(o).block, undefined, `${l}: ${JSON.stringify(o.result)}`);
      assert.equal(res(o).ask, undefined, l);
      assert.equal(o.danger?.name, "danger-opaque", `${l}: ${JSON.stringify(o.danger)}`);
      assert.doesNotMatch(JSON.stringify(o), GUARD, l);
    }
  });

  test(`${who}: the false-alarm line echo "wall $(( $(date +%s) - start ))s"; ls has no floor, no deny and no ask (class opaque, left to the mode step)`, { skip: !posix }, () => {
    const o = run('echo "wall $(( $(date +%s) - start ))s"; ls', child);
    assert.deepEqual(res(o), {}, JSON.stringify(o.result));
    assert.equal(o.danger?.name, "danger-opaque", JSON.stringify(o.danger));
  });

  test(`${who}: git commit -m with any message gets the same gate decision whatever the message (messages are not read)`, { skip: !posix }, () => {
    const a = run('git commit -m "anything"', child);
    const b = run('git commit -m "WIP fixup! no trailer, not a conventional subject"', child);
    assert.deepEqual(res(a), res(b));
    assert.equal(res(a).block, undefined, JSON.stringify(a.result));
    assert.equal(res(a).ask, undefined);
  });
}

test("child PR forms: hub pull-request and tea pr create are not refused by a PR rule", { skip: !posix }, () => {
  for (const l of ["hub pull-request -m x", "tea pr create --title x"]) {
    const o = run(l, true);
    assert.equal(res(o).block, undefined, `${l}: ${JSON.stringify(o.result)}`);
    assert.doesNotMatch(String(res(o).rule), /pr-create/, l);
  }
});

test("child PR forms: gh api repos/o/r/pulls is in the dangerous class (reaches the mode step, no silent allow)", { skip: !posix }, () => {
  const o = run("gh api repos/o/r/pulls -f title=x", true);
  assert.equal(res(o).block, undefined, JSON.stringify(o.result));
  assert.equal(res(o).allow, undefined, "no rule allowed it");
  assert.equal(o.danger?.name, "danger-forge", JSON.stringify(o.danger));
});

test("child PR forms: gh pr create and glab mr create are refused by child-pr-create", { skip: !posix }, () => {
  for (const l of ["gh pr create --title t --body b", "glab mr create --title t"]) {
    const o = run(l, true);
    assert.equal(res(o).block, true, l);
    assert.equal(res(o).rule, "child-pr-create", l);
  }
});

test("drop 3: gh pr create in the main session is not refused for a missing review; the same line from a child is refused", { skip: !posix }, () => {
  for (const l of ["gh pr create --title t --body b", "glab mr create --title t"]) {
    const m = run(l, false);
    assert.equal(res(m).block, undefined, `${l}: ${JSON.stringify(m.result)}`);
    assert.doesNotMatch(JSON.stringify(m), /review|PASS/i, l);
    assert.equal(res(run(l, true)).block, true, l);
  }
});
