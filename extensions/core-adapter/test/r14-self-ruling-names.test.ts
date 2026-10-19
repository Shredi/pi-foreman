// R14 item 3 (chair ruling 3): the self-ruling guard refused the foreman's `cp <own handoff>/ruling-2.md .workflow/scratch/...`.
// A ruling name is a basename match and a copy source is a read; a ruling-named write into a handoff dir where the session is
// the child stays refused. R14 ruling 7 reverted the `into` shortcut: `cp <H>/ruling-2.md T` with T no directory is refused
// again (`T/ruling-2.md` may be written); foreman_copy is the path for that copy.
// R16 item 4a: the alias-source, moved/linked dir, computed dir, backup-suffix and heredoc rows live in test/retired/self-ruling-rows.json.
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
const run = (r: Rig, command: string) => selfRulingRefusal("bash", { command }, r.root, r.dirs);

const PASS: Array<[string, (r: Rig) => string]> = [
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
  ["mv <S>/x <own handoff>/ruling-2.md", (r) => `mv ${r.S}/x ${r.H}/ruling-2.md`],
  ["ln <S>/x <child handoff>/ruling.md", (r) => `ln ${r.S}/x ${r.C}/ruling.md`],
];

for (const [name, line] of DENY) {
  test(`r14 self-ruling names deny: ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(bash(r))), SELF_RULING_REASON, line(bash(r)));
  });
}
