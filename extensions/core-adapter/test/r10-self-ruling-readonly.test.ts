// R10 item 7: the narrowing of the self-ruling guard to real write surfaces of ruling*.md was REVERTED to the 545abc2
// guard after three review cycles (98ba72e, 5c79ea3, f30001b); each re-review found new bypasses (quote-split moves
// that are not the command word, PowerShell backtick escapes, links made by an interpreter). A parser-level rewrite is
// needed (open item). The deny fixtures stay; the read-only lines are kept as documented current state.
// Against the 545abc2 guard: L1 refused by branch 1 `named.some(inChild)` (the cat operand),
// L2 with `cd $FOREMAN_SCRATCH` by branch 3 `dynamic && moves`, L3 by branch 3 `dynamic && mentionsDir` (the `ls`
// operand, `[` in the heredoc body), the session copy line (cp brief + `cat >>` heredoc) by branch 2 `named && dynamic`;
// L2 with a literal scratch path and the cp of plan.md into the handoff dir pass.
// R16 item 4a: ruling.ts keeps only the plain literal-path deny and a flat ask trigger; the cd, variable, symlink, -t, alias-source,
// interpreter and PowerShell rows live in test/retired/self-ruling-rows.json with their outcome now.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { SELF_RULING_REASON, selfRulingRefusal } from "../ruling.ts";

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r10sr-")));
  const hand = path.join(root, ".workflow", "handoffs");
  const H = path.join(hand, "up");
  const S = path.join(root, "scratch");
  fs.mkdirSync(H, { recursive: true });
  fs.mkdirSync(S, { recursive: true });
  fs.mkdirSync(path.join(root, ".workflow", "scratch"), { recursive: true });
  fs.writeFileSync(path.join(H, "parent"), "other\n");
  fs.writeFileSync(path.join(H, "child"), "me\n");
  fs.writeFileSync(path.join(H, "ruling.md"), "APPROVED\n");
  return { root, hand, H, S, dirs: childHandoffDirs(hand, "me") };
}
type Rig = ReturnType<typeof rig>;
const run = (r: Rig, command: string, tool = "bash", cwd = r.root) => selfRulingRefusal(tool, { command }, cwd, r.dirs);
// A child on Windows writes a path into a bash line with forward slashes; native backslashes would be bash escapes.
// Bash lines are built from this view; PowerShell lines and the ctx paths (cwd, child dirs) stay native.
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const view = (r: Rig, tool = "bash"): Rig => (tool === "powershell" ? r : { ...r, root: inBash(r.root), hand: inBash(r.hand), H: inBash(r.H), S: inBash(r.S) });

// R10 read-only lines the 545abc2 guard refused; the r13 lexed write-surface check (hub 170) passes them.
const PASSES_R13: Array<[string, (r: Rig) => string]> = [
  ["cd $FOREMAN_SCRATCH && gh run view 39038003331", () => `cd $FOREMAN_SCRATCH && gh run view 39038003331`],
  ["ls <H>/; python3 - <<'EOF' (json.load of <S>/status.json, print(d[\"runs\"][0]))", (r) => `ls ${r.H}/; python3 - <<'EOF'\nimport json\nd = json.load(open('${r.S}/status.json'))\nprint(d["runs"][0])\nEOF`],
];

for (const [name, line] of PASSES_R13) {
  test(`r13 lexed write surfaces: ${name} passes`, async () => {
    const r = rig();
    assert.equal(await run(r, line(view(r))), undefined, line(view(r)));
  });
}

const PASSES_NOW: Array<[string, (r: Rig) => string]> = [
  ["cd <S> && gh run view 39038003331", (r) => `cd ${r.S} && gh run view 39038003331`],
  ["cp <root>/.workflow/scratch/plan-r10.md <H>/plan.md", (r) => `cp ${r.root}/.workflow/scratch/plan-r10.md ${r.H}/plan.md`],
];

// R14 ruling 3: every write form of the Addendum-D row stays denied
const DENY_R14: Array<[string, (r: Rig) => string]> = [
  ["mv <H>/ruling.md <scratch>/ruling-r10.md", (r) => `mv ${r.H}/ruling.md ${r.root}/.workflow/scratch/ruling-r10.md`],
  ["cp x <child handoff>/ruling.md", (r) => `cp ${r.S}/x ${r.H}/ruling.md`],
];

for (const [name, line] of DENY_R14) {
  test(`r14 ruling 3 (write forms of the Addendum-D row): ${name} is refused`, async () => {
    const r = rig();
    assert.equal(await run(r, line(view(r))), SELF_RULING_REASON, line(view(r)));
  });
}

for (const [name, line] of PASSES_NOW) {
  test(`documented current state (R10, narrowing reverted): ${name} passes`, async () => {
    const r = rig();
    assert.equal(await run(r, line(view(r))), undefined, line(view(r)));
  });
}

const DENY: Array<[string, (r: Rig) => string]> = [
  ["redirect >>", (r) => `echo A >> ${r.H}/ruling.md`],
  ["redirect >|", (r) => `echo A >| ${r.H}/ruling.md`],
  ["redirect &>", (r) => `echo A &> ${r.H}/ruling-1.md`],
  ["redirect 2>", (r) => `ls nope 2> ${r.H}/ruling-1.md`],
  ["read verb with redirect into the handoff dir", (r) => `cat ${r.S}/x.md > ${r.H}/ruling.md`],
  ["read verb copying one ruling over another", (r) => `cat ${r.H}/ruling.md >> ${r.H}/ruling-1.md`],
  ["tee -a", (r) => `echo A | tee -a ${r.H}/ruling-1.md`],
  ["mv destination", (r) => `mv ${r.S}/x ${r.H}/ruling-1.md`],
  ["install destination", (r) => `install ${r.S}/x ${r.H}/ruling.md`],
  ["ln destination", (r) => `ln ${r.S}/x ${r.H}/ruling.md`],
  ["L3 heredoc body with shell after the terminator", (r) => `ls ${r.H}/; cat <<'EOF'\nx\nEOF\ncp x ${r.H}/ruling.md`],
];

for (const [name, line] of DENY) {
  test(`r10 write surface denied: ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(view(r))), SELF_RULING_REASON, line(view(r)));
  });
}

// Revision round 1 (reviewer F1-F5): each line writes <H>/ruling.md and passed the guard at 98ba72e. Case names are the
// reviewer's literal lines.
const DENY_R1: Array<[string, (r: Rig) => string, string?]> = [
  // F2: a backslash escape or line continuation hides a segment break
  ["F2 echo APPROVED | tee \\ + newline + cat <H>/ruling.md", (r) => `echo APPROVED | tee \\\ncat ${r.H}/ruling.md`],
  ["F2 echo APPROVED | tee \\; cat <H>/ruling.md", (r) => `echo APPROVED | tee \\; cat ${r.H}/ruling.md`],
  ["F2 echo APPROVED | tee \\& cat <H>/ruling.md", (r) => `echo APPROVED | tee \\& cat ${r.H}/ruling.md`],
];

for (const [name, line, tool] of DENY_R1) {
  test(`r10 write surface denied (round 1): ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(view(r, tool)), tool ?? "bash"), SELF_RULING_REASON, line(view(r, tool)));
  });
}

test("r10 write surface denied: write and edit tools on <H>/ruling.md", async () => {
  const r = rig();
  for (const tool of ["write", "edit"]) assert.equal(await selfRulingRefusal(tool, { path: path.join(r.H, "ruling.md") }, r.root, r.dirs), SELF_RULING_REASON, tool);
});
