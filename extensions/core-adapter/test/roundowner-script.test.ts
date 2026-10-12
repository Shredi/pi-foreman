// Ledger 7c security: a read-only child (reviewer, cwd = round worktree) runs only git-tracked scripts whose realpath lies in the
// round worktree, and no run (script or test run) may come with cd/pushd, env assignments or `env`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { childSurface } from "../roundsurface.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-owner-sc-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const rt = path.join(base, "repo.worktrees", "round");
const scratch = path.join(base, "scratch");
const outside = path.join(base, "outside");
fs.mkdirSync(path.join(rt, "scripts"), { recursive: true });
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(rt, "scripts", "foreman_docs.py"), "print(1)\n");
fs.writeFileSync(path.join(rt, "scripts", "check.mjs"), "\n");
fs.writeFileSync(path.join(rt, "package.json"), "{}\n");
fs.writeFileSync(path.join(outside, "evil.py"), "print(2)\n");
if (posix) {
  fs.symlinkSync(path.join(outside, "evil.py"), path.join(rt, "scripts", "link.py"));
  const git = (...a: string[]): void => void execFileSync("git", ["-C", rt, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { stdio: "ignore" });
  git("init", "-q");
  git("add", "scripts/foreman_docs.py", "scripts/check.mjs", "scripts/link.py", "package.json");
  git("commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(rt, "scripts", "new.py"), "print(3)\n");
}
const top = (d: string): string | null => (d.startsWith(rt) ? rt : null);
const r = buildOverlayRules(baseline, {}, {}, path.join(base, "agent"), pkgRoot, undefined, false);

const run = (command: string, role = "reviewer"): string => {
  const s = childSurface([rt], rt, role, process.platform, top);
  return checkToolCall(r, "bash", { command }, { cwd: rt, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read })?.kind ?? "pass";
};

test("a reviewer cannot run a script after cd/pushd, with env assignments or env", { skip: !posix }, () => {
  for (const cmd of [
    `cd ${scratch} && python3 x.py`,
    `cd ${scratch} && node x.mjs`,
    `pushd ${scratch} && python3 x.py`,
    `builtin cd ${scratch} && python3 scripts/foreman_docs.py`,
    `command cd ${scratch} && python3 scripts/foreman_docs.py`,
    `( cd ${scratch} && python3 scripts/foreman_docs.py )`,
    `PYTHONPATH=${scratch} python3 scripts/foreman_docs.py`,
    `export PYTHONPATH=${scratch}; python3 scripts/foreman_docs.py`,
    `env PYTHONPATH=${scratch} python3 scripts/foreman_docs.py`,
    `NODE_OPTIONS='--require ${scratch}/x.js' npm test`,
    `cd ${scratch} && npm test`,
    `env FOO=1 npm run test:node`,
  ]) assert.equal(run(cmd), "deny", cmd);
});

test("a reviewer cannot run an untracked script or a tracked symlink resolving outside the worktree", { skip: !posix }, () => {
  for (const cmd of ["python3 scripts/new.py", "python3 scripts/link.py", "python3 scripts/missing.py"]) assert.equal(run(cmd), "deny", cmd);
});

test("a reviewer still runs tracked scripts and test runs", { skip: !posix }, () => {
  for (const cmd of ["python3 scripts/foreman_docs.py features --check", "python3 -I scripts/foreman_docs.py features --check", "node scripts/check.mjs", "npm run test:node", "npm test"]) assert.equal(run(cmd), "pass", cmd);
});

test("a builder keeps running scripts in its own worktree", { skip: !posix }, () => {
  assert.equal(run("python3 scripts/new.py", "builder"), "pass");
});
