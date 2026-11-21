// D3b revision 2: a select / arithmetic-for body keeps the decision of the line it stands in (a rebind or an env-clearing wrapper elsewhere on the line),
// a nested -c string is read for a rebind with its own parse (an ANSI-C escape in the name), `$"..."` names count, and `node -e x -e "$C"` runs code the harness cannot read.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { r11Rig } from "./_r11rig.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { posixOnly } from "./_platform.ts";

// pi-subagents resolves the global npm root with `npm root -g` on the first skill lookup; PI_OFFLINE makes that return null without starting npm.
const savedOffline = process.env.PI_OFFLINE;
before(() => {
  process.env.PI_OFFLINE = "1";
});
after(() => {
  if (savedOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedOffline;
});

const base = fs.realpathSync(mkTestTmp("pf-d3b-rev2-"));
const wt = path.join(base, "wt");
const scratch = path.join(base, "scratch");
const out = path.join(base, "out");
for (const d of [wt, scratch, out]) fs.mkdirSync(d, { recursive: true });
after(() => rmTestTmp(base));

const roots = (): GateRoots => ({ worktree: wt, scratch: [scratch, out], out, tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false });
const eval1 = (command: string) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true, scratch: [scratch, out], out }), roots });
const judged = (command: string): boolean => {
  const r = eval1(command) as { dangers?: string[]; result?: { block?: boolean } };
  return !!r.result?.block || (r.dangers ?? []).length > 0;
};

const shapes = (n: string): string[] => [
  `printf -v ${n.slice(0, -1)}'${n.slice(-1)}' %s ~; for ((i=0;i<1;i++)); do rm -rf $${n}/Documents; done`,
  `env -i bash -c 'for ((i=0;i<1;i++)); do rm -rf $${n}/x; done'`,
  `exec -c bash -c 'select x in a; do rm -rf $${n}/x; break; done' <<< 1`,
  `${n}=/etc; select x in a; do rm -rf $${n}/x; break; done <<< 1`,
  `sh -c "printf -v ${n.slice(0, -1)}\\$'\\\\x${n.charCodeAt(n.length - 1).toString(16)}' %s ~; rm -rf \\$${n}/Documents"`,
  `printf -v $"${n.slice(0, -1)}"${n.slice(-1)} %s ~; rm -rf $${n}/Documents`,
];
const controls = (n: string): string[] => [`> $${n}/f`, `echo it's > $${n}/f`, `for f in a; do cp $f $${n}/; done`, `for ((i=0;i<2;i++)); do echo $i > $${n}/f; done`];

test("gateEvaluate: loop-body, nested-escape and locale-string rebinds are judged, both names", { skip: posixOnly }, () => {
  for (const n of ["FOREMAN_OUT", "FOREMAN_SCRATCH"]) for (const c of shapes(n)) assert.equal(judged(c), true, c);
});

test("gateEvaluate: plain uses of the folders still run", { skip: posixOnly }, () => {
  for (const n of ["FOREMAN_OUT", "FOREMAN_SCRATCH"]) for (const c of controls(n)) assert.equal(judged(c), false, c);
});

test("gateEvaluate: node -e x -e \"$C\" runs code the harness cannot read", { skip: posixOnly }, () => {
  const reasons = (c: string) => JSON.stringify(eval1(c));
  assert.ok(!reasons(`node -e x -e "$C"`).includes("the code is in the command"));
  assert.ok(reasons(`node -e x`).includes("the code is in the command") || !reasons(`node -e x`).includes("cannot read"));
});

const ASK = JSON.stringify({ verdict: "unsure", reason: "cannot tell" });
const registry = () => ({ find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: ASK }], stopReason: "stop", usage: { input: 1, output: 1 } }) });
const config = { gate: { askTimeoutMs: 600000 }, presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } } };

for (const role of ["reviewer", "builder"]) {
  test(`caller path (${role}): the revision shapes are not run, the controls run`, { skip: posixOnly }, async (t) => {
    const dir = fs.realpathSync(mkTestTmp("pf-d3b-rev2c-"));
    t.after(() => rmTestTmp(dir));
    const sc = path.join(dir, "scratch");
    const o = path.join(dir, "out");
    for (const d of [sc, o]) fs.mkdirSync(d, { recursive: true });
    const prev = process.env[BINDINGS_ENV];
    process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role, launchId: "L9", kind: "first", model: null, scratch: sc, out: o } });
    t.after(() => {
      if (prev === undefined) delete process.env[BINDINGS_ENV];
      else process.env[BINDINGS_ENV] = prev;
    });
    const child = await r11Rig(t, {}, { ctx: { modelRegistry: registry() }, config, child: true });
    for (const n of ["FOREMAN_OUT", "FOREMAN_SCRATCH"]) {
      for (const command of shapes(n)) assert.equal((await child.call("bash", { command }))?.block, true, `${role}: ${command}`);
      if (role === "builder") for (const command of controls(n)) assert.equal(await child.call("bash", { command }), undefined, `${role}: ${command}`);
    }
  });
}
