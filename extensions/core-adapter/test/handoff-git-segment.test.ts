// No `.git` segment below a handoff dir is a child-written name: `childHandoffWrite` refuses it the way `folderProtected` matches it (without case on
// every platform; win32: trailing dots and spaces dropped). Path tool, shell redirect, cp and mv all go through it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import { childHandoffWrite, pathDecide, type GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";

test("posix: a .git segment below work/ is refused in any case; .gitignore and a name containing .git are fine", () => {
  const real = (p: string): string | null => p;
  const root = "/h/handoffs/h1";
  const ok = (rel: string): boolean => childHandoffWrite(root, `${root}/${rel}`, `${root}/${rel}`, "linux", real);
  for (const rel of ["work/.git/HEAD", "work/.GIT/HEAD", "work/.Git/config", "work/a/.git", "work/a/.git/b/c"]) assert.equal(ok(rel), false, rel);
  for (const rel of ["work/.gitignore", "work/a.git/x", "work/legit/x.txt", "work/x.git"]) assert.equal(ok(rel), true, rel);
});

test("win32: .git spelled with trailing dots or spaces, in any case, is refused", () => {
  const real = (p: string): string | null => p;
  const root = "C:\\h\\handoffs\\h1";
  const ok = (rel: string): boolean => childHandoffWrite(root, `${root}\\${rel}`, `${root}\\${rel}`, "win32", real);
  for (const rel of ["work\\.git\\HEAD", "work\\.GIT\\HEAD", "work\\.git.\\HEAD", "work\\.git \\HEAD", "work\\a\\.Git...\\x", "work\\GIT~1\\x"]) assert.equal(ok(rel), false, rel);
  for (const rel of ["work\\.gitignore", "work\\x.txt"]) assert.equal(ok(rel), true, rel);
});

test("the real spelling is judged too: a .git segment that only the real path shows is refused", () => {
  const root = "/h/handoffs/h1";
  assert.equal(childHandoffWrite(root, `${root}/work/link/x`, `${root}/work/.git/x`, "linux", (p) => p), false);
});

const base = fs.realpathSync(mkTestTmp("pf-hgs-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
for (const d of [wt, scr, path.join(H, "work", ".git")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "a"), "a");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (kind: "S" | "C"): GateRoots => ({ worktree: wt, scratch: kind === "S" ? [scr] : [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: kind === "S", role: "builder", tmpAccess: false, ...(kind === "S" ? { childHandoff: H } : { ownHandoff: H }) });

test("write tool, S and C: work/.git and work/.GIT are no default; work/x is", () => {
  for (const k of ["S", "C"] as const) {
    for (const n of ["work/.git/HEAD", "work/.GIT/HEAD", "work/.git"]) assert.equal(pathDecide("write", { path: path.join(H, n) }, wt, roots(k)), undefined, `${k} ${n}`);
    assert.equal(pathDecide("write", { path: path.join(H, "work", "x.txt") }, wt, roots(k))?.rule, "path-write-handoff", k);
  }
});

test("shell, S: redirect, cp and mv into work/.git or work/.GIT are blocked", { skip: !posix }, () => {
  const seen = (command: string): string | undefined => {
    const r = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true }), roots: () => roots("S") }).result as { block?: boolean; rule?: string } | undefined;
    return r?.block ? r.rule : undefined;
  };
  for (const n of ["work/.git/HEAD", "work/.GIT/HEAD"]) {
    for (const l of [`echo x > ${H}/${n}`, `cp ${wt}/a ${H}/${n}`, `mv ${wt}/a ${H}/${n}`]) assert.equal(seen(l), "child-write-outside", l);
  }
  assert.equal(seen(`cp ${wt}/a ${H}/work/x.txt`), undefined);
});

test("shell, C: redirect, cp and mv into work/.git are write-outside, work/x carries no danger", { skip: !posix }, () => {
  const danger = (command: string): string | null => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: false }), roots: () => roots("C") }).danger?.name ?? null;
  for (const n of ["work/.git/HEAD", "work/.GIT/HEAD"]) {
    for (const l of [`echo x > ${H}/${n}`, `cp ${wt}/a ${H}/${n}`, `mv ${wt}/a ${H}/${n}`]) assert.equal(danger(l), "danger-write-outside", l);
  }
  assert.equal(danger(`echo x > ${H}/work/x.txt`), null);
});
