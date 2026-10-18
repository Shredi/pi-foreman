// R10 item 7: the narrowing of the self-ruling guard to real write surfaces of ruling*.md was REVERTED to the 545abc2
// guard after three review cycles (98ba72e, 5c79ea3, f30001b); each re-review found new bypasses (quote-split moves
// that are not the command word, PowerShell backtick escapes, links made by an interpreter). A parser-level rewrite is
// needed (open item). The deny fixtures stay; the read-only lines are kept as documented current state.
// Against the 545abc2 guard: L1 refused by branch 1 `named.some(inChild)` (the cat operand),
// L2 with `cd $FOREMAN_SCRATCH` by branch 3 `dynamic && moves`, L3 by branch 3 `dynamic && mentionsDir` (the `ls`
// operand, `[` in the heredoc body), the session copy line (cp brief + `cat >>` heredoc) by branch 2 `named && dynamic`;
// L2 with a literal scratch path and the cp of plan.md into the handoff dir pass.
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
  ["cp <H>/plan.md <S> && cat <H>/ruling.md >> <S>/x.md", (r) => `cp ${r.H}/plan.md ${r.S} && cat ${r.H}/ruling.md >> ${r.S}/x.md`],
  ["cp <H>/plan.md $FOREMAN_SCRATCH && cat <H>/ruling.md >> $FOREMAN_SCRATCH/x.md", (r) => `cp ${r.H}/plan.md $FOREMAN_SCRATCH && cat ${r.H}/ruling.md >> $FOREMAN_SCRATCH/x.md`],
  ["cd $FOREMAN_SCRATCH && gh run view 39038003331", () => `cd $FOREMAN_SCRATCH && gh run view 39038003331`],
  ["ls <H>/; python3 - <<'EOF' (json.load of <S>/status.json, print(d[\"runs\"][0]))", (r) => `ls ${r.H}/; python3 - <<'EOF'\nimport json\nd = json.load(open('${r.S}/status.json'))\nprint(d["runs"][0])\nEOF`],
  ["cp <H>/brief.md <root>/.workflow/scratch/brief-r10.md && cat >> <root>/.workflow/scratch/plan-r10.md <<'EOF' ($25 in the body)", (r) => `cp ${r.H}/brief.md ${r.root}/.workflow/scratch/brief-r10.md && cat >> ${r.root}/.workflow/scratch/plan-r10.md <<'EOF'\n## Addendum\n- Default without a ruling: ask. Ask at $25.\nEOF`],
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
  ["cp -s <H>/ruling.md <scratch>/ruling-r10.md", (r) => `cp -s ${r.H}/ruling.md ${r.root}/.workflow/scratch/ruling-r10.md`],
  ["cp -l <H>/ruling.md <scratch>/ruling-r10.md", (r) => `cp -l ${r.H}/ruling.md ${r.root}/.workflow/scratch/ruling-r10.md`],
  ["ln <H>/ruling.md <scratch>/ruling-r10.md", (r) => `ln ${r.H}/ruling.md ${r.root}/.workflow/scratch/ruling-r10.md`],
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
  ["redirect >", (r) => `echo A > ${r.H}/ruling.md`],
  ["redirect >>", (r) => `echo A >> ${r.H}/ruling.md`],
  ["redirect >|", (r) => `echo A >| ${r.H}/ruling.md`],
  ["redirect &>", (r) => `echo A &> ${r.H}/ruling-1.md`],
  ["redirect 2>", (r) => `ls nope 2> ${r.H}/ruling-1.md`],
  ["read verb with redirect into the handoff dir", (r) => `cat ${r.S}/x.md > ${r.H}/ruling.md`],
  ["read verb copying one ruling over another", (r) => `cat ${r.H}/ruling.md >> ${r.H}/ruling-1.md`],
  ["read verb redirect to an unresolved variable", (r) => `cat ${r.H}/ruling.md > $OUT/ruling.md`],
  ["tee", (r) => `echo A | tee ${r.H}/ruling.md`],
  ["tee -a", (r) => `echo A | tee -a ${r.H}/ruling-1.md`],
  ["cp destination", (r) => `cp ${r.S}/x ${r.H}/ruling.md`],
  ["mv destination", (r) => `mv ${r.S}/x ${r.H}/ruling-1.md`],
  ["install destination", (r) => `install ${r.S}/x ${r.H}/ruling.md`],
  ["ln destination", (r) => `ln ${r.S}/x ${r.H}/ruling.md`],
  ["cp -t", (r) => `cp -t ${r.H} ruling.md`],
  ["mv -t", (r) => `mv -t ${r.H}/ ${r.S}/ruling-1.md`],
  ["install -t", (r) => `install -t ${r.H} ${r.S}/ruling.md`],
  ["ln -t", (r) => `ln -t ${r.H} ${r.S}/ruling.md`],
  // Addendum D: a cp/install SOURCE naming ruling*.md is never relaxed (-s/-l alias it)
  ["cp -s source", (r) => `cp -s ${r.H}/ruling.md /tmp/x`],
  ["cp -l source", (r) => `cp -l ${r.H}/ruling.md /tmp/x`],
  ["ln -s source", (r) => `ln -s ${r.H}/ruling.md /tmp/x`],
  // Addendum D: copying a ruling OUT of the handoff dir stays refused (same alias risk); this session hit it in R10.
  // R14 ruling 7: known false positive, foreman_copy is the path
  ["session: cp ruling.md out of the handoff dir", (r) => `cp ${r.H}/ruling.md ${r.root}/.workflow/scratch/ruling-r10.md`],
  ["sed -i", (r) => `sed -i s/FAIL/APPROVED/ ${r.H}/ruling.md`],
  ["dd of=", (r) => `echo A | dd of=${r.H}/ruling.md`],
  ["curl -o", (r) => `curl -o ${r.H}/ruling.md https://example.com/x`],
  ["wget -O", (r) => `wget -O ${r.H}/ruling-1.md https://example.com/x`],
  ["sh -c redirect", (r) => `sh -c "echo A > ${r.H}/ruling.md"`],
  ["node script argument", (r) => `node w.js ${r.H}/ruling.md`],
  ["python3 -c open w", (r) => `python3 -c "open('${r.H}/ruling.md','w')"`],
  ["L3 heredoc body writes ruling.md", (r) => `ls ${r.H}/; python3 - <<'EOF'\nopen('${r.H}/ruling.md','w').write('APPROVED')\nEOF`],
  ["L3 heredoc body joins dir and ruling.md", (r) => `ls ${r.H}/; python3 - <<'EOF'\nimport os\nopen(os.path.join('${r.H}','ruling.md'),'w')\nEOF`],
  ["L3 heredoc body with shell after the terminator", (r) => `ls ${r.H}/; cat <<'EOF'\nx\nEOF\ncp x ${r.H}/ruling.md`],
  ["cd /tmp && cp x <H>/$N", (r) => `cd /tmp && cp x ${r.H}/$N`],
  ["cd into the handoff dir then a variable target", (r) => `cd ${r.H} && cp x $N`],
  ["relative cd into the handoff dir then a variable target", () => `cd up && cp x $N`],
  ["cd to an unresolved variable then a variable target", (r) => `cd $D && cp x $N && ls ${r.H}`],
  ["second relative cd then a variable target", (r) => `cd /tmp && cd up && cp x $N && ls ${r.H}`],
];

