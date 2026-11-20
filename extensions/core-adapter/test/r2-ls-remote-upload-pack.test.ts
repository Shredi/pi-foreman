// Guard round 2: `git ls-remote -u <cmd>` (the short form of `--upload-pack`, as for `clone`) is no built-in read: it comes out exactly as the `--upload-pack=` form for
// main, builder, reviewer and explorer. Every other git read row keeps its verdict. Each row is one literal "<verdict> <rule> <sorted labels>" per role. Lines are data, never run.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-lsr-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const handoff = path.join(base, "handoffs", "h1");
for (const d of [wt, scr, handoff]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

type Kind = "ro" | "child" | "main";
const roots = (role: string, kind: Kind): GateRoots => ({ worktree: wt, scratch: [scr], tmp: kind === "main" ? [base, "/tmp"] : [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], childHandoff: handoff, child: kind !== "main", role, tmpAccess: kind === "main", ...(kind === "ro" ? { roundReadOnly: true } : {}) });
/** "<block|allow|ask|undecided> <rule> <sorted labels as JSON>" */
function show(line: string, role: string, kind: Kind): string {
  const o = gateEvaluate("bash", { command: line }, wt, { env: (c) => baseFloorEnv(c, kind === "main" ? {} : { child: true }), roots: () => roots(role, kind) });
  const r = o.result as { block?: boolean; allow?: boolean; ask?: boolean; rule?: string } | undefined;
  return `${r ? (r.block ? "block" : r.allow ? "allow" : r.ask ? "ask" : "other") : "undecided"} ${r?.rule ?? ""} ${JSON.stringify([...(o.dangers ?? [])].sort())}`;
}
const ROLES: Array<[string, Kind]> = [["foreman", "main"], ["builder", "child"], ["reviewer", "ro"], ["explorer", "ro"]];
const outcomes = (line: string): string[] => ROLES.map(([role, kind]) => show(line, role, kind));

const READ = "allow default-git-read []";
const NOT_READ = ["undecided  []", "undecided  []", "block child-readonly-write []", "block child-readonly-write []"];

test("ls-remote -u is the --upload-pack form: no built-in read, for all four roles", () => {
  assert.deepEqual(outcomes("git ls-remote --upload-pack=/tmp/p origin"), NOT_READ);
  for (const line of ["git ls-remote -u /tmp/p origin", "git ls-remote -u/tmp/p origin", "git ls-remote -qu /tmp/p origin"]) {
    assert.deepEqual(outcomes(line), NOT_READ, line);
    assert.deepEqual(outcomes(line), outcomes("git ls-remote --upload-pack=/tmp/p origin"), line);
  }
});

test("the other ls-remote forms stay a built-in read", () => {
  for (const line of ["git ls-remote origin", "git ls-remote --heads origin", "git ls-remote -h origin", "git ls-remote -t origin", "git ls-remote -q origin", "git ls-remote 'ext::sh -c x' b"]) {
    assert.deepEqual(outcomes(line), [READ, READ, READ, READ], line);
  }
});

test("a -u, -o or -c of another git subcommand keeps its verdict", () => {
  assert.deepEqual(outcomes("git add -u"), ["allow default-git-add []", "allow default-git-add []", "block child-readonly-write []", "block child-readonly-write []"]);
  assert.deepEqual(outcomes("git status -u"), [READ, READ, READ, READ]);
  // C: a plain push is no judge-first kind, the main session runs it
  assert.deepEqual(outcomes("git push -u origin x"), ["undecided  []", "block floor-git-push-child []", "block floor-git-push-child []", "block floor-git-push-child []"]);
  const unread = ["undecided  []", "undecided  []", "undecided  []", "undecided  []"];
  assert.deepEqual(outcomes("git ls-files -o"), unread);
  assert.deepEqual(outcomes("git log -c"), unread);
});
