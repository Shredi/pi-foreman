// A builder launched with `cwd` set to a hand-made worktree under the worktree root (outside the main checkout) is not refused
// `child-write-outside` for writing its own node_modules there: the sanctioned root is that worktree's git top level (gateRootsOf).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-builder-wt-"));
const main = path.join(base, "pi-foreman");
const wt = path.join(base, "pi-foreman.worktrees", "feat-x");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
for (const d of [path.join(main, ".git"), path.join(main, "node_modules"), wt, scr, H]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "feat-x")}\n`);
fs.writeFileSync(path.join(wt, "package.json"), "{}");
after(() => fs.rmSync(base, { recursive: true, force: true }));

// the roots gateRootsOf builds for a builder whose launch cwd is `wt`: the worktree is that cwd's git top level
const roots = (): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false, childHandoff: H });
type Res = { block?: boolean; rule?: string } | undefined;
const call = (tool: string, input: Record<string, unknown>, cwd = wt): Res =>
  gateEvaluate(tool, input, cwd, { env: (c) => baseFloorEnv(c, { child: true }), roots: () => roots() }).result as Res;

test("a builder in its worktree is not refused child-write-outside for its own install and node_modules writes", { skip: !posix }, () => {
  for (const l of ["npm ci", "npm install", `echo x > ${wt}/node_modules/a.js`, `cp package.json node_modules/a.json`, `mv package.json node_modules/b.json`]) {
    assert.notEqual(call("bash", { command: l })?.rule, "child-write-outside", l);
  }
  assert.notEqual(call("write", { path: path.join(wt, "node_modules", "x", "index.js"), content: "x" })?.rule, "child-write-outside");
});

test("the same node_modules write into the main checkout stays child-write-outside (control)", { skip: !posix }, () => {
  assert.equal(call("bash", { command: `echo x > ${main}/node_modules/a.js` })?.rule, "child-write-outside");
  assert.equal(call("write", { path: path.join(main, "node_modules", "x.js"), content: "x" })?.rule, "child-write-outside");
});
