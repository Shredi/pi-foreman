// Guard false blocks 2 (PR-B): a builder from a single launch pushes like the main session; every other child
// (reviewer, explorer, overlay role, unbound, group launch) stays refused by the floor. Force and protected pushes stay refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { gateDecide, type GateResult } from "../gate.ts";
import type { GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/s/scr", "/tmp"], protectedBranches: ["release"], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const builder: FloorEnv = { ...env, child: true, builder: true };
const other: FloorEnv = { ...env, child: true };

const rule = (line: string, e: FloorEnv): string | null => lineFloors(line, parseShell(line, { cwd: e.cwd }), e)?.rule ?? null;

test("a builder's push is not floored; a git stash push and unparsed stash lines pass", () => {
  for (const l of ["git push origin feature", "git push -u origin HEAD", "git status && git push origin round/x", "git stash push -m x", "T=x; $T f; git stash push -q f"]) {
    assert.equal(rule(l, builder), null, l);
  }
});

test("a child that is not a builder never pushes, parsed or unparsed, in any cwd", () => {
  const lines = ["git push origin HEAD", "git push origin round/x", "G=git; $G push origin round/x"];
  for (const cwd of ["/w/repo", "/elsewhere/not-a-round"]) {
    // reviewer, explorer, overlay role and unbound child all reach the floor as `child` without the builder flag
    const e: FloorEnv = { ...other, cwd };
    for (const l of lines) assert.equal(rule(l, e), "floor-git-push-child", `${cwd}: ${l}`);
  }
  assert.equal(rule("git push origin x", other), "floor-git-push-child");
  assert.match(lineFloors("git push origin x", parseShell("git push origin x", { cwd: other.cwd }), other)?.reason ?? "", /never push; the foreman pushes/);
});

test("a builder without a launch binding (group launch) is a child without the flag: refused", () => {
  const groupLaunched: FloorEnv = { ...env, child: true, builder: false };
  assert.equal(rule("git push origin feature", groupLaunched), "floor-git-push-child");
});

test("force, delete and protected pushes stay refused for a builder and for main, parsed and unparsed", () => {
  for (const e of [builder, env]) {
    assert.equal(rule("git push --force origin feature", e), "floor-git-push-force");
    assert.equal(rule("git push origin main", e), "floor-git-push-protected");
  }
  for (const l of ["G=git; $G push -f origin feature", "G=git; $G push origin +feature", `sh -c "$X git push origin main"`]) {
    const b = rule(l, builder);
    assert.ok(b === "floor-git-push-force" || b === "floor-git-push-protected", `builder ${l}: ${b}`);
    const m = lineFloors(l, parseShell(l, { cwd: env.cwd }), env);
    assert.ok(m && m.rule.startsWith("floor-git-push"), `main ${l}`);
  }
});

test("an unparsed protected push on main is an owner ask, not a deny", () => {
  const l = `sh -c "$X git push origin main"`;
  const m = lineFloors(l, parseShell(l, { cwd: env.cwd }), env);
  assert.ok(m && m.rule.startsWith("floor-git-push"), JSON.stringify(m));
  assert.equal(m.kind, "ask");
});

const facts: GitFacts = { currentBranch: () => "round/41-x", protectedBranches: () => ["main", "master", "trunk"], pushConfigured: () => false };
const roots = (o: Partial<GateRoots>): GateRoots => ({
  worktree: "/w/repo", scratch: [], tmp: ["/tmp"], scratchBase: "/tmp/pi-foreman-scratch", owned: [], install: [], roundFlow: [], handoffs: [],
  child: false, role: "foreman", tmpAccess: true, ...o,
});
const gate = (line: string, r: Partial<GateRoots>, e: FloorEnv): GateResult => gateDecide("bash", { command: line }, "/w/repo", { env: () => e, roots: () => roots(r), facts });

test("pushOk: a builder's own-branch push is allowed by default; any other child's is not", () => {
  const ok = gate("git push origin HEAD", { child: true, role: "builder", builder: true }, builder);
  assert.ok(ok && "allow" in ok && ok.rule.includes("default-git-push"), JSON.stringify(ok));
  const refused = gate("git push origin HEAD", { child: true, role: "builder" }, other);
  assert.ok(!refused || !("allow" in refused), JSON.stringify(refused));
  const main = gate("git push origin HEAD", {}, env);
  assert.ok(main && "allow" in main);
});