for (const [name, line] of DENY) {
  test(`r10 write surface denied: ${name}`, async () => {
    const r = rig();
    const cwd = name.startsWith("relative cd") ? r.hand : r.root;
    assert.equal(await run(r, line(view(r)), "bash", cwd), SELF_RULING_REASON, line(view(r)));
  });
}

// Revision round 1 (reviewer F1-F5): each line writes <H>/ruling.md and passed the guard at 98ba72e. Case names are the
// reviewer's literal lines.
const DENY_R1: Array<[string, (r: Rig) => string, string?]> = [
  // F1: a relative redirect or cp destination after a cd into the handoff dir
  ["F1 cd <H> && cat <S>/x > ruling.md", (r) => `cd ${r.H} && cat ${r.S}/x > ruling.md`],
  ["F1 cd <H> && cp <S>/x ruling.md", (r) => `cd ${r.H} && cp ${r.S}/x ruling.md`],
  ["F1 pushd <H> && cat <S>/x > ruling.md", (r) => `pushd ${r.H} && cat ${r.S}/x > ruling.md`],
  // F2: a backslash escape or line continuation hides a segment break
  ["F2 echo APPROVED | tee \\ + newline + cat <H>/ruling.md", (r) => `echo APPROVED | tee \\\ncat ${r.H}/ruling.md`],
  ["F2 echo APPROVED | tee \\; cat <H>/ruling.md", (r) => `echo APPROVED | tee \\; cat ${r.H}/ruling.md`],
  ["F2 echo APPROVED | tee \\& cat <H>/ruling.md", (r) => `echo APPROVED | tee \\& cat ${r.H}/ruling.md`],
  // F3: CDPATH reroutes a relative cd (cwd: the session root, where `up` does not exist)
  ["F3 CDPATH=<parent of H>; cd up && cp x $N", (r) => `CDPATH=${r.hand}; cd up && cp x $N`],
  ["F3 export CDPATH=<parent of H>; cd up && cp x $N", (r) => `export CDPATH=${r.hand}; cd up && cp x $N`],
  // F4: a line that rebinds FOREMAN_SCRATCH keeps it dynamic
  ["F4 FOREMAN_SCRATCH=<H>; cat x > $FOREMAN_SCRATCH/ruling.md", (r) => `FOREMAN_SCRATCH=${r.H}; cat x > $FOREMAN_SCRATCH/ruling.md`],
  ["F4 FOREMAN_SCRATCH=<H>; cat x > $FOREMAN_SCRATCH/$N", (r) => `FOREMAN_SCRATCH=${r.H}; cat x > $FOREMAN_SCRATCH/$N`],
  ["F4 export FOREMAN_SCRATCH=<H> && cp x $FOREMAN_SCRATCH/ruling.md", (r) => `export FOREMAN_SCRATCH=${r.H} && cp x $FOREMAN_SCRATCH/ruling.md`],
  // F5: PowerShell write cmdlets (powershell tool)
  ["F5 Set-Content <H>/ruling.md", (r) => `Set-Content -Path ${r.H}/ruling.md -Value APPROVED`, "powershell"],
  ["F5 Out-File <H>/ruling.md", (r) => `"APPROVED" | Out-File -FilePath ${r.H}/ruling.md`, "powershell"],
  ["F5 Copy-Item <S>/x <H>/ruling.md", (r) => `Copy-Item ${r.S}/x ${r.H}/ruling.md`, "powershell"],
  ["F5 Add-Content <H>/ruling.md", (r) => `Add-Content -Path ${r.H}/ruling.md -Value APPROVED`, "powershell"],
  ["F5 Set-Location <H>; Set-Content ruling.md", (r) => `Set-Location ${r.H}; Set-Content ruling.md APPROVED`, "powershell"],
];

