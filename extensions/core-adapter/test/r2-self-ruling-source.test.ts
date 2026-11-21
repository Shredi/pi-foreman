// Round 2, step 2a: the own-ruling refusal (ruling.ts selfRulingRefusal) reads the write words from the gate's parse (shellast.ts, defaults.ts
// shellWriteTargets) instead of permoverlay.ts shellWrites. Lines are data strings, never run.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { SELF_RULING_REASON, selfRulingRefusal } from "../ruling.ts";
import { shellWriteTargets, unresolvedWriteWords } from "../defaults.ts";
import { parseShell } from "../shellast.ts";
import { posixOnly } from "./_platform.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const made: string[] = [];
after(() => {
  for (const d of made) rmTestTmp(d);
});
const mk = (prefix: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
};

function rig() {
  const root = fs.realpathSync.native(mk("pf-r2src-"));
  const hand = path.join(root, ".workflow", "handoffs");
  const H = path.join(hand, "up");
  const S = path.join(root, "scratch");
  fs.mkdirSync(H, { recursive: true });
  fs.mkdirSync(S, { recursive: true });
  fs.writeFileSync(path.join(H, "parent"), "other\n");
  fs.writeFileSync(path.join(H, "child"), "me\n");
  fs.writeFileSync(path.join(H, "ruling.md"), "APPROVED\n");
  return { root, H, S, dirs: childHandoffDirs(hand, "me") };
}
type Rig = ReturnType<typeof rig>;
const run = (r: Rig, command: string, tool = "bash", cwd = r.root) => selfRulingRefusal(tool, { command }, cwd, r.dirs);

type Row = [name: string, line: (r: Rig) => string];

const REFUSED: Row[] = [
  ["redirect >", (r) => `echo x > ${r.H}/ruling.md`],
  ["redirect >>", (r) => `echo x >> ${r.H}/ruling.md`],
  ["redirect &>", (r) => `echo x &> ${r.H}/ruling-1.md`],
  ["redirect >|", (r) => `echo x >| ${r.H}/brief-a.md`],
  ["redirect with fd", (r) => `echo x 1>${r.H}/ruling.md`],
  ["tee", (r) => `echo x | tee ${r.H}/ruling.md`],
  ["tee -a", (r) => `echo x | tee -a ${r.H}/ruling-2.md`],
  ["cp", (r) => `cp /tmp/x ${r.H}/ruling.md`],
  ["mv", (r) => `mv /tmp/x ${r.H}/ruling-2.md`],
  ["ln -s", (r) => `ln -s /tmp/x ${r.H}/ruling.md`],
  ["install", (r) => `install -m 644 /tmp/x ${r.H}/ruling.md`],
  ["sed -i", (r) => `sed -i s/a/b/ ${r.H}/ruling.md`],
  ["sed --in (a prefix of --in-place)", (r) => `sed --in s/a/b/ ${r.H}/ruling.md`],
  ["curl -o", (r) => `curl -o ${r.H}/ruling.md http://example.com/x`],
  ["curl -sSo (cluster)", (r) => `curl -sSo ${r.H}/ruling.md http://example.com/x`],
  ["curl --output", (r) => `curl --output ${r.H}/ruling.md http://example.com/x`],
  ["wget -O", (r) => `wget -O ${r.H}/ruling.md http://example.com/x`],
  ["git config --file", (r) => `git config --file ${r.H}/ruling.md a.b c`],
  ["git log --output=", (r) => `git log --output=${r.H}/ruling.md`],
  ["git diff --output <f>", (r) => `git diff --output ${r.H}/ruling.md`],
  ["git show --output=", (r) => `git show --output=${r.H}/ruling.md HEAD`],
  ["git format-patch --output-directory", (r) => `git format-patch --output-directory ${r.H}/ruling.md HEAD~1`],
  ["python3 -c naming the path", (r) => `python3 -c "open('${r.H}/ruling.md','w').write('x')"`],
  ["node -e naming the path", (r) => `node -e "require('fs').writeFileSync('${r.H}/ruling.md','x')"`],
  ["stdin-fed python3 script naming the path", (r) => `python3 - <<'EOF'\nopen('${r.H}/ruling.md','w').write('x')\nEOF`],
  ["stdin-fed bash script naming the path", (r) => `bash <<'EOF'\necho x > ${r.H}/ruling.md\nEOF`],
  ["a bound variable", (r) => `D=${r.H}; echo x > $D/ruling.md`],
  ["cd, then a relative name", (r) => `cd ${r.H} && echo x > ruling.md`],
  ["unresolved word on a line naming the handoff dir", (r) => `echo x > "$X"; ls ${r.H}`],
  ["unresolved name on a line naming a ruling file", () => `echo x > $X/ruling.md`],
  ["substitution target on a line naming a ruling file", () => `echo x > $(pwd)/ruling.md`],
  ["unresolved cp destination, line names the dir", (r) => `cp x "$X"; ls ${r.H}`],
  ["brace list in the file name", (r) => `echo x > ${r.H}/ruling{,-1}.md`],
  ["bg_run", (r) => `echo x > ${r.H}/ruling.md`],
];

for (const [name, line] of REFUSED) {
  test(`refused: ${name}`, { skip: posixOnly }, () => {
    const r = rig();
    const tool = name === "bg_run" ? "bg_run" : "bash";
    assert.equal(run(r, line(r), tool), SELF_RULING_REASON, line(r));
  });
}

