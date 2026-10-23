// Ledger 7c follow-up: a read-only child (reviewer in the round worktree) is denied every shell command that writes or
// deletes there, not only redirects and mkdir/cp/mv; an unclassifiable command is denied rather than allowed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { childSurface } from "../roundsurface.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-owner-sh-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const rt = path.join(base, "repo.worktrees", "round");
const scratch = path.join(base, "scratch");
fs.mkdirSync(rt, { recursive: true });
fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(rt, "f"), "x\n");
fs.writeFileSync(path.join(rt, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
const top = (d: string): string | null => (d.startsWith(rt) ? rt : null);
const r = buildOverlayRules(baseline, {}, {}, path.join(base, "agent"), pkgRoot, undefined, false);

const run = (role: string, command: string): string => {
  const s = childSurface([rt], rt, role, process.platform, top);
  return checkToolCall(r, "bash", { command }, { cwd: rt, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read })?.kind ?? "pass";
};

test("a reviewer in the round worktree is denied rm, in-place sed, truncate, git writes", { skip: !posix }, () => {
  for (const cmd of [
    "rm f",
    "rm -rf .",
    "rmdir d",
    "unlink f",
    "sed -i '' s/x/y/ f",
    "sed -i '' -e s/x/y/ f",
    "truncate -s0 f",
    "dd if=/dev/zero of=f",
    "chmod 600 f",
    "find . -delete",
    "git checkout -- f",
    "git reset --hard",
    "git apply x.patch",
    "git stash",
    "git commit -m x",
    "git add f",
    "git -C . restore f",
    "perl -pi -e 's/x/y/' f",
    "node -e 'require(\"fs\").unlinkSync(\"f\")'",
    "bash -c 'rm f'",
    "echo f | xargs rm",
  ]) assert.equal(run("reviewer", cmd), "deny", cmd);
});

test("a reviewer still reads, diffs, logs, greps and runs the tests", { skip: !posix }, () => {
  for (const cmd of ["cat f", "git diff", "git log", "git status", "git apply --check x.patch", "git stash list", "rg x", "npm test", "ls | wc -l", "sed -n 1p f", "bash -c 'cat f'"]) assert.equal(run("reviewer", cmd), "pass", cmd);
});

test("a reviewer may write its own scratch dir", { skip: !posix }, () => {
  assert.equal(run("reviewer", `rm ${scratch}/x`), "pass");
  assert.equal(run("reviewer", `touch ${scratch}/x`), "pass");
});

test("git grep -O / --open-files-in-pager (any abbreviation) is no read in a reviewer; plain git grep is", { skip: !posix }, () => {
  for (const cmd of ["git grep -Orm x -- f", "git grep -1Oecho x", "git grep -n1Oecho x", "git grep --open-files-in-pager=rm x", "git grep --op=rm x", "git grep --open=rm x"]) assert.equal(run("reviewer", cmd), "deny", cmd);
  assert.equal(run("reviewer", "git grep x"), "pass");
  assert.equal(run("reviewer", "git grep -n x -- f"), "pass");
});

test("the builder in the round worktree is not restricted by the read-only check", { skip: !posix }, () => {
  for (const cmd of ["rm f", "sed -i '' s/x/y/ f", "git checkout -- f", "truncate -s0 f"]) assert.notEqual(run("builder", cmd), "deny", cmd);
});
