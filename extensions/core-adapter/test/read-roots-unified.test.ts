// One read-roots list (pathrules.ts readRootsOfGate) feeds the effect context, the path rules (a child too, reads only) and the judge read scope;
// the main session also reads the harness state dir except pages/roots; the pi-foreman package root is an install root.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateDecide, type GateResult } from "../gate.ts";
import { pathDecide, readRootsOfGate, type GateRoots } from "../pathrules.ts";
import { judgeReadScope, resolveReadable } from "../judgereads.ts";
import type { FloorEnv } from "../floors.ts";
import type { GitFacts } from "../defaults.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-rr-"));
const wt = path.join(base, "wt");
const extra = path.join(base, "reference");
const agent = path.join(base, "home", ".pi", "agent");
const state = path.join(agent, "pi-foreman", "state");
const pkg = path.join(agent, "git", "pi-foreman");
for (const d of [wt, extra, path.join(state, "gate"), path.join(state, "pages", "roots"), pkg]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(extra, "notes.md"), "n\n");
fs.writeFileSync(path.join(state, "gate", "log.jsonl"), "x\n");
fs.writeFileSync(path.join(state, "pages", "roots", "x.json"), "{}");
fs.writeFileSync(path.join(pkg, "README.md"), "r\n");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (o: Partial<GateRoots> = {}): GateRoots => ({
  worktree: wt, scratch: [], tmp: [path.join(base, "tmp")], owned: [], install: [], roundFlow: [], handoffs: [],
  child: false, role: "foreman", tmpAccess: true, agentDir: agent, home: path.join(base, "home"), ...o,
});
const kid = (o: Partial<GateRoots> = {}): GateRoots => roots({ child: true, role: "builder", builder: true, ...o });
const facts: GitFacts = { currentBranch: () => "round/x", protectedBranches: () => ["main"], pushConfigured: () => false };
const env: FloorEnv = { cwd: wt, home: path.join(base, "home"), agentDir: agent, platform: process.platform, protectedBranches: ["main"], currentBranch: () => "round/x", remoteHead: () => "main", writeRoots: [wt] };
const g = (tool: string, input: Record<string, unknown>, r: GateRoots): GateResult => gateDecide(tool, input, wt, { env: () => env, roots: () => r, facts });
const rule = (r: GateResult): string | null => (r && "allow" in r ? r.rule : null);

test("a builder child reads a file below an additionalDirectories folder with the read tool and with cat; the judge read is not outside", () => {
  const r = kid({ readDirs: [extra] });
  const f = path.join(extra, "notes.md");
  assert.equal(pathDecide("read", { path: f }, wt, r)?.rule, "path-read-owned");
  assert.equal(pathDecide("write", { path: f }, wt, r), undefined, "reads only");
  assert.match(rule(g("bash", { command: `cat ${f}` }, r)) ?? "", /^default-read/);
  const scope = judgeReadScope({ cwd: wt, worktree: wt, agentDir: agent, config: undefined, readRoots: readRootsOfGate(r) })!;
  assert.equal(resolveReadable(f, scope).outcome, "ok");
  // without the folder in the child's roots the read tool has no default
  assert.equal(pathDecide("read", { path: f }, wt, kid()), undefined);
});

test("the one list: main and child take the same worktree, install, owned roots; tmp, work folders and state are the main session's", () => {
  const m = readRootsOfGate(roots({ owned: [extra, path.join(base, "sib", "*")], install: [pkg], state }));
  assert.ok(m.includes(wt) && m.includes(extra) && m.includes(pkg) && m.includes(state) && m.includes(path.join(base, "tmp")));
  assert.ok(!m.some((d) => d.includes("*")), "a wildcard root is no read root");
  const c = readRootsOfGate(kid({ owned: [path.join(base, "o")], readDirs: [extra], install: [pkg], state }));
  assert.ok(c.includes(extra) && c.includes(pkg) && !c.includes(path.join(base, "o")) && !c.includes(state) && !c.includes(path.join(base, "tmp")));
});

test("the pi-foreman package root is readable for the judge even below the agent dir; the same folder stays outside as no install root", () => {
  const f = path.join(pkg, "README.md");
  const without = judgeReadScope({ cwd: wt, worktree: wt, agentDir: agent, config: undefined })!;
  assert.equal(resolveReadable(f, without).outcome, "outside");
  const withPkg = judgeReadScope({ cwd: wt, worktree: wt, agentDir: agent, config: undefined, install: [pkg] })!;
  assert.equal(resolveReadable(f, withPkg).outcome, "ok");
  // the rest of the agent dir stays closed, and an install root never opens a withheld name
  fs.writeFileSync(path.join(agent, "auth.json"), "{}");
  assert.equal(resolveReadable(path.join(agent, "auth.json"), withPkg).outcome, "outside");
});

test("main session: a clean read in the harness state dir is a default; pages/roots is not; a child stays refused", () => {
  const r = roots({ state });
  assert.equal(pathDecide("read", { path: path.join(state, "gate", "log.jsonl") }, wt, r)?.rule, "path-read-state");
  assert.equal(pathDecide("read", { path: path.join(state, "pages", "roots", "x.json") }, wt, r), undefined);
  assert.equal(pathDecide("read", { path: path.join(state, "gate", "log.jsonl") }, wt, kid()), undefined);
  assert.equal(pathDecide("write", { path: path.join(state, "gate", "log.jsonl") }, wt, r), undefined, "reads only");
  assert.match(rule(g("bash", { command: `tail -n 3 ${path.join(state, "gate", "log.jsonl")}` }, r)) ?? "", /^default-read/);
  assert.notEqual(rule(g("bash", { command: `cat ${path.join(state, "pages", "roots", "x.json")}` }, r)), "default-read");
  // the bash text spells the path with `/`: bash eats the backslashes of a raw `C:\\...` word, so that word never names the file (on win32 the main-session read above is the same)
  const k = g("bash", { command: `tail -n 3 ${path.join(state, "gate", "log.jsonl").replace(/\\/g, "/")}` }, kid());
  assert.ok(k && "block" in k && k.rule === "selfmod-state-read");
});
