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
fs.writeFileSync(path.join(rt, "tests", "committed-evil.test.mjs"), CASES.probeDeny[0] + "\n");
if (posix) {
  const git = (...a: string[]): void => void execFileSync("git", ["-C", rt, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { stdio: "ignore" });
  git("init", "-q");
  git("add", "package.json", "Makefile", "tests/t.test.mjs", "tests/test_x.py", "tests/committed-evil.test.mjs");
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

test("tracked, unmodified files of the round worktree are not scanned", { skip: !posix }, () => {
  assert.equal(run("node --test tests/committed-evil.test.mjs", "builder"), "pass");
  assert.equal(run("node --test tests/committed-evil.test.mjs"), "pass");
});

// ---- R6 lane 1, review fixes ----
const denies = (cmds: string[], role = "reviewer", cwd = rt): void => cmds.forEach((c) => assert.equal(run(c, role, cwd), "deny", c));
const passes = (cmds: string[], role = "reviewer", cwd = rt): void => cmds.forEach((c) => assert.equal(run(c, role, cwd), "pass", c));

test("finding 1: module-loading option values are operands (reporter, global setup, require, import, loader)", { skip: !posix }, () => {
  denies([
    "node --test --test-reporter=$FOREMAN_SCRATCH/r.mjs tests/t.test.mjs",
    "node --test --test-reporter $FOREMAN_SCRATCH/r.mjs tests/t.test.mjs",
    "npm run test:node -- --test-reporter=$FOREMAN_SCRATCH/r.mjs",
    "node --test --test-reporter=spec --test-reporter-destination=$FOREMAN_SCRATCH/out.txt tests/t.test.mjs",
    "node --test --test-global-setup=$FOREMAN_SCRATCH/g.mjs",
    "node --test --require $FOREMAN_SCRATCH/plain.mjs",
    "node --test -r $FOREMAN_SCRATCH/plain.mjs",
    "node --test --import=$FOREMAN_SCRATCH/plain.mjs",
    "node --test --loader $FOREMAN_SCRATCH/plain.mjs",
    "node --test --experimental-loader=$FOREMAN_SCRATCH/plain.mjs",
  ]);
  passes([
    "node --test --test-reporter=spec tests/t.test.mjs",
    "node --test --test-reporter dot --test-reporter-destination stdout tests/t.test.mjs",
    "node --test --test-reporter=junit --test-reporter-destination=stderr",
    "node --test --import ./tests/t.test.mjs",
  ]);
});

test("finding 2: npm positionals are operands", { skip: !posix }, () => {
  denies([
    "npm run test:node $FOREMAN_SCRATCH/evil.test.mjs",
    "npm test $FOREMAN_SCRATCH/evil.test.mjs",
    "npm run test:node --silent tests/new.test.mjs",
    "npm run-script test:node $FOREMAN_SCRATCH/evil.test.mjs",
  ]);
  passes(["npm test tests/t.test.mjs", "npm run test:node tests/t.test.mjs", "npm run test:node --silent", "npm test"]);
});

test("finding 3: attached make options are resolved", { skip: !posix }, () => {
  denies([
    `make test -C${scratch}`,
    `make test -f${scratch}/mk`,
    `make test -I${scratch}`,
    `make test --directory=${scratch}`,
    `make test --file=${scratch}/mk`,
    `make test --makefile=${scratch}/mk`,
    `make test --directory ${scratch}`,
  ]);
  passes(["make test -C.", "make test -f Makefile"]);
});

test("finding 4: npx interpreters are scanned and value-taking flags are not the script", { skip: !posix }, () => {
  for (const role of ["builder", "reviewer"]) {
    denies([
      "npx tsx $FOREMAN_SCRATCH/evil0.mjs",
      "npx node $FOREMAN_SCRATCH/evil0.mjs",
      "npx ts-node $FOREMAN_SCRATCH/evil0.mjs",
      "npx --yes tsx $FOREMAN_SCRATCH/evil0.mjs",
      "tsx $FOREMAN_SCRATCH/evil0.mjs",
      "python3 -X dev $FOREMAN_SCRATCH/evil.py",
      "python3 -W ignore $FOREMAN_SCRATCH/evil.py",
      "bash -o pipefail $FOREMAN_SCRATCH/evil.sh",
      "node --import $FOREMAN_SCRATCH/plain.mjs $FOREMAN_SCRATCH/evil0.mjs",
      "node --conditions dev $FOREMAN_SCRATCH/evil0.mjs",
      "node --test-reporter=$FOREMAN_SCRATCH/evil0.mjs plain.mjs",
    ], role, scratch);
  }
  passes(["python3 -X dev plain.mjs", "node --import ./plain.mjs plain.mjs", "npx tsx plain.mjs"], "builder", scratch);
});

test("finding 5: staged or modified tracked probes are scanned; stdin files too", { skip: !posix }, () => {
  const file = path.join(rt, "tests", "t.test.mjs");
  const git = (...a: string[]): void => void execFileSync("git", ["-C", rt, ...a], { stdio: "ignore" });
  try {
    fs.writeFileSync(file, CASES.probeDeny[0] + "\n");
    assert.equal(run("node --test tests/t.test.mjs", "builder"), "deny", "modified");
    git("add", "tests/t.test.mjs");
    assert.equal(run("node --test tests/t.test.mjs", "builder"), "deny", "staged");
  } finally {
    git("reset", "-q", "HEAD", "--", "tests/t.test.mjs");
    git("checkout", "--", "tests/t.test.mjs");
  }
  assert.equal(run("node --test tests/t.test.mjs", "builder"), "pass", "restored");
  for (const role of ["builder", "reviewer"]) {
    denies(["node < $FOREMAN_SCRATCH/evil0.mjs", `python3 < ${scratch}/evil.py`, `bash < ${scratch}/evil.sh`, "node - < $FOREMAN_SCRATCH/evil0.mjs"], role, scratch);
  }
});

test("finding 6: plugin names and make K=V words are no paths", { skip: !posix }, () => {
  passes(["pytest -p no:cacheprovider tests/test_x.py", "pytest -p no:cacheprovider", "pytest -sv tests/test_x.py", "pytest -rA tests/test_x.py", "make test PYTHON=python3", "make test PYTHON=python3 V=1"]);
  denies([`make test PYTHON=${scratch}/py`, "pytest -c $FOREMAN_SCRATCH/pytest.ini", `pytest -c${scratch}/pytest.ini`]);
});

test("finding 7: a git config write is denied for a read-only child whatever repository it names", { skip: !posix }, () => {
  denies([
    "git --git-dir=$FOREMAN_SCRATCH/g config a.b c",
    "git --work-tree=$FOREMAN_SCRATCH config a.b c",
    "git --git-dir $FOREMAN_SCRATCH/g config a.b c",
    "git -C $FOREMAN_SCRATCH config a.b c",
    "GIT_DIR=$FOREMAN_SCRATCH/g git config a.b c",
    "git -C $FOREMAN_SCRATCH config --add a.b c",
    "git -C $FOREMAN_SCRATCH config --unset a.b",
  ]);
  passes(["git -C . config --list"]);
});

test("finding 8: a copy of a tracked test in scratch is an untracked operand", { skip: !posix }, () => {
  const copy = path.join(scratch, "probe.mts");
  fs.copyFileSync(path.join(rt, "tests", "t.test.mjs"), copy);
  denies(["node --test $FOREMAN_SCRATCH/probe.mts", `node --test ${copy}`, "npm run test:node -- $FOREMAN_SCRATCH/probe.mts"]);
  passes(["node --test tests/t.test.mjs"]);
});

// ---- R6 lane 1, review fixes 2: fail-closed operands and probe words ----
if (posix) {
  fs.mkdirSync(path.join(rt, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(rt, "extensions", "core-adapter", "test"), { recursive: true });
  fs.writeFileSync(path.join(rt, "scripts", "foreman_docs.py"), "\n");
  fs.writeFileSync(path.join(rt, "extensions", "core-adapter", "test", "a.test.ts"), "\n");
  execFileSync("git", ["-C", rt, "add", "scripts/foreman_docs.py", "extensions/core-adapter/test/a.test.ts"], { stdio: "ignore" });
  execFileSync("git", ["-C", rt, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "more"], { stdio: "ignore" });
}

test("fix 2A: attached short-option groups and abbreviated make long options are denied", { skip: !posix }, () => {
  denies([
    "make test -sC$FOREMAN_SCRATCH",
    "make test -kf$FOREMAN_SCRATCH/mk",
    "pytest -sc$FOREMAN_SCRATCH/pytest.ini tests/test_x.py",
    "make test --di=$FOREMAN_SCRATCH",
    "make test --fi=$FOREMAN_SCRATCH/mk",
    "make test --direct=$FOREMAN_SCRATCH",
    "make test --jobs=$FOREMAN_SCRATCH/x",
    "node --test tests/t.test.mjs --some-option=$FOREMAN_SCRATCH/x.mjs",
    "node --test -xy/$FOREMAN_SCRATCH/x.mjs",
    `pytest -p ${scratch}/plug.py tests/test_x.py`,
    "node --test --test-reporter=./tests/new.test.mjs",
  ]);
});

test("fix 2A: ordinary test runs are not over-blocked", { skip: !posix }, () => {
  passes([
    "npm run test:node",
    'node --test "extensions/core-adapter/test/*.test.ts"',
    "python3 -m unittest discover -s tests",
    "pytest -k name -p no:cacheprovider tests/test_x.py",
    "pytest -kname -pno:cacheprovider tests/test_x.py",
    "make test -j4 --keep-going",
    "make test -j 4 --jobs=2 --silent --always-make --no-print-directory --dry-run",
    "python3 scripts/foreman_docs.py features --check",
    "node --test --test-reporter=spec tests/t.test.mjs",
    "node --test --test-reporter=some-npm-reporter tests/t.test.mjs",
  ]);
  denies(['node --test "tests/*.mjs"']);
});

test("fix 2B: every word of an interpreter command is scanned, not only the first positional", { skip: !posix }, () => {
  for (const role of ["builder", "reviewer"]) {
    denies([
      "node --unhandled-rejections strict $FOREMAN_SCRATCH/evil0.mjs",
      `bash -eo pipefail ${scratch}/evil.sh`,
      "node --watch-path . evil0.mjs",
      "node --some-flag value --other=1 $FOREMAN_SCRATCH/evil0.mjs",
      `node -r${scratch}/evil0.mjs plain.mjs`,
    ], role, scratch);
  }
  passes(["node --unhandled-rejections strict plain.mjs", "bash -eo pipefail -c true"], "builder", scratch);
});

test("fix 2C: git config in a write form is denied for a read-only child whatever the target and cwd", { skip: !posix }, () => {
  denies(["git config --global user.name x", "git config --system a.b c", "git config --global --unset a.b"], "reviewer", scratch);
  denies(["git config --global user.name x"]);
  passes(["git config --global --list", "git config --global user.name"], "reviewer", scratch);
});

test("fix 3A: test-runner words with $VAR, ~ or command substitution are expanded and checked, unexpandable ones denied", { skip: !posix }, () => {
  denies([
    "pytest $FOREMAN_SCRATCH",
    "pytest ~",
    "pytest $HOME",
    "pytest ${HOME}",
    "node --test $FOREMAN_SCRATCH",
    "pytest --rootdir $HOME tests/test_x.py",
    "node --test --test-name-pattern=zzznomatch $FOREMAN_SCRATCH",
    "pytest $(pwd)/../x",
    "pytest `pwd`",
    "pytest $UNKNOWN_VAR",
  ]);
  passes([
    "npm run test:node",
    'node --test "extensions/core-adapter/test/*.test.ts"',
    "python3 -m unittest discover -s tests",
    "python3 scripts/foreman_docs.py features --check",
    "pytest -k name tests/test_x.py",
    "pytest -k name",
  ]);
});

test("fix 3B: a directory operand outside git is an untracked directory run, denied for every role", { skip: !posix }, () => {
  fs.mkdirSync(path.join(scratch, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "pkg", "index.js"), "console.log(1);\n");
  fs.writeFileSync(path.join(scratch, "pkg", "__main__.py"), "print(1)\n");
  for (const role of ["builder", "reviewer"]) {
    denies(["node $FOREMAN_SCRATCH", "python3 $FOREMAN_SCRATCH", `node ${scratch}/pkg`], role, scratch);
    denies(["python3 -m pkg"], role, scratch);
  }
  passes(["node ."], "builder");
});
