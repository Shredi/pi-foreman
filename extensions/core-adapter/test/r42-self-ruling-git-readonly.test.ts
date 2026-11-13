// A read-only line next to a parent's ruling no longer asks: `git ls-remote` joins the read-only git subcommands, minus the forms that start a
// program (`--upload-pack`, `--exec`, a `<transport>::` remote, `--exec-path=`, any variable the line sets). The protection stays: a write to a ruling
// is still refused and asked, and `--output <file>` (separate value) of any git subcommand now counts as a write word.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { childHandoffDirs } from "../owned.ts";
import { buildOverlayRules, checkToolCall, readBaseline, shellWrites } from "../permoverlay.ts";
import { selfRulingAsk, selfRulingRefusal } from "../ruling.ts";
import { childSurface } from "../roundsurface.ts";

const posix = process.platform !== "win32";
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r42gro-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const hand = path.join(root, ".workflow", "handoffs");
const Hn = path.join(hand, "up");
fs.mkdirSync(Hn, { recursive: true });
fs.writeFileSync(path.join(Hn, "parent"), "other\n");
fs.writeFileSync(path.join(Hn, "child"), "me\n");
fs.writeFileSync(path.join(Hn, "ruling.md"), "APPROVED\n");
fs.writeFileSync(path.join(Hn, "brief.md"), "x\n");
fs.writeFileSync(path.join(Hn, "plan.md"), "## X\n");
const dirs = childHandoffDirs(hand, "me");
const H = inBash(Hn);

const refusal = (command: string): string | undefined => selfRulingRefusal("bash", { command }, root, dirs);
const ask = (command: string): boolean => selfRulingAsk("bash", { command }, dirs) !== undefined;

const GREP = `grep -n -i -B1 -A3 'approved' ${H}/brief*.md ${H}/ruling*.md | cut -c1-200`;
const DIFF = "git diff --stat origin/main..HEAD";
const LS = "git ls-remote origin round/x";
const SED = `sed -n '/^## X/,$p' ${H}/plan.md | grep -n foo | head -5`;
const chain = (sep: string, ls = LS): string => [GREP, DIFF, ls, SED].join(` ${sep} `);
const readChain = `${GREP}; ${DIFF}`;

test("the held read chain passes without a refusal or an ask, joined by ; and by &&", () => {
  for (const line of [chain(";"), chain("&&")]) {
    assert.equal(refusal(line), undefined, line);
    assert.equal(ask(line), false, line);
  }
});

test("near variants of the held chain pass", () => {
  const long = `grep -n -i -B1 -A3 '${"a".repeat(400)}' ${H}/brief*.md ${H}/ruling*.md | cut -c1-200`;
  for (const line of [
    chain(";", "git ls-remote --heads origin round/x"),
    chain(";", `git -C ${H} ls-remote origin round/x`),
    chain(";", "git ls-remote --tags --refs origin"),
    `${long}; ${LS}`,
    `sed -n '1,$p' ${H}/plan.md; ${LS}; cat ${H}/ruling.md`,
    `sed -n '/^## X/,$p' ${H}/plan.md; ${LS}; cat ${H}/ruling.md`,
  ]) {
    assert.equal(refusal(line), undefined, line);
    assert.equal(ask(line), false, line);
  }
});

const STILL_ASKED: Array<[string, string]> = [
  ["--upload-pack=", "git ls-remote --upload-pack=/tmp/p origin"],
  ["--upload-pack separate", "git ls-remote --upload-pack /tmp/p origin"],
  ["--upload-pack prefix", "git ls-remote --up=/tmp/p origin"],
  ["--exec separate", "git ls-remote --exec /tmp/p origin"],
  ["--exec=", "git ls-remote --exec=/tmp/p origin"],
  ["-u", "git ls-remote -u /tmp/p origin"],
  ["ext:: remote", "git ls-remote 'ext::sh -c x' b"],
  ["foo:: remote", "git ls-remote foo::bar b"],
  ["--exec-path=", "git --exec-path=/tmp/e ls-remote origin"],
  ["GIT_SSH_COMMAND", "GIT_SSH_COMMAND=/tmp/p git ls-remote origin"],
  ["GIT_SSH", "GIT_SSH=/tmp/p git ls-remote origin"],
  ["GIT_PROXY_COMMAND", "GIT_PROXY_COMMAND=/tmp/p git ls-remote origin"],
  ["GIT_ASKPASS", "GIT_ASKPASS=/tmp/p git ls-remote origin"],
  ["SSH_ASKPASS", "SSH_ASKPASS=/tmp/p git ls-remote origin"],
  ["HOME", "HOME=/tmp/h git ls-remote origin"],
  ["export GIT_SSH_COMMAND", "export GIT_SSH_COMMAND=/tmp/p; git ls-remote origin"],
  ["export HOME", "export HOME=/tmp/h; git ls-remote origin"],
  ["bare assignment", "X=1; git ls-remote origin"],
  ["env VAR=", "env GIT_SSH_COMMAND=/tmp/p git ls-remote origin"],
  ["declare -x", "declare -x GIT_SSH=/tmp/p; git ls-remote origin"],
  ["typeset -x", "typeset -x GIT_SSH=/tmp/p; git ls-remote origin"],
  ["readonly assignment", "readonly GIT_SSH=/tmp/p; git ls-remote origin"],
  ["assignment inside bash -c", "bash -c 'GIT_SSH=/tmp/p git ls-remote origin'"],
  ["git reflog", "git reflog"],
  ["git whatchanged", "git whatchanged"],
  ["git verify-commit", "git verify-commit HEAD"],
  ["git commit", "git commit -m x"],
  ["unknown command", "frobnicate --now"],
];
for (const [name, cmd] of STILL_ASKED) {
  test(`still asked next to a ruling read: ${name}`, () => {
    const line = `${readChain}; ${cmd}`;
    assert.equal(refusal(line), undefined, line);
    assert.equal(ask(line), true, line);
  });
}

