// Round 2, step 2 (row 30): a file wait's write protection comes from the gate's path functions (floors, self-modification, protected folders) over the session's GateRoots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkWaitPath } from "../wait.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const root = fs.realpathSync.native(mkTestTmp("pf-r2-waitroots-"));
test.after(() => rmTestTmp(root));
const ws = path.join(root, "ws");
const agentDir = path.join(root, "agent");
const scratch = path.join(root, "scr");
const handoff = path.join(agentDir, "pi-foreman", "handoffs", "h1");
for (const d of [ws, path.join(ws, ".git"), path.join(ws, ".pi"), path.join(ws, ".workflow"), handoff, scratch, path.join(root, ".ssh"), path.join(agentDir, "pi-foreman", "state", "wait")]) fs.mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q", ws]);
const PKG = path.resolve(import.meta.dirname, "..", "..", "..");
const roots = { worktree: ws, scratch: [scratch], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [handoff], child: false, role: "foreman", tmpAccess: true, agentDir, home: root, pkgRoot: PKG } as never;
const bound = { cwd: ws, home: root, agentDir, platform: process.platform, roots };

test("wait roots: ordinary workspace files are allowed", () => {
  for (const p of ["build/done.flag", ".workflow/ready", "src/a.ts", ".github/workflows/ci.yml"]) assert.ok("path" in checkWaitPath(p, bound), p);
  assert.ok("path" in checkWaitPath(path.join(agentDir, "pi-foreman", "state", "wait", "x"), bound));
});

test("wait roots: git internals, project settings, project Claude files and secrets are refused", () => {
  for (const p of [".git/HEAD", ".git/config", ".pi/settings.json", ".claude/settings.json", ".mcp.json", ".env"]) {
    const r = checkWaitPath(p, bound);
    assert.ok("error" in r && /write protection/.test(r.error), p);
  }
});

test("wait roots: paths outside the workspace stay refused (agent settings, harness config, ssh keys, handoff, scratch)", () => {
  for (const p of [path.join(agentDir, "settings.json"), path.join(agentDir, "foreman.json"), path.join(root, ".ssh", "id_x"), path.join(handoff, "plan.md"), path.join(scratch, "x.txt")]) {
    const r = checkWaitPath(p, bound);
    assert.ok("error" in r && r.error.includes("refused"), p);
  }
});

test("wait roots: without roots a workspace file is refused", () => {
  const r = checkWaitPath("a.txt", { ...bound, roots: null });
  assert.ok("error" in r && /gate roots are unavailable/.test(r.error));
});

test("wait roots: under .pi/tasks only the own session's output passes (as given and resolved)", () => {
  const own = ".pi/tasks/sid-own-1/a.output";
  const other = ".pi/tasks/sid-other-1/a.output";
  for (const f of [own, other]) {
    fs.mkdirSync(path.join(ws, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), "x\n");
  }
  const b = { ...bound, ownTasks: [`${path.join(ws, ".pi", "tasks")}/sid-own-*`] };
  assert.ok("path" in checkWaitPath(own, b));
  assert.ok("error" in checkWaitPath(other, b));
  assert.ok("error" in checkWaitPath(other, bound));
  fs.symlinkSync(path.join(ws, other), path.join(ws, ".pi/tasks/sid-own-1/link.output"));
  assert.ok("error" in checkWaitPath(".pi/tasks/sid-own-1/link.output", b));
  fs.symlinkSync(path.join(ws, other), path.join(ws, "viaworktree.output"));
  assert.ok("error" in checkWaitPath("viaworktree.output", b));
  const r = checkWaitPath(".pi/tasks/../settings.json", b);
  assert.ok("error" in r && /write protection/.test(r.error));
});
