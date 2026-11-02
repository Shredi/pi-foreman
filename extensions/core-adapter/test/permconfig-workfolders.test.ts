// PR5 work folders: permconfig.ts parses `workFolders` in the user file only, reports it dropped elsewhere, validates it at resolve time.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PermStore, userFilePath } from "../permconfig.ts";
import type { GitRun } from "../permconfig.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const root = fs.realpathSync(mkTestTmp("pf-wf-perm-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

function world() {
  const base = path.join(root, `w${++n}`);
  const agentDir = path.join(base, "agent");
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  const home = path.join(base, "home");
  for (const d of [path.join(agentDir, "pi-foreman"), path.join(main, ".workflow"), path.join(wt, ".pi"), home]) fs.mkdirSync(d, { recursive: true });
  const git: GitRun = (args) => {
    if (args[0] === "worktree") return { status: 0, stdout: `worktree ${main}\nHEAD abc\n\nworktree ${wt}\nHEAD abc\n` };
    if (args[0] === "check-ignore") return { status: 0, stdout: "" };
    return { status: 1, stdout: "" };
  };
  const put = (file: string) => (v: unknown) => fs.writeFileSync(file, JSON.stringify(v));
  return {
    base, home, main, wt,
    store: () => new PermStore({ agentDir, cwd: wt, home, git }),
    user: put(userFilePath(agentDir)),
    project: put(path.join(main, ".workflow", "permissions.json")),
    tracked: put(path.join(wt, ".pi", "permissions.json")),
  };
}

test("11 the user file: path and mode parse; mode defaults to auto; ~ expands; duplicates collapse", () => {
  const w = world();
  w.user({ workFolders: [{ path: "~/git", mode: "auto" }, { path: path.join(w.home, "notes"), mode: "read" }, { path: "~/plain" }, { path: "~/git" }] });
  const s = w.store();
  const r = s.resolve();
  assert.deepEqual(r.workFolders, [
    { path: path.join(w.home, "git"), mode: "auto" },
    { path: path.join(w.home, "notes"), mode: "read" },
    { path: path.join(w.home, "plain"), mode: "auto" },
  ]);
  assert.deepEqual(s.drainNotices(), []);
  assert.deepEqual(r.workFolderNotes, []);
});

test("11 a mode other than auto or read warns and falls back to read", () => {
  for (const mode of ["ask", "deny", "allow", 3]) {
    const w = world();
    w.user({ workFolders: [{ path: "~/git", mode }] });
    const s = w.store();
    assert.deepEqual(s.resolve().workFolders, [{ path: path.join(w.home, "git"), mode: "read" }], String(mode));
    assert.ok(s.drainNotices().some((x) => /workFolders\[0\] mode .* is not auto or read; using read/.test(x)), String(mode));
  }
});

test("11 entries without a path and a non-list are skipped with a notice", () => {
  const w = world();
  w.user({ workFolders: [{ mode: "auto" }, "~/x", { path: "" }, { path: "~/ok" }] });
  const s = w.store();
  assert.deepEqual(s.resolve().workFolders, [{ path: path.join(w.home, "ok"), mode: "auto" }]);
  assert.equal(s.drainNotices().filter((x) => /has no path; skipped/.test(x)).length, 3);
  const v = world();
  v.user({ workFolders: "~/git" });
  const t = v.store();
  assert.deepEqual(t.resolve().workFolders, []);
  assert.ok(t.drainNotices().some((x) => /workFolders must be a list/.test(x)));
});

test("11 relative, filesystem root, home dir and its ancestors are dropped with a warning", () => {
  const w = world();
  const parent = path.dirname(w.home);
  w.user({ workFolders: [{ path: "git" }, { path: "./git" }, { path: "/" }, { path: "~" }, { path: w.home }, { path: parent }, { path: path.dirname(parent) }, { path: "~/ok" }] });
  const s = w.store();
  const r = s.resolve();
  assert.deepEqual(r.workFolders, [{ path: path.join(w.home, "ok"), mode: "auto" }]);
  assert.equal(r.workFolderNotes.length, 7);
  assert.equal(r.workFolderNotes.filter((x) => /not an absolute path; dropped/.test(x)).length, 2);
  assert.equal(r.workFolderNotes.filter((x) => /home dir or one of its parents; dropped/.test(x)).length, 5);
  assert.equal(s.drainNotices().length, 7);
});

test("11 a folder outside home that is not an ancestor is kept with a warning", () => {
  const w = world();
  const out = path.join(w.base, "elsewhere");
  w.user({ workFolders: [{ path: out, mode: "read" }] });
  const s = w.store();
  const r = s.resolve();
  assert.deepEqual(r.workFolders, [{ path: out, mode: "read" }]);
  assert.ok(r.workFolderNotes.some((x) => /lies outside your home dir; kept/.test(x)));
});

test("11 layering: workFolders in a project or tracked file are reported dropped and not honoured", () => {
  const w = world();
  w.project({ workFolders: [{ path: "~/git" }] });
  w.tracked({ workFolders: [{ path: "~/git" }], deny: ["Bash(rm *)"] });
  const s = w.store();
  const r = s.resolve();
  assert.deepEqual(r.workFolders, []);
  const notes = s.drainNotices();
  assert.equal(notes.filter((x) => /workFolders is not honoured in the (project|tracked) file; dropped/.test(x)).length, 2, notes.join("\n"));
  assert.equal(r.rules.deny.length, 1);
});

test("11 layering: profiles.<name>.workFolders in the user file is reported dropped; the top-level key stays", () => {
  const w = world();
  w.user({ workFolders: [{ path: "~/git" }], profiles: { dev: { mode: "ask", workFolders: [{ path: "~/other" }] } } });
  const s = w.store();
  const r = s.resolve();
  assert.deepEqual(r.workFolders, [{ path: path.join(w.home, "git"), mode: "auto" }]);
  assert.ok(s.drainNotices().some((x) => /profiles\.dev\.workFolders is not honoured in the user file; dropped/.test(x)));
});

test("11 no user file or an invalid one: no folders", () => {
  const w = world();
  assert.deepEqual(w.store().resolve().workFolders, []);
  fs.writeFileSync(path.join(w.base, "agent", "pi-foreman", "permissions.json"), "{ nope");
  assert.deepEqual(w.store().resolve().workFolders, []);
});
