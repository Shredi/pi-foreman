// R41 selfmod rules (selfmod.ts, plan 2.5): writes that change how Pi or pi-foreman runs ask the owner (a rule ask, never a default and
// never a model call); a child is denied with what to report. Targets are judged lexically and through symlinks and hard links.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateDecide, type GateResult } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf41-selfmod-")));
const wt = path.join(base, "wt");
const agent = path.join(base, "agent");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const hand = path.join(agent, "pi-foreman", "handoffs", "h1");
const pi = path.join(wt, ".pi");
for (const d of [path.join(pi, "scratch"), path.join(pi, "tasks"), path.join(agent, "pi-foreman", "state", "live"), scr, hand, path.join(wt, ".git")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(pi, "settings.json"), "{}");
fs.symlinkSync("../settings.json", path.join(pi, "scratch", "link"));
fs.linkSync(path.join(pi, "settings.json"), path.join(pi, "scratch", "hard"));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (o: Partial<GateRoots> = {}): GateRoots => ({
  worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], owned: [`${agent}/pi-foreman`], install: [], roundFlow: [], handoffs: [hand],
  child: false, role: "foreman", tmpAccess: true, agentDir: agent, ...o,
});
const env: FloorEnv = { cwd: wt, home: path.join(base, "home"), agentDir: agent, platform: process.platform, writeRoots: [wt, base] };
const g = (tool: string, input: Record<string, unknown>, o: Partial<GateRoots> = {}): GateResult => gateDecide(tool, input, wt, { env: () => env, roots: () => roots(o) });
const sh = (line: string, o: Partial<GateRoots> = {}): GateResult => g("bash", { command: line }, o);
const ruleOf = (r: GateResult): string => (r ? ("ask" in r ? `ask:${r.rule}` : "block" in r ? `block:${r.rule}` : `allow:${r.rule}`) : "pass");

test("owner: the write and edit tools on each protected class ask with the rule name", () => {
  assert.equal(ruleOf(g("write", { path: ".pi/settings.json", content: "x" })), "ask:selfmod-project-settings");
  assert.equal(ruleOf(g("edit", { path: path.join(pi, "settings.json"), edits: [] })), "ask:selfmod-project-settings");
  assert.equal(ruleOf(g("write", { path: ".pi/extensions/x.ts", content: "x" })), "ask:selfmod-project-pi");
  assert.equal(ruleOf(g("write", { path: path.join(agent, "settings.json"), content: "x" })), "ask:selfmod-agent-settings");
  assert.equal(ruleOf(g("write", { path: path.join(agent, "pi-foreman", "state", "live", "o.json"), content: "x" })), "ask:selfmod-state");
  assert.equal(ruleOf(g("foreman_move", { src: "a.txt", dst: ".pi/settings.json" })), "ask:selfmod-project-settings");
  assert.equal(ruleOf(g("foreman_copy", { src: ".pi/settings.json", dst: "copy.json" })), "allow:path-read-worktree", "copying out of the settings file is a read");
});

test("owner: .pi/scratch and .pi/tasks stay ordinary; a plain file in the worktree stays a default", () => {
  assert.equal(ruleOf(g("write", { path: ".pi/scratch/n.md", content: "x" })), "allow:path-write-worktree");
  assert.equal(ruleOf(g("write", { path: ".pi/tasks/t.md", content: "x" })), "allow:path-write-worktree");
  assert.equal(ruleOf(g("write", { path: "src/a.ts", content: "x" })), "allow:path-write-worktree");
  assert.ok(!ruleOf(sh("echo x > .pi/scratch/n.md")).startsWith("ask:"));
});

test("owner: shell writes (redirect, cp, mv, rm, ln) on a protected file ask", () => {
  for (const line of ["echo x > .pi/settings.json", "echo x >> .pi/settings.json", "cp /x.json .pi/settings.json", "mv a.json .pi/settings.json", "rm .pi/settings.json", "rm -f .pi/settings.json", "ln -s /x .pi/settings.json", "cp -t .pi /x.json"]) {
    assert.ok(ruleOf(sh(line)).startsWith("ask:selfmod-project-"), line);
  }
  assert.equal(ruleOf(sh(`echo x > ${agent}/settings.json`)), "ask:selfmod-agent-settings");
  assert.equal(ruleOf(sh(`rm ${agent}/pi-foreman/state/live/other.json`)), "ask:selfmod-state");
  assert.equal(ruleOf(sh("cd .pi && rm settings.json")), "ask:selfmod-project-settings");
});

test("a symlink or hard link inside .pi/scratch is the settings file", () => {
  for (const p of [".pi/scratch/link", ".pi/scratch/hard"]) {
    assert.equal(ruleOf(g("write", { path: p, content: "x" })), "ask:selfmod-project-settings", p);
    assert.equal(ruleOf(sh(`echo x > ${p}`)), "ask:selfmod-project-settings", p);
  }
  assert.equal(ruleOf(sh("ln .pi/settings.json .pi/scratch/new-hard")), "ask:selfmod-project-settings");
});

test("a child is denied with the rule name and what to report; it never gets an ask", () => {
  const c = { child: true, role: "builder" };
  for (const r of [g("write", { path: ".pi/settings.json", content: "x" }, c), sh("rm .pi/settings.json", c), sh(`echo x > ${agent}/settings.json`, c)]) {
    assert.ok(r && "block" in r, ruleOf(r));
    assert.match(r.rule, /^selfmod-/);
    assert.match(r.reason, new RegExp(`self-modification rule ${r.rule}.*report this line to the foreman`));
  }
});

test("a child's read of other sessions' state is denied; its own handoff dir and scratch are not", () => {
  const c = { child: true, role: "builder" };
  const stateFile = path.join(agent, "pi-foreman", "state", "live", "o.json");
  assert.equal(ruleOf(g("read", { path: stateFile }, c)), "block:selfmod-state-read");
  assert.equal(ruleOf(sh(`cat ${stateFile}`, c)), "block:selfmod-state-read");
  assert.equal(ruleOf(g("read", { path: path.join(hand, "plan.md") }, c)), "allow:path-read-handoff");
  assert.equal(ruleOf(g("read", { path: stateFile })), "allow:path-read-owned", "an owner read of state is no selfmod hit");
});

test("the ask never carries a model: the result is a plain ask record (the gate calls no reviewer)", () => {
  const r = g("write", { path: ".pi/settings.json", content: "x" });
  assert.deepEqual(Object.keys(r as object).sort(), ["ask", "reason", "rule"]);
});