const NOT_REFUSED: Row[] = [
  ["cat of the ruling", (r) => `cat ${r.H}/ruling.md`],
  ["grep of the ruling", (r) => `grep -n APPROVED ${r.H}/ruling.md`],
  ["git diff --no-index of the ruling", (r) => `git diff --no-index ${r.H}/ruling.md /tmp/x`],
  ["sed -n of the ruling", (r) => `sed -n 's/a/b/p' ${r.H}/ruling.md`],
  ["a read of the ruling copied to scratch", (r) => `cp ${r.H}/ruling.md ${r.S}/copy.md`],
  ["a write elsewhere on a line that only reads the ruling", (r) => `cat ${r.H}/ruling.md; echo x > ${r.S}/n.md`],
  ["a write of a non-ruling file of the handoff dir", (r) => `echo x > ${r.H}/plan.md`],
  // #227: ruling-plan.md left the tracked names (no plan approval travels from a parent)
  ["tee -a of ruling-plan.md", (r) => `echo x | tee -a ${r.H}/ruling-plan.md`],
  ["an .ack file", (r) => `echo x > ${r.H}/ruling-1.ack`],
  ["curl to scratch", (r) => `curl -o ${r.S}/f http://example.com/x`],
  ["wget -O -", () => `wget -q -O - http://example.com/x`],
  ["git log --output elsewhere", (r) => `git log --output ${r.S}/out.txt`],
  ["git log -o (no target)", (r) => `git log -o ${r.H}/ruling.md`],
  ["inline code reading nothing of the ruling", (r) => `python3 -c "print(open('${r.S}/a.txt').read())"`],
  ["stdin-fed script naming the dir but no ruling file", (r) => `python3 - <<'EOF'\nimport os\nprint(os.listdir('${r.H}'))\nEOF`],
  ["a variable read: cat $D/ruling.md", (r) => `D=${r.H}; cat $D/ruling.md`],
  ["an unresolved read word beside the dir", (r) => `cat $X; ls ${r.H}`],
  ["unresolved write word on a line that names neither dir nor ruling file", () => `echo x > "$X"`],
  ["$FOREMAN_SCRATCH target", () => `echo x > $FOREMAN_SCRATCH/ruling.md`],
  ["${FOREMAN_SCRATCH} target beside the dir", (r) => `echo x > \${FOREMAN_SCRATCH}/ruling.md; ls ${r.H}`],
  ["$FOREMAN_SCRATCH rebound on the line", (r) => `FOREMAN_SCRATCH=/tmp/q; echo x > $FOREMAN_SCRATCH/ruling.md; ls ${r.H}`],
];

for (const [name, line] of NOT_REFUSED) {
  test(`not refused: ${name}`, { skip: posixOnly }, () => {
    const r = rig();
    assert.equal(run(r, line(r)), undefined, line(r));
  });
}

const PS_REFUSED: Row[] = [
  ["Set-Content with the full path", (r) => `Set-Content ${r.H}/ruling.md x`],
  ["backslash spelling and parameters", (r) => `Set-Content -Path ${r.H}\\ruling.md -Value x`],
  ["Out-File with a quoted path", (r) => `"x" | Out-File '${r.H}/ruling.md'`],
  ["Copy-Item onto a brief", (r) => `Copy-Item x ${r.H}/brief-a.md`],
  ["Add-Content onto ruling-1.md", (r) => `Add-Content ${r.H}/ruling-1.md x`],
  ["a read: Get-Content of the ruling", (r) => `Get-Content ${r.H}/ruling.md`],
  ["a bare ruling name beside the handoff dir", (r) => `Set-Content -Path ruling.md -Value x; ls ${r.H}`],
  ["a bare ruling name read beside the handoff dir", (r) => `Get-Content ruling.md; ls ${r.H}`],
];

for (const [name, line] of PS_REFUSED) {
  test(`powershell refused: ${name}`, { skip: posixOnly }, () => {
    const r = rig();
    assert.equal(run(r, line(r), "powershell"), SELF_RULING_REASON, line(r));
  });
}

const PS_NOT_REFUSED: Row[] = [
  ["ls of the dir", (r) => `ls ${r.H}`],
  ["a write of plan.md", (r) => `Set-Content ${r.H}/plan.md x`],
  ["a bare ruling name with no dir word", () => `Set-Content -Path ruling.md -Value x`],
  ["the scratch env path", () => `Set-Content $env:FOREMAN_SCRATCH\\ruling.md x`],
  ["a ruling file elsewhere", (r) => `Set-Content ${r.S}/ruling.md x`],
];

for (const [name, line] of PS_NOT_REFUSED) {
  test(`powershell not refused: ${name}`, { skip: posixOnly }, () => {
    const r = rig();
    assert.equal(run(r, line(r), "powershell"), undefined, line(r));
  });
}

test("a ruling in a dir where the session is the parent is no refusal for any kind", { skip: posixOnly }, () => {
  const r = rig();
  const other = path.join(r.root, ".workflow", "handoffs", "down");
  fs.mkdirSync(other, { recursive: true });
  for (const line of [`echo x > ${other}/ruling.md`, `curl -o ${other}/ruling.md http://example.com/x`, `git log --output=${other}/ruling.md`]) assert.equal(run(r, line), undefined, line);
});

test("shellWriteTargets: long git output options, downloads and git config --file name a target; a short git -o does not", () => {
  const paths = (line: string): string[] => shellWriteTargets(parseShell(line, { cwd: "/w" }), "linux").map((t) => t.path);
  assert.deepEqual(paths("git log --output=/w/a"), ["/w/a"]);
  assert.deepEqual(paths("git diff --output /w/b"), ["/w/b"]);
  assert.deepEqual(paths("git format-patch --output-directory=/w/d HEAD~1"), ["/w/d"]);
  assert.ok(paths("git config --file /w/c a.b c").includes("/w/c"));
  assert.deepEqual(paths("git log -o /w/e"), []);
  assert.deepEqual(paths("git ls-files -o"), []);
  assert.deepEqual(paths("curl -o /w/f http://example.com/x"), ["/w/f"]);
  assert.deepEqual(paths("curl -sSo /w/g http://example.com/x"), ["/w/g"]);
  assert.deepEqual(paths("wget -O /w/h http://example.com/x"), ["/w/h"]);
  assert.deepEqual(paths("wget -q -O - http://example.com/x"), []);
  assert.deepEqual(paths("curl http://example.com/x"), []);
});

