// Judge-first-unknown round 10: a tilde program word with quoted parts (`~/bin/"git"`) is named by its decoded word, so it gets what the unquoted word gets; a literal path-qualified `cd` (`/x/cd DIR`) does not move the guard's directory. Gate level for builder and reviewer, and through the real tool_call handler (PI_OFFLINE=1).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { posixOnly } from "./_platform.ts";

process.env.PI_OFFLINE = "1";

const base = fs.realpathSync(mkTestTmp("pf-jfu10-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "tmp", "pi-foreman-out", "mine");
const handoff = path.join(base, "handoffs", "h1");
for (const d of [wt, scr, out, handoff]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

type T = Parameters<typeof r11Rig>[0];
type Role = "builder" | "reviewer";
const roots = (role: Role): GateRoots => ({
  worktree: wt, scratch: [scr, out], out, tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], childHandoff: handoff,
  child: true, role, tmpAccess: false, ...(role === "reviewer" ? { roundReadOnly: true } : {}),
});
type Res = ({ allow?: boolean; block?: boolean } & { rule?: string }) | undefined;
const gate = (command: string, role: Role): { result: Res; danger: string | null } => {
  const o = gateEvaluate("bash", { command }, wt, { env: (c) => baseFloorEnv(c, { child: true, scratch: [scr, out], out }), roots: () => roots(role) });
  return { result: o.result as Res, danger: o.danger?.name ?? null };
};

const QUOTED = [
  `sh -c '~/bin/"git" push --force'`,
  `~/../../usr/bin/env ~/bin/"git" push --force`,
  `~/../../usr/bin/env ~'/bin/git' push --force`,
  `~/bin/"git" push --force`,
  `~/../../usr/bin/env ~/bin/"ssh" host 'mkfs /dev/sda'`,
  `~/bin/"dd" of=/dev/sda`,
];
// each quoted line and the same line with the program word plain
const plainOf = (l: string): string => l.replace(/~\/bin\/"(\w+)"/g, "~/bin/$1").replace("~'/bin/git'", "~/bin/git");
const CD = [`/x/cd ${scr}; rm -rf src`, `/x/cd $FOREMAN_SCRATCH; rm -rf src`, `$V/bin/cd ${scr}; rm -rf src`];
const KEEP = ["~/bin/tool x", "$V/bin/pip install x", "cd sub && ls", "./node_modules/.bin/tsc", "~/bin/\"tool\" x"];

for (const role of ["builder", "reviewer"] as const) {
  test(`${role}: a quoted tilde program word gets what the unquoted one gets`, { skip: posixOnly }, () => {
    for (const l of QUOTED) {
      const shape = (x: { result: Res; danger: string | null }) => ({ allow: !!x.result?.allow, block: !!x.result?.block, rule: x.result?.rule, danger: x.danger });
      const q = shape(gate(l, role));
      const p = shape(gate(plainOf(l), role));
      assert.deepEqual(q, p, `${l}: ${JSON.stringify(q)} vs ${JSON.stringify(p)}`);
    }
    for (const l of QUOTED.slice(0, 3)) {
      const g = gate(l, role);
      assert.ok(!g.result?.allow && (g.danger !== null || g.result?.block), `${l}: ${JSON.stringify(g)}`);
    }
  });
  if (role === "reviewer") {
    test("reviewer: a literal path-qualified cd does not move the guard's directory", { skip: posixOnly }, () => {
      for (const l of CD) {
        const g = gate(l, role);
        assert.ok(!g.result?.allow && (g.danger !== null || g.result?.block), `${l}: ${JSON.stringify(g)}`);
      }
    });
  }
  test(`${role}: ordinary lines keep running`, { skip: posixOnly }, () => {
    for (const l of KEEP) {
      const g = gate(l, role);
      assert.notEqual(g.danger, "danger-unknown-program", l);
      assert.equal(g.result?.block ?? false, false, l);
    }
  });
  test(`${role}: through the real handler the quoted line matches the plain one`, { skip: posixOnly }, async (t: T) => {
    const saved = { b: process.env[BINDINGS_ENV], c: process.env.FOREMAN_CHECKOUT };
    t.after(() => {
      if (saved.b === undefined) delete process.env[BINDINGS_ENV];
      else process.env[BINDINGS_ENV] = saved.b;
      if (saved.c === undefined) delete process.env.FOREMAN_CHECKOUT;
      else process.env.FOREMAN_CHECKOUT = saved.c;
    });
    process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role, launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
    delete process.env.FOREMAN_CHECKOUT;
    let classifier = 0;
    const verdict = JSON.stringify({ verdict: "clear", reason: "stub" });
    const modelRegistry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => { classifier++; return { content: [{ type: "text", text: verdict }], stopReason: "stop", usage: { input: 1, output: 1 } }; } };
    const ui = { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
    const config = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } } };
    const c = await r11Rig(t, {}, { ctx: { modelRegistry, ui }, config, child: true });
    const run = async (command: string): Promise<{ blocked: boolean; judged: number }> => {
      const before = classifier;
      const res = await c.call("bash", { command });
      return { blocked: !!res?.block, judged: classifier - before };
    };
    for (const l of QUOTED) assert.deepEqual(await run(l), await run(plainOf(l)), `${l}: outcome differs from the plain word`);
    for (const l of QUOTED.slice(0, 3)) {
      const r = await run(l);
      assert.ok(r.blocked || r.judged > 0, `${l}: ${JSON.stringify(r)}`);
    }
    for (const k of KEEP) {
      const b4 = classifier;
      assert.equal(await c.call("bash", { command: k }), undefined, `keep line runs: ${k}`);
      assert.equal(classifier, b4, `keep line: no judge: ${k}`);
    }
    // the rig's cwd is no read-only root: the reference is the same line with the path-qualified word swapped for `echo`
    for (const l of CD) assert.deepEqual(await run(l), await run(l.replace(/^\S+cd/, "echo")), `${l}: outcome differs from the line with echo`);
  });
}
