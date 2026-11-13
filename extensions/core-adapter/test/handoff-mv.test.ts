// A subagent child (roots.child, roots.childHandoff) may `mv` into the child-written names of the launching session's handoff dir, as `cp` does:
// both branches (move onto a name, move into an existing dir). The source rule is unchanged: a source in the handoff dir is refused.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-hmv-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
for (const d of [wt, scr, path.join(H, "work", "sub")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "a"), "a");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false, childHandoff: H });
const seen = (command: string): string => {
  const r = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true }), roots: roots }).result as { allow?: boolean; block?: boolean; rule?: string } | undefined;
  return r?.block ? `block:${r.rule}` : r?.allow ? `allow:${r.rule}` : "none";
};

test("mv onto an allow-list name or a file below work/ passes the child floor and is a default allow", { skip: !posix }, () => {
  for (const n of ["result.md", "plan.md", "ask.md", ".seen", "ask-3.md", "work/y.txt", "work/sub/z.txt"]) assert.equal(seen(`mv ${wt}/a ${H}/${n}`), "allow:default-write-in", n);
});

test("mv into an existing dir: work/ and work/sub/ accept the moved name", { skip: !posix }, () => {
  assert.equal(seen(`mv ${wt}/a ${H}/work`), "allow:default-write-in");
  assert.equal(seen(`mv ${wt}/a ${H}/work/sub/`), "allow:default-write-in");
});

test("mv into the handoff dir itself puts a non-listed name there: refused", { skip: !posix }, () => {
  assert.equal(seen(`mv ${wt}/a ${H}`), "block:child-write-outside");
});

test("mv onto parent-owned names, outside names and .git below work/ stays refused", { skip: !posix }, () => {
  for (const n of ["ruling.md", "brief.md", "close.json", "parent", "some-other.md", "work/.git/HEAD", "work/.GIT/HEAD"]) assert.equal(seen(`mv ${wt}/a ${H}/${n}`), "block:child-write-outside", n);
});

test("the source rule is unchanged: a source in the handoff dir is refused, also handoff to handoff", { skip: !posix }, () => {
  fs.writeFileSync(path.join(H, "result.md"), "r");
  assert.equal(seen(`mv ${H}/result.md ${H}/work/y.txt`), "block:child-write-outside");
  assert.equal(seen(`mv ${H}/result.md ${wt}/b`), "block:child-write-outside");
});

test("cp stays allowed onto the same names (pin)", { skip: !posix }, () => {
  assert.equal(seen(`cp ${wt}/a ${H}/result.md`), "allow:default-write-in");
  assert.equal(seen(`cp ${wt}/a ${H}/ruling.md`), "block:child-write-outside");
});

test("redirects: a literal redirect to an own name passes the floor, to another name stays blocked", { skip: !posix }, () => {
  assert.notEqual(seen(`echo x > ${H}/result.md`), "block:child-write-outside");
  assert.equal(seen(`echo x > ${H}/ruling.md`), "block:child-write-outside");
  assert.equal(seen(`echo x > ${base}/out/f`), "block:child-write-outside");
});

test("a redirect into an own name with a built-in default segment (cat f >) is an allow", { skip: !posix }, () => {
  assert.equal(seen(`cat ${wt}/a > ${H}/result.md`), "allow:default-write-in");
});