test("unresolvedWriteWords: a variable, substitution, backtick or brace word in a write position; not $FOREMAN_SCRATCH, not a read", () => {
  const words = (line: string): string[] => unresolvedWriteWords(parseShell(line, { cwd: "/w" }));
  assert.equal(words('echo x > "$X"').length, 1);
  assert.deepEqual(words("cp a $D/b"), ["$D/b"]);
  assert.equal(words("echo x > `pwd`/f").length, 1);
  assert.equal(words("echo x > $(pwd)/f").length, 1);
  assert.equal(words("echo x > f{,-1}").length, 1);
  assert.deepEqual(words("echo x > $FOREMAN_SCRATCH/f"), []);
  assert.deepEqual(words("echo x > ${FOREMAN_SCRATCH}/f"), []);
  assert.deepEqual(words("cat $X"), []);
  assert.deepEqual(words("echo x > /w/f"), []);
});

// Round 2, step 2a revision: mode writers, brace names with the cwd in the handoff dir, and the stdin-fed text bounded to its own command.
const MODE_REFUSED: Row[] = [
  ["chmod", (r) => `chmod 600 ${r.H}/ruling.md`],
  ["chmod -R on a brief", (r) => `chmod -R 444 ${r.H}/brief-a.md`],
  ["chown", (r) => `chown me ${r.H}/ruling.md`],
  ["chgrp", (r) => `chgrp staff ${r.H}/ruling-1.md`],
  ["chmod --reference= naming the ruling (the old layer counted the value as a target)", (r) => `chmod --reference=${r.H}/ruling.md x`],
];

for (const [name, line] of MODE_REFUSED) {
  for (const cd of [false, true]) {
    test(`refused: ${name}${cd ? " behind cd" : ""}`, { skip: posixOnly }, () => {
      const r = rig();
      const l = line(r);
      assert.equal(run(r, cd ? `cd ${r.H} && ${l.replaceAll(`${r.H}/`, "")}` : l), SELF_RULING_REASON, l);
    });
  }
}

test("refused: a copier with a target directory reads its operands too (cwd in the handoff dir); a PowerShell colon parameter names the file", { skip: posixOnly }, () => {
  const r = rig();
  assert.equal(run(r, `cp -t ${r.S} ruling.md`, "bash", r.H), SELF_RULING_REASON);
  assert.equal(run(r, `Set-Content -Path:${r.H}/ruling.md -Value x`, "powershell"), SELF_RULING_REASON);
});

test("not refused: chmod, chown and chgrp of another file", { skip: posixOnly }, () => {
  const r = rig();
  for (const line of [`chmod 600 ${r.H}/notes.md`, `chown me ${r.H}/plan.md`, `chmod 600 ${r.S}/ruling.md`, `chmod --reference=${r.H}/notes.md x`]) assert.equal(run(r, line), undefined, line);
});

const BRACE_LINES = ["echo x > ruling{,-1}.md", "echo x > rul{ing,e}.md", "touch ruling{,-1}.md", "chmod 444 ruling.md"];

for (const line of BRACE_LINES) {
  test(`refused with the cwd in the handoff dir: ${line}`, { skip: posixOnly }, () => {
    const r = rig();
    assert.equal(run(r, line, "bash", r.H), SELF_RULING_REASON, line);
  });
  test(`refused behind cd from another cwd: ${line}`, { skip: posixOnly }, () => {
    const r = rig();
    assert.equal(run(r, `cd ${r.H} && ${line}`), SELF_RULING_REASON, line);
  });
}

test("not refused: a brace list of other names with the cwd in the handoff dir (behind cd the line names the dir beside an unresolved word: the variable clause refuses it)", { skip: posixOnly }, () => {
  const r = rig();
  assert.equal(run(r, "echo x > note{,-1}.md", "bash", r.H), undefined);
});

test("a stdin-fed segment's text ends at its terminator: a read after it is no refusal, its body naming the ruling and a write after it are", { skip: posixOnly }, () => {
  const r = rig();
  assert.equal(run(r, `python3 - <<'EOF'\nprint(1)\nEOF\ncat ${r.H}/ruling.md`), undefined);
  assert.equal(run(r, `python3 - <<'EOF'\nprint(1)\nEOF\ngrep x ${r.H}/ruling.md; echo done`), undefined);
  assert.equal(run(r, `python3 - <<'EOF'\nopen('${r.H}/ruling.md','w').write('x')\nEOF\ncat y`), SELF_RULING_REASON);
  assert.equal(run(r, `python3 - <<'EOF'\nprint(1)\nEOF\ncp /tmp/x ${r.H}/ruling.md`), SELF_RULING_REASON);
});

// Round 2, step 2a, second revision: every text the check reads is judged by its literal path and by its words resolved against the cwd of the segment.
// Each line runs with the cwd in the handoff dir, in a subfolder of it (`work`, `../name`), and from the repo root behind `cd <H> &&`.
const cwdsOf = (r: Rig, line: string): Array<[string, string]> => [
  [`in H: ${line}`, run(r, line, "bash", r.H) ?? ""],
  [`behind cd: ${line}`, run(r, `cd ${r.H} && ${line}`) ?? ""],
];