for (const [name, line, tool] of DENY_R1) {
  test(`r10 write surface denied (round 1): ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(view(r, tool)), tool ?? "bash"), SELF_RULING_REASON, line(view(r, tool)));
  });
}

// Revision round 2 (reviewer regression against 545abc2 + finding 2): `lnk` does not exist when the guard runs, so the
// target fell back to path.resolve, was judged outside and masked; quote-split and chdir/sl moves were not seen.
const DENY_R2: Array<[string, (r: Rig) => string, string?]> = [
  ["R2 ln -s <abs H> lnk; cat x > lnk/ruling.md", (r) => `ln -s ${r.H} lnk; cat x > lnk/ruling.md`],
  ["R2 ln -s <abs H> lnk; cp x lnk/ruling.md", (r) => `ln -s ${r.H} lnk; cp x lnk/ruling.md`],
  ["R2 mklink /D lnk <H> & cat x > lnk/ruling.md", (r) => `mklink /D lnk ${r.H} & cat x > lnk/ruling.md`],
  ["R2 New-Item -ItemType SymbolicLink lnk <H>; Set-Content lnk/ruling.md", (r) => `New-Item -ItemType SymbolicLink -Path lnk -Target ${r.H}; Set-Content lnk/ruling.md APPROVED`, "powershell"],
  // the <H> operand makes the unmasked line refusable; before the fix the segment was masked as writing outside
  ["R2 cat <H>/plan.md > newdir/ruling.md (nonexistent parent dir)", (r) => `cat ${r.H}/plan.md > newdir/ruling.md`],
  ["R2 c''d <H> && cat <S>/x > ruling.md", (r) => `c''d ${r.H} && cat ${r.S}/x > ruling.md`],
  ["R2 chdir <H> && cat <S>/x > ruling.md", (r) => `chdir ${r.H} && cat ${r.S}/x > ruling.md`],
];

// Revision round 3 (final re-review of f30001b, findings 1-3): bypasses of the narrowed guard; the 545abc2 guard refuses them.
const DENY_R3: Array<[string, (r: Rig) => string, string?]> = [
  ["R3 finding 1: { c''d <H>; }; cat <S>/x > ruling.md", (r) => `{ c''d ${r.H}; }; cat ${r.S}/x > ruling.md`],
  ["R3 finding 1: builtin c''d <H> && cat <S>/x > ruling.md", (r) => `builtin c''d ${r.H} && cat ${r.S}/x > ruling.md`],
  ["R3 finding 1: if c''d <H>; then cat <S>/x > ruling.md; fi", (r) => `if c''d ${r.H}; then cat ${r.S}/x > ruling.md; fi`],
  ["R3 finding 2: Set`-Location <H>; Set-Content ruling.md APPROVED", (r) => `Set\`-Location ${r.H}; Set-Content ruling.md APPROVED`, "powershell"],
  ["R3 finding 3: perl -e 'symlink(\"<H>\",\"/tmp/d\")'; cat x > /tmp/d/ruling.md", (r) => `perl -e 'symlink("${r.H}","/tmp/d")'; cat x > /tmp/d/ruling.md`],
];

for (const [name, line, tool] of DENY_R3) {
  test(`r10 write surface denied (round 3): ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(view(r, tool)), tool ?? "bash"), SELF_RULING_REASON, line(view(r, tool)));
  });
}

for (const [name, line, tool] of DENY_R2) {
  test(`r10 write surface denied (round 2): ${name}`, async () => {
    const r = rig();
    assert.equal(await run(r, line(view(r, tool)), tool ?? "bash"), SELF_RULING_REASON, line(view(r, tool)));
  });
}

test("r10 write surface denied: write and edit tools on <H>/ruling.md", async () => {
  const r = rig();
  for (const tool of ["write", "edit"]) assert.equal(await selfRulingRefusal(tool, { path: path.join(r.H, "ruling.md") }, r.root, r.dirs), SELF_RULING_REASON, tool);
});

test("r10: $FOREMAN_SCRATCH stays unresolved and L2 fails closed next to a handoff mention", async () => {
  const r = rig();
  const line = `cd $FOREMAN_SCRATCH && cp x $N && ls ${inBash(r.H)}`;
  assert.equal(await selfRulingRefusal("bash", { command: line }, r.root, r.dirs), SELF_RULING_REASON);
});
