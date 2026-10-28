// R41 slice 2: the runtime path rules (pathrules.ts) and the gate's path-tool flow. Fixture agent dir /pf41/agent, never the real home.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateDecide } from "../gate.ts";
import { pathDecide, under, type GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf41-path-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const otherScr = path.join(base, "tmp", "pi-foreman-scratch", "theirs");
const tmpDir = path.join(base, "tmp");
const outside = path.join(base, "outside");
for (const d of [wt, scr, otherScr, outside, path.join(wt, ".git")]) fs.mkdirSync(d, { recursive: true });
fs.symlinkSync(outside, path.join(wt, "link"));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const AGENT = "/pf41/agent";
const roots = (o: Partial<GateRoots> = {}): GateRoots => ({
  worktree: wt,
  scratch: [scr],
  tmp: [tmpDir, "/tmp"],
  scratchBase: path.join(tmpDir, "pi-foreman-scratch"),
  owned: [`${AGENT}/pi-foreman`, `${AGENT}/sessions/*/subagent-artifacts`],
  install: ["/pf41/pi", "/pf41/npm", "/pf41/pkg/node_modules/unbash"],
  roundFlow: ["/pf41/main/.workflow"],
  handoffs: [`${AGENT}/pi-foreman/handoffs/h1`],
  child: false,
  role: "foreman",
  tmpAccess: true,
  ...o,
});
const rule = (tool: string, input: Record<string, unknown>, o: Partial<GateRoots> = {}): string | undefined => pathDecide(tool, input, wt, roots(o))?.rule;

test("reads: worktree (relative and absolute), scratch, tmp, owned, install, round workflow, handoff", () => {
  assert.equal(rule("read", { path: "src/a.ts" }), "path-read-worktree");
  assert.equal(rule("read", { path: path.join(wt, "src", "a.ts") }), "path-read-worktree");
  assert.equal(rule("read", { path: path.join(scr, "o.txt") }), "path-read-scratch");
  assert.equal(rule("read", { path: path.join(tmpDir, "x") }), "path-read-tmp");
  assert.equal(rule("read", { path: "/tmp/pf41-x" }), "path-read-tmp");
  assert.equal(rule("read", { path: `${AGENT}/pi-foreman/state/a.json` }), "path-read-owned");
  assert.equal(rule("read", { path: `${AGENT}/sessions/s1/subagent-artifacts/o.md` }), "path-read-owned");
  assert.equal(rule("read", { path: "/pf41/pi/dist/core/extensions/types.d.ts" }), "path-read-install");
  assert.equal(rule("read", { path: "/pf41/npm/foo/package.json" }), "path-read-install");
  assert.equal(rule("read", { path: "/pf41/pkg/node_modules/unbash/index.js" }), "path-read-install");
  assert.equal(rule("read", { path: "/pf41/main/.workflow/LEDGER-x.md" }), "path-read-round-workflow");
  assert.equal(rule("read", { path: `${AGENT}/pi-foreman/handoffs/h1/ask.md` }), "path-read-handoff");
  assert.equal(rule("ls", {}), "path-read-worktree");
  assert.equal(rule("grep", { pattern: "x", path: "src" }), "path-read-worktree");
  assert.equal(rule("find", { pattern: "*.ts" }), "path-read-worktree");
});

test("reads outside every root, the agent dir elsewhere, and escapes are no default", () => {
  for (const p of ["/etc/hosts", `${AGENT}/auth.json`, `${AGENT}/other`, "/pf41/elsewhere", "../outside/x", "~/x", "", "src/../../outside/x", "link/x"]) assert.equal(rule("read", { path: p }), undefined, p);
  assert.equal(rule("read", {}), undefined);
  assert.equal(rule("read", { path: path.join(otherScr, "o") }), undefined, "another session's scratch is not a tmp default");
  assert.equal(rule("read", { path: `${scr}/../theirs/o` }), undefined);
});

test("writes: worktree, scratch, tmp (tmpAccess), own handoff plan.md and result.md only", () => {
  assert.equal(rule("write", { path: "src/new.ts" }), "path-write-worktree");
  assert.equal(rule("edit", { path: path.join(wt, "a.ts") }), "path-write-worktree");
  assert.equal(rule("write", { path: path.join(scr, "o") }), "path-write-scratch");
  assert.equal(rule("write", { path: "/tmp/pf41-w" }), "path-write-tmp");
  assert.equal(rule("write", { path: `${AGENT}/pi-foreman/handoffs/h1/plan.md` }), "path-write-handoff");
  assert.equal(rule("write", { path: `${AGENT}/pi-foreman/handoffs/h1/result.md` }), "path-write-handoff");
  for (const p of [`${AGENT}/pi-foreman/handoffs/h1/ask.md`, `${AGENT}/pi-foreman/handoffs/h1/sub/plan.md`, `${AGENT}/pi-foreman/handoffs/h2/plan.md`, `${AGENT}/pi-foreman/state/x`, "/pf41/main/.workflow/x", "/pf41/pi/x", ".git/config", "link/x", path.join(otherScr, "o")]) assert.equal(rule("write", { path: p }), undefined, p);
  assert.equal(rule("write", { path: "/tmp/pf41-w" }, { tmpAccess: false }), undefined);
  assert.equal(rule("read", { path: "/tmp/pf41-w" }, { tmpAccess: false }), undefined);
  assert.equal(rule("read", { path: ".git/HEAD" }), "path-read-worktree");
});

test("a child gets its worktree, scratch, install roots, round workflow and handoff reads only", () => {
  const child = { child: true, role: "builder" };
  assert.equal(rule("read", { path: "src/a.ts" }, child), "path-read-worktree");
  assert.equal(rule("write", { path: "src/a.ts" }, child), "path-write-worktree");
  assert.equal(rule("write", { path: path.join(scr, "o") }, child), "path-write-scratch");
  assert.equal(rule("read", { path: "/pf41/pi/x" }, child), "path-read-install");
  assert.equal(rule("read", { path: "/pf41/main/.workflow/LEDGER-x.md" }, child), "path-read-round-workflow");
  assert.equal(rule("write", { path: "/pf41/main/.workflow/LEDGER-x.md" }, child), undefined);
  for (const p of ["/tmp/x", path.join(tmpDir, "x"), `${AGENT}/pi-foreman/state/a.json`, `${AGENT}/sessions/s1/subagent-artifacts/o.md`]) assert.equal(rule("read", { path: p }, child), undefined, p);
  assert.equal(rule("write", { path: "/tmp/x" }, child), undefined);
});

test("foreman_move / foreman_copy: every end is judged", () => {
  assert.equal(rule("foreman_move", { src: "a", dst: "b" }), "path-write-worktree");
  assert.equal(rule("foreman_move", { src: "a", dst: "/etc/b" }), undefined);
  assert.equal(rule("foreman_copy", { src: "/pf41/pi/x", dst: "b" }), "path-read-install");
  assert.equal(rule("foreman_copy", { src: "/pf41/pi/x", dst: "/pf41/pi/y" }), undefined);
  assert.equal(rule("foreman_move", { src: "/pf41/pi/x", dst: "b" }), undefined, "a move deletes its source");
});

test("a glob that is absolute or climbs out is no default", () => {
  assert.equal(rule("grep", { pattern: "x", glob: "/etc/*" }), undefined);
  assert.equal(rule("grep", { pattern: "x", glob: "../*" }), undefined);
  assert.equal(rule("grep", { pattern: "x", glob: "*.ts" }), "path-read-worktree");
  assert.equal(rule("find", { pattern: "../**" }), undefined);
});

test("Windows paths: drive letters, both separators, case", () => {
  const w = roots({ worktree: "C:\\wt", scratch: ["C:\\Temp\\scr"], tmp: ["C:\\Temp"], scratchBase: "C:\\Temp\\pi-foreman-scratch", owned: [], install: ["D:\\pi"], roundFlow: [], handoffs: [], realpath: () => null });
  const d = (tool: string, p: string): string | undefined => pathDecide(tool, { path: p }, "C:\\wt", w, "win32")?.rule;
  assert.equal(d("read", "src\\a.ts"), "path-read-worktree");
  assert.equal(d("read", "c:/WT/src/a.ts"), "path-read-worktree");
  assert.equal(d("write", "C:/Temp/scr/o"), "path-write-scratch");
  assert.equal(d("write", "C:\\Temp\\x"), "path-write-tmp");
  assert.equal(d("read", "d:/pi/types.d.ts"), "path-read-install");
  for (const p of ["D:/wt/x", "C:x", "C:\\wt\\..\\other", "C:\\Windows\\win.ini", "\\\\srv\\share\\x"]) assert.equal(d("read", p), undefined, p);
  assert.equal(d("write", "C:\\wt\\.git\\config"), undefined);
  assert.ok(under("win32", "C:\\wt", "c:/WT/a"));
});

test("the gate: a secret path is a floor before the path rules; an ordinary read is a default; an unknown path falls through", () => {
  const env: FloorEnv = { cwd: wt, home: "/pf41/home", agentDir: AGENT, platform: process.platform };
  const g = (tool: string, input: Record<string, unknown>) => gateDecide(tool, input, wt, { env: () => env, roots: () => roots() });
  assert.deepEqual(g("read", { path: `${AGENT}/auth.json` }), { block: true, rule: "floor-secret-path", reason: (g("read", { path: `${AGENT}/auth.json` }) as { reason: string }).reason });
  assert.deepEqual(g("read", { path: "src/a.ts" }), { allow: true, rule: "path-read-worktree" });
  assert.equal(g("read", { path: "/etc/hosts" }), undefined);
  assert.equal(gateDecide("read", { path: "src/a.ts" }, wt, { env: () => env }), undefined, "without roots the gate applies floors only");
});
