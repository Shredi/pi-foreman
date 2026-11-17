// A read-only line next to a parent's ruling no longer asks: `git ls-remote` joins the read-only git subcommands, minus the forms that start a
// program (`--upload-pack`, `--exec`, a `<transport>::` remote, `--exec-path=`, any variable the line sets). The protection stays: a write to a ruling
// is still refused, and `--output <file>` (separate value) of any git subcommand now counts as a write word. (The overlay's own-ruling ask
// these lines were also checked against is gone; the refusal half stays.)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { selfRulingRefusal } from "../ruling.ts";

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

const GREP = `grep -n -i -B1 -A3 'approved' ${H}/brief*.md ${H}/ruling*.md | cut -c1-200`;
const DIFF = "git diff --stat origin/main..HEAD";
const LS = "git ls-remote origin round/x";
const SED = `sed -n '/^## X/,$p' ${H}/plan.md | grep -n foo | head -5`;
const chain = (sep: string, ls = LS): string => [GREP, DIFF, ls, SED].join(` ${sep} `);
const readChain = `${GREP}; ${DIFF}`;

test("the held read chain passes without a refusal, joined by ; and by &&", () => {
  for (const line of [chain(";"), chain("&&")]) {
    assert.equal(refusal(line), undefined, line);
  }
});

test("near variants of the held chain pass without a refusal", () => {
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
  test(`no refusal next to a ruling read: ${name}`, () => {
    const line = `${readChain}; ${cmd}`;
    assert.equal(refusal(line), undefined, line);
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
  test(`still refused, alone and after the held read chain: ${name}`, () => {
    // every writer is refused outright, the interpreter one-liners (python3 -c, node -e) too
    assert.notEqual(refusal(cmd), undefined, cmd);
    assert.notEqual(refusal(`${chain(";")}; ${cmd}`), undefined, cmd);
  });
}

test("--output <file> of a git subcommand onto a ruling is refused", () => {
  for (const sub of ["log -1 --format=tformat:APPROVED", "show --format=tformat:APPROVED", "diff"]) {
    for (const flag of [`--output ${H}/ruling.md`, `--output=${H}/ruling.md`]) {
      const line = `git ${sub} ${flag}`;
      assert.notEqual(refusal(line), undefined, line);
    }
  }
});

test("--output <file> elsewhere next to a ruling read is no refusal", () => {
  const line = `${readChain}; git log -1 --output /tmp/x.txt`;
  assert.equal(refusal(line), undefined);
});
