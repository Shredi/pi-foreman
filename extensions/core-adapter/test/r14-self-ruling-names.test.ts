// R14 item 3 (chair ruling 3): the self-ruling guard refused the foreman's `cp <own handoff>/ruling-2.md .workflow/scratch/...`.
// A ruling name is a basename match, a copy source is a read, and `<target>/<source name>` of a copy into a target that is no
// directory is no write below it; a ruling-named write into a handoff dir where the session is the child stays refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { isRulingName, SELF_RULING_REASON, selfRulingRefusal } from "../ruling.ts";

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r14sn-")));
  const hand = path.join(root, ".workflow", "handoffs");
  // H: the own handoff dir (the parent writes its rulings here); C: a second handoff dir where this session is the child
  const H = path.join(hand, "own");
  const C = path.join(hand, "up");
  const S = path.join(root, "scratch");
  for (const d of [H, C, S, path.join(root, ".workflow", "scratch")]) fs.mkdirSync(d, { recursive: true });
  for (const d of [H, C]) {
    fs.writeFileSync(path.join(d, "parent"), "other\n");
    fs.writeFileSync(path.join(d, "child"), "me\n");
    fs.writeFileSync(path.join(d, "ruling-2.md"), "APPROVED\n");
  }
  fs.writeFileSync(path.join(H, "asks.md"), "asks\n");
  fs.writeFileSync(path.join(S, "x"), "x\n");
  return { root, hand, H, C, S, dirs: childHandoffDirs(hand, "me") };
}
type Rig = ReturnType<typeof rig>;
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const bash = (r: Rig): Rig => ({ ...r, root: inBash(r.root), hand: inBash(r.hand), H: inBash(r.H), C: inBash(r.C), S: inBash(r.S) });
const run = (r: Rig, command: string) => selfRulingRefusal("bash", { command }, r.root, r.dirs, { scratch: r.S });

const PASS: Array<[string, (r: Rig) => string]> = [
  ["cp <H>/ruling-2.md .workflow/scratch/r14-ruling-2.md && echo ok", (r) => `cp ${r.H}/ruling-2.md .workflow/scratch/r14-ruling-2.md && echo ok`],
  ["cp <H>/ruling-2.md <abs worktree>/.workflow/scratch/r14-ruling-2.md", (r) => `cp ${r.H}/ruling-2.md ${r.root}/.workflow/scratch/r14-ruling-2.md`],
  ["cat <H>/ruling-2.md > .workflow/scratch/r14-ruling-2.md", (r) => `cat ${r.H}/ruling-2.md > .workflow/scratch/r14-ruling-2.md`],
  ["cat >> <H>/asks.md heredoc naming ruling-2.md; touch <H>/.ack", (r) => `cat >> ${r.H}/asks.md <<'EOF'\n- ask 3: see ruling-2.md\nEOF\ntouch ${r.H}/.ack`],
  ["echo x >> <H>/asks.md", (r) => `echo x >> ${r.H}/asks.md`],
  ["node w.js <S>/r14-ruling-2.md <S>/x.ruling.md (no ruling basename)", (r) => `node w.js ${r.S}/r14-ruling-2.md ${r.S}/x.ruling.md`],
];

