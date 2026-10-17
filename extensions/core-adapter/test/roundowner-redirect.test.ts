// Ledger 7c security follow-up: a read-only child (reviewer) cannot create files in the round worktree by redirect,
// runs tracked repo scripts as test runs, and an unclassifiable command naming a read-only path is denied from any cwd.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { childSurface } from "../roundsurface.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-owner-rd-")));
after(() => rmTestTmp(base));
const rt = path.join(base, "repo.worktrees", "round");
const scratch = path.join(base, "scratch");
fs.mkdirSync(path.join(rt, "scripts"), { recursive: true });
fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(rt, "f"), "x\n");
// scripts run by a read-only child must be git-tracked (roundowner-script.test.ts)
if (posix) {
  for (const s of ["foreman_docs.py", "check.mjs"]) fs.writeFileSync(path.join(rt, "scripts", s), "\n");
  const git = (...a: string[]): void => void execFileSync("git", ["-C", rt, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { stdio: "ignore" });
  git("init", "-q");
  git("add", "scripts");
  git("commit", "-q", "-m", "init");
}
const top = (d: string): string | null => (d.startsWith(rt) ? rt : null);
const r = buildOverlayRules(baseline, {}, {}, path.join(base, "agent"), pkgRoot, undefined, false);

const run = (command: string, cwd = rt): string => {
  const s = childSurface([rt], rt, "reviewer", process.platform, top);
  return checkToolCall(r, "bash", { command }, { cwd, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read })?.kind ?? "pass";
};

test("a reviewer cannot create a new file in the round worktree by redirect", { skip: !posix }, () => {
  for (const cmd of ["echo x > f2", "cat f > f2", "ls > f2", "grep x f > f2", "echo x >> f2", "echo x | tee f2"]) assert.equal(run(cmd), "deny", cmd);
});

test("a reviewer still redirects to /dev/null, dups fds and writes its own scratch", { skip: !posix }, () => {
  for (const cmd of ["cat f > /dev/null", "ls 2>&1", "grep x f 2>/dev/null", `echo x > ${scratch}/out`, `cat f > ${scratch}/out`]) assert.equal(run(cmd), "pass", cmd);
  assert.equal(run("echo x > out", scratch), "pass");
});

test("a reviewer runs tracked repo scripts as test runs; interpreter code forms stay denied", { skip: !posix }, () => {
  for (const cmd of ["python3 scripts/foreman_docs.py features --check", "python3 -I scripts/foreman_docs.py features --check", "node scripts/check.mjs"]) assert.equal(run(cmd), "pass", cmd);
  for (const cmd of ["python3 -c 'open(\"f2\",\"w\")'", "python3 -I -c 'print(1)'", "python3 - <<'EOF'\nprint(1)\nEOF", "node -e 'x'", "python3 ../x.py", `python3 ${scratch}/x.py`, "python3 scripts/x.sh", "python3"]) assert.equal(run(cmd), "deny", cmd);
});

test("an in-place interpreter naming a read-only path is denied from a scratch cwd", { skip: !posix }, () => {
  assert.equal(run(`perl -pi -e s/x/y/ ${rt}/f`, scratch), "deny");
  assert.equal(run(`perl -pi -e s/x/y/ ${scratch}/f`, scratch), "pass");
});
