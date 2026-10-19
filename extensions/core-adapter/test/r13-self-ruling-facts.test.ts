// R13 item 1 (hub 170, hub 288): the self-ruling guard reads lexed write surfaces (scripts/shell_facts.py, the git guard's
// Lexer). Named PASS cases are literal friction lines of R11/R12; the fail-closed cases refuse with the old reason.
// R16 item 4a: ruling.ts keeps the plain literal-path deny on the TS lexer; the rows it no longer decides live in
// test/retired/self-ruling-rows.json (fail-closed, computed, sed/awk/find/xargs and bound-variable rows).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { SELF_RULING_REASON, selfRulingRefusal } from "../ruling.ts";

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r13sr-")));
  const hand = path.join(root, ".workflow", "handoffs");
  const H = path.join(hand, "up");
  const S = path.join(root, "scratch");
  fs.mkdirSync(H, { recursive: true });
  fs.mkdirSync(S, { recursive: true });
  fs.mkdirSync(path.join(root, "extensions", "core-adapter"), { recursive: true });
  fs.writeFileSync(path.join(H, "parent"), "other\n");
  fs.writeFileSync(path.join(H, "child"), "me\n");
  fs.writeFileSync(path.join(H, "ruling.md"), "APPROVED\n");
  fs.writeFileSync(path.join(H, "plan.md"), "plan\n");
  fs.writeFileSync(path.join(S, "usage.json"), "{}\n");
  return { root, hand, H, S, dirs: childHandoffDirs(hand, "me") };
}
type Rig = ReturnType<typeof rig>;
// A child on Windows writes a path into the bash line with forward slashes; native backslashes would be bash escapes.
// The lines are built from this view; the ctx paths (cwd, child dirs, scratch, write/edit paths) stay native.
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const bash = (r: Rig): Rig => ({ ...r, root: inBash(r.root), hand: inBash(r.hand), H: inBash(r.H), S: inBash(r.S) });
const run = (r: Rig, command: string, tool = "bash", cwd = r.root) => selfRulingRefusal(tool, { command }, cwd, r.dirs);

const PASS: Array<[string, (r: Rig) => string]> = [
  ["ls -la $D; cat $D/parent (D bound to <H>)", (r) => `D=${r.H}; ls -la $D; cat $D/parent`],
  ["ls -la $D; cat $D/parent (D unbound)", () => `ls -la $D; cat $D/parent`],
  ["cd extensions/core-adapter; grep -rln selfRuling .", () => `cd extensions/core-adapter; grep -rln selfRuling .`],
  ["ls <H>/; python3 heredoc reading <H> files, writing <S>", (r) => `ls ${r.H}/; python3 - <<'EOF'\nimport os\nfor n in os.listdir('${r.H}'):\n    print(n, open(os.path.join('${r.H}', n)).read()[:40])\nopen('${r.S}/notes.txt', 'w').write('x')\nEOF`],
  ["node -e reading and writing the own usage file", (r) => `node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('${r.S}/usage.json','utf8'));d.n=1;fs.writeFileSync('${r.S}/usage.json',JSON.stringify(d))"`],
  ["heredoc body with $25 and [ appended to own scratch", (r) => `cat >> ${r.S}/plan.md <<'EOF'\n- Ask at $25 [x] ruling.md\nEOF`],
  ["glob and $ words in read positions next to <H>", (r) => `ls ${r.H}/*.md $X; grep -l APPROVED ${r.H}/ruling*.md`],
  ["write ruling.md in own scratch", (r) => `echo x > $FOREMAN_SCRATCH/ruling.md`],
];

for (const [name, line] of PASS) {
  test(`r13 named pass: ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(bash(r))), undefined, line(bash(r)));
  });
}

test("r13 named pass: ack_write_in_own_handoff_dir_passes (write tool)", async () => {
  const r = rig();
  for (const tool of ["write", "edit"]) assert.equal(await selfRulingRefusal(tool, { path: path.join(r.H, "ruling-x.ack") }, r.root, r.dirs), undefined, tool);
});

const DENY: Array<[string, (r: Rig) => string]> = [
  ["subshell cd does not carry over (cwd <H>)", () => `echo $(cd /tmp) ; cat x > ruling.md`],
];

const PASS_R2: Array<[string, (r: Rig) => string]> = [
  ["find -name x -print", (r) => `find ${r.H} -name x -print`],
  ["sed -n -e s///p", (r) => `sed -n -e 's/a/b/p' ${r.S}/usage.json`],
  ["sed -n s///p", (r) => `sed -n 's/a/b/p' ${r.S}/usage.json`],
];

for (const [name, line] of PASS_R2) {
  test(`r13 named pass (round 2): ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(bash(r))), undefined, line(bash(r)));
  });
}

for (const [name, line] of DENY) {
  test(`r13 deny: ${name}`, async () => {
    const r = rig();
    const cwd = name.includes("(cwd <H>)") ? r.H : r.root;
    assert.equal(await run(r, line(bash(r)), "bash", cwd), SELF_RULING_REASON, line(bash(r)));
  });
}

// Review round 3: sed scripts with e, w or W anywhere, sed long options that are not exact GNU forms and computed find
// words are fully computed writes.
const DENY_R3: Array<[string, (r: Rig) => string]> = [
  ["sed --in", (r) => `sed --in s/a/b/ ${r.H}/ruling.md`],
];

for (const [name, line] of DENY_R3) {
  test(`r13 deny (round 3): ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(bash(r))), SELF_RULING_REASON, line(bash(r)));
  });
}

// R14 item 3: a read-only sed script whose regex merely contains e/w/W.
const PASS_R14: Array<[string, (r: Rig) => string]> = [
  ["sed -n '1,5p' <H>/ruling.md", (r) => `sed -n '1,5p' ${r.H}/ruling.md`],
  ["sed -n '/review/p' <H>/ruling.md (a regex with w and e)", (r) => `sed -n '/review/p' ${r.H}/ruling.md`],
];

for (const [name, line] of PASS_R14) {
  test(`r14 pass (residual): ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(bash(r))), undefined, line(bash(r)));
  });
}

// The exception to inBash: the point of these lines is the native backslash spelling (quoted reaches the path; unquoted is a
// bash escape, but the native spelling is a candidate too, fail closed).
test("r13 deny (win32): a native backslash path to the parent's ruling, quoted or not", { skip: process.platform !== "win32" }, async () => {
  const r = rig();
  const f = path.join(r.H, "ruling.md");
  for (const line of [`echo A > '${f}'`, `cp x "${f}"`, `echo A > ${f}`]) assert.equal(await run(r, line), SELF_RULING_REASON, line);
});
