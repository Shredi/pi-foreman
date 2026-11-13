// A parent session's shell write of a ruling or brief into a handoff dir it opened is an allow in every mode (as the write tool is); only the names
// `ruling*.md` / `brief*.md`, only dirs the session opened, never a dir where the session is the child (also opened-and-child, also through a link).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import { pathDecide, type GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-hpr-"));
const wt = path.join(base, "wt");
const O = path.join(base, "agent", "handoffs", "opened");
const F = path.join(base, "agent", "handoffs", "foreign");
const MINE = path.join(base, "agent", "handoffs", "mine");
for (const d of [wt, O, F, MINE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "a"), "a");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (o: Partial<GateRoots> = {}): GateRoots => ({ worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], openedHandoffs: [O], child: false, role: "foreman", tmpAccess: false, ...o });
type Seen = { allow?: string; danger: string | null };
const shell = (command: string, o: Partial<GateRoots> = {}): Seen => {
  const r = roots(o);
  const out = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: r.child }), roots: () => r });
  const res = out.result as { allow?: boolean; rule?: string } | undefined;
  return { ...(res?.allow ? { allow: res.rule } : {}), danger: out.danger?.name ?? null };
};
const ALLOWED: Seen = { allow: "default-write-handoff-ruling", danger: null };

test("redirect, cat >, heredoc, cp and mv into ruling*.md / brief*.md of an opened dir are an allow", { skip: !posix }, () => {
  for (const n of ["ruling.md", "ruling-3.md", "ruling-plan.md", "brief.md", "brief-2.md"]) {
    for (const l of [`echo x > ${O}/${n}`, `printf x >> ${O}/${n}`, `cat ${wt}/a > ${O}/${n}`, `cat > ${O}/${n} <<EOF\nhi\nEOF`, `cp ${wt}/a ${O}/${n}`, `mv ${wt}/a ${O}/${n}`]) {
      assert.deepEqual(shell(l), ALLOWED, l);
      fs.writeFileSync(path.join(wt, "a"), "a");
    }
  }
});

test("other names of an opened dir, other dirs and a missing opened root stay write-outside", { skip: !posix }, () => {
  const cases: Array<[string, Partial<GateRoots>?]> = [
    [`echo x > ${O}/notes.md`], [`echo x > ${O}/ask.md`], [`echo x > ${O}/result.md`], [`cp ${wt}/a ${O}/close.json`], [`echo x > ${O}/ruling.txt`], [`echo x > ${O}/work/ruling.md`],
    [`echo x > ${F}/ruling.md`], [`cp ${wt}/a ${F}/brief.md`], [`echo x > ${O}/ruling.md`, { openedHandoffs: [] }],
  ];
  for (const [l, o] of cases) assert.deepEqual(shell(l, o), { danger: "danger-write-outside" }, l);
});

test("every target must be a ruling target: a second redirect into the worktree or another dir is no allow", { skip: !posix }, () => {
  for (const l of [`echo x > ${O}/ruling.md > ${wt}/b`, `echo x > ${O}/ruling.md > ${F}/ruling.md`, `cp ${wt}/a ${O}/ruling.md > ${wt}/b`]) assert.equal(shell(l).allow, undefined, l);
});

test("only echo, printf, cat, cp and mv: another program writing a ruling name is no allow", { skip: !posix }, () => {
  for (const l of [`sort ${wt}/a > ${O}/ruling.md`, `git log > ${O}/ruling.md`, `curl -s https://example.com > ${O}/ruling.md`]) assert.equal(shell(l).allow, undefined, l);
});

test("an earlier-call variable stays unresolved: no allow", { skip: !posix }, () => {
  for (const l of [`echo x > $D/ruling.md`, `cp ${wt}/a $D/brief.md`]) assert.equal(shell(l).allow, undefined, l);
});

test("a dir where the session is the child never gets the ruling allow (ownHandoff, childHandoffs, opened-and-child)", { skip: !posix }, () => {
  const cases: Array<Partial<GateRoots>> = [{ openedHandoffs: [MINE], ownHandoff: MINE }, { openedHandoffs: [MINE], childHandoffs: [MINE] }, { openedHandoffs: [O, MINE], childHandoffs: [MINE], ownHandoff: MINE }];
  for (const o of cases) {
    for (const l of [`echo x > ${MINE}/ruling.md`, `cat ${wt}/a > ${MINE}/brief.md`, `cp ${wt}/a ${MINE}/ruling-2.md`, `mv ${wt}/a ${MINE}/ruling.md`]) {
      assert.equal(shell(l, o).allow, undefined, l);
    }
    assert.equal(pathDecide("write", { path: path.join(MINE, "ruling.md") }, wt, roots(o)), undefined);
    assert.equal(pathDecide("write", { path: path.join(MINE, "brief-2.md") }, wt, roots(o)), undefined);
  }
  // the other opened dir of the same session still works
  assert.deepEqual(shell(`echo x > ${O}/ruling.md`, { openedHandoffs: [O, MINE], childHandoffs: [MINE] }), ALLOWED);
});

test("a symlinked spelling of the session's own child dir is excluded on its real path too", (t) => {
  const link = path.join(base, "agent", "handoffs", "link-to-mine");
  try {
    fs.symlinkSync(MINE, link, "dir");
  } catch {
    t.skip("cannot create a symlink on this platform");
    return;
  }
  // the opened root is spelled through the link, the child dir by its real path
  const o: Partial<GateRoots> = { openedHandoffs: [link], ownHandoff: MINE };
  assert.equal(pathDecide("write", { path: path.join(link, "ruling.md") }, wt, roots(o)), undefined);
  assert.equal(pathDecide("write", { path: path.join(MINE, "ruling.md") }, wt, roots(o)), undefined);
  // and the child dir spelled through the link, the opened root by its real path
  const p: Partial<GateRoots> = { openedHandoffs: [MINE], childHandoffs: [link] };
  assert.equal(pathDecide("write", { path: path.join(MINE, "ruling.md") }, wt, roots(p)), undefined);
  // control: with no child dir the link spelling is an opened dir like any other
  assert.equal(pathDecide("write", { path: path.join(link, "ruling.md") }, wt, roots({ openedHandoffs: [link] }))?.rule, "path-write-handoff-ruling");
});
