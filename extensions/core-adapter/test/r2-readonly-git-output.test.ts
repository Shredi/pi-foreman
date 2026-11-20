// Guard round 2: the read-only fence refuses a git output option, or a default output into the cwd, that lands in the worktree (`archive -o`, `format-patch`,
// `bundle create`, `checkout-index`). Every row is one literal outcome "<verdict> <rule> <sorted labels>" per role; builder and main keep their old values.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const fwd = (p: string): string => p.replace(/\\/g, "/");
const base = fs.realpathSync(mkTestTmp("pf-ro-gout-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const clone = path.join(scr, "c");
const handoff = path.join(base, "handoffs", "h1");
for (const d of [path.join(wt, "sub"), clone, handoff]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));
const W = fwd(wt);
const S = fwd(scr);

type Kind = "ro" | "child" | "main";
const roots = (role: string, kind: Kind): GateRoots => ({ worktree: wt, scratch: [scr], tmp: kind === "main" ? [base, "/tmp"] : [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], childHandoff: handoff, child: kind !== "main", role, tmpAccess: kind === "main", ...(kind === "ro" ? { roundReadOnly: true } : {}) });
/** "<block|allow|ask|undecided> <rule> <sorted labels as JSON>" */
function show(line: string, role: string, kind: Kind): string {
  const o = gateEvaluate("bash", { command: line }, wt, { env: (c) => baseFloorEnv(c, kind === "main" ? {} : { child: true }), roots: () => roots(role, kind) });
  const r = o.result as { block?: boolean; allow?: boolean; ask?: boolean; rule?: string } | undefined;
  return `${r ? (r.block ? "block" : r.allow ? "allow" : r.ask ? "ask" : "other") : "undecided"} ${r?.rule ?? ""} ${JSON.stringify([...(o.dangers ?? [])].sort())}`;
}
const REFUSED = "block child-readonly-write []";
const FREE = "undecided  []";
// C: no `danger-opaque` label: a line the harness cannot read is not judge-first, it runs for builder and main
const OPAQUE = FREE;

/** Each row: the line, the outcome for reviewer and explorer, and the outcome for builder and main (the same value as before this step). */
function check(rows: Array<[string, string, string]>): void {
  for (const [line, ro, other] of rows) {
    for (const role of ["reviewer", "explorer"]) assert.equal(show(line, role, "ro"), ro, `${role}: ${line}`);
    assert.equal(show(line, "builder", "child"), other, `builder: ${line}`);
    assert.equal(show(line, "foreman", "main"), other, `main: ${line}`);
  }
}

test("a git output option or default output that lands in the worktree is refused for the read-only roles", () => {
  check([
    ["git archive -o x.tar HEAD", REFUSED, FREE],
    ["git archive -o src/x.tar HEAD", REFUSED, FREE],
    ["git archive -ox.tar HEAD", REFUSED, FREE],
    ["git archive --output=x.tar HEAD", REFUSED, FREE],
    ["git format-patch HEAD~1", REFUSED, FREE],
    ["git format-patch -1", REFUSED, FREE],
    ["git format-patch -o p HEAD~1", REFUSED, FREE],
    ["git format-patch -op HEAD~1", REFUSED, FREE],
    ["git format-patch --output-directory=p HEAD~1", REFUSED, FREE],
    ["git bundle create b.bundle HEAD", REFUSED, FREE],
    ["git checkout-index -a --prefix=out/", REFUSED, FREE],
    ["git checkout-index -a --prefix out/", REFUSED, FREE],
    ["git checkout-index -a", REFUSED, FREE],
    ["git -C sub archive -o ../x.tar HEAD", REFUSED, FREE],
    [`git -C ${W}/sub archive -o x.tar HEAD`, REFUSED, FREE],
    ["cd sub && git format-patch -1", REFUSED, FREE],
  ]);
});

test("an opaque target word with the cwd in the worktree is refused", () => {
  check([
    ["git archive -o $X HEAD", REFUSED, OPAQUE],
    ["git archive -o *.tar HEAD", REFUSED, OPAQUE],
    ["git archive -o ~/x.tar HEAD", REFUSED, OPAQUE],
    ["git format-patch -o ~/p HEAD~1", REFUSED, OPAQUE],
  ]);
});

test("stdout forms, list forms and targets in the child's own scratch dir keep their outcome", () => {
  check([
    ["git archive HEAD", FREE, FREE],
    ["git format-patch --stdout HEAD~1", FREE, FREE],
    ["git bundle verify b", FREE, FREE],
    ["git bundle list-heads b", FREE, FREE],
    ["git bundle create - HEAD", FREE, FREE],
    ["git checkout-index --stdout x", FREE, FREE],
    [`git archive -o ${S}/x.tar HEAD`, FREE, FREE],
    [`git format-patch -o ${S}/p HEAD~1`, FREE, FREE],
    [`git bundle create ${S}/b HEAD`, FREE, FREE],
    [`git checkout-index -a --prefix=${S}/o/`, FREE, FREE],
    [`git -C ${S}/c archive -o x.tar HEAD`, FREE, FREE],
    [`git -C ${S}/c format-patch -1`, FREE, FREE],
    // the output lands in the scratch dir: the cwd of the segment is the scratch dir, the repository is the worktree's
    [`cd ${S} && git --git-dir=${W}/.git archive -o x.tar HEAD`, FREE, FREE],
  ]);
});

test("neighbours: long output options and plain writes stay refused, the scratch --output over-refusal stays", () => {
  check([
    ["tee x.tar", REFUSED, OPAQUE],
    ["git diff --output=d.txt", REFUSED, FREE],
    [`git diff --output=${S}/d.txt`, REFUSED, FREE],
  ]);
});
