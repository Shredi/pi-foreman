// Ledger 18(f): the gate against REAL symlinks into the repository's git folder and the project `.pi` folder (`gd` -> git folder, `pp` -> `.pi`, `lnk` -> a file in `.pi`,
// `sub/gd2` -> `../<git folder>`). The fixture is made at run time in a temp dir; the contexts are built as the other r2 tests build them. The gate resolves through the real
// filesystem here: `roots.realpath` is left unset, so `realDefault` (the native realpath) is used. Each row pins the literal verdict for a builder (child), a reviewer
// (read-only child) and the main session; a symlink spelling gets what the plain spelling gets.
// Symlink creation needs privileges on win32, so every test is skipped there (the pattern of `rm-link.test.ts`: `{ skip: !posix }`).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { gateEvaluate } from "../gate.ts";
import { pathDecide, realDefault, realSpelling } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-r2-symfx-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const G = "." + "git";
const GT = String.fromCharCode(62);
const wt = path.join(base, "wt");
const home = path.join(base, "home");
const agent = path.join(home, ".pi", "agent");
const scr = path.join(base, "scr");
for (const d of [path.join(wt, G, "hooks"), path.join(wt, ".pi"), path.join(wt, "sub"), agent, scr]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, ".pi", "foreman.json"), "{}\n");
fs.writeFileSync(path.join(wt, "a"), "a\n");
if (posix) {
  fs.symlinkSync(G, path.join(wt, "gd"), "dir");
  fs.symlinkSync(".pi", path.join(wt, "pp"), "dir");
  fs.symlinkSync(path.join(".pi", "foreman.json"), path.join(wt, "lnk"));
  fs.symlinkSync(path.join("..", G), path.join(wt, "sub", "gd2"), "dir");
  fs.symlinkSync("src", path.join(wt, "ln"), "dir");
  fs.symlinkSync(".github", path.join(wt, "gh"), "dir");
}
for (const d of ["src", path.join("sub", "gd"), ".github"]) fs.mkdirSync(path.join(wt, d), { recursive: true });

