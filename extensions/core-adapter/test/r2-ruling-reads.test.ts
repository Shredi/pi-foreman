// Round 2, step 6a: the own-ruling ask is deleted, so the three pins that locked in its false asks (`git reflog`, `git whatchanged`, `git verify-commit` next to a read of a
// parent's ruling, r42-self-ruling-git-readonly.test.ts STILL_ASKED rows) become "not refused, not asked" rows at the gate: no block and no ask for any role.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseFloorEnv, gateDecide, type GateResult } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";

const W = "/Users/r2fx/proj";
const H = `${W}/.workflow/handoffs/up`;
const GREP = `grep -n -i -B1 -A3 'approved' ${H}/brief*.md ${H}/ruling*.md | cut -c1-200`;
const readChain = `${GREP}; git diff --stat origin/main..HEAD`;

const decide = (role: string, command: string): GateResult => {
  const child = role !== "foreman";
  const roots: GateRoots = {
    worktree: W, ...(role === "reviewer" ? { roundReadOnly: true } : {}), scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [H], ...(child ? { childHandoff: H } : {}), child,
    agentDir: "/Users/r2fx/agent", role, tmpAccess: true, pkgRoot: "/Users/r2fx/pkg",
  };
  return gateDecide("bash", { command }, W, {
    env: (x) => baseFloorEnv(x, { home: "/Users/r2fx/home", platform: "darwin", agentDir: "/Users/r2fx/agent", pkgRoot: "/Users/r2fx/pkg", ...(child ? { child: true } : {}), writeRoots: [W] }),
    roots: () => roots,
  });
};

// r42-self-ruling-git-readonly.test.ts "still asked next to a ruling read: git reflog / git whatchanged / git verify-commit"
for (const cmd of ["git reflog", "git whatchanged", "git verify-commit HEAD"]) {
  test(`${cmd}: neither refused nor asked, alone and after a read of a ruling`, () => {
    for (const line of [cmd, `${readChain}; ${cmd}`]) {
      for (const role of ["foreman", "builder", "reviewer"]) {
        const r = decide(role, line);
        assert.ok(!(r && "block" in r && r.block), `${role} refused: ${line}`);
        assert.ok(!(r && "ask" in r && r.ask), `${role} asked: ${line}`);
      }
    }
  });
}
