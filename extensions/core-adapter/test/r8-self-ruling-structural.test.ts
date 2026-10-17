// R8 item 12 rev 2: the "provable read" exemption is a strict viewer set; every other verb is checked word by word.
// The frozen copy below is the 0a8b2bc guard; the new guard must refuse everything it refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { isRulingName, selfRulingMessage, selfRulingRefusal, SELF_RULING_REASON } from "../ruling.ts";

// ---- frozen copy of the 0a8b2bc guard ----
const OLD_READ_VERBS = new Set(["cat", "head", "tail", "ls", "grep", "egrep", "fgrep", "rg", "wc", "stat", "file", "nl", "realpath", "sort", "uniq", "cut", "tr", "cd"]);
const OLD_ONLY_MATCHING = new Set(["grep", "egrep", "fgrep", "rg", "ls"]);
function oldPureRead(command: string): boolean {
  if (/[`>&]|\$\(|<\(|\$\{/.test(command.replace(/&&/g, ";"))) return false;
  const parts = command.split(/&&|\|\||;|\||\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => {
    const w = p.split(/\s+/);
    if (!OLD_READ_VERBS.has(w[0])) return false;
    if (w[0] === "uniq" && w.slice(1).some((x) => !x.startsWith("-"))) return false;
    if (w[0] === "sort" && w.some((x) => /^-[^-]*[oT]|^--(output|compress-program|temporary)/.test(x))) return false;
    return OLD_ONLY_MATCHING.has(w[0]) || !w.some((x) => /^--?o(utput)?\b/.test(x));
  });
}
const oldRealKey = (p: string): string => {
  try {
    return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
  } catch {
    return path.resolve(p);
  }
};
const oldRealDir = (d: string): string => path.dirname(oldRealKey(path.join(d, "x")));
const oldUnquote = (w: string): string => w.replace(/^['"]+|['"]+$/g, "");
function oldGuard(command: string, cwd: string, childDirs: string[]): boolean {
  const dirs = new Set(childDirs.map(oldRealDir));
  const inChild = (p: string): boolean => isRulingName(path.basename(p)) && dirs.has(path.dirname(oldRealKey(path.resolve(cwd, p))));
  if (!command || oldPureRead(command)) return false;
  const words = command.split(/[\s;&|<>()]+/).filter(Boolean).map(oldUnquote);
  const named = words.filter((w) => /ruling/.test(w));
  const dynamic = words.some((w) => /[*?[$]/.test(w));
  const mentionsDir = [...childDirs, ...dirs].some((d) => command.includes(d));
  const moves = /\b(cd|pushd|Set-Location)\b/.test(command);
  if (named.some(inChild)) return true;
  if (named.length > 0 && (mentionsDir || moves || dynamic)) return true;
  return dynamic && (mentionsDir || moves);
}

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r8st-")));
  const up = path.join(root, "handoffs", "up");
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, "parent"), "other\n");
  fs.writeFileSync(path.join(up, "child"), "me\n");
  return { root, up, dirs: childHandoffDirs(path.join(root, "handoffs"), "me") };
}

const writes = (h: string): string[] => [
  // the three leaks the reviewer found
  `sed -n 'w ${h}/ruling.md' x`,
  `sed 's/a/b/w ${h}/ruling.md' x`,
  `sed -n "1w ${h}/ruling-3.md" x`,
  `sort -uo ${h}/ruling.md x`,
  `sort -mo${h}/ruling.md x`,
  `sort -o ${h}/ruling.md x`,
  `git diff --output=${h}/ruling.md`,
  `git log --output=${h}/ruling-2.md`,
  `git show --output=${h}/ruling.md HEAD`,
  // other interpreters and writers
  `awk '{print > "${h}/ruling.md"}' x`,
  `perl -e 'open F,">","${h}/ruling.md"'`,
  `find ${h} -fprint ${h}/ruling.md`,
  `tar -xf a.tar -C ${h}`,
  `rg --pre "tee ${h}/ruling.md" x ${h}/ruling.md`,
  `git grep -O"tee ${h}/ruling.md" x`,
  `python3 -c 'open("${h}/ruling.md","w")'`,
  `node -e 'require("fs").writeFileSync("${h}/ruling.md","x")'`,
  `dd if=x of=${h}/ruling.md`,
  `echo APPROVED > ${h}/ruling.md`,
  `cp x ${h}/ruling-2.md`,
  `cat x | tee ${h}/ruling.md`,
  `H=${h}; mv x "$H/ruling.md"`,
  `sed -i s/a/b/ ${h}/ruling.md`,
  `bash -c 'echo hi > ${h}/ruling.md'`,
  `env FOO=1 sed -n 'w ${h}/ruling.md' x`,
];

test("r8 self ruling structural: the new guard refuses every write the 0a8b2bc guard refused", () => {
  const r = rig();
  for (const command of writes(r.up)) {
    if (oldGuard(command, r.root, r.dirs)) assert.ok(selfRulingRefusal("bash", { command }, r.root, r.dirs), `regressed: ${command}`);
  }
  // the frozen guard really refuses the corpus (so the comparison is not vacuous)
  assert.ok(writes(r.up).filter((c) => oldGuard(c, r.root, r.dirs)).length >= 15);
});

test("r8 self ruling structural: every corpus write is refused, naming the target", () => {
  const r = rig();
  for (const command of writes(r.up)) {
    for (const tool of ["bash", "bg_run", "foreman_bg"]) assert.equal(selfRulingRefusal(tool, { command }, r.root, r.dirs), SELF_RULING_REASON, `${tool}: ${command}`);
    const msg = selfRulingMessage("bash", { command }, r.root, r.dirs);
    assert.ok(msg && msg.startsWith(`${SELF_RULING_REASON} (target: `) && /ruling|handoffs/.test(msg), `${command}: ${msg}`);
  }
});

test("r8 self ruling structural: sed w, sort -o clusters and git --output name the ruling file", () => {
  const r = rig();
  const h = r.up;
  assert.match(selfRulingMessage("bash", { command: `sort -uo ${h}/ruling.md x` }, r.root, r.dirs) ?? "", /ruling\.md/);
  assert.match(selfRulingMessage("bash", { command: `git diff --output=${h}/ruling.md` }, r.root, r.dirs) ?? "", /ruling\.md/);
  assert.match(selfRulingMessage("bash", { command: `sed -n 'w ${h}/ruling.md' x` }, r.root, r.dirs) ?? "", /ruling\.md/);
});

test("r8 self ruling structural: the nine freed read/scratch cases still pass", () => {
  const r = rig();
  const h = r.up;
  const state = path.join(r.root, "state");
  for (const command of [
    `cat ${h}/ruling-pre-models.md ${h}/parent`,
    `ls -la ${h}; env | grep FOO; git log`,
    `grep -rlE "foo|bar" --include=*.ts .`,
    `cd extensions/core-adapter; ls; grep foo x ; grep bar y 2>/dev/null`,
    `ls ${state}/usage | tail`,
    `cd ${state}/usage; head -c 600 x.jsonl`,
    `grep foo ${h}/ci.log > .workflow/scratch/x.txt`,
    `cp ${h}/ci.log .workflow/scratch/`,
    `grep -E 'a|b' ${h}/log | cut -c1-3 | head`,
    `cat ${h}/ruling.md 2>&1 | head`,
    `cp ${h}/ruling.md .workflow/scratch/`,
    `diff ${h}/ruling.md ${h}/ruling-2.md`,
    `rg foo ${h}/ruling.md | wc -l`,
    `sed -n 1,5p ${h}/ruling.md`,
    `sed -n '/APPROVED/p' ${h}/ruling.md`,
    `git show HEAD:${h}/ruling.md`,
    `git log -3 --oneline -- ${h}/ruling.md`,
  ]) assert.equal(selfRulingRefusal("bash", { command }, r.root, r.dirs), undefined, command);
});

test("r8 self ruling structural: viewers with a writing option are not exempt", () => {
  const r = rig();
  const h = r.up;
  for (const command of [
    `diff --output=${h}/ruling.md a b`,
    `rg --pre-glob "*" --pre "tee ${h}/ruling.md" x ${h}/ruling.md`,
    `less -o ${h}/ruling.md x`,
    `sed -n 'p;w ${h}/ruling.md' x`,
    `sed -n 'p' x -s${h}/ruling.md`,
    `git --no-pager diff --output=${h}/ruling.md`,
    `git diff --out=${h}/ruling.md`,
    `git -c core.pager='tee ${h}/ruling.md' show HEAD`,
  ]) assert.equal(selfRulingRefusal("bash", { command }, r.root, r.dirs), SELF_RULING_REASON, command);
});