const CWD_REFUSED: Array<[string, string]> = [
  ["D1 python -c write", `python3 -c "open('ruling.md','w')"`],
  ["D1 python -c ./name", `python3 -c "open('./ruling.md','w')"`],
  ["D1 python -c brief", `python3 -c "open('brief-a.md','w')"`],
  ["D1 python -c pure read (the old layer refused a read of the name in inline code)", `python3 -c "print(open('ruling.md').read())"`],
  ["D1 python -c joined literals", `python3 -c "open('rul'+'ing.md','w')"`],
  ["D1 node -e", `node -e "require('fs').writeFileSync('ruling.md','x')"`],
  ["D1 bash -c python -c", `bash -c "python3 -c \\"open('ruling.md','w')\\""`],
  ["D1 stdin-fed python", `python3 - <<EOF\nopen('ruling.md','w').write('x')\nEOF`],
  ["D2 bash heredoc", `bash <<EOF\ncat > ruling.md\nEOF`],
  ["D2 sh heredoc", `sh <<EOF\necho x > ruling.md\nEOF`],
  ["D2 sh -s heredoc", `sh -s <<EOF\ntouch brief-a.md\nEOF`],
  ["D2 zsh heredoc", `zsh <<EOF\ncat > ruling.md\nEOF`],
  ["D2 bash -s heredoc rm", `bash -s <<EOF\nrm ruling.md\nEOF`],
  ["D2 here-string", `bash <<< "echo x > ruling.md"`],
  ["D2 body with a cd of its own", `bash <<EOF\ncd .\nchmod 600 ruling.md\nEOF`],
  ["D3 range letters", "echo x > brief-{a..c}.md"],
  ["D3 range numbers", "echo x > ruling-{1..3}.md"],
  ["D3 range brief numbers", "echo x > brief-{1..2}.md"],
  ["D3 range touch", "touch brief-{a..b}.md"],
  ["D3 range cp", "cp a brief-{a..b}.md"],
  ["D3 range reversed", "echo x > ruling-{3..1}.md"],
  ["D3 range inside a comma list", "echo x > ruling{,-{1..2}}.md"],
  ["-t: the last operand is the old layer's target", `cp -t ${"/tmp"} ruling.md`],
  ["a copy into the dir: <dir>/<name of the operand>", `cp /tmp/ruling.md .`],
];

for (const [name, line] of CWD_REFUSED) {
  test(`refused (cwd in the handoff dir, behind cd): ${name}`, { skip: posixOnly }, () => {
    const r = rig();
    for (const [label, got] of cwdsOf(r, line)) assert.equal(got, SELF_RULING_REASON, label);
  });
}

const CWD_NOT_REFUSED: Array<[string, string]> = [
  ["D1 python -c of another file", `python3 -c "open('notes.md','w')"`],
  ["D1 node -e of another file", `node -e "require('fs').writeFileSync('plan.md','x')"`],
  ["D2 bash heredoc that writes another file", `bash <<EOF\necho x > notes.md\nEOF`],
  ["D2 bash heredoc that only reads the ruling", `bash <<EOF\ncat ruling.md\nEOF`],
  ["D2 here-string that only reads the ruling", `bash <<< "grep x ruling.md"`],
  ["D2 body whose write is elsewhere", `bash <<EOF\ncat ruling.md > /tmp/q\nEOF`],
  ["D3 range of other names (no variable clause: no dir word, no ruling name)", "echo x > note-{1..3}.md"],
  ["-t: a copy source is a read", `cp -t /tmp x ruling-9.ack`],
];

for (const [name, line] of CWD_NOT_REFUSED) {
  test(`not refused with the cwd in the handoff dir: ${name}`, { skip: posixOnly }, () => {
    const r = rig();
    assert.equal(run(r, line, "bash", r.H), undefined, line);
  });
}

test("not refused: inline code that only prints a ruling name from a cwd outside the handoff dir, with no handoff dir on the line", { skip: posixOnly }, () => {
  const r = rig();
  for (const line of [`python3 -c "print('ruling.md')"`, `python3 -c "open('ruling.md').read()"`, `bash <<EOF\ncat > ruling.md\nEOF`, "echo x > brief-{a..c}.md"]) assert.equal(run(r, line, "bash", r.S), undefined, line);
});

test("D2/D3 from a subfolder of the handoff dir: ../name and a range of ../name", { skip: posixOnly }, () => {
  const r = rig();
  const work = path.join(r.H, "work");
  fs.mkdirSync(work, { recursive: true });
  for (const line of ["echo x > ../ruling.md", `python3 -c "open('../ruling.md','w')"`, `sh <<EOF\necho x > ../ruling.md\nEOF`, "echo x > ../brief-{a..c}.md", "cp a ../brief-{a..b}.md"]) assert.equal(run(r, line, "bash", work), SELF_RULING_REASON, line);
  assert.equal(run(r, `cd ${r.H} && echo x > ../ruling.md`, "bash", work), SELF_RULING_REASON, "the old layer resolved a relative word against the cwd the line started in, cd or not");
  for (const line of ["echo x > ../notes.md", `sh <<EOF\ncat ../ruling.md\nEOF`, "echo x > ../note-{1..3}.md"]) assert.equal(run(r, line, "bash", work), undefined, line);
});

