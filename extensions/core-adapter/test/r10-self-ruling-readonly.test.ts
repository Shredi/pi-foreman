// R10 item 7: the self-ruling guard narrowed to real write surfaces of ruling*.md in a handoff dir where the session is
// the child. Before the fix (reproduced against 545abc2): L1 refused by branch 1 `named.some(inChild)` (the cat operand),
// L2 with `cd $FOREMAN_SCRATCH` by branch 3 `dynamic && moves`, L3 by branch 3 `dynamic && mentionsDir` (the `ls`
// operand, `[` in the heredoc body), the session copy line (cp brief + `cat >>` heredoc) by branch 2 `named && dynamic`;
// L2 with a literal scratch path and the cp of plan.md into the handoff dir already passed.
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
const run = (r: Rig, command: string, tool = "bash", cwd = r.root) => selfRulingRefusal(tool, { command }, cwd, r.dirs, [r.S]);

const PASS: Array<[string, (r: Rig) => string]> = [
  ["L1 cp plan.md to scratch && cat ruling.md >> scratch file", (r) => `cp ${r.H}/plan.md ${r.S} && cat ${r.H}/ruling.md >> ${r.S}/x.md`],
  ["L1 with $FOREMAN_SCRATCH targets", (r) => `cp ${r.H}/plan.md $FOREMAN_SCRATCH && cat ${r.H}/ruling.md >> $FOREMAN_SCRATCH/x.md`],
  ["L2 cd scratch && gh run view", (r) => `cd ${r.S} && gh run view 39038003331`],
  ["L2 cd $FOREMAN_SCRATCH && gh run view", () => `cd $FOREMAN_SCRATCH && gh run view 39038003331`],
  ["L3 ls handoff; python3 heredoc not naming a ruling", (r) => `ls ${r.H}/; python3 - <<'EOF'\nimport json\nd = json.load(open('${r.S}/status.json'))\nprint(d["runs"][0])\nEOF`],
  ["session: cp brief.md out of the handoff dir && cat >> plan heredoc", (r) => `cp ${r.H}/brief.md ${r.root}/.workflow/scratch/brief-r10.md && cat >> ${r.root}/.workflow/scratch/plan-r10.md <<'EOF'\n## Addendum\n- Default without a ruling: ask. Ask at $25.\nEOF`],
  ["session: cp plan.md into the handoff dir (target is not ruling*.md)", (r) => `cp ${r.root}/.workflow/scratch/plan-r10.md ${r.H}/plan.md`],
];

for (const [name, line] of PASS) {
  test(`r10 read-only passes: ${name}`, () => {
    const r = rig();
    assert.equal(run(r, line(r)), undefined, line(r));
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
  // Addendum D: copying a ruling OUT of the handoff dir stays refused (same alias risk); this session hit it in R10
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
  test(`r10 write surface denied: ${name}`, () => {
    const r = rig();
    const cwd = name.startsWith("relative cd") ? r.hand : r.root;
    assert.equal(run(r, line(r), "bash", cwd), SELF_RULING_REASON, line(r));
  });
}

test("r10 write surface denied: write and edit tools on <H>/ruling.md", () => {
  const r = rig();
  for (const tool of ["write", "edit"]) assert.equal(selfRulingRefusal(tool, { path: path.join(r.H, "ruling.md") }, r.root, r.dirs, [r.S]), SELF_RULING_REASON, tool);
});

test("r10: without a scratch dir $FOREMAN_SCRATCH stays unresolved and L2 fails closed next to a handoff mention", () => {
  const r = rig();
  const line = `cd $FOREMAN_SCRATCH && cp x $N && ls ${r.H}`;
  assert.equal(selfRulingRefusal("bash", { command: line }, r.root, r.dirs), SELF_RULING_REASON);
});
