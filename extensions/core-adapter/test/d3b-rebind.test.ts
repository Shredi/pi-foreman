// D3b: a rebind of FOREMAN_OUT / FOREMAN_SCRATCH spelled with quotes or escapes must not leave the name a harness constant: the line is judged for a builder and refused
// for a read-only reviewer; plain `$NAME` / `${NAME}` lines still resolve.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-d3b-"));
const wt = path.join(base, "wt");
const scratch = path.join(base, "scratch");
const out = path.join(base, "out");
const home = path.join(base, "home");
const agentDir = path.join(home, ".pi", "agent");
for (const d of [wt, scratch, out, agentDir]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (role: string) => (): GateRoots => ({ worktree: wt, scratch: [scratch, out], out, tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role, tmpAccess: false });
const gate = (command: string, role: string) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true, scratch: [scratch, out], out, home, agentDir }), roots: roots(role) });
/** The gate finds nothing to refuse or ask: an allow verdict, or no verdict and no danger class. */
const allowed = (c: string, role: string): boolean => {
  const o = gate(c, role);
  const r = o.result as { allow?: boolean } | undefined;
  return r ? r.allow === true : o.danger === null;
};

const rebinds = (n: string): string[] => {
  const q = `${n.slice(0, -1)}'${n.slice(-1)}'`;
  const dq = `${n.slice(0, -3)}"${n.slice(-3)}"`;
  const esc = `${n.slice(0, -1)}\\${n.slice(-1)}`;
  return [
    `printf -v ${q} %s ~; rm -rf $${n}/Documents`,
    `${esc}=/etc; rm -rf $${n}/x`,
    `read ${dq} <<< /etc; rm -rf $${n}/x`,
    `declare ${q}=/etc; rm -rf $${n}/x`,
    `typeset ${esc}=/etc; rm -rf $${n}/x`,
    `export ${q}=/etc; rm -rf $${n}/x`,
    `local ${dq}=/etc; rm -rf $${n}/x`,
    `readonly ${esc}=/etc; rm -rf $${n}/x`,
    `"${n}"=/etc; rm -rf $${n}/x`,
    `sh -c 'printf -v ${q} %s ~; rm -rf $${n}/x'`,
    `env ${q}=/etc sh -c "rm -rf \\$${n}/x"`,
    `printf -v ${q} %s ~; rm -rf \${${n}}/x`,
  ];
};

test("a quoted or escaped rebind of FOREMAN_OUT / FOREMAN_SCRATCH is judged for a builder and refused for a reviewer", { skip: posixOnly }, () => {
  for (const n of ["FOREMAN_OUT", "FOREMAN_SCRATCH"]) {
    for (const c of rebinds(n)) {
      assert.equal(allowed(c, "builder"), false, `builder: ${c}`);
      // gateEvaluate gives a danger class and no allow verdict; the caller turns that into a judge call (builder) or a refusal (read-only reviewer)
      assert.equal(allowed(c, "reviewer"), false, `reviewer: ${c}`);
      assert.notEqual(gate(c, "reviewer").danger, null, `reviewer danger: ${c}`);
    }
  }
});

test("plain $NAME and ${NAME} lines still resolve to the harness folders", { skip: posixOnly }, () => {
  for (const c of ["echo it's > $FOREMAN_OUT/f", 'echo x > "${FOREMAN_OUT}/f"', "cd $FOREMAN_SCRATCH && cp a b", "echo x > $FOREMAN_SCRATCH/f", "rm -rf $FOREMAN_OUT/sub"]) {
    assert.equal(allowed(c, "builder"), true, `builder: ${c}`);
  }
});

test("a name inside a data word that is not an expansion is not resolved (refusing is accepted)", { skip: posixOnly }, () => {
  // the design cannot tell a bare name in a data word from a rebind, so it refuses to resolve
  assert.equal(allowed("echo FOREMAN_OUT > $FOREMAN_OUT/f", "builder"), false);
});