test("-t forms: the destination directory plus the operand's name; a source is no write word", { skip: posixOnly }, () => {
  const r = rig();
  for (const line of [`cp -t ${r.H} /tmp/ruling.md`, `cp --target-directory=${r.H} /tmp/brief-a.md`, `mv -t ${r.H} /tmp/ruling-1.md`, `install -t ${r.H} /tmp/ruling.md`, `ln -s -t ${r.H} /tmp/ruling.md`]) assert.equal(run(r, line), SELF_RULING_REASON, line);
  for (const line of [`cp -t ${r.H} /tmp/notes.md`, `cp -t ${r.S} ${r.H}/ruling.md x`, `cp --target-directory ${r.S} ${r.H}/ruling.md /tmp/x`]) assert.equal(run(r, line), undefined, line);
  assert.equal(run(r, `cp -t ${r.S} ${r.H}/ruling.md`), SELF_RULING_REASON, "the last operand stays a target, as the old layer read it");
});

test("D4: a heredoc on a compound command owns the compound and its body, not the lines after it", { skip: posixOnly }, () => {
  const r = rig();
  const compounds = ["{ python3 -; }", "while read l; do python3 -; done", "if true; then python3 -; fi"];
  for (const c of compounds) {
    assert.equal(run(r, `${c} <<EOF\nprint(1)\nEOF\ncat ${r.H}/ruling.md`), undefined, `${c}: a read after it`);
    assert.equal(run(r, `${c} <<EOF\nprint(1)\nEOF\ncat ruling.md`, "bash", r.H), undefined, `${c}: a read after it, cwd in the dir`);
    assert.equal(run(r, `${c} <<EOF\nopen('${r.H}/ruling.md','w')\nEOF\ncat y`), SELF_RULING_REASON, `${c}: its body names the file`);
    assert.equal(run(r, `${c} <<EOF\nopen('ruling.md','w')\nEOF\ncat y`, "bash", r.H), SELF_RULING_REASON, `${c}: its body names the file by a relative name`);
    assert.equal(run(r, `${c} <<EOF\nprint(1)\nEOF\necho x > ${r.H}/ruling.md`), SELF_RULING_REASON, `${c}: a write after it`);
  }
});

// Round 2, step 2a, third revision: E1 a stdin-fed program behind a wrapper, E2 constructs the parse hands over opaque with no inner segments,
// E3 the nesting cap, E4 the cap on literals and on joined literals.
const WRAPPERS = ["env ", "env -i ", "env A=1 ", "command ", "nice ", "nice -n 5 ", "timeout 5 ", "nohup ", "xargs ", "time ", "stdbuf -o0 ", "/usr/bin/env "];

for (const w of WRAPPERS) {
  test(`E1 refused behind '${w.trim()}': a stdin-fed shell or interpreter whose text writes the ruling`, { skip: posixOnly }, () => {
    const r = rig();
    for (const sh of ["sh", "bash"]) {
      assert.equal(run(r, `${w}${sh} <<EOF\necho x > ${r.H}/ruling.md\nEOF`), SELF_RULING_REASON, `${sh} heredoc, full path`);
      assert.equal(run(r, `${w}${sh} <<EOF\necho x > ruling.md\nEOF`, "bash", r.H), SELF_RULING_REASON, `${sh} heredoc, relative, cwd in the dir`);
      assert.equal(run(r, `${w}${sh} -s <<EOF\ncat > ruling.md\nEOF`, "bash", r.H), SELF_RULING_REASON, `${sh} -s heredoc`);
      assert.equal(run(r, `${w}${sh} <<< "echo x > ruling.md"`, "bash", r.H), SELF_RULING_REASON, `${sh} here-string`);
    }
    assert.equal(run(r, `${w}python3 - <<EOF\nopen('${r.H}/ruling.md','w')\nEOF`), SELF_RULING_REASON, "python3 heredoc, full path");
    assert.equal(run(r, `${w}python3 - <<EOF\nopen('ruling.md','w')\nEOF`, "bash", r.H), SELF_RULING_REASON, "python3 heredoc, relative");
  });
  test(`E1 not refused behind '${w.trim()}': the body reads the ruling, or writes another file`, { skip: posixOnly }, () => {
    const r = rig();
    assert.equal(run(r, `${w}sh <<EOF\ncat ruling.md\nEOF`, "bash", r.H), undefined, "a read");
    assert.equal(run(r, `${w}sh <<EOF\necho x > notes.md\nEOF`, "bash", r.H), undefined, "another file");
    assert.equal(run(r, `${w}sh <<EOF\necho x > ruling.md\nEOF`, "bash", r.S), undefined, "a ruling name in another cwd");
  });
}

const FUNCTIONS = [
  (b: string) => `f() { ${b}; }`,
  (b: string) => `f () ( ${b} )`,
  (b: string) => `function f { ${b}; }`,
  (b: string) => `function f() { ${b}; }`,
  (b: string) => `f() {\n  ${b}\n}`,
  (b: string) => `f() { g() { ${b}; }; g; }`,
  (b: string) => `f() { sh <<EOF\n${b}\nEOF\n}`,
];

for (const [i, def] of FUNCTIONS.entries()) {
  for (const call of ["", "; f", "; f <<EOF\nx\nEOF"]) {
    test(`E2 function form ${i}${call ? " with a call" : ""}: a write of the ruling is refused, another file is not`, { skip: posixOnly }, () => {
      const r = rig();
      assert.equal(run(r, def(`cat > ${r.H}/ruling.md`) + call), SELF_RULING_REASON, "full path");
      assert.equal(run(r, def(`tee ${r.H}/brief-a.md`) + call), SELF_RULING_REASON, "full path, brief");
      assert.equal(run(r, def("echo x > ruling.md") + call, "bash", r.H), SELF_RULING_REASON, "relative name, cwd in the dir");
      assert.equal(run(r, `cd ${r.H} && ` + def("echo x > ruling.md") + call), SELF_RULING_REASON, "relative name behind cd");
      assert.equal(run(r, def("echo x > notes.md") + call, "bash", r.H), undefined, "another file");
      assert.equal(run(r, def("echo x > ruling.md") + call, "bash", r.S), undefined, "a ruling name in another cwd");
      assert.equal(run(r, def(`echo x > ${r.S}/n.md`) + call), undefined, "a write elsewhere");
    });
  }
}

