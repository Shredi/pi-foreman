// The child's own scratch dir may not exist yet (the harness creates it lazily, or the bind is a symlinked temp root): a write into it is
// compared by the deepest existing ancestor on both sides, so it is write-in in every spelling. A cp source is a read, not a write.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-scratchmiss-"));
const wt = path.join(base, "wt");
const realTmp = path.join(base, "real");
const linkTmp = path.join(base, "lnk");
const outDir = path.join(base, "outside");
const rel = path.join("pi-foreman-scratch", "missing-run");
for (const d of [wt, path.join(realTmp, "pi-foreman-scratch"), path.join(realTmp, "pi-foreman-scratch", "other"), outDir, path.join(outDir, "dir")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "x.txt"), "x");
fs.writeFileSync(path.join(outDir, "f.txt"), "o");
fs.writeFileSync(path.join(outDir, "dir", "g.txt"), "g");
if (posix) {
  fs.symlinkSync(realTmp, linkTmp);
  fs.symlinkSync(outDir, path.join(realTmp, "pi-foreman-scratch", "other", "out"));
}
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (scratch: string): GateRoots => ({ worktree: wt, scratch: [scratch], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false });
const decide = (scratch: string, tool: string, input: unknown) => gateEvaluate(tool, input, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true }), roots: () => roots(scratch) });
const outsideTool = (scratch: string, tool: string, input: unknown): boolean => {
  const r = decide(scratch, tool, input).result as { block?: boolean; rule?: string } | undefined;
  return !!r?.block && r.rule === "child-write-outside";
};
const outside = (scratch: string, command: string): boolean => outsideTool(scratch, "bash", { command });

// [scratch root as bound, literal spelling of the same dir]: a plain missing dir, then the link and real spellings crossed
const spellings: Array<[string, string]> = [
  [path.join(realTmp, rel), path.join(realTmp, rel)],
  ...(posix ? ([[path.join(linkTmp, rel), path.join(realTmp, rel)], [path.join(realTmp, rel), path.join(linkTmp, rel)], [path.join(linkTmp, rel), path.join(linkTmp, rel)]] as Array<[string, string]>) : []),
];

test("missing own scratch dir: mkdir, redirect, write tool, cp, variables are write-in in every spelling", () => {
  assert.equal(fs.existsSync(path.join(realTmp, rel)), false);
  for (const [root, lit] of spellings) {
    const cmds = [
      `mkdir -p ${lit}/new/a`,
      `echo x > ${lit}/f.txt`,
      `cp wt/x.txt ${lit}/h.txt`,
      `cp ${wt}/x.txt ${lit}/h.txt`,
      `S=$FOREMAN_SCRATCH; mkdir -p "$S/a"`,
      `D=${lit}; cp ${wt}/x.txt "$D/x"`,
      `mkdir -p "$FOREMAN_SCRATCH/a" && cp ${wt}/x.txt "$FOREMAN_SCRATCH/a/"`,
    ];
    for (const cmd of cmds) assert.equal(outside(root, cmd), false, `${root} :: ${cmd}`);
    assert.equal(outsideTool(root, "write", { path: `${lit}/q/w.txt`, content: "x" }), false, `${root} :: write tool`);
  }
});

test("a cp source outside the worktree is a read: into the scratch dir or the worktree", () => {
  for (const [root, lit] of spellings) {
    for (const cmd of [`cp ${outDir}/f.txt ${lit}/h.txt`, `cp ${outDir}/f.txt ${wt}/h.txt`, `cp -r ${outDir}/dir ${lit}/d`, `cp -t ${lit} ${outDir}/f.txt`]) assert.equal(outside(root, cmd), false, `${root} :: ${cmd}`);
  }
});

test("missing own scratch dir does not widen the fence", () => {
  for (const [root, lit] of spellings) {
    const scratchRoot = path.dirname(lit);
    const cmds = [
      `echo x > ${scratchRoot}/other/f.txt`,
      `echo x > ${scratchRoot}/f.txt`,
      `echo x > ${path.dirname(scratchRoot)}/f.txt`,
      `mkdir -p ${outDir}/x`,
      `mv ${outDir}/f.txt ${lit}/h.txt`,
      `cp ${wt}/x.txt ${outDir}/x`,
      `echo x > ${lit}/new/../../other/f`,
    ];
    for (const cmd of cmds) assert.equal(outside(root, cmd), true, `${root} :: ${cmd}`);
    assert.equal(outsideTool(root, "write", { path: `${scratchRoot}/other/f.txt`, content: "x" }), true, `${root} :: write tool sibling`);
  }
});

test("a link inside the scratch dir that points outside stays outside", { skip: !posix }, () => {
  const root = path.join(linkTmp, "pi-foreman-scratch", "other");
  assert.equal(outside(root, `echo x > ${root}/out/f.txt`), true);
  assert.equal(outside(root, `echo x > ${path.join(realTmp, "pi-foreman-scratch", "other")}/out/new.txt`), true);
});
