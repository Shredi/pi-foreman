// R13 item 1 (hub 170, hub 288): the self-ruling guard reads lexed write surfaces (scripts/shell_facts.py, the git guard's
// Lexer). Named PASS cases are literal friction lines of R11/R12; the fail-closed cases refuse with the old reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { SELF_RULING_REASON, selfRulingRefusal, shellFacts } from "../ruling.ts";

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
const run = (r: Rig, command: string, tool = "bash", cwd = r.root) => selfRulingRefusal(tool, { command }, cwd, r.dirs, { scratch: r.S });

const PASS: Array<[string, (r: Rig) => string]> = [
  ["ls -la $D; cat $D/parent (D bound to <H>)", (r) => `D=${r.H}; ls -la $D; cat $D/parent`],
  ["ls -la $D; cat $D/parent (D unbound)", () => `ls -la $D; cat $D/parent`],
  ["cd extensions/core-adapter; grep -rln selfRuling .", () => `cd extensions/core-adapter; grep -rln selfRuling .`],
  ["cp <H>/plan.md <S> && cat <H>/ruling.md >> <S>/x.md", (r) => `cp ${r.H}/plan.md ${r.S} && cat ${r.H}/ruling.md >> ${r.S}/x.md`],
  ["ls <H>/; python3 heredoc reading <H> files, writing <S>", (r) => `ls ${r.H}/; python3 - <<'EOF'\nimport os\nfor n in os.listdir('${r.H}'):\n    print(n, open(os.path.join('${r.H}', n)).read()[:40])\nopen('${r.S}/notes.txt', 'w').write('x')\nEOF`],
  ["node -e reading and writing the own usage file", (r) => `node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('${r.S}/usage.json','utf8'));d.n=1;fs.writeFileSync('${r.S}/usage.json',JSON.stringify(d))"`],
  ["ack_write_in_own_handoff_dir_passes (shell redirect)", (r) => `echo seen > ${r.H}/ruling-x.ack`],
  ["heredoc body with $25 and [ appended to own scratch", (r) => `cat >> ${r.S}/plan.md <<'EOF'\n- Ask at $25 [x] ruling.md\nEOF`],
  ["glob and $ words in read positions next to <H>", (r) => `ls ${r.H}/*.md $X; grep -l APPROVED ${r.H}/ruling*.md`],
  ["write ruling.md in own scratch", (r) => `echo x > $FOREMAN_SCRATCH/ruling.md`],
];

for (const [name, line] of PASS) {
  test(`r13 named pass: ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(r)), undefined, line(r));
  });
}

test("r13 named pass: ack_write_in_own_handoff_dir_passes (write tool)", async () => {
  const r = rig();
  for (const tool of ["write", "edit"]) assert.equal(await selfRulingRefusal(tool, { path: path.join(r.H, "ruling-x.ack") }, r.root, r.dirs), undefined, tool);
});

const DENY: Array<[string, (r: Rig) => string]> = [
  ["bound variable resolves into <H>", (r) => `D=${r.H}; echo A > $D/ruling.md`],
  ["subshell cd does not carry over (cwd <H>)", () => `echo $(cd /tmp) ; cat x > ruling.md`],
  ["existing symlink file aliasing the ruling", (r) => `ln -s ${r.H}/ruling.md ${r.S}/alias; echo A > ${r.S}/alias`],
  ["python heredoc writing a computed path", (r) => `ls ${r.H}/; python3 - <<'EOF'\np = '${r.H}' + '/' + 'ruling.md'\nopen(p, 'w').write('APPROVED')\nEOF`],
  ["exec 3> into <H>", (r) => `exec 3> ${r.H}/ruling.md`],
  ["truncate", (r) => `truncate -s 0 ${r.H}/ruling.md`],
  ["computed sh -c", () => `sh -c "$C"`],
  ["computed eval", () => `eval "$C"`],
  ["sed e command", (r) => `sed '1e touch ${r.H}/ruling.md' ${r.S}/usage.json`],
  ["sed s///e", (r) => `sed 's|.*|touch ${r.H}/ruling.md|e' ${r.S}/usage.json`],
  ["xargs touch from stdin", (r) => `echo ${r.H}/ruling.md | xargs touch`],
  ["awk system", (r) => `awk 'BEGIN{system("touch ${r.H}/ruling.md")}'`],
  ["find -exec", (r) => `find ${r.H} -name ruling.md -exec touch {} +`],
  ["find -exec sh -c on r*.md", (r) => `find ${r.H} -name 'r*.md' -exec sh -c 'echo APPROVED > "$1"' _ {} \\;`],
  ["find -type f -exec touch {} +", (r) => `find ${r.H} -type f -exec touch {} +`],
  ["find -delete", (r) => `find ${r.H} -name 'r*' -delete`],
  ["sed --expression=1e", (r) => `sed --expression='1e touch ${r.H}/ruling.md' ${r.S}/usage.json`],
  ["sed -e1e (one word)", (r) => `sed '-e1e touch ${r.H}/ruling.md' ${r.S}/usage.json`],
  ["sed -ne 1e", (r) => `sed -ne '1e touch ${r.H}/ruling.md' ${r.S}/usage.json`],
  ["sed custom-delimiter address then e", (r) => `sed '\\,a,e touch ${r.H}/ruling.md' ${r.S}/usage.json`],
  ["sed -f script file", (r) => `sed -f script.sed ${r.S}/usage.json`],
];

const PASS_R2: Array<[string, (r: Rig) => string]> = [
  ["find -name x -print", (r) => `find ${r.H} -name x -print`],
  ["sed -n -e s///p", (r) => `sed -n -e 's/a/b/p' ${r.S}/usage.json`],
  ["sed -n s///p", (r) => `sed -n 's/a/b/p' ${r.S}/usage.json`],
];

for (const [name, line] of PASS_R2) {
  test(`r13 named pass (round 2): ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(r)), undefined, line(r));
  });
}