// the opaque kinds of shellast.ts whose body the check parses again for its write words: select, coproc and the arithmetic for (a function is in FUNCTIONS above).
const OPAQUE_WRITES: Array<[string, (b: string) => string]> = [
  ["select", (b) => `select v in a b; do ${b}; break; done`],
  ["coproc braces", (b) => `coproc { ${b}; }`],
  ["coproc named", (b) => `coproc NAME { ${b}; }`],
  ["coproc simple", (b) => `coproc ${b}`],
  ["arithmetic for", (b) => `for ((i=0;i<1;i++)); do ${b}; done`],
];

for (const [name, wrap] of OPAQUE_WRITES) {
  test(`E2 opaque kind ${name}: a write of the ruling is refused (full path, relative with the cwd in the dir); a write of another file is not`, { skip: posixOnly }, () => {
    const r = rig();
    assert.equal(run(r, wrap(`echo x > ${r.H}/ruling.md`)), SELF_RULING_REASON, "full path");
    assert.equal(run(r, wrap("echo x > ruling.md"), "bash", r.H), SELF_RULING_REASON, "relative");
    assert.equal(run(r, wrap("echo x > notes.md"), "bash", r.H), undefined, "another file");
    assert.equal(run(r, wrap("echo x > ruling.md"), "bash", r.S), undefined, "a ruling name in another cwd");
  });
}

// F3: an opaque construct is judged by its write words only; a read of the ruling in it, by its full path or its name, is no refusal.
test("F3 a read inside an opaque construct is no refusal; a write in it is", { skip: posixOnly }, () => {
  const r = rig();
  const H = r.H;
  const reads = [
    `[[ -f ${H}/ruling.md ]] && cat ${H}/ruling.md`,
    `[[ -f ${H}/ruling.md ]] || echo none`,
    `if [[ -s ${H}/ruling.md ]]; then head ${H}/ruling.md; fi`,
    `[[ $(head -1 ${H}/ruling.md) == APPROVED ]] && echo ok`,
    `(( n = $(wc -l < ${H}/ruling.md) ))`,
    `f() { cat ${H}/ruling.md; }; f`,
    `for ((i=0;i<1;i++)); do cat ${H}/ruling.md; done`,
    `trap 'cat ${H}/ruling.md' EXIT`,
    `[[ -f ${H}/ruling.md ]] && cp ${H}/ruling.md ${r.S}/r.md`,
  ];
  for (const line of reads) {
    assert.equal(run(r, line), undefined, line);
    assert.equal(run(r, line, "bash", H), undefined, `${line} (cwd in the dir)`);
    assert.equal(run(r, line, "bash", path.join(H, "work")), undefined, `${line} (cwd below the dir)`);
  }
  assert.equal(run(r, `f() { cat ruling.md; }`, "bash", H), undefined, "a function body that reads the ruling by name");
  assert.equal(run(r, `[[ -f ruling.md ]]`, "bash", H), undefined, "a test of the ruling name");
  for (const line of [`f() { cat > ${H}/ruling.md; }; f`, `[[ -f x ]] && echo y > ${H}/ruling.md`, `for ((i=0;i<1;i++)); do echo x > ${H}/brief-a.md; done`]) assert.equal(run(r, line), SELF_RULING_REASON, line);
  assert.equal(run(r, `f() { cat notes.md; }; cat ${H}/ruling.md`), undefined, "the read after the function");
});

// F1: the literal path is judged on every heredoc and here-string text, whatever program it feeds (a program the gate's parse does not model).
test("F1 a heredoc or here-string that names the ruling by its full path is refused whatever it feeds", { skip: posixOnly }, () => {
  const r = rig();
  const feeds = ["busybox sh", "busybox ash", "toybox sh", "chroot / sh", "ionice -c3 sh", "unshare sh", "caffeinate sh", "script -q /dev/null sh", "ssh localhost", "git -C . sh", "tclsh"];
  for (const f of feeds) {
    assert.equal(run(r, `${f} <<EOF\necho x > ${r.H}/ruling.md\nEOF`), SELF_RULING_REASON, f);
    assert.equal(run(r, `${f} <<< "echo x > ${r.H}/brief-a.md"`), SELF_RULING_REASON, `${f} here-string`);
    assert.equal(run(r, `${f} <<EOF > ${r.H}/ruling.md\nx\nEOF`), SELF_RULING_REASON, `${f} redirect on the heredoc line`);
    assert.equal(run(r, `${f} <<EOF\necho x > ${r.S}/n.md\nEOF`), undefined, `${f} writing elsewhere`);
  }
  assert.equal(run(r, `cat <<EOF\nsee ${r.H}/ruling.md\nEOF`), SELF_RULING_REASON, "a heredoc body that only names the ruling by full path (a read) is refused too");
  assert.equal(run(r, `cat <<EOF\nsee ruling.md\nEOF`, "bash", r.H), undefined, "a relative name in a heredoc that feeds no shell or interpreter");
});

