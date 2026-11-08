// Gate order with protected targets: floors and deny rules stay ahead; a protected match goes before ask rules; a pending floor ask skips it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateDecide, type GateResult } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import type { ProtectedEntry } from "../permconfig.ts";
import { parseRule } from "../rules.ts";
import type { RuleSets } from "../rules.ts";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-gate-prot-")));
const wt = path.join(base, "wt");
const agent = path.join(base, "agent");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [wt, scr, path.join(agent, "pi-foreman"), path.join(wt, ".git")]) fs.mkdirSync(d, { recursive: true });
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots: GateRoots = { worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], owned: [`${agent}/pi-foreman`], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true, agentDir: agent };
const env: FloorEnv = { cwd: wt, home: path.join(base, "home"), agentDir: agent, platform: process.platform, writeRoots: [wt, base] };
const E = (kind: ProtectedEntry["kind"], glob: string, i: number): ProtectedEntry => ({ id: `P${i}`, kind, glob, source: "user" });
const prot = [E("host", "prod-*.example.net", 1), E("path", "ops/playbooks/**", 2), E("command", "deploy-*", 3)];
const rule = (t: string) => { const r = parseRule(t); if (!r.ok) throw new Error(t); return r.rule; };
const sets = (o: { allow?: string[]; ask?: string[]; deny?: string[] }): RuleSets => ({ allow: (o.allow ?? []).map(rule), ask: (o.ask ?? []).map(rule), deny: (o.deny ?? []).map(rule) });
const g = (tool: string, input: Record<string, unknown>, o: { entries?: ProtectedEntry[]; rules?: RuleSets } = {}): GateResult =>
  gateDecide(tool, input, wt, {
    env: () => env,
    roots: () => roots,
    ...(o.entries ? { protected: o.entries } : {}),
    ...(o.rules ? { rules: { sets: o.rules, env: { cwd: wt, home: env.home as string, platform: process.platform, checkout: wt } } } : {}),
  });
const tag = (r: GateResult): string => (r ? ("ask" in r ? `ask:${r.cause}:${r.rule}` : "block" in r ? `block:${r.rule}` : `allow:${r.rule}`) : "pass");

test("a protected host match asks with cause protected and carries the match", () => {
  const r = g("bash", { command: "ssh prod-1.example.net uptime" }, { entries: prot });
  assert.ok(r && "ask" in r);
  assert.equal(r.cause, "protected");
  assert.equal(r.rule, "protected:P1");
  assert.deepEqual(r.match?.kinds, ["host"]);
  assert.equal(r.match?.remoteClasses.length, 1);
});

test("a path tool write to a protected path asks; a read of it does not", () => {
  assert.equal(tag(g("write", { path: "ops/playbooks/a.yml", content: "x" }, { entries: prot })), "ask:protected:protected:P2");
  assert.notEqual(tag(g("read", { path: "ops/playbooks/a.yml" }, { entries: prot })).split(":")[1], "protected");
});

test("a deny rule beats a protected match", () => {
  const r = g("bash", { command: "ssh prod-1.example.net uptime" }, { entries: prot, rules: sets({ deny: ["Bash(ssh *)"] }) });
  assert.equal(tag(r), "block:rule Bash(ssh *)");
});

test("a protected match is returned where an ask rule also matches", () => {
  const r = g("bash", { command: "ssh prod-1.example.net uptime" }, { entries: prot, rules: sets({ ask: ["Bash(ssh *)"] }) });
  assert.equal(tag(r), "ask:protected:protected:P1");
  // without entries the ask rule answers as before
  assert.equal(tag(g("bash", { command: "ssh prod-1.example.net uptime" }, { rules: sets({ ask: ["Bash(ssh *)"] }) })), "ask:rule:rule Bash(ssh *)");
});

test("a pending floor ask beats a protected match", () => {
  const line = "for b in $L; do jq .gate.askTimeoutMs config/foreman.json; done";
  const withEntry = g("bash", { command: line }, { entries: [E("command", "*", 1)] });
  const without = g("bash", { command: line });
  assert.ok(withEntry && "ask" in withEntry);
  assert.equal(withEntry.cause, "floor");
  assert.equal(tag(withEntry), tag(without));
});

test("a floor deny beats everything", () => {
  const r = g("bash", { command: "rm -rf /" }, { entries: [E("command", "rm", 1)] });
  assert.ok(r && "block" in r);
  assert.equal(r.layer, "floor");
});

test("no entries or an empty list: behaviour unchanged", () => {
  const plain = g("bash", { command: "ssh prod-1.example.net uptime" });
  assert.equal(tag(g("bash", { command: "ssh prod-1.example.net uptime" }, { entries: [] })), tag(plain));
  assert.notEqual(tag(plain).split(":")[1], "protected");
  assert.equal(tag(g("bash", { command: "git log -- ops/playbooks/a.yml" }, { entries: prot })).startsWith("allow"), true);
});
