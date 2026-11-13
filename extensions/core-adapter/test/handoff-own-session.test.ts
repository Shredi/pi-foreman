// A session-level child (roots.child false, roots.ownHandoff set) writes the child-written names of its own handoff dir by path tool and by shell
// without a dialog; every other name stays refused. Ask mode: the write tool, `cp` and `cat f >` are an allow, `echo >`, `printf >` and a heredoc carry
// no danger mark and reach the mode step. The shell cases run on posix only (literal paths in a shell line).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import { pathDecide, type GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-hos-"));
const wt = path.join(base, "wt");
const H = path.join(base, "agent", "handoffs", "h1");
for (const d of [wt, path.join(H, "work")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "a"), "a");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (o: Partial<GateRoots> = {}): GateRoots => ({ worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false, ownHandoff: H, ...o });
const tool = (name: string, o: Partial<GateRoots> = {}): string | undefined => pathDecide("write", { path: path.join(H, name) }, wt, roots(o))?.rule;
type Seen = { allow?: string; block?: string; danger: string | null };
const shell = (command: string, o: Partial<GateRoots> = {}): Seen => {
  const r = roots(o);
  const out = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: r.child }), roots: () => r });
  const res = out.result as { allow?: boolean; block?: boolean; rule?: string } | undefined;
  return { ...(res?.allow ? { allow: res.rule } : {}), ...(res?.block ? { block: res.rule } : {}), danger: out.danger?.name ?? null };
};

const OWN = ["plan.md", "result.md", "ask.md", "ask-2.md", ".ask", ".seen", ".steer-last-read.json", "work/x.txt", "work/d/y.txt"];
const REFUSED = ["some-other.md", "ruling.md", "ruling-plan.md", "brief.md", "brief-2.md", "steer.md", "parent", "child", "close.json", "live.json", "work", "work/", "work/../x", "../x"];

test("write tool: the child-written names of the own handoff dir are a default allow", () => {
  for (const n of OWN) assert.equal(tool(n), "path-write-handoff", n);
});

test("write tool: every other name stays refused", () => {
  for (const n of REFUSED) assert.equal(tool(n), undefined, n);
});

test("write tool: no ownHandoff root, no allow beyond the existing plan.md/result.md rule", () => {
  for (const n of ["ask.md", ".seen", "work/x.txt", "plan.md", "result.md"]) assert.equal(tool(n, { ownHandoff: undefined }), undefined, n);
});

test("write tool: nothing below a .git segment, in any case", () => {
  for (const n of ["work/.git/HEAD", "work/.GIT/HEAD", "work/sub/.Git/config"]) assert.equal(tool(n), undefined, n);
  assert.equal(tool("work/.gitignore"), "path-write-handoff");
});

test("shell cp, and cat f >, into an own name are an allow", { skip: !posix }, () => {
  for (const n of ["result.md", "plan.md", "ask.md", ".seen", "work/x.txt"]) {
    assert.deepEqual(shell(`cp ${wt}/a ${H}/${n}`), { allow: "default-write-in", danger: null }, `cp ${n}`);
    assert.deepEqual(shell(`cat ${wt}/a > ${H}/${n}`), { allow: "default-write-in", danger: null }, `cat > ${n}`);
  }
});

test("shell echo >, printf > and a heredoc into an own name carry no danger mark (mode step)", { skip: !posix }, () => {
  for (const l of [`echo x > ${H}/result.md`, `printf x >> ${H}/ask-1.md`, `cat > ${H}/result.md <<EOF\nhi\nEOF`, `echo x > ${H}/work/n.txt`]) assert.deepEqual(shell(l), { danger: null }, l);
});

test("shell mv, touch and mkdir on own names are an allow", { skip: !posix }, () => {
  assert.deepEqual(shell(`mv ${wt}/a ${H}/work/moved.txt`), { allow: "default-write-in", danger: null });
  assert.deepEqual(shell(`touch ${H}/ask.md`), { allow: "default-write-in", danger: null });
  assert.deepEqual(shell(`mkdir -p ${H}/work/d`), { allow: "default-write-in", danger: null });
});

test("shell writes of every other name stay write-outside", { skip: !posix }, () => {
  for (const n of ["some-other.md", "ruling.md", "brief.md", "close.json", "parent", "child", "work/../x", "work/.git/HEAD", "work/.GIT/HEAD"]) {
    for (const l of [`echo x > ${H}/${n}`, `cp ${wt}/a ${H}/${n}`, `cat ${wt}/a > ${H}/${n}`, `mv ${wt}/a ${H}/${n}`]) {
      const s = shell(l);
      assert.equal(s.allow, undefined, l);
      assert.equal(s.danger, "danger-write-outside", l);
    }
  }
});

test("without ownHandoff the same shell writes stay write-outside", { skip: !posix }, () => {
  for (const l of [`echo x > ${H}/result.md`, `cp ${wt}/a ${H}/result.md`]) assert.deepEqual(shell(l, { ownHandoff: undefined }), { danger: "danger-write-outside" }, l);
});

test("an earlier-call variable is no allow (opaque)", { skip: !posix }, () => {
  const s = shell(`cp ${wt}/a $D/result.md`);
  assert.equal(s.allow, undefined);
  assert.equal(s.danger, "danger-opaque");
});
