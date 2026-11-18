// Round 2, step 1, revision 4, at the gate: a name built by an expansion or an attached option is no verified public-key read; a quoted `$` is no expansion.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateDecide, type GateResult } from "../gate.ts";
import type { FloorEnv } from "../floors.ts";
import { parseRule } from "../rules.ts";
import type { RuleSets } from "../rules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-gate-pub-exp-"));
test.after(() => rmTestTmp(base));
const home = path.join(base, "home");
const ssh = path.join(home, ".ssh");
const work = path.join(base, "work");
const agent = path.join(home, ".pi", "agent");
for (const d of [ssh, work, agent]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(ssh, "k.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host\n");

const roots = { worktree: work, scratch: [], tmp: [], scratchBase: path.join(base, "scr"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false } as never;
const env: FloorEnv = { cwd: work, home, agentDir: agent, writeRoots: [work] };
const rule = (t: string) => {
  const r = parseRule(t);
  if (!r.ok) throw new Error(t);
  return r.rule;
};
const sets: RuleSets = { allow: ["Bash(echo *)", "Bash(wait *)", "Bash(compgen *)"].map(rule), ask: [], deny: [] };
const decide = (command: string): GateResult =>
  gateDecide("bash", { command }, work, { env: () => env, roots: () => roots, rules: { sets, env: { cwd: work, home, platform: process.platform, checkout: work } } });
const allowedByPubkey = (r: GateResult): boolean => !!r && "allow" in r && /floor-pubkey-read/.test(r.rule ?? "");

for (const line of [
  "wait -p $NOPE'HOME'; cat $HOME/.ssh/k.pub",
  'wait -p "$NOPE"HOME; cat $HOME/.ssh/k.pub',
  "wait -p {HOME,}; cat $HOME/.ssh/k.pub",
  "compgen -V {HOME,} -W x; cat $HOME/.ssh/k.pub",
  "x=HOME; y=x; wait -p ${!y}; cat $HOME/.ssh/k.pub",
  "wait -pHOME; cat $HOME/.ssh/k.pub",
  "wait -npHOME; cat $HOME/.ssh/k.pub",
  "compgen -W x -VHOME; cat $HOME/.ssh/k.pub",
]) {
  test(`${line}: not allowed as a public-key read`, () => {
    assert.equal(allowedByPubkey(decide(line)), false);
  });
}

for (const line of ["echo 'cost $5'; cat ~/.ssh/k.pub", "echo '$(date)'; cat ~/.ssh/k.pub", "echo 'a `b`'; cat ~/.ssh/k.pub"]) {
  test(`${line}: allowed as a public-key read`, () => {
    assert.equal(allowedByPubkey(decide(line)), true);
  });
}
