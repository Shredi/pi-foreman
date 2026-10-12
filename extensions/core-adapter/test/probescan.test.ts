// R6 lane 1a/1b/1d: a read-only child runs only git-tracked test operands inside the round worktree, `git config` is a read only in its
// read forms, and a script run from outside git (any child role) is scanned for reassembled guarded tokens. Evil fixture files are
// written here from the strings of tests/fixtures/split-literal-cases.json, never stored.
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
const CASES = JSON.parse(fs.readFileSync(path.join(pkgRoot, "tests", "fixtures", "split-literal-cases.json"), "utf8")) as { probeDeny: string[] };
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-probe-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const rt = path.join(base, "repo.worktrees", "round");
const scratch = path.join(base, "scratch");
fs.mkdirSync(path.join(rt, "tests"), { recursive: true });
fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(rt, "package.json"), "{}\n");
fs.writeFileSync(path.join(rt, "Makefile"), "test:\n\t@true\n");
fs.writeFileSync(path.join(rt, "tests", "t.test.mjs"), "\n");
fs.writeFileSync(path.join(rt, "tests", "test_x.py"), "\n");
if (posix) {
  const git = (...a: string[]): void => void execFileSync("git", ["-C", rt, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { stdio: "ignore" });
  git("init", "-q");
  git("add", "package.json", "Makefile", "tests/t.test.mjs", "tests/test_x.py");
  git("commit", "-q", "-m", "init");
  // untracked: a builder's own new test, one with a reassembled token
  fs.writeFileSync(path.join(rt, "tests", "new.test.mjs"), "const names = ['a', 'b'].join(', ');\n");
  fs.writeFileSync(path.join(rt, "tests", "evil.test.mjs"), CASES.probeDeny[0] + "\n");
}
fs.writeFileSync(path.join(scratch, "plain.mjs"), "console.log('hello');\n");
fs.writeFileSync(path.join(scratch, "ordinary.mjs"), "const s = 'a-b'.replaceAll('-', '_') + String.fromCharCode(72, 105) + 'x'.concat('y');\n");
fs.writeFileSync(path.join(scratch, "read.mjs"), "import fs from 'node:fs';\nconsole.log(fs.readFileSync(process.argv[2], 'utf8'));\n");
CASES.probeDeny.forEach((src, i) => fs.writeFileSync(path.join(scratch, `evil${i}.mjs`), src + "\n"));
fs.writeFileSync(path.join(scratch, "evil.py"), CASES.probeDeny[3] + "\n");
fs.writeFileSync(path.join(scratch, "evil.sh"), CASES.probeDeny[5] + "\n");
const top = (d: string): string | null => (d.startsWith(rt) ? rt : null);
const r = buildOverlayRules(baseline, {}, {}, path.join(base, "agent"), pkgRoot, undefined, false);

const run = (command: string, role = "reviewer", cwd = rt): string => {
  const s = childSurface([rt], rt, role, process.platform, top);
  return checkToolCall(r, "bash", { command }, { cwd, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read })?.kind ?? "pass";
};

test("a reviewer's test runs name only git-tracked operands inside the round worktree", { skip: !posix }, () => {
  for (const cmd of [
    "node --test $FOREMAN_SCRATCH/evil.test.mjs",
    `node --test ${scratch}/plain.mjs`,
    "node --test tests/new.test.mjs",
    "node --test tests/t.test.mjs tests/new.test.mjs",
    "node --test ../outside.test.mjs",
    `npm run test:node -- --require ${scratch}/plain.mjs`,
    "npm run test:node -- --import ./tests/new.test.mjs",
    `pytest ${scratch}/t.py`,
    "pytest tests/missing_test.py::A::b",
    `make test -C ${scratch}`,
    "make test PYTHON=./tests/new.test.mjs",
    `python3 -m unittest ${scratch}/t.py`,
    "python3 -m unittest tests.nope",
    "node --test 'tests/*.mjs'",
  ]) assert.equal(run(cmd), "deny", cmd);
});

test("a reviewer still runs tracked test operands and flags", { skip: !posix }, () => {
  for (const cmd of [
    "node --test",
    "node --test tests/t.test.mjs",
    "node --test --test-name-pattern foo tests/t.test.mjs",
    "npm run test:node -- --test-name-pattern foo",
    "npm run test:node",
    "pytest tests/test_x.py::A::b -k foo",
    "pytest tests",
    "make test",
    "make test -C .",
    "python3 -m unittest discover -s tests",
    "python3 -m unittest tests.test_x",
    "python3 -m unittest tests.test_x.Case.test_a",
  ]) assert.equal(run(cmd), "pass", cmd);
});

test("a builder runs its own new untracked test in its worktree", { skip: !posix }, () => {
  assert.equal(run("node --test tests/new.test.mjs", "builder"), "pass");
});

test("git config is a read only in its read forms (read-only child)", { skip: !posix }, () => {
  for (const cmd of [
    "git config user.name",
    "git config --get core.hooksPath",
    "git config --get user.name '^x'",
    "git config --get-all remote.origin.url",
    "git config --get-regexp '^remote\\.'",
    "git config --list",
    "git config -l --show-origin --show-scope",
    "git config --local --includes --list -z",
    "git config --worktree --includes --list -z",
    "git config --global --no-includes --name-only --list",
    "git config get user.name",
    "git config list",
    "git config --type=bool --default false core.bare",
    "git config --bool core.bare",
    "git config --get-urlmatch http.proxy https://example.invalid",
  ]) assert.equal(run(cmd), "pass", cmd);
});

test("git config writes are denied for a read-only child", { skip: !posix }, () => {
  for (const cmd of [
    "git config core.hooksPath $FOREMAN_SCRATCH/h",
    "git config user.name v",
    "git config --file x.cfg user.name v",
    "git config -f x.cfg --list",
    "git config --blob HEAD:x --list",
    "git config --add a.b c",
    "git config --unset a.b",
    "git config --unset-all a.b",
    "git config --replace-all a.b c",
    "git config --rename-section a b",
    "git config --remove-section a",
    "git config --edit",
    "git config -e",
    "git config set a.b c",
    "git config unset a.b",
    "git config --get a.b c d",
    "git config --list a.b",
    "git config --get --add a.b",
  ]) assert.equal(run(cmd), "deny", cmd);
});

test("a script outside git that reassembles a guarded token is denied in every child role", { skip: !posix }, () => {
  for (const role of ["builder", "reviewer"]) {
    for (let i = 0; i < CASES.probeDeny.length; i++) assert.equal(run(`node $FOREMAN_SCRATCH/evil${i}.mjs`, role, scratch), "deny", `${role} ${CASES.probeDeny[i]}`);
    assert.equal(run("python3 $FOREMAN_SCRATCH/evil.py", role, scratch), "deny", role);
    assert.equal(run(`bash ${scratch}/evil.sh`, role, scratch), "deny", role);
    assert.equal(run("sh evil.sh", role, scratch), "deny", role);
    assert.equal(run("npx ./evil0.mjs", role, scratch), "deny", role);
  }
  assert.equal(run("node --test $FOREMAN_SCRATCH/evil0.mjs", "builder"), "deny");
  assert.equal(run("node --test $FOREMAN_SCRATCH/evil0.mjs"), "deny");
  assert.equal(run("node --test tests/evil.test.mjs", "builder"), "deny");
});

test("scratch scripts without a reassembled token keep running", { skip: !posix }, () => {
  for (const role of ["builder", "reviewer"]) {
    assert.equal(run("node plain.mjs", role, scratch), "pass", role);
    assert.equal(run("node $FOREMAN_SCRATCH/ordinary.mjs", role, scratch), "pass", role);
    assert.equal(run(`node ${scratch}/read.mjs ${scratch}/plain.mjs`, role, scratch), "pass", role);
  }
});

test("tracked files of the round worktree are not scanned", { skip: !posix }, () => {
  fs.writeFileSync(path.join(rt, "tests", "t.test.mjs"), CASES.probeDeny[0] + "\n");
  try {
    assert.equal(run("node --test tests/t.test.mjs", "builder"), "pass");
    assert.equal(run("node --test tests/t.test.mjs"), "pass");
  } finally {
    fs.writeFileSync(path.join(rt, "tests", "t.test.mjs"), "\n");
  }
});
