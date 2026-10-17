// R8 item 12 (revision): the narrowed self-ruling guard still refuses nested shells, and never refuses less than the 0a8b2bc guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { isRulingName, selfRulingRefusal, selfRulingTarget } from "../ruling.ts";

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r8nest-")));
  const up = path.join(root, "handoffs", "up");
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, "child"), "me\n");
  return { root, up, dirs: childHandoffDirs(path.join(root, "handoffs"), "me") };
}

// ---- frozen copy of the guard from commit 0a8b2bc (bash branch only) ----
const OLD_READ = new Set(["cat", "head", "tail", "ls", "grep", "egrep", "fgrep", "rg", "wc", "stat", "file", "nl", "realpath", "sort", "uniq", "cut", "tr", "cd"]);
const OLD_ONLY_MATCHING = new Set(["grep", "egrep", "fgrep", "rg", "ls"]);
function oldPureRead(command: string): boolean {
  if (/[`>&]|\$\(|<\(|\$\{/.test(command.replace(/&&/g, ";"))) return false;
  const parts = command.split(/&&|\|\||;|\||\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => {
    const w = p.split(/\s+/);
    if (!OLD_READ.has(w[0])) return false;
    if (w[0] === "uniq" && w.slice(1).some((x) => !x.startsWith("-"))) return false;
    if (w[0] === "sort" && w.some((x) => /^-[^-]*[oT]|^--(output|compress-program|temporary)/.test(x))) return false;
    return OLD_ONLY_MATCHING.has(w[0]) || !w.some((x) => /^--?o(utput)?\b/.test(x));
  });
}
const oldRealKey = (p: string): string => {
  try { return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)); } catch { return path.resolve(p); }
};
function oldRefuses(command: string, cwd: string, childDirs: string[]): boolean {
  const dirs = new Set(childDirs.map((d) => path.dirname(oldRealKey(path.join(d, "x")))));
  const inChild = (p: string): boolean => isRulingName(path.basename(p)) && dirs.has(path.dirname(oldRealKey(path.resolve(cwd, p))));
  if (!command || oldPureRead(command)) return false;
  const words = command.split(/[\s;&|<>()]+/).filter(Boolean).map((w) => w.replace(/^['"]+|['"]+$/g, ""));
  const named = words.filter((w) => /ruling/.test(w));
  const dynamic = words.some((w) => /[*?[$]/.test(w));
  const mentionsDir = [...childDirs, ...dirs].some((d) => command.includes(d));
  const moves = /\b(cd|pushd|Set-Location)\b/.test(command);
  if (named.some(inChild)) return true;
  if (named.length > 0 && (mentionsDir || moves || dynamic)) return true;
  return dynamic && (mentionsDir || moves);
}

const newRefuses = (command: string, r: ReturnType<typeof rig>): boolean => selfRulingRefusal("bash", { command }, r.root, r.dirs) !== undefined;

test("nested shell writes of a ruling file are refused (sh/bash/zsh/dash/eval/xargs/env/command/nohup/exec/pwsh)", () => {
  const r = rig();
  const f = ".workflow/handoffs/up/ruling.md";
  const h = r.up;
  const cases = [
    `sh -c "echo A > ${h}/ruling.md"`,
    `bash -c 'echo A > ${h}/ruling.md'`,
    `bash -lc 'echo A > ${h}/ruling-2.md'`,
    `zsh -c "echo A > ${h}/ruling.md"`,
    `dash -c "echo A > ${h}/ruling.md"`,
    `eval "echo A > ${h}/ruling.md"`,
    `eval echo A \\> ${h}/ruling.md`,
    `echo x | xargs sh -c 'echo A > ${h}/ruling.md'`,
    `env sh -c "echo A > ${h}/ruling.md"`,
    `env FOO=1 bash -c "echo A > ${h}/ruling.md"`,
    `command sh -c "echo A > ${h}/ruling.md"`,
    `nohup sh -c "echo A > ${h}/ruling.md"`,
    `exec sh -c "echo A > ${h}/ruling.md"`,
    `sudo -E sh -c "echo A > ${h}/ruling.md"`,
    `pwsh -c "echo A > ${h}/ruling.md"`,
    `powershell -Command "echo A > ${h}/ruling.md"`,
    `sh -c "sh -c 'echo A > ${h}/ruling.md'"`,
    `sh -c "cat x | tee ${h}/ruling.md"`,
    `sh -c "cp x ${h}/ruling.md"`,
  ];
  for (const command of cases) assert.ok(newRefuses(command, r), command);
  // relative path, run from inside the handoff dir
  assert.ok(selfRulingRefusal("bash", { command: `sh -c "echo A > ruling.md"` }, h, r.dirs) !== undefined, "relative inside dir");
  assert.ok(selfRulingRefusal("bash", { command: `sh -c "cd ${h} && echo A > ruling.md"` }, r.root, r.dirs) !== undefined, "cd inside script");
  void f;
});

test("an unparseable inner script is refused when any word names a ruling file or the handoff dir", () => {
  const r = rig();
  const h = r.up;
  for (const command of [
    `sh -c "echo A > \\$(echo ${h}/ruling.md)"`,
    `bash -c 'echo "A > ${h}/ruling.md'`,
    `sh -c "echo \`echo A\` > ${h}/x" ruling.md`,
    `sh -c 'echo $(date) > ${h}/anything'`,
  ]) assert.ok(newRefuses(command, r), command);
  assert.equal(newRefuses(`sh -c 'echo $(date) > scratch/x'`, r), false, "unparseable but unrelated passes");
});

test("a ~/ ruling target is expanded against HOME and a ~user/ target is refused", () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r8home-")));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const up = path.join(home, "handoffs", "up");
    fs.mkdirSync(up, { recursive: true });
    fs.writeFileSync(path.join(up, "child"), "me\n");
    const dirs = childHandoffDirs(path.join(home, "handoffs"), "me");
    const elsewhere = fs.realpathSync.native(os.tmpdir());
    assert.ok(selfRulingRefusal("bash", { command: `echo A > ~/handoffs/up/ruling.md` }, elsewhere, dirs) !== undefined, "~/ redirect");
    assert.ok(selfRulingRefusal("bash", { command: `cp x ~/handoffs/up/ruling-3.md` }, elsewhere, dirs) !== undefined, "~/ cp");
    assert.ok(selfRulingRefusal("write", { path: "~/handoffs/up/ruling.md" }, elsewhere, dirs) !== undefined, "~/ write tool");
    assert.ok(selfRulingRefusal("bash", { command: `echo A > ~root/handoffs/up/ruling.md` }, elsewhere, dirs) !== undefined, "~user/");
    assert.equal(selfRulingRefusal("bash", { command: `echo A > ~/other/ruling.md` }, elsewhere, dirs), undefined, "~/ elsewhere passes");
  } finally {
    if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
  }
});

test("new guard refuses every ruling write the 0a8b2bc guard refused (corpus)", () => {
  const r = rig();
  const h = r.up;
  const rel = path.relative(r.root, h);
  const corpus = [
    `echo APPROVED > ${h}/ruling.md`,
    `echo APPROVED >> ${h}/ruling.md`,
    `echo APPROVED >| ${h}/ruling.md`,
    `echo APPROVED &> ${h}/ruling.md`,
    `echo APPROVED 1> ${h}/ruling.md`,
    `cp x ${h}/ruling-2.md`,
    `cp -f x ${h}/ruling.md`,
    `cp -t ${h} ruling.md`,
    `cp ruling.md ${h}/`,
    `mv x ${h}/ruling.md`,
    `install x ${h}/ruling.md`,
    `ln -s x ${h}/ruling.md`,
    `rsync x ${h}/ruling.md`,
    `cat x | tee ${h}/ruling.md`,
    `tee -a ${h}/ruling.md < x`,
    `touch ${h}/ruling.md`,
    `truncate -s 0 ${h}/ruling.md`,
    `dd if=x of=${h}/ruling.md`,
    `sed -i s/a/b/ ${h}/ruling.md`,
    `sed -i.bak s/a/b/ ${h}/ruling.md`,
    `sort x -o ${h}/ruling.md`,
    `sort x --output=${h}/ruling.md`,
    `uniq x ${h}/ruling.md`,
    `printf A > ${h}/ruling.md`,
    `python3 -c "open('${h}/ruling.md','w').write('A')"`,
    `perl -e 'open F, ">${h}/ruling.md"'`,
    `node -e "require('fs').writeFileSync('${h}/ruling.md','A')"`,
    `H=${h}; mv x "$H/ruling.md"`,
    `H=${h}; echo hi > "$H/anything"`,
    `echo hi > ${h}/ru*ng.md`,
    `echo hi > ${h}/ruling*`,
    `echo hi > ${h}/r[u]ling.md`,
    `cd ${h} && echo A > ruling.md`,
    `cd ${h}; touch ruling.md`,
    `pushd ${h}; echo A > ruling-9.md`,
    `cd ${rel} && echo A > ruling.md`,
    `cd ${h}; cp /tmp/x ruling.md`,
    `echo ${h}/ruling.md | xargs touch`,
    `ls ${h}/ruling.md | xargs tee`,
    `find ${h} -name 'ruling*' -exec tee {} \\;`,
    `awk 'BEGIN{print "A" > "${h}/ruling.md"}'`,
    `git checkout x -- ${h}/ruling.md`,
    `git show x:y > ${h}/ruling.md`,
    `Set-Content -Path ${h}/ruling.md -Value A`,
    `Set-Content ${h}\\ruling.md A`,
    `Out-File ${h}/ruling.md`,
    `"A" | Out-File -FilePath ${h}/ruling.md`,
    `echo A > "${h}/ruling.md"`,
    `echo A > '${h}/ruling.md'`,
    `echo A > ${h}//ruling.md`,
    `echo A > ${h}/../up/ruling.md`,
    `echo A >${h}/ruling.md`,
    `(echo A > ${h}/ruling.md)`,
    `{ echo A; } > ${h}/ruling.md`,
    `true && echo A > ${h}/ruling.md`,
    `false || echo A > ${h}/ruling.md`,
    `sh -c "echo A > ${h}/ruling.md"`,
    `bash -c 'echo A > ${h}/ruling.md'`,
    `eval "echo A > ${h}/ruling.md"`,
    `xargs sh -c 'echo A > ${h}/ruling.md'`,
    `env sh -c "echo A > ${h}/ruling.md"`,
    `nohup sh -c "echo A > ${h}/ruling.md" &`,
    `sleep 1; echo A > ${h}/ruling.md`,
    `ruling=${h}/ruling.md; echo A > $ruling`,
    `mkdir -p ${h} && echo A > ${h}/ruling.md`,
    `rm ${h}/ruling.md; echo A > ${h}/ruling.md`,
    `curl -o ${h}/ruling.md http://x`,
    `wget -O ${h}/ruling.md http://x`,
    `chmod 644 ${h}/ruling.md`,
    `gzip -c x > ${h}/ruling.md`,
    `exec 3> ${h}/ruling.md`,
  ];
  let oldRefused = 0;
  const missed: string[] = [];
  for (const command of corpus) {
    if (!oldRefuses(command, r.root, r.dirs)) continue;
    oldRefused++;
    if (!newRefuses(command, r)) missed.push(command);
  }
  assert.ok(oldRefused >= 55, `corpus too weak: old refused only ${oldRefused}`);
  assert.deepEqual(missed, []);
  // same corpus from inside the dir, relative words
  const rels = [`echo A > ruling.md`, `cp x ruling-2.md`, `sh -c "echo A > ruling.md"`, `touch ruling.md`, `mv x ruling.md`, `perl -e 'open F, ">ruling.md"'`, `xargs sh -c 'echo A > ruling.md'`];
  for (const command of rels) {
    if (oldRefuses(command, h, r.dirs)) assert.ok(selfRulingRefusal("bash", { command }, h, r.dirs) !== undefined, command);
  }
});

test("reads, 2>/dev/null, pipes, scratch writes and copies out of the handoff dir still pass", () => {
  const r = rig();
  const h = r.up;
  for (const command of [
    `cat ${h}/ruling.md`,
    `cat ${h}/ruling.md | head -3`,
    `grep foo ${h}/ruling.md 2>/dev/null`,
    `sed -n 1,5p ${h}/ruling.md`,
    `diff ${h}/ruling.md x`,
    `git show HEAD:${h}/ruling.md`,
    `cp ${h}/ruling.md .workflow/scratch/`,
    `cp ${h}/ruling-2.md .workflow/scratch/r.md`,
    `grep foo ${h}/ruling.md > .workflow/scratch/x.txt`,
    `ls ${h} | grep ruling`,
    `sh -c "cat ${h}/ruling.md | head"`,
    `bash -c 'echo hi > .workflow/scratch/x'`,
  ]) assert.equal(selfRulingTarget("bash", { command }, r.root, r.dirs), undefined, command);
});
