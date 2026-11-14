// Guard round 1, step 4: rows that pin faults already fixed, none of which a test held before. Each sits beside a must-stay-refused row.
// Held elsewhere and only cited here: floor words in the prose fields of foreman_show, the session brief, notes (g8-script-notes.test.ts, gate-payload-tools.test.ts),
// own-ruling read chains with `git ls-remote` and a refused write to a ruling (r42-self-ruling-git-readonly.test.ts), overlay reads of protected paths
// (r29-protected-read-only.test.ts), a child's ask ended by an away owner (gate-child-ask-lines.test.ts, the wait answers `away`; the owner's own ask:
// gate-away-floor.test.ts). Test text with guarded words is data.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateDecide, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const HOME = "/Users/someone";
const KEY = `${HOME}/.ssh/id_rsa`;
type R = { block?: true; allow?: true; rule?: string } | undefined;
const plain = (tool: string, input: unknown): R => gateDecide(tool, input, process.cwd(), { env: (cwd: string) => baseFloorEnv(cwd, { home: HOME }) }) as R;

test("prose fields of foreman_show (title, summary, note) and of the session brief (label, context, notes) are not floor-denied; its command and path fields are", () => {
  const words = "wipe with `fdisk /dev/sda`, `sudo ls`, npm publish, then reboot";
  for (const field of ["title", "summary", "note"]) assert.equal(plain("foreman_show", { markdown: "x", [field]: words }), undefined, field);
  for (const field of ["label", "context", "notes"]) assert.equal(plain("foreman_session_open", { brief: "x", [field]: words }), undefined, field);
  // beside it: the same words in a command field, and a secret path in any field, stay refused
  assert.ok(plain("foreman_show", { markdown: "x", command: words })?.block);
  assert.ok(plain("foreman_session_open", { brief: "x", cmd: words })?.block);
  assert.ok(plain("foreman_show", { markdown: "x", path: KEY })?.block);
  assert.ok(plain("foreman_session_open", { brief: "x", cwd: KEY })?.block);
});

const base = fs.realpathSync(mkTestTmp("pf-pins-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [path.join(wt, "sub"), scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));
const roots: GateRoots = { worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "reviewer", tmpAccess: false, roundReadOnly: true };
const reviewer = (command: string): { block?: boolean; rule?: string } | undefined =>
  gateEvaluate("bash", { command }, wt, { env: (c) => baseFloorEnv(c, { child: true }), roots: () => roots }).result as { block?: boolean; rule?: string } | undefined;

test("a reviewer's read lines pass the gate; the write forms beside them are refused as child-readonly-write", () => {
  for (const l of [
    "grep -n foo sub/a.ts", "grep -rn foo .", "sed -n '1,20p' sub/a.ts", "ls", "ls sub", "cat README.md | head -3", "cat *.md | head -3", "ls ~ | head -1", "git reflog -n 1",
    "git show-branch --list", "git check-ignore -v x", "git var GIT_AUTHOR_IDENT", "git log --oneline -5", "git diff --stat", "git ls-remote origin round/x",
  ]) {
    const v = reviewer(l);
    assert.ok(!v?.block, `${l} -> ${JSON.stringify(v)}`);
  }
  for (const l of ["sed -i s/a/b/ sub/a.ts", "echo x > sub/a.ts", "git commit -m x", "cat a | tee sub/a.ts"]) {
    const v = reviewer(l);
    assert.ok(v?.block && v.rule === "child-readonly-write", `${l} -> ${JSON.stringify(v)}`);
  }
});

test("open gap, verdict of today: a git subcommand outside the write set that rewrites history is not refused by the read-only fence", () => {
  // `git reflog expire --all` is in no write set of the gate and names no path: it goes on to the judge or the parent as before (docs/safety.md, read-only roles, known limit)
  assert.equal(reviewer("git reflog expire --all"), undefined);
  // beside it: the write set the gate does know is refused
  assert.equal(reviewer("git reset --hard")?.rule, "child-readonly-write");
});
