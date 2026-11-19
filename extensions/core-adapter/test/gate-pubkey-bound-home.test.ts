// A line that may rebind HOME is no verified public-key read: the gate must not add floor-pubkey-read for it (round 2, step 1 revision).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateDecide, type GateResult } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-gate-pub-bound-"));
test.after(() => rmTestTmp(base));
const home = path.join(base, "home");
const ssh = path.join(home, ".ssh");
const work = path.join(base, "work");
const agent = path.join(home, ".pi", "agent");
for (const d of [ssh, work, agent]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(ssh, "k.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host\n");

const roots = { worktree: work, scratch: [], tmp: [], scratchBase: path.join(base, "scr"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false } as never;
const env: FloorEnv = { cwd: work, home, agentDir: agent, writeRoots: [work] };
const decide = (command: string): GateResult =>
  gateDecide("bash", { command }, work, { env: () => env, roots: () => roots, rules: { env: { cwd: work, home, platform: process.platform, checkout: work } } });
const allowedByPubkey = (r: GateResult): boolean => !!r && "allow" in r && /floor-pubkey-read/.test(r.rule ?? "");

test("wait -p HOME rebinds HOME: the line is not allowed as a public-key read", () => {
  assert.equal(allowedByPubkey(decide("sleep 1 & wait -p HOME; cat $HOME/.ssh/k.pub")), false);
});

test("without a rebinding the same read is allowed as a public-key read", () => {
  assert.equal(allowedByPubkey(decide("sleep 1 & wait; cat $HOME/.ssh/k.pub")), true);
});

const decide2 = (command: string): GateResult =>
  gateDecide("bash", { command }, work, { env: () => env, roots: () => roots, rules: { env: { cwd: work, home, platform: process.platform, checkout: work } } });

test("test -v 'a[HOME=1]' rebinds HOME: the line is not allowed as a public-key read", () => {
  assert.equal(allowedByPubkey(decide2("test -v 'a[HOME=1]'; cat $HOME/.ssh/k.pub")), false);
});

test("compgen -V HOME rebinds HOME: the line is not allowed as a public-key read", () => {
  assert.equal(allowedByPubkey(decide2("compgen -V HOME -W x; cat $HOME/.ssh/k.pub")), false);
});

for (const line of [
  "test -v 'a[$(cat f)]'; cat $HOME/.ssh/k.pub",
  "test -v 'a[`cat f`]'; cat $HOME/.ssh/k.pub",
  "test -v 'a[$(<f)]'; cat $HOME/.ssh/k.pub",
  "test -v 'a[`printf HOME\\x3d1`]'; cat $HOME/.ssh/k.pub",
  "test -v 'a[$1]'; cat $HOME/.ssh/k.pub",
]) {
  test(`${line}: not allowed as a public-key read (revision 3)`, () => {
    assert.equal(allowedByPubkey(decide2(line)), false);
  });
}
