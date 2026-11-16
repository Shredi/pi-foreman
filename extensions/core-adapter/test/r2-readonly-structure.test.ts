// Guard round 2, step 3a: the read-only fence (`roots.roundReadOnly`: reviewer, explorer) refuses by structure, without a program list:
// (a) a real-path compare (a link to the worktree counts as inside), (b) a write target that does not resolve, (c) a git segment that writes the repository of the
// worktree, (d) the implicit-cwd target of `tar -x`, `unzip`, `patch`, (e) a `find` with an action. Every refused row has a free row beside it; a builder control
// shows the rule is the read-only role's alone; the rows marked "unchanged" assert the answer of today for a form the rule does not name.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

type Verdict = { block?: boolean; rule?: string; allow?: boolean; ask?: boolean } | undefined;
const fwd = (p: string): string => p.replace(/\\/g, "/");
const base = fs.realpathSync(mkTestTmp("pf-ro2-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const clone = path.join(scr, "c");
const handoff = path.join(base, "handoffs", "h1");
const link = path.join(base, "wtlink");
for (const d of [path.join(wt, "sub"), clone, handoff]) fs.mkdirSync(d, { recursive: true });
const linked = (() => {
  try {
    fs.symlinkSync(wt, link, "junction");
    return true;
  } catch {
    return false;
  }
})();
after(() => fs.rmSync(base, { recursive: true, force: true }));
const W = fwd(wt);
const S = fwd(scr);
const L = fwd(link);

type Kind = "ro" | "child" | "main";
const roots = (role: string, kind: Kind): GateRoots => ({ worktree: wt, scratch: [scr], tmp: kind === "main" ? [base, "/tmp"] : [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], childHandoff: handoff, child: kind !== "main", role, tmpAccess: kind === "main", ...(kind === "ro" ? { roundReadOnly: true } : {}) });
const verdict = (line: string, role: string, kind: Kind, cwd = wt): Verdict => gateEvaluate("bash", { command: line }, cwd, { env: (c) => baseFloorEnv(c, kind === "main" ? {} : { child: true }), roots: () => roots(role, kind) }).result as Verdict;
const RO = "child-readonly-write";
const refused = (v: Verdict): boolean => !!v?.block && v.rule === RO;
const ROLES = ["reviewer", "explorer"];

/** Every line refused for both read-only roles and not refused by this rule for a builder; `cwd` the directory the lines run in. */
function mustRefuse(lines: string[], cwd = wt): void {
  for (const line of lines) {
    for (const role of ROLES) assert.ok(refused(verdict(line, role, "ro", cwd)), `${role}: ${line} -> ${JSON.stringify(verdict(line, role, "ro", cwd))}`);
    assert.ok(!refused(verdict(line, "builder", "child", cwd)), `builder: ${line} -> ${JSON.stringify(verdict(line, "builder", "child", cwd))}`);
  }
}
/** Every line not refused by this rule, for both read-only roles and a builder. */
function mustFree(lines: string[], cwd = wt): void {
  for (const line of lines) for (const [role, kind] of [["reviewer", "ro"], ["explorer", "ro"], ["builder", "child"]] as const) assert.ok(!refused(verdict(line, role, kind, cwd)), `${role}: ${line} -> ${JSON.stringify(verdict(line, role, kind, cwd))}`);
}

test("(a) a link to the worktree counts as inside, the real scratch dir stays free", { skip: !linked }, () => {
  mustRefuse([`touch ${L}/f`, `echo x > ${L}/f`, `rm ${L}/f`, `cd ${L} && touch f`]);
  mustFree([`echo x > ${S}/f`, `touch ${S}/f`, `cd ${S} && touch f`]);
});

test("(b) a write target that does not resolve is refused; $FOREMAN_SCRATCH forms are free", () => {
  mustRefuse(['echo x > "$OUT"', "HOME=/x echo y > ~/f", `export HOME=${W} && echo y > ~/f`, 'echo x | tee "$OUT"', 'cp a "$D"']);
  mustFree(["echo x > $FOREMAN_SCRATCH/x", 'echo x > "$FOREMAN_SCRATCH/x"', "echo x > ${FOREMAN_SCRATCH}/x", "cat a > /dev/null", "ls 2>&1"]);
  // after `cd "$X"` the cwd is unknown: child-write-outside refuses it first (not this rule), for the read-only roles and the builder alike
  for (const [role, kind] of [["reviewer", "ro"], ["explorer", "ro"], ["builder", "child"]] as const) assert.equal(verdict('cd "$X" && touch f', role, kind)?.rule, "child-write-outside", role);
});

const GIT_WRITES = ["commit -m x", "add .", "rm f", "mv a b", "merge x", "rebase x", "reset --hard", "checkout -- f", "switch x", "restore f", "stash", "tag v1", "cherry-pick x", "revert x", "apply p", "am p", "pull", "clone . c", "init", "clean -fd", "worktree add x", "branch x", "submodule update", "config user.name x", "gc", "prune", "update-index --add f", "update-ref r HEAD", "notes add", "bisect start"];

test("(c) a git subcommand that writes is refused in the worktree (cwd, -C <wt>, an unresolved -C); a scratch clone is free", () => {
  mustRefuse(GIT_WRITES.flatMap((s) => [`git ${s}`, `git -C ${W} ${s}`, `git -C "$D" ${s}`]));
  // a plain `git fetch origin` is a fetch rule (free); with -C it is not that rule's form
  mustRefuse([`git -C ${W} fetch origin`, `git -C "$D" fetch origin`]);
  mustFree(["git fetch origin", "git config --get x", `cd ${S} && git clone ${W} c2`]);
  mustFree(GIT_WRITES.filter((s) => !s.startsWith("clone") && !s.startsWith("init")).flatMap((s) => [`git -C ${S}/c ${s}`]));
  mustFree(["git commit -m x", "git add .", "git log", "git fetch origin", "git reflog expire --all", "git diff --ext-diff", "git checkout -b x", `git -C ${S}/c reflog expire --all`], clone);
  // `git --work-tree=<wt> checkout` from the scratch dir names the worktree
  mustRefuse([`git --work-tree=${W} checkout x`], clone);
});

test("(c) a read-table subcommand in a write form is refused: a long output or program option, --ext-diff, reflog expire|delete|drop", () => {
  mustRefuse([
    `git diff --output=${W}/x`, `git show --output ${W}/x`, "git diff --ext-diff", "git diff --ext-d", "git log --textconv", "git status --output=x",
    "git reflog expire --all", "git reflog delete HEAD@{1}", "git reflog drop", `git -C ${W} diff --ext-diff`, `git -C "$D" diff --ext-diff`, `git -C ${W} reflog expire --all`, `git -C "$D" reflog expire --all`,
  ]);
});

test("(c) git reads are free: the seven added reads, pager and lock options, list forms, -C reads", () => {
  const added = ["reflog", "reflog -n 1", "reflog show", "show-branch", "check-ignore -v x", "var GIT_AUTHOR_IDENT", "ls-remote origin", "whatchanged", "verify-commit HEAD"];
  mustFree(added.flatMap((s) => [`git ${s}`, `git --no-pager ${s}`, `git -P ${s}`, `git --no-optional-locks ${s}`, `git -C ${W} ${s}`]));
  mustFree(["git stash list", "git tag -l", "git worktree list", "git branch -a", "git branch --list", "git branch --contains HEAD", "git --no-pager stash list", "git --no-pager branch --contains HEAD", `git -C ${W} stash list`, `git -C ${W} tag -l`, `git -C ${W} worktree list`, `git -C ${W} branch -a`, `git -C ${W} config --get x`]);
});

test("(c) unchanged: a short -o or -c, a global -c, an env prefix, and git subcommands the gate does not know are not refused by this rule", () => {
  // each answer is the one of before this step (not child-readonly-write: the call goes on to the judge or the parent); only the read table grew
  mustFree(["git ls-files -o", "git grep -o foo", "git -c k=v log", "GIT_TRACE=f git log", "git cat-file -p HEAD", "git symbolic-ref HEAD", "git archive -o x.tar HEAD", "git log -c", `git --git-dir=${W}/.git log`]);
});

test("(c) long output options and downloads into the worktree are refused, into the scratch dir free", () => {
  const into = (dir: string): string[] => [`git diff --no-index --output=${dir}/x a b`, `git show --output ${dir}/x`, `git config --file ${dir}/c k v`, `curl -o ${dir}/f http://example.invalid/x`, `wget -O ${dir}/f http://example.invalid/x`];
  mustRefuse(into(W), clone);
  mustFree(into(S), clone);
});

test("(c) the seven added git reads are default-git-read for main, builder, reviewer and explorer", () => {
  for (const s of ["reflog", "reflog -n 1", "reflog show", "show-branch", "show-branch --list", "check-ignore -v x", "var GIT_AUTHOR_IDENT", "ls-remote origin", "whatchanged", "verify-commit HEAD"]) {
    for (const [role, kind] of [["foreman", "main"], ["builder", "child"], ["reviewer", "ro"], ["explorer", "ro"]] as const) {
      const v = verdict(`git ${s}`, role, kind);
      assert.ok(v?.allow && v.rule === "default-git-read", `${role}: git ${s} -> ${JSON.stringify(v)}`);
    }
  }
  // not a read: reflog with a mutating word, or a long output option, stays no default for main and builder
  for (const s of ["reflog expire --all", "reflog delete HEAD@{1}", "ls-remote --upload-pack=x origin", "var --output=x GIT_AUTHOR_IDENT"]) for (const [role, kind] of [["foreman", "main"], ["builder", "child"]] as const) assert.notEqual(verdict(`git ${s}`, role, kind)?.rule, "default-git-read", `${role}: git ${s}`);
});

test("(d) tar -x, unzip and patch with no directory option write the cwd: refused in the worktree; with -C / -d into the scratch dir, or run from it, free", () => {
  mustRefuse(["tar -xf a.tar", "tar xf a.tar", "unzip a.zip", "patch -p1 < x.diff", "patch -i x.diff", "tar -xf a.tar -C sub", "unzip a.zip -d sub", "patch -d sub -i p.diff"]);
  mustFree([`tar -xf a.tar -C ${S}`, `unzip a.zip -d ${S}`, `patch -d ${S} -p1 < x.diff`, "tar -tf a.tar", "unzip -l a.zip", "tar -czf ../a.tgz ."]);
  mustFree(["tar -xf a.tar", "unzip a.zip", "patch -p1 < x.diff"], clone);
});

test("(e) a find with an action in the worktree is refused; a plain find, a find in the scratch dir and a find with -L are free", () => {
  mustRefuse(["find . -delete", "find . -exec rm {} +", "find . -name x -exec grep y {} +", "find sub -delete", "find . -type f -ok rm {} ;", "find . -fprint x"]);
  mustFree(["find . -name x", "find . -name '*.ts'", "find sub -type f", "find -L . -name x", "find . -L -name x", `find ${S} -delete`, `find ${S} -exec rm {} +`, "chmod +x a"]);
  mustFree(["find . -delete", "find . -exec rm {} +"], clone);
});

const FOUR = [["foreman", "main"], ["builder", "child"], ["reviewer", "ro"], ["explorer", "ro"]] as const;

test("revision: git ls-remote with a program option, in any prefix spelling, is no git read for any role and refused for a read-only role", () => {
  const rows = ["--upl=touch origin", "--upl touch . origin", "--upload-p=touch . origin", "--exe=touch origin", "--exe touch . origin", "--exec=touch . origin", "--upload-pack=touch . origin", "--up=touch origin", "origin --upl=touch", "origin --exe touch ."];
  for (const r of rows) {
    for (const [role, kind] of FOUR) assert.notEqual(verdict(`git ls-remote ${r}`, role, kind)?.rule, "default-git-read", `${role}: git ls-remote ${r}`);
  }
  mustRefuse(rows.map((r) => `git ls-remote ${r}`));
  // the same forms in the other added reads and in the GIT_READ subcommands
  mustRefuse(["git var --exe=x GIT_EDITOR", "git reflog --upl=x", "git show-branch --exec=x", "git whatchanged --ext-d", "git log --upl=touch", "git diff --exe", "git show --up"]);
  // ls-remote without a program option stays a read
  for (const r of ["origin", "--tags origin", "--heads origin", "--refs origin", "--exit-code origin", "--get-url origin", "--symref origin", "--sort=refname origin", "-q origin", "--server-option=x origin"]) {
    for (const [role, kind] of FOUR) assert.equal(verdict(`git ls-remote ${r}`, role, kind)?.rule, "default-git-read", `${role}: git ls-remote ${r}`);
  }
});

test("revision: the ordinary git read options that share a prefix with a write option keep default-git-read", () => {
  const opts = ["--oneline", "--text", "-a", "--no-textconv", "--no-ext-diff", "--until=x", "--unified=3", "--unified", "--exit-code", "--encoding=utf8", "--topo-order", "--tags", "--exclude=x", "--expand-tabs", "--ours", "--theirs", "--early-output", "--use-mailmap", "--output-indicator-new=x", "--output-indicator-old=x", "--output-indicator-context=x"];
  for (const o of opts) for (const s of ["diff", "log", "show"]) {
    for (const [role, kind] of FOUR) assert.equal(verdict(`git ${s} ${o}`, role, kind)?.rule, "default-git-read", `${role}: git ${s} ${o}`);
  }
  mustFree(["git diff --text", "git log --output-indicator-new=x", "git diff --output-indicator-old=x", "git log --text"]);
  // an ambiguous short prefix is the write option (fail closed): refused for a read-only role, no default for the others
  for (const o of ["--o", "--e", "--t", "--u", "--ex", "--ext", "--tex", "--out", "--outp=x"]) {
    for (const [role, kind] of FOUR) assert.notEqual(verdict(`git diff ${o}`, role, kind)?.rule, "default-git-read", `${role}: git diff ${o}`);
  }
  mustRefuse(["git diff --o", "git log --e", "git show --t", "git diff --u", "git diff --outp=x", "git log --ext-d"]);
});

test("revision: a find with an action whose root is relative under an unknown cwd is refused; absolute roots and plain finds stay free", () => {
  mustRefuse(['cd "$X" && find . -delete', 'cd "$X" && find . -exec rm {} +', 'pushd "$X" && find . -exec rm {} +', 'cd "$X" && find sub -delete', 'cd "$X" && find -delete']);
  mustFree(['cd "$X" && find . -name x', `cd "$X" && find ${S} -delete`, `find ${S} -delete`]);
});

test("revision: patch --dry-run changes no file and is free; patch without it stays refused", () => {
  mustFree(["patch --dry-run -p1 < x.diff", "patch --dry-run -i x.diff", "cd sub && patch --dry-run -p1 < x.diff", `patch --dry-run -p1 < x.diff > ${S}/o`, "patch --dry -i x.diff", "tar -tf a.tar", "tar --list -f a.tar", "unzip -l a.zip"]);
  mustRefuse(["patch -p1 < x.diff", "patch -i x.diff", "cd sub && patch -p1 < x.diff", "patch --dry-run -o f -i x.diff"]);
});

test("revision: a brace list whose every variant lies in the scratch dir is free; a variant in the worktree or one that does not resolve is refused", () => {
  mustFree([`touch ${S}/{a,b}`, `mkdir -p ${S}/{a,b}`, "touch $FOREMAN_SCRATCH/{a,b}", "mkdir -p $FOREMAN_SCRATCH/{a,b}", `touch ${S}/{a,b}/{c,d}`, `echo x > ${S}/{a,b}`]);
  mustRefuse([`touch ${W}/{a,b}`, `touch {${W},${S}}/f`, `touch {${S},${W}}/f`, `touch ${S}/{../../../wt/a,b}`, "touch {a,b}", "touch sub/{a,b}", "touch {$FOREMAN_SCRATCH,sub}/f", `touch ${S}/{a,$X}`, `touch ${S}/{1..3}`]);
  // from the scratch dir, a relative variant is in the scratch dir
  mustFree(["touch {a,b}", "touch d/{a,b}"], clone);
});

test("revision: known limit (the parser substitutes an assignment only outside a pipeline): a scratch path held in a variable and written in a pipeline is refused, without the pipe free", () => {
  mustFree([`T=${S}/x; echo y > "$T"`]);
  mustRefuse([`T=${S}/x; echo y > "$T" 2>&1 | head`]);
});
