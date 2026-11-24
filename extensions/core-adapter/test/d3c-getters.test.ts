// D3c item 16: unbash keeps Assignment.name / value, Word.parts, expansion scripts and arithmetic expressions as prototype getters; a walk with Object.values never reads them,
// so `declare -n r='FOREMAN_'OUT; r=$HOME; rm -rf $FOREMAN_OUT/Documents` ran. The walk now uses the library's forEachChild.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { forEachChild, parse } from "unbash";
import { namedOutsideExpansion } from "../shellast.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { r11Rig } from "./_r11rig.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { posixOnly } from "./_platform.ts";

const savedOffline = process.env.PI_OFFLINE;
before(() => {
  process.env.PI_OFFLINE = "1";
});
after(() => {
  if (savedOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedOffline;
});

// One probe per getter field of an unbash node class: the name FOREMAN_OUT stands only inside that field, spelled so that it is not a `$NAME` expansion.
// Derived by listing `Object.getOwnPropertyDescriptors(Object.getPrototypeOf(node))` getters over the nodes of the corpus below (the test "every getter ..." redoes it).
const N = "FOREMAN_OUT";
const PROBES: Record<string, string> = {
  "Assignment.name": `FOREMAN_OU\\T=1`,
  "Assignment.value": `a=${N}`,
  "Assignment.append": `FOREMAN_OU\\T+=1`,
  "Assignment.index": `a[${N}]=1`,
  "ArrayValue.elements": `a=(${N})`,
  "Command.args": `echo ${N}`,
  "Command.redirects": `echo x > ${N}`,
  "Word.value": `echo ${N}`,
  "Word.parts": `echo "x ${N}"`,
  "CommandExpansion.script": `echo $(echo ${N})`,
  "ProcessSubstitution.script": `cat <(echo ${N})`,
  "ArithmeticCommandExpansion.script": `echo $(( $(echo ${N}) ))`,
  "ArithmeticExpansion.expression": `echo $(( $(echo ${N}) ))`,
  "ArithmeticCommand.expression": `(( $(echo ${N}) ))`,
  "ArithmeticFor.initialize": `for (( i=$(echo ${N}); ; )); do :; done`,
  "ArithmeticFor.test": `for (( ; $(echo ${N}); )); do :; done`,
  "ArithmeticFor.update": `for (( ; ; $(echo ${N}) )); do :; done`,
  "HereDocBody.parts": `cat <<EOF\n$(echo ${N})\nEOF`,
};

function nodesOf(src: string): any[] {
  const out: any[] = [];
  const visit = (n: any): void => {
    out.push(n);
    forEachChild(n, visit);
  };
  visit(parse(src));
  return out;
}

test("every getter field of an unbash node class is read by the walk", () => {
  const seen = new Set<string>();
  for (const src of Object.values(PROBES)) {
    for (const n of nodesOf(src)) {
      const proto = Object.getPrototypeOf(n);
      for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) if (d.get && n.type && k !== "__proto__") seen.add(`${n.type}.${k}`);
    }
  }
  const pinned = new Set(Object.keys(PROBES));
  // a getter the corpus meets that no probe covers is a new blind spot: add a probe for it
  const uncovered = [...seen].filter((k) => !pinned.has(k) && !/^(Script|Statement)\./.test(k));
  assert.deepEqual(uncovered, []);
  for (const [field, line] of Object.entries(PROBES)) assert.equal(namedOutsideExpansion(line, N), true, `${field}: ${line}`);
});

test("the walk still accepts plain expansions", () => {
  for (const line of [`rm -rf $${N}/x`, `echo "\${${N}}/x"`, `X=1; echo > $${N}/f`, `echo $(echo $${N})`]) assert.equal(namedOutsideExpansion(line, N), false, line);
});

const shapes = (n: string): string[] => {
  const q = `'${n.slice(0, -1)}'${n.slice(-1)}`;
  const hex = `${n.slice(0, -1)}\\x${n.charCodeAt(n.length - 1).toString(16)}`;
  const end = `; r=$HOME; rm -rf $${n}/Documents`;
  return [
    `declare -n r=${q}${end}`,
    `typeset -n r=${q}${end}`,
    `f() { local -n r=${q}${end}; }; f`,
    `declare -n r=$'${hex}'${end}`,
    `declare -n r=$"${n}"${end}`,
    `X=$'${hex}' declare -n r=$X${end}`,
    `a=(${q}); declare -n r=\${a[0]}${end}`,
  ];
};
const controls = (o: string, s: string): string[] => [`> $${o}/f`, `echo it's > $${o}/f`, `X=1; echo > $${o}/f`, `for f in a b; do cp $f $${o}/; done`, `cd $${s} && cp a b`];

const base = fs.realpathSync(mkTestTmp("pf-d3c-"));
const wt = path.join(base, "wt");
const scratch = path.join(base, "scratch");
const out = path.join(base, "out");
const home = path.join(base, "home");
const agentDir = path.join(home, ".pi", "agent");
for (const d of [wt, scratch, out, agentDir]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (role: string) => (): GateRoots => ({ worktree: wt, scratch: [scratch, out], out, tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role, tmpAccess: false });
const gate = (command: string, role: string) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true, scratch: [scratch, out], out, home, agentDir }), roots: roots(role) });
const allowed = (c: string, role: string): boolean => {
  const o = gate(c, role);
  const r = o.result as { allow?: boolean } | undefined;
  return r ? r.allow === true : o.danger === null;
};

test("nameref shapes of FOREMAN_OUT / FOREMAN_SCRATCH get a danger class (judge-first for a builder, refused for a reviewer)", { skip: posixOnly }, () => {
  for (const n of ["FOREMAN_OUT", "FOREMAN_SCRATCH"]) {
    for (const c of shapes(n)) {
      for (const role of ["builder", "reviewer"]) {
        assert.equal(allowed(c, role), false, `${role}: ${c}`);
        assert.notEqual(gate(c, role).danger, null, `${role} danger: ${c}`);
      }
    }
  }
});

test("control lines still run", { skip: posixOnly }, () => {
  for (const c of controls("FOREMAN_OUT", "FOREMAN_SCRATCH")) assert.equal(allowed(c, "builder"), true, c);
});

const ASK = JSON.stringify({ verdict: "owner", class: "data-loss", reason: "cannot tell" });
const registry = () => ({ find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: ASK }], stopReason: "stop", usage: { input: 1, output: 1 } }) });
const config = { gate: { askTimeoutMs: 600000 }, presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } } };

type T = Parameters<typeof r11Rig>[0];
async function childOf(t: T, role: string) {
  const dir = fs.realpathSync(mkTestTmp("pf-d3c-caller-"));
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
  return r11Rig(t, {}, { ctx: { modelRegistry: registry() }, config, child: true });
}

for (const role of ["reviewer", "builder"]) {
  test(`caller path (${role}): nameref shapes are judged or refused, controls run`, { skip: posixOnly }, async (t) => {
    const child = await childOf(t, role);
    for (const n of ["FOREMAN_OUT", "FOREMAN_SCRATCH"]) {
      for (const command of shapes(n)) assert.equal((await child.call("bash", { command }))?.block, true, `${role}: ${command}`);
    }
    if (role === "builder") for (const command of controls("FOREMAN_OUT", "FOREMAN_SCRATCH")) assert.equal(await child.call("bash", { command }), undefined, command);
  });
}