type Role = "builder" | "reviewer" | "main";
const roots = (role: Role) => ({
  worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "sb"), owned: [], install: [], roundFlow: [], handoffs: [],
  child: role !== "main", role: role === "main" ? "foreman" : role, tmpAccess: true, agentDir: agent, home,
  ...(role === "reviewer" ? { roundReadOnly: true } : {}),
}) as never;
const facts = { currentBranch: () => "feature/x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false };
const got = (role: Role, tool: string, input: Record<string, unknown>): string => {
  const env = (): FloorEnv => ({ cwd: wt, home, agentDir: agent, writeRoots: [wt, scr], scratch: [scr], child: role !== "main" });
  const o = gateEvaluate(tool, input, wt, { env, roots: () => roots(role), facts });
  const r = o.result as Record<string, unknown> | undefined;
  return r?.block ? `block ${r.rule}` : r?.ask ? `ask ${r.rule}` : r?.allow ? `allow ${r.rule}` : `undecided ${JSON.stringify([...(o.dangers ?? [])].sort())}`;
};
// expected verdicts in the order builder, reviewer, main
type Exp = [string, string, string];
const ROLES: Role[] = ["builder", "reviewer", "main"];
const bashRow = (line: string, exp: Exp): void => ROLES.forEach((role, i) => assert.equal(got(role, "bash", { command: line }), exp[i], `${role}: ${line}`));
const pathRow = (p: string, exp: Exp): void => {
  for (const spelling of [p, path.join(wt, p)]) {
    ROLES.forEach((role, i) => {
      assert.equal(got(role, "write", { path: spelling, content: "x" }), exp[i], `${role} write: ${spelling}`);
      assert.equal(got(role, "edit", { path: spelling, edits: [{ oldText: "a", newText: "b" }] }), exp[i], `${role} edit: ${spelling}`);
    });
  }
};
const CWO = "block child-write-outside";
const PI = "block selfmod-project-pi";
const ASKPI = "ask selfmod-project-pi";
const WO = 'undecided ["danger-write-outside"]';
const OPQ = 'undecided ["danger-opaque"]';
const NONE = "undecided []";
const ALLOW = "allow path-write-worktree";
const ALLOW_READ = "allow path-read-worktree";

test("bash: a redirect, cp and mv through a link to the git folder or `.pi` get what the plain spelling gets", { skip: !posix }, () => {
  bashRow(`echo x ${GT} gd/hooks/pre-commit`, [CWO, CWO, WO]);
  bashRow(`echo x ${GT} ${G}/hooks/pre-commit`, [CWO, CWO, WO]);
  bashRow(`echo x ${GT} pp/foreman.json`, [PI, PI, ASKPI]);
  bashRow(`echo x ${GT} .pi/foreman.json`, [PI, PI, ASKPI]);
  bashRow("cp a gd/hooks/pre-commit", [CWO, CWO, WO]);
  bashRow(`cp a ${G}/hooks/pre-commit`, [CWO, CWO, WO]);
  bashRow("mv a pp/foreman.json", [PI, PI, ASKPI]);
  bashRow("mv a .pi/foreman.json", [PI, PI, ASKPI]);
  bashRow(`echo x ${GT} sub/gd2/hooks/pre-commit`, [CWO, CWO, WO]);
});

test("bash: a redirect into a link to a file in `.pi` is the selfmod rule, as the plain path", { skip: !posix }, () => {
  bashRow(`echo x ${GT} lnk`, [PI, PI, ASKPI]);
  bashRow(`echo x ${GT} .pi/foreman.json`, [PI, PI, ASKPI]);
});

test("bash: tee through a link and the plain spelling (the main session and the reviewer are as strict as plain)", { skip: !posix }, () => {
  bashRow(`tee ${G}/hooks/pre-commit`, [CWO, CWO, OPQ]);
  // the reviewer is blocked as for the plain spelling; main is undecided with the opaque label for both spellings
  assert.equal(got("reviewer", "bash", { command: "tee gd/hooks/pre-commit" }), CWO);
  assert.equal(got("main", "bash", { command: "tee gd/hooks/pre-commit" }), OPQ);
});

test("bash: a builder's `tee gd/hooks/pre-commit` is blocked as the plain `tee <git folder>/hooks/pre-commit`", { skip: !posix }, () => {
  assert.equal(got("builder", "bash", { command: "tee gd/hooks/pre-commit" }), CWO);
  assert.equal(got("builder", "bash", { command: `tee ${G}/hooks/pre-commit` }), CWO);
});

test("write and edit tools: `.pi` through a link or a link to a file is the selfmod rule, relative and absolute, as plain", { skip: !posix }, () => {
  pathRow("pp/foreman.json", [PI, PI, ASKPI]);
  pathRow(".pi/foreman.json", [PI, PI, ASKPI]);
  pathRow("lnk", [PI, PI, ASKPI]);
});

test("write and edit tools: the plain git folder path", { skip: !posix }, () => {
  pathRow(`${G}/hooks/pre-commit`, [CWO, CWO, NONE]);
});

test("write and edit tools: the reviewer stays blocked through the git-folder links, as plain", { skip: !posix }, () => {
  for (const p of ["gd/hooks/pre-commit", "sub/gd2/hooks/pre-commit"]) for (const s of [p, path.join(wt, p)]) {
    assert.equal(got("reviewer", "write", { path: s, content: "x" }), CWO, s);
    assert.equal(got("reviewer", "edit", { path: s, edits: [{ oldText: "a", newText: "b" }] }), CWO, s);
  }
});

test("write and edit tools through `gd` or `sub/gd2` get what the plain git folder path gets (builder blocked, main no decision)", { skip: !posix }, () => {
  for (const p of ["gd/hooks/pre-commit", "sub/gd2/hooks/pre-commit"]) pathRow(p, [CWO, CWO, NONE]);
});

test("write tool: paths that only look like the git folder or are links elsewhere stay allowed for a builder", { skip: !posix }, () => {
  for (const p of ["ln/f", "sub/gd/f", "x.git", ".github/f", ".gitignore", ".gitattributes", "gh/f"]) {
    for (const s of [p, path.join(wt, p)]) assert.equal(got("builder", "write", { path: s, content: "x" }), ALLOW, s);
  }
});

test("read tool: a read through `gd` keeps its outcome", { skip: !posix }, () => {
  assert.equal(got("builder", "read", { path: "gd/HEAD" }), got("builder", "read", { path: `${G}/HEAD` }));
  assert.equal(got("builder", "read", { path: "gd/HEAD" }), ALLOW_READ);
});

// A real ancestor of the root named like the git folder does not make an ordinary write below the root a git-folder write: only the segments below the root count.
const gotAt = (wtRoot: string, scrRoot: string, role: Role, tool: string, input: Record<string, unknown>): string => {
  const rs = { ...(roots(role) as object), worktree: wtRoot, scratch: [scrRoot] } as never;
  const env = (): FloorEnv => ({ cwd: wtRoot, home, agentDir: agent, writeRoots: [wtRoot, scrRoot], scratch: [scrRoot], child: role !== "main" });
  const o = gateEvaluate(tool, input, wtRoot, { env, roots: () => rs, facts });
  const r = o.result as Record<string, unknown> | undefined;
  return r?.block ? `block ${r.rule}` : r?.ask ? `ask ${r.rule}` : r?.allow ? `allow ${r.rule}` : `undecided ${JSON.stringify([...(o.dangers ?? [])].sort())}`;
};
const under = path.join(base, "outer", G);
const wtReal = path.join(under, "wt-real");
const wtLink = path.join(base, "wtlink");
const scrReal = path.join(under, "scr-real");
const scrLink = path.join(base, "scrlink");
if (posix) {
  for (const d of [path.join(wtReal, "src"), path.join(wtReal, G, "hooks"), scrReal]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(wtReal, "src", "a"), "a\n");
  fs.symlinkSync(G, path.join(wtReal, "gd"), "dir");
  fs.symlinkSync(wtReal, wtLink, "dir");
  fs.symlinkSync(scrReal, scrLink, "dir");
}
const ORDINARY = ["src/a", "src/new.txt", ".gitignore", path.join("newdir", "new.txt")];

test("a worktree below a git-named folder, given through a link or really: ordinary writes are allowed in all spellings", { skip: !posix }, () => {
  for (const root of [wtLink, wtReal]) for (const role of ROLES) for (const rel of ORDINARY) {
    for (const spelling of [rel, path.join(wtLink, rel), path.join(wtReal, rel)]) {
      // a root given through the link with a path in the real spelling is outside the root as given: unchanged by this fix, not a row here
      if (root === wtLink && spelling.startsWith(wtReal)) continue;
      const want = role === "reviewer" ? "block child-readonly-write" : ALLOW;
      assert.equal(gotAt(root, scr, role, "write", { path: spelling, content: "x" }), want, `${role} ${root} ${spelling}`);
      assert.equal(gotAt(root, scr, role, "edit", { path: spelling, edits: [{ oldText: "a", newText: "b" }] }), want, `${role} ${root} ${spelling}`);
    }
  }
});

test("a worktree below a git-named folder: its own git folder and a link to it stay blocked as plain", { skip: !posix }, () => {
  for (const root of [wtLink, wtReal]) for (const rel of [path.join(G, "hooks", "h"), path.join("gd", "hooks", "h"), path.join("gd", "config")]) {
    for (const spelling of [rel, path.join(wtLink, rel), path.join(wtReal, rel)]) {
      if (root === wtReal && spelling.startsWith(wtLink)) continue;
      assert.equal(gotAt(root, scr, "builder", "write", { path: spelling, content: "x" }), CWO, `${root} ${spelling}`);
      assert.equal(gotAt(root, scr, "reviewer", "write", { path: spelling, content: "x" }), CWO, `${root} ${spelling}`);
      assert.equal(gotAt(root, scr, "main", "write", { path: spelling, content: "x" }), NONE, `${root} ${spelling}`);
    }
  }
});

test("a scratch root below a git-named folder, given through a link: a write of <scratch>/f is allowed; its own git folder is not", { skip: !posix }, () => {
  for (const role of ["builder", "reviewer"] as Role[]) {
    for (const sc of [scrLink, scrReal]) {
      assert.equal(gotAt(wt, sc, role, "write", { path: path.join(sc, "f"), content: "x" }), "allow path-write-scratch", `${role} ${sc}`);
      assert.equal(gotAt(wt, sc, role, "write", { path: path.join(sc, G, "f"), content: "x" }), CWO, `${role} ${sc}`);
    }
  }
});

// A DANGLING link (its target does not exist yet) into the git folder is a git-folder write, as the plain spelling: the real spelling follows the link target.
const elsewhere = path.join(base, "elsewhere");
if (posix) {
  fs.symlinkSync(path.join(G, "hooks", "pre-commit"), path.join(wt, "hk"));
  fs.symlinkSync(path.join(G, "newdir", "x"), path.join(wt, "hk2"));
  fs.symlinkSync("hk", path.join(wt, "hk3"));
  fs.symlinkSync(path.join(wt, G, "hooks", "pre-commit"), path.join(scr, "sl"));
  fs.symlinkSync(path.join("src", "new.txt"), path.join(wt, "dl"));
  fs.symlinkSync(path.join(elsewhere, "x"), path.join(wt, "do"));
  fs.symlinkSync("lb", path.join(wt, "la"));
  fs.symlinkSync("la", path.join(wt, "lb"));
}

test("write and edit tools through a dangling link into the git folder get what the plain spelling gets", { skip: !posix }, () => {
  pathRow("hk", [CWO, CWO, NONE]);
  pathRow("hk2", [CWO, CWO, NONE]);
  pathRow("hk3", [CWO, CWO, NONE]);
  const s = path.join(scr, "sl");
  ROLES.forEach((role, i) => assert.equal(got(role, "write", { path: s, content: "x" }), [CWO, CWO, NONE][i], `${role} ${s}`));
});

test("bash: a builder's tee through a dangling link into the git folder is blocked as the plain spelling", { skip: !posix }, () => {
  assert.equal(got("builder", "bash", { command: "tee hk" }), CWO);
  assert.equal(got("builder", "bash", { command: `tee ${G}/hooks/pre-commit` }), CWO);
  assert.equal(got("main", "bash", { command: "tee hk" }), OPQ);
});

test("write tool: a dangling link to an ordinary new file stays allowed; one to a place outside and a link loop are pinned", { skip: !posix }, () => {
  assert.equal(got("builder", "write", { path: "dl", content: "x" }), ALLOW);
  assert.equal(got("builder", "write", { path: "do", content: "x" }), CWO);
  assert.equal(got("builder", "write", { path: "la", content: "x" }), ALLOW);
});

// Cost: the real spelling of an existing file is one native realpath call.
const countNative = <T>(fn: () => T): [T, number] => {
  const orig = fs.realpathSync.native;
  let n = 0;
  fs.realpathSync.native = ((p: fs.PathLike, o?: never) => { n++; return orig(p, o); }) as typeof orig;
  try {
    return [fn(), n];
  } finally {
    fs.realpathSync.native = orig;
  }
};

test("realSpelling of an existing file makes exactly one native realpath call", { skip: !posix }, () => {
  const f = path.join(wt, "a");
  const [r, n] = countNative(() => realSpelling(process.platform, f, realDefault));
  assert.equal(r, f);
  assert.equal(n, 1);
});

// A chain of links: 8 are followed to the end (the git folder); a longer chain whose end does not exist yet is followed for 8 links and gets the verdict of the place reached (known limit); a chain that ends at an existing file is followed to its end, whatever its length.
const chain = (name: string, len: number, end: string): void => {
  for (let i = 1; i <= len; i++) fs.symlinkSync(i === len ? end : `${name}${i + 1}`, path.join(wt, `${name}${i}`));
};
if (posix) {
  chain("c8_", 8, path.join(G, "hooks", "x"));
  chain("c9_", 9, path.join(G, "hooks", "x"));
  fs.writeFileSync(path.join(wt, G, "hooks", "ex"), "x\n");
  chain("e10_", 10, path.join(G, "hooks", "ex"));
}

test("write tool: a chain of 8 dangling links ending in the git folder is blocked for a builder", { skip: !posix }, () => {
  assert.equal(got("builder", "write", { path: "c8_1", content: "x" }), CWO);
  assert.equal(got("builder", "write", { path: path.join(wt, "c8_1"), content: "x" }), CWO);
});

test("write tool: a chain of 9 links whose end does not exist yet is followed for 8 links only (known limit)", { skip: !posix }, () => {
  assert.equal(got("builder", "write", { path: "c9_1", content: "x" }), ALLOW);
});

test("write and edit tools: a chain of 10 links ending at an existing file in the git folder gets what the plain spelling gets", { skip: !posix }, () => {
  pathRow("e10_1", [CWO, CWO, NONE]);
});

test("write tool: a link loop ends at the hop bound without hanging", { skip: !posix }, () => {
  assert.equal(got("builder", "write", { path: "lb", content: "x" }), ALLOW);
});

test("one pathDecide write on an existing worktree file: native realpath call count", { skip: !posix }, () => {
  const [v, n] = countNative(() => pathDecide("write", { path: path.join(wt, "a"), content: "x" }, wt, roots("builder") as never));
  assert.equal((v as { allow?: boolean } | undefined)?.allow, true);
  assert.equal(n, 3);
});

// Cost of a file that does not exist yet: native realpath and lstat calls counted together.
const countNativeLstat = <T>(fn: () => T): [T, number, number] => {
  const origReal = fs.realpathSync.native;
  const cjs = nodeFs as { lstatSync: unknown };
  const origLstat = fs.lstatSync;
  let nr = 0;
  let nl = 0;
  fs.realpathSync.native = ((p: fs.PathLike, o?: never) => { nr++; return origReal(p, o); }) as typeof origReal;
  cjs.lstatSync = ((...a: Parameters<typeof origLstat>) => { nl++; return origLstat(...a); }) as typeof origLstat;
  syncBuiltinESMExports();
  try {
    return [fn(), nr, nl];
  } finally {
    fs.realpathSync.native = origReal;
    cjs.lstatSync = origLstat;
    syncBuiltinESMExports();
  }
};

test("realSpelling of a new file in an existing folder: exactly 2 native realpath and 1 lstat call", { skip: !posix }, () => {
  const f = path.join(wt, "brand-new-file");
  const [r, nr, nl] = countNativeLstat(() => realSpelling(process.platform, f, realDefault));
  assert.equal(r, f);
  assert.equal(nr, 2);
  assert.equal(nl, 1);
});

test("one pathDecide write of a new worktree file: native realpath and lstat call counts", { skip: !posix }, () => {
  const [v, nr, nl] = countNativeLstat(() => pathDecide("write", { path: path.join(wt, "brand-new-file-2"), content: "x" }, wt, roots("builder") as never));
  assert.equal((v as { allow?: boolean } | undefined)?.allow, true);
  assert.equal(nr, 5);
  assert.equal(nl, 2);
});

// darwin: os.tmpdir() is a link (`/var/...` -> `/private/var/...`); on a host where both spellings are equal the rows add nothing and are skipped
const tmpDir = os.tmpdir();
const tmpDiffers = posix && fs.realpathSync(tmpDir) !== tmpDir;

test("darwin temp spellings: the root in one spelling and the paths in the other: ordinary write allowed, a link into the git folder blocked", { skip: !tmpDiffers }, () => {
  const dd = fs.mkdtempSync(path.join(tmpDir, "pf-r2-dd-"));
  after(() => fs.rmSync(dd, { recursive: true, force: true }));
  const ddReal = fs.realpathSync(dd);
  for (const d of [path.join(dd, "src"), path.join(dd, G, "hooks")]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(G, path.join(dd, "gd"), "dir");
  for (const [root, sp] of [[dd, ddReal], [ddReal, dd], [dd, dd], [ddReal, ddReal]]) for (const role of ROLES) {
    assert.equal(gotAt(root, scr, role, "write", { path: path.join(sp, "src", "new.txt"), content: "x" }), role === "reviewer" ? "block child-readonly-write" : ALLOW, `${role} ${root} ${sp}`);
    assert.equal(gotAt(root, scr, role, "write", { path: path.join(sp, "gd", "hooks", "h"), content: "x" }), role === "main" ? NONE : CWO, `${role} ${root} ${sp}`);
  }
});
