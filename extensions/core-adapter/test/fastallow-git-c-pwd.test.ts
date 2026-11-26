// plan D2 / ledger item 5: `git -C "$PWD"` names the tracked folder, so a harmless write in the own worktree stays allowed for a child, while the
// closed gap (an unreadable `-C` target of a git write is judged) stays closed for every other spelling.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateEvaluate, baseFloorEnv } from "../gate.ts";
import { mkTestTmp } from "./_tmpbase.ts";

let root = "";
let wt = "";
let sc = "";
before(() => {
  root = fs.realpathSync(mkTestTmp("pf-gitc-pwd-"));
  wt = path.join(root, "wt");
  sc = path.join(root, "pi-foreman-scratch", "mine");
  fs.mkdirSync(wt);
  fs.mkdirSync(sc, { recursive: true });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const child = (command: string): { block?: boolean; rule?: string } | undefined =>
  gateEvaluate("bash", { command }, wt, {
    env: (c) => baseFloorEnv(c, { child: true, home: path.join(root, "h"), platform: "linux", writeRoots: [c, root], scratch: [sc] }),
    roots: () => ({ worktree: wt, scratch: [sc], tmp: [], scratchBase: path.dirname(path.dirname(sc)), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false }),
  }).result as { block?: boolean; rule?: string } | undefined;

test("child: git -C \"$PWD\" add x in the own worktree is allowed", () => {
  for (const l of ['git -C "$PWD" add x', "git -C $PWD add x", 'git -C "${PWD}" add x']) assert.equal(child(l), undefined, l);
});

test("child: $PWD after a cd outside the worktree, or with PWD rebound, is not the own worktree", () => {
  assert.equal(child("cd /etc && git -C \"$PWD\" add x")?.rule, "child-write-outside");
  for (const l of ['PWD=/etc; git -C "$PWD" add x', 'read PWD; git -C "$PWD" add x', 'eval "$X"; git -C "$PWD" add x']) assert.notEqual(child(l), undefined, l);
});

test("child: another unreadable -C target of a git write is still refused", () => {
  for (const l of ['git -C "$HOME" add x', "git -C $UNSET add x", 'git -C "$PWD/.." add x']) assert.notEqual(child(l), undefined, l);
});