for (const [name, line] of PASS) {
  test(`r14 self-ruling names pass: ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(bash(r))), undefined, line(bash(r)));
  });
}

test("r14 self-ruling names pass: write and edit tools on <H>/asks.md", async () => {
  const r = rig();
  for (const tool of ["write", "edit"]) assert.equal(await selfRulingRefusal(tool, { path: path.join(r.H, "asks.md") }, r.root, r.dirs), undefined, tool);
});

test("r14 self-ruling names: ruling names are anchored basenames", () => {
  for (const n of ["ruling.md", "ruling-2.md"]) assert.equal(isRulingName(n), true, n);
  for (const n of ["r14-ruling-2.md", "x.ruling.md", "asks.md", ".ack", "ruling-2.md.ack"]) assert.equal(isRulingName(n), false, n);
});

const DENY: Array<[string, (r: Rig) => string]> = [
  ["cp x <child handoff>/ruling.md", (r) => `cp ${r.S}/x ${r.C}/ruling.md`],
  ["cp x <own handoff>/ruling.md", (r) => `cp ${r.S}/x ${r.H}/ruling.md`],
  ["cp <S>/ruling.md <own handoff>", (r) => `cp ${r.S}/ruling.md ${r.H}`],
  ["mv <S>/x <own handoff>/ruling-2.md", (r) => `mv ${r.S}/x ${r.H}/ruling-2.md`],
  ["ln <S>/x <child handoff>/ruling.md", (r) => `ln ${r.S}/x ${r.C}/ruling.md`],
  // a link or move of a ruling source still changes or aliases it
  ["mv <own handoff>/ruling-2.md <S>/y (a ruling source of a move)", (r) => `mv ${r.H}/ruling-2.md ${r.S}/y`],
  ["cp -l <own handoff>/ruling-2.md <S>/y", (r) => `cp -l ${r.H}/ruling-2.md ${r.S}/y`],
  ["cp -s <own handoff>/ruling-2.md <S>/y", (r) => `cp -s ${r.H}/ruling-2.md ${r.S}/y`],
  ["ln -s <own handoff>/ruling-2.md <S>/y", (r) => `ln -s ${r.H}/ruling-2.md ${r.S}/y`],
  ["mv <own handoff> T && cp <S>/ruling.md T (a moved dir reaches the new target)", (r) => `mv ${r.H} .workflow/scratch/t && cp ${r.S}/ruling.md .workflow/scratch/t`],
  ["ln -s <own handoff> T; cp <S>/ruling.md T", (r) => `ln -s ${r.H} .workflow/scratch/t; cp ${r.S}/ruling.md .workflow/scratch/t`],
  ["cp x $D/ruling.md (computed dir)", (r) => `cp ${r.S}/x $D/ruling.md`],
];

for (const [name, line] of DENY) {
  test(`r14 self-ruling names deny: ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(bash(r))), SELF_RULING_REASON, line(bash(r)));
  });
}

// R14 ruling 5: a copy into a target that is no directory now is a write below it when the line can make that target a
// symlink first (recursive/-a copy, tar/unzip/git or any unknown program), and a backup option writes a name of its own choosing
// next to the target (`cp -b -S .md x <H>/ruling` writes <H>/ruling.md)
const DENY5: Array<[string, (r: Rig) => string]> = [
  ["cp -R <S>/lnk T && cp <S>/ruling.md T (lnk -> child handoff dir)", (r) => `cp -R ${r.S}/lnk .workflow/scratch/t && cp ${r.S}/ruling.md .workflow/scratch/t`],
  ["cp -a <S>/lnk T && cp <S>/ruling.md T (lnk -> child handoff dir)", (r) => `cp -a ${r.S}/lnk .workflow/scratch/t && cp ${r.S}/ruling.md .workflow/scratch/t`],
  ["tar xf a.tar && cp <S>/ruling.md T", (r) => `tar xf ${r.S}/a.tar && cp ${r.S}/ruling.md .workflow/scratch/t`],
  ["cp -b -S .md x <H>/ruling", (r) => `cp -b -S .md ${r.S}/x ${r.H}/ruling`],
  ["mv --backup --suffix=.md x <H>/ruling", (r) => `mv --backup --suffix=.md ${r.S}/x ${r.H}/ruling`],
];

for (const [name, line] of DENY5) {
  test(`r14 self-ruling names deny: ${name}`, async () => {
    const r = rig();
    try {
      fs.symlinkSync(r.C, path.join(r.S, "lnk"), "dir");
    } catch {
      // no symlink right (win32): the line alone decides
    }
    assert.equal(await run(r, line(bash(r))), SELF_RULING_REASON, line(bash(r)));
  });
}
