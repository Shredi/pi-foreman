// Judge-first-unknown round 8: a tilde program word (`~/../../usr/bin/env …`) is read by its last component like `$V/bin/pip`, so the wrapped program is walked; a program word
// the walk cannot reduce to a name is judged or refused. Gate level for builder and reviewer, and through the real tool_call handler (PI_OFFLINE=1).
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

const base = fs.realpathSync(mkTestTmp("pf-jfu8-"));
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

const BAD = [
  "~/../../usr/bin/env rm -rf ~/Documents",
  "~/../../usr/bin/env -S 'rm -rf ~/Documents'",
  "~/../../usr/bin/env --ign rm -rf ~/Documents",
  "~/../../bin/sh -c 'touch /opt/zz'",
  "~/../../usr/bin/env FOREMAN_SCRATCH=/opt sh -c 'echo x > $FOREMAN_SCRATCH/f.txt'",
  "$(echo /usr)/bin/sh -c 'touch /opt/zz'",
  "*/bin/sh -c 'touch /opt/zz'",
];
const KEEP = ["~/bin/tool x", "$V/bin/pip install x", "./node_modules/.bin/tsc"];

for (const role of ["builder", "reviewer"] as const) {
  test(`${role}: a tilde or computed program word the walk cannot reduce to a name is judged or refused`, { skip: posixOnly }, () => {
    for (const l of BAD) {
      const g = gate(l, role);
      assert.ok(!g.result?.allow && (g.danger !== null || g.result?.block), `${l}: ${JSON.stringify(g)}`);
    }
  });
  test(`${role}: tilde, expansion-prefixed and relative program words that name a program keep running`, { skip: posixOnly }, () => {
    for (const l of KEEP) {
      const g = gate(l, role);
      assert.notEqual(g.danger, "danger-unknown-program", l);
      assert.equal(g.result?.block ?? false, false, l);
    }
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
    for (const k of KEEP) {
      const b4 = classifier;
      assert.equal(await c.call("bash", { command: k }), undefined, `keep line runs: ${k}`);
      assert.equal(classifier, b4, `keep line: no judge: ${k}`);
    }
    for (const command of BAD) {
      const before = classifier;
      const res = await c.call("bash", { command });
      assert.ok(res?.block || classifier === before + 1, `${command}: judged or refused ${JSON.stringify(res)}`);
    }
  });
}