for (const [name, line] of DENY) {
  test(`r13 deny: ${name}`, async () => {
    const r = rig();
    const cwd = name.includes("(cwd <H>)") ? r.H : r.root;
    assert.equal(await run(r, line(r), "bash", cwd), SELF_RULING_REASON, line(r));
  });
}

// Review round 3: sed scripts with e, w or W anywhere, sed long options that are not exact GNU forms and computed find
// words are fully computed writes.
const DENY_R3: Array<[string, (r: Rig) => string]> = [
  ["sed 1w", (r) => `sed -n '1w ${r.H}/ruling.md' ${r.S}/usage.json`],
  ["sed $w", (r) => `sed -n '$w ${r.H}/ruling.md' ${r.S}/usage.json`],
  ["sed s|a|b|w", (r) => `sed 's|a|b|w ${r.H}/ruling.md' ${r.S}/usage.json`],
  ["sed 1,+2e", (r) => `sed '1,+2e touch ${r.H}/ruling.md' ${r.S}/usage.json`],
  ["sed 1 ! e", (r) => `sed '1 ! e touch ${r.H}/ruling.md' ${r.S}/usage.json`],
  ["sed --expr=", (r) => `sed --expr='1e touch ${r.H}/ruling.md' ${r.S}/usage.json`],
  ["sed --fi=", (r) => `sed --fi=script.sed ${r.S}/usage.json`],
  ["sed --in", (r) => `sed --in s/a/b/ ${r.H}/ruling.md`],
  ["find computed action $A", (r) => `find ${r.H} -name ruling.md $A touch {} +`],
  ['find quoted "$A"', (r) => `find ${r.H} -name ruling.md "$A" touch {} +`],
];

for (const [name, line] of DENY_R3) {
  test(`r13 deny (round 3): ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(r)), SELF_RULING_REASON, line(r));
  });
}

test("r13 fail closed: no python, a missing interpreter and an unreadable line refuse a shell call", async () => {
  const r = rig();
  const cmd = `ls ${r.H}`;
  assert.equal(await selfRulingRefusal("bash", { command: cmd }, r.root, r.dirs, { python: null }), SELF_RULING_REASON);
  assert.equal(await selfRulingRefusal("bash", { command: cmd }, r.root, r.dirs, { python: path.join(r.root, "no-python") }), SELF_RULING_REASON);
  assert.equal(await run(r, `echo 'unterminated`), SELF_RULING_REASON);
  // the tool path compare needs no python
  assert.equal(await selfRulingRefusal("write", { path: path.join(r.H, "ruling.md") }, r.root, r.dirs, { python: null }), SELF_RULING_REASON);
  assert.equal(await selfRulingRefusal("bash", { command: cmd }, r.root, [], { python: null }), undefined);
});

test("r13 shellFacts: a redirect target is reported with its resolved path", async () => {
  const r = rig();
  const f = await shellFacts(`cd ${r.H} && echo A > ruling.md`, r.root, "bash");
  assert.ok(f);
  assert.deepEqual(f.writes.map((w) => [w.kind, w.path]), [["redirect", path.join(r.H, "ruling.md")]]);
});
