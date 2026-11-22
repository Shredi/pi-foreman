// Judge-first-unknown round 9: a program reached by its last component (`~/bin/cd`, `$V/bin/pushd`) is no builtin and cannot move the calling shell, so a later `rm -rf src` is still judged or refused. Gate level for builder and reviewer, and through the real tool_call handler (PI_OFFLINE=1).
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

const base = fs.realpathSync(mkTestTmp("pf-jfu9-"));
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
type Res = { allow?: boolean; block?: boolean } | undefined;
const gate = (command: string, role: Role): { result: Res; danger: string | null } => {
  const o = gateEvaluate("bash", { command }, wt, { env: (c) => baseFloorEnv(c, { child: true, scratch: [scr, out], out }), roots: () => roots(role) });
  return { result: o.result as Res, danger: o.danger?.name ?? null };
};

const RM = (p: string): string[] => [
  `${p}/cd ${scr}; rm -rf src`,
  `${p}/cd ${scr} && rm -rf src`,
  `${p}/cd ${scr} && rm -rf *`,
  `${p}/cd $FOREMAN_SCRATCH && rm -rf *`,
  `${p}/cd $FOREMAN_SCRATCH && cp a b`,
  `${p}/pushd ${scr}; rm -rf src`,
  `sh -c '${p}/cd ${scr}; rm -rf src'`,
];
const REVIEWER_BAD = [
  ...RM("~/bin"), ...RM("$V/bin"),
  `~+/cd ${scr}; rm -rf src`,
  `~root/cd ${scr}; rm -rf src`,
  `~"/bin/cd" ${scr}; rm -rf src`,
  `~/bin/c"d" ${scr}; rm -rf src`,
  `~/bin/c\\d ${scr}; rm -rf src`,
];
const BUILDER_BAD = ["~/bin/cd sub && cd .. && git commit -F msg.txt", "$V/bin/cd sub && cd .. && git commit -F msg.txt"];
const BADS: Record<Role, string[]> = { reviewer: REVIEWER_BAD, builder: BUILDER_BAD };
const KEEP = ["~/bin/tool x", "$V/bin/pip install x", "cd sub && ls", "./node_modules/.bin/tsc"];

for (const role of ["builder", "reviewer"] as const) {
  const BAD = BADS[role];
  test(`${role}: a path-qualified cd or pushd does not move the guard's directory`, { skip: posixOnly }, () => {
    for (const l of BAD) {
      const g = gate(l, role);
      assert.ok(!g.result?.allow && (g.danger !== null || g.result?.block), `${l}: ${JSON.stringify(g)}`);
    }
  });
  test(`${role}: ordinary lines keep running`, { skip: posixOnly }, () => {
    for (const l of KEEP) {
      const g = gate(l, role);
      assert.notEqual(g.danger, "danger-unknown-program", l);
      assert.equal(g.result?.block ?? false, false, l);
    }
  });
  test(`${role}: the same lines are judged as the line without the path-qualified word through the real handler`, { skip: posixOnly }, async (t: T) => {
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
    for (const k of KEEP) {
      const b4 = classifier;
      assert.equal(await c.call("bash", { command: k }), undefined, `keep line runs: ${k}`);
      assert.equal(classifier, b4, `keep line: no judge: ${k}`);
    }
    // the rig's cwd is no read-only root, so the reference is the same line with the path-qualified word swapped for `echo`: both must give the same outcome
    const words = ["~/bin/cd", "$V/bin/cd", "~+/cd", "~root/cd", '~"/bin/cd"', '~/bin/c"d"', "~/bin/c\\d", "~/bin/pushd", "$V/bin/pushd"];
    const run = async (command: string): Promise<{ blocked: boolean; judged: number }> => {
      const before = classifier;
      const res = await c.call("bash", { command });
      return { blocked: !!res?.block, judged: classifier - before };
    };
    for (const command of BAD) {
      const w = words.find((x) => command.includes(x));
      assert.ok(w, command);
      assert.deepEqual(await run(command), await run(command.replace(w, "echo")), `${command}: outcome differs from the same line with echo`);
    }
    // a directory change that did happen does move the guard: a write outside the worktree after a real `cd` is refused
    assert.equal((await run(`cd ${scr}; rm -rf src`)).blocked, true);
  });
}
