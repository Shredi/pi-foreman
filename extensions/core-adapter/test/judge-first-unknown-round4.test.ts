// Judge-first-unknown round 4: unread runners (`ionice`, `chroot`, `unbuffer`, `parallel`, `busybox sh -c`), `env` layers behind `env`, and `env` settings with a name that is no shell identifier.
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

const base = fs.realpathSync(mkTestTmp("pf-jfu5-"));
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


const W = "echo x > $FOREMAN_SCRATCH/.zshrc";
const BAD = [
  "ionice -c3 rm -rf ~/Documents",
  "chroot / sh -c 'echo x > ~/.zshrc'",
  "unbuffer rm -rf ~/Documents",
  "parallel rm -rf ::: ~/Documents",
  "busybox sh -c 'echo x > ~/.zshrc'",
  `env env BASH_ENV=rc bash -c '${W}'`,
  `env -i env BASH_ENV=rc bash -c '${W}'`,
  `env A=1 env BASH_ENV=rc bash -c '${W}'`,
  `env timeout 5 env BASH_ENV=rc bash -c '${W}'`,
  `env env ENV=x sh -c '${W}'`,
  "env A-B=1 rm -rf ~/Documents",
  `env 'BASH_FUNC_true%%=() { :; }' bash -c '${W}'`,
];
const KEEP = ["busybox ls", "echo env BASH_ENV=x; echo y > $FOREMAN_SCRATCH/f"];
for (const role of ["builder", "reviewer"] as const) {
  test(`${role}: unread runners, env behind env and odd env setting names are judged or refused`, { skip: posixOnly }, () => {
    for (const l of BAD) {
      const g = gate(l, role);
      assert.ok(!g.result?.allow && (g.danger !== null || g.result?.block), `${l}: ${JSON.stringify(g)}`);
    }
  });
  test(`${role}: busybox applets and a harmless env word keep running`, { skip: posixOnly }, () => {
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
    const keepBefore = classifier;
    assert.equal(await c.call("bash", { command: "busybox ls" }), undefined, "busybox ls runs");
    assert.equal(classifier, keepBefore, "busybox ls: no judge");
    for (const command of BAD) {
      const before = classifier;
      const res = await c.call("bash", { command });
      assert.ok(res?.block || classifier === before + 1, `${command.slice(0, 120)}: judged or refused ${JSON.stringify(res)}`);
    }
  });
}