// F2: one whole-run join of the literals of inline code.
test("F2 a name joined from a long run of literals is still read", { skip: posixOnly }, () => {
  const r = rig();
  const pieces = (name: string): string => [...name].map((c) => `'${c}'`).join("+");
  for (const name of ["ruling.md", "brief-a.md"]) {
    assert.equal(run(r, `python3 -c "open(${pieces(name)},'w')"`, "bash", r.H), SELF_RULING_REASON, `${name} in ${name.length} pieces`);
  }
  assert.equal(run(r, `python3 -c "open(${pieces("notes.md")},'w')"`, "bash", r.H), undefined, "another file");
});

// F4/F5: each text takes its own fed segment; a line of many fed heredocs is judged in one pass.
test("F4 many fed heredocs on one line: the one that writes the ruling is found, the rest do not cost a cross product", { skip: posixOnly }, () => {
  const r = rig();
  const many = (n: number, last: string): string => Array.from({ length: n }, () => `env sh <<EOF\necho x > notes.md\nEOF`).join("\n") + `\n${last}`;
  const t0 = Date.now();
  assert.equal(run(r, many(1000, "sh <<EOF\necho x > ruling.md\nEOF"), "bash", r.H), SELF_RULING_REASON);
  assert.equal(run(r, many(1000, "sh <<EOF\necho x > notes.md\nEOF"), "bash", r.H), undefined);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});

test("E3 nested heredocs past the nesting cap: refused when the body at the cap names the ruling, not when it names nothing", { skip: posixOnly }, () => {
  const r = rig();
  const nest = (depth: number, body: string): string => {
    let s = body;
    for (let i = depth; i >= 1; i--) s = `bash <<E${i}\n${s}\nE${i}`;
    return s;
  };
  for (let d = 1; d <= 8; d++) {
    assert.equal(run(r, nest(d, "echo x > ruling.md"), "bash", r.H), SELF_RULING_REASON, `depth ${d}, relative`);
    assert.equal(run(r, nest(d, `echo x > ${r.H}/ruling.md`)), SELF_RULING_REASON, `depth ${d}, full path`);
    assert.equal(run(r, nest(d, "echo x > notes.md"), "bash", r.H), undefined, `depth ${d}, another file`);
    assert.equal(run(r, nest(d, "echo x > ruling.md"), "bash", r.S), undefined, `depth ${d}, another cwd`);
  }
});

const LITERALS = (n: number, tail: string): string => Array.from({ length: n }, (_, i) => `'a${i}'`).join(" + ") + tail;

test("E4 a text over the literal cap is refused only when it names a child dir or a ruling name literally", { skip: posixOnly }, () => {
  const r = rig();
  for (const n of [300, 2000]) {
    assert.equal(run(r, `python3 -c "${LITERALS(n, "")}"`, "bash", r.H), undefined, `${n} literals, nothing named`);
    assert.equal(run(r, `python3 -c "${LITERALS(n, " + 'notes.md'")}"`, "bash", r.H), undefined, `${n} literals, another file`);
    assert.equal(run(r, `python3 -c "${LITERALS(n, " + 'ruling.md'")}"`, "bash", r.S), SELF_RULING_REASON, `${n} literals, a ruling name`);
    assert.equal(run(r, `python3 -c "${LITERALS(n, ` + '${r.H}/x'`)}"`, "bash", r.S), SELF_RULING_REASON, `${n} literals, the dir`);
    assert.equal(run(r, `python3 - <<EOF\n${LITERALS(n, " + 'ruling.md'")}\nEOF`, "bash", r.S), SELF_RULING_REASON, `${n} literals in a heredoc`);
  }
});

test("E4 under the literal cap the words still resolve; a run of eight joined literals still spells the name", { skip: posixOnly }, () => {
  const r = rig();
  assert.equal(run(r, `python3 -c "${LITERALS(100, " + 'ruling.md'")}"`, "bash", r.H), SELF_RULING_REASON, "100 literals, a relative name, cwd in the dir");
  assert.equal(run(r, `python3 -c "'r'+'u'+'l'+'i'+'n'+'g'+'.m'+'d'"`, "bash", r.H), SELF_RULING_REASON, "eight joined literals");
});

// Round 2, step 2a, fifth revision: a heredoc in an arithmetic for is read whatever the parse shows; brace words are expanded within a budget, code text is not.
test("D2 a heredoc inside an arithmetic for: the full path is refused; a read of the relative name in the loop is not", { skip: posixOnly }, () => {
  const r = rig();
  for (const name of ["ruling.md", "brief-a.md"]) {
    const loop = (inner: string): string => `for ((i=0;i<1;i++)); do ${inner}\ndone`;
    assert.equal(run(r, loop(`sh <<'EOF'\necho x > ${r.H}/${name}\nEOF`)), SELF_RULING_REASON, `sh, ${name}`);
    assert.equal(run(r, loop(`cat <<EOF\n${r.H}/${name}\nEOF`)), SELF_RULING_REASON, `cat, ${name}`);
    assert.equal(run(r, loop(`cat ${name}`), "bash", r.H), undefined, `read, ${name}`);
  }
});

const BRIEF_REFUSED: Array<[string, string, "root" | "H"]> = [
  ["sed -i", "sed -i s/a/b/ brief-a.md", "H"],
  ["download output (data string)", "curl -o brief-a.md http://example.com/x", "H"],
  ["git --output", "git log --output=brief-a.md", "H"],
  ["cd, then a relative write", "cd <H> && echo x > brief-a.md", "root"],
  ["a bound variable", "D=<H>; echo x > $D/brief-a.md", "root"],
  ["the variable clause", "echo x > $X/brief-a.md", "root"],
];

for (const [name, line, at] of BRIEF_REFUSED) {
  test(`brief name, refused: ${name}`, { skip: posixOnly }, () => {
    const r = rig();
    assert.equal(run(r, line.replaceAll("<H>", r.H), "bash", at === "H" ? r.H : r.root), SELF_RULING_REASON, line);
  });
}

