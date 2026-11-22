// Judge-first-unknown round 3: shell options the walker does not read (`--rcfile`, `--init-file`) and `env BASH_ENV=x` / `env ENV=x` operands.
// Gate level for builder and reviewer, and through the real tool_call handler (PI_OFFLINE=1).
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

const base = fs.realpathSync(mkTestTmp("pf-jfu4-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "tmp", "pi-foreman-out", "mine");
const handoff = path.join(base, "handoffs", "h1");
for (const d of [path.join(wt, "sub"), scr, out, handoff]) fs.mkdirSync(d, { recursive: true });
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


const BAD = [
  "bash --rcfile /dev/null -c 'echo x > ~/.zshrc'",
  "bash --rcfile /dev/null -c 'E=sh; $E -c ls'",
  "bash --init-file x -c ls",
  "env BASH_ENV=x bash -c 'echo x > $FOREMAN_SCRATCH/.zshrc'",
  "env ENV=x sh -c 'echo x > $FOREMAN_SCRATCH/.zshrc'",
  "timeout 5 env BASH_ENV=x bash -c 'echo x > $FOREMAN_SCRATCH/.zshrc'",
  "env -u FOO BASH_ENV=x bash -c 'echo x > $FOREMAN_SCRATCH/.zshrc'",
];
const KEEP = ["bash $FOREMAN_SCRATCH/x.sh", 'sh "$FOREMAN_SCRATCH/run.sh"', "bash --norc -c 'echo x > $FOREMAN_SCRATCH/f'", "bash -lc 'ls'"];
for (const role of ["builder", "reviewer"] as const) {
  test(`${role}: unread shell options and env startup-file operands are judged or refused`, { skip: posixOnly }, () => {
    for (const l of BAD) {
      const g = gate(l, role);
      assert.ok(!g.result?.allow && (g.danger !== null || g.result?.block), `${l}: ${JSON.stringify(g)}`);
    }
  });
  test(`${role}: script files in the harness folder and options the walker reads still run`, { skip: posixOnly }, () => {
    for (const l of KEEP.slice(0, 3)) assert.notEqual(gate(l, role).danger, "danger-unknown-program", l);
    for (const l of KEEP.slice(0, 2)) assert.equal(gate(l, role).result?.block ?? false, false, l);
  });
  test(`${role}: the same lines reach the judge or are refused through the real handler`, { skip: posixOnly }, async (t: T) => {
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
    for (const command of BAD) {
      const before = classifier;
      const res = await c.call("bash", { command });
      assert.ok(res?.block || classifier === before + 1, `${command.slice(0, 120)}: judged or refused ${JSON.stringify(res)}`);
    }
  });
}