const WRITES: Array<[string, string]> = [
  ["> redirect", `echo APPROVED > ${H}/ruling.md`],
  ["tee", `echo APPROVED | tee ${H}/ruling.md`],
  ["sed -i", `sed -i s/FAIL/APPROVED/ ${H}/ruling.md`],
  ["cp", `cp /tmp/x ${H}/ruling.md`],
  ["mv", `mv /tmp/x ${H}/ruling.md`],
  ["python3 -c", `python3 -c "open('${H}/ruling.md','w').write('APPROVED')"`],
  ["node -e", `node -e "require('fs').writeFileSync('${H}/ruling.md','APPROVED')"`],
];
for (const [name, cmd] of WRITES) {
  test(`still stopped, alone and after the held read chain: ${name}`, () => {
    for (const line of [cmd, `${chain(";")}; ${cmd}`]) {
      assert.equal(ask(line), true, line);
    }
    // the literal-path writers are refused outright; an interpreter one-liner is asked (selfRulingAsk) as before this change
    if (!/^(python3|node) /.test(cmd)) assert.notEqual(refusal(cmd), undefined, cmd);
    if (!/^(python3|node) /.test(cmd)) assert.notEqual(refusal(`${chain(";")}; ${cmd}`), undefined, cmd);
  });
}

test("--output <file> of a git subcommand onto a ruling is refused and asked", () => {
  for (const sub of ["log -1 --format=tformat:APPROVED", "show --format=tformat:APPROVED", "diff"]) {
    for (const flag of [`--output ${H}/ruling.md`, `--output=${H}/ruling.md`]) {
      const line = `git ${sub} ${flag}`;
      assert.notEqual(refusal(line), undefined, line);
      assert.equal(ask(line), true, line);
    }
  }
});

test("--output <file> elsewhere is a write word: the line asks next to a ruling read", () => {
  const line = `${readChain}; git log -1 --output /tmp/x.txt`;
  assert.equal(refusal(line), undefined);
  assert.equal(ask(line), true);
});

test("shellWrites: plain git ls-remote has no write word and is not unnamed", () => {
  for (const cmd of [LS, "git ls-remote --heads origin", "git -C /some/dir ls-remote origin b"]) {
    const w = shellWrites(cmd);
    assert.deepEqual(w.words.filter((x) => x === "."), [], cmd);
    assert.equal(w.unnamed, false, cmd);
  }
});

test("shellWrites: every program-running form of git ls-remote is unnamed", () => {
  for (const [name, cmd] of STILL_ASKED.slice(0, 22)) assert.equal(shellWrites(cmd).unnamed, true, `${name}: ${cmd}`);
});

test("shellWrites: --output <file> names the file", () => {
  assert.ok(shellWrites("git log --output /tmp/out.txt").words.includes("/tmp/out.txt"));
  assert.ok(shellWrites("git diff --output=/tmp/out.txt").words.includes("/tmp/out.txt"));
});

// the permission overlay for a read-only child (reviewer in the round worktree)
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const rt = path.join(root, "repo.worktrees", "round");
const scratch = path.join(root, "scratch");
fs.mkdirSync(rt, { recursive: true });
fs.mkdirSync(scratch, { recursive: true });
const top = (d: string): string | null => (d.startsWith(rt) ? rt : null);
const rules = buildOverlayRules(baseline, {}, {}, path.join(root, "agent"), pkgRoot, undefined, false);
const overlay = (command: string): string => {
  const s = childSurface([rt], rt, "reviewer", process.platform, top);
  return checkToolCall(rules, "bash", { command }, { cwd: rt, home: root, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read })?.kind ?? "pass";
};

test("a read-only child may run a plain git ls-remote and is denied the program-running forms", { skip: !posix }, () => {
  assert.equal(overlay("git ls-remote origin b"), "pass");
  assert.equal(overlay("GIT_SSH_COMMAND=/tmp/p git ls-remote ssh://h/r"), "deny");
  assert.equal(overlay("git ls-remote --upload-pack=/tmp/p origin"), "deny");
});