test("brief name, not refused: a read, and a write of another file, with the cwd in the handoff dir", { skip: posixOnly }, () => {
  const r = rig();
  for (const line of ["sed -n p brief-a.md", "curl -o notes.md http://example.com/x", "git log --output=notes.md"]) assert.equal(run(r, line, "bash", r.H), undefined, line);
});

test("D1 expansion cost: lines with many brace words and brace words in code text are answered", { skip: posixOnly }, () => {
  const r = rig();
  const cp = `cp -t d{1..64} ${Array.from({ length: 200 }, () => "a{1..64}").join(" ")}`;
  assert.equal(run(r, cp, "bash", r.S), undefined);
  const lits = Array.from({ length: 250 }, (_, i) => `'${"x".repeat(100)}{1..9}${i}'`).join(" + ");
  assert.equal(run(r, `python3 -c "${lits}"`, "bash", r.H), undefined);
  assert.equal(run(r, `python3 -c "${lits} + 'ruling.md'"`, "bash", r.H), SELF_RULING_REASON);
  assert.equal(run(r, Array.from({ length: 50 }, () => "echo x > n{1..9}{a..z}.md").join("\n"), "bash", r.S), undefined);
});

// one budget per top-level call: a brace word past it is not expanded and counts as unresolved
test("D4 over the budget: a brace word is refused by its literal text, its cwd, or the names on the line", { skip: posixOnly }, () => {
  const r = rig();
  const burn = (cmd: string): string => Array.from({ length: 5 }, () => cmd).join("\n");
  assert.equal(run(r, `${burn("chmod 600 a{1..64}")}\nchmod 444 ${r.H}/r{u,x}ling.md`, "bash", r.root), SELF_RULING_REASON);
  assert.equal(run(r, `${burn("echo x > n{1..64}.md")}\necho x > rul{ing,x}.md`, "bash", r.H), SELF_RULING_REASON);
  assert.equal(run(r, Array.from({ length: 300 }, (_, i) => `echo x > w{1..2}${i}.md`).join("\n"), "bash", r.S), undefined);
  assert.equal(run(r, Array.from({ length: 300 }, (_, i) => `chmod 600 w{a,b}${i}`).join("\n"), "bash", r.S), undefined);
});

const BODY = (kind: string, inner: string): string =>
  kind === "for" ? `for ((i=0;i<1;i++)); do ${inner}\ndone` : `select x in a b; do ${inner}\ndone`;

for (const kind of ["for", "select"]) {
  for (const name of ["ruling.md", "brief-a.md"]) {
    for (const [sh, at] of [["sh", "H"], ["bash", "H"], ["python3 -", "H"], ["sh", "work"]]) {
      test(`D2b ${kind}: a relative write in a heredoc (${sh}, ${name}, cwd ${at}), refused`, { skip: posixOnly }, () => {
        const r = rig();
        const rel = at === "work" ? `../${name}` : name;
        const body = sh === "python3 -" ? `open('${rel}','w')` : `echo x > ${rel}`;
        const cwd = at === "work" ? path.join(r.H, "work") : r.H;
        assert.equal(run(r, BODY(kind, `${sh} <<'EOF'\n${body}\nEOF`), "bash", cwd), SELF_RULING_REASON);
      });
    }
    test(`D2b ${kind}: a read in a heredoc (${name}) is no refusal`, { skip: posixOnly }, () => {
      const r = rig();
      assert.equal(run(r, BODY(kind, `sh <<'EOF'\ncat ${name}\nEOF`), "bash", r.H), undefined);
    });
  }
}

// D2c: the brace body form of select and arithmetic for
const BRACE_BODY = (kind: string, inner: string): string =>
  kind === "for" ? `for ((i=0;i<1;i++)) { ${inner}\n}` : `select v in a; { ${inner}\n}`;

for (const kind of ["for", "select"]) {
  for (const name of ["ruling.md", "brief-a.md"]) {
    for (const sh of ["sh", "bash"]) {
      for (const at of ["H", "work"]) {
        test(`D2c ${kind} brace body: a relative write in a heredoc (${sh}, ${name}, cwd ${at}), refused`, { skip: posixOnly }, () => {
          const r = rig();
          const rel = at === "work" ? `../${name}` : name;
          const cwd = at === "work" ? path.join(r.H, "work") : r.H;
          assert.equal(run(r, BRACE_BODY(kind, `${sh} <<'EOF'\necho x > ${rel}\nEOF`), "bash", cwd), SELF_RULING_REASON);
        });
      }
    }
    test(`D2c ${kind} brace body: a read in a heredoc (${name}) is no refusal`, { skip: posixOnly }, () => {
      const r = rig();
      assert.equal(run(r, BRACE_BODY(kind, `sh <<'EOF'\ncat ${name}\nEOF`), "bash", r.H), undefined);
    });
  }
}

// D5: past the budget, a mode-program word is resolved against the cwd of the segment and of the line
for (const prog of ["chmod 444", "chown me", "chgrp staff"]) {
  for (const name of ["r{u,x}ling.md", "br{i,x}ef-a.md"]) {
    test(`D5 over the budget: ${prog} ../${name} from <H>/work, refused; from scratch, not`, { skip: posixOnly }, () => {
      const r = rig();
      const burn = Array.from({ length: 5 }, () => "chmod 600 a{1..64}").join("\n");
      assert.equal(run(r, `${burn}\n${prog} ../${name}`, "bash", path.join(r.H, "work")), SELF_RULING_REASON);
      assert.equal(run(r, `${burn}\n${prog} ../${name}`, "bash", r.S), undefined);
    });
  }
}
