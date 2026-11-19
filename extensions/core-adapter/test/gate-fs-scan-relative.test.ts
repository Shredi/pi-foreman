// PR C steering case: a relative or in-worktree search root is no whole-disk scan, for bash and for the grep, find and ls tools (the path field is a path,
// not text); only `/`, `~`, a drive root or the home directory (or a parent of the workspace) count.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { lineFloors, scanToolFloor, type FloorEnv } from "../floors.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = mkTestTmp("fs-scan-relative-");
after(() => fs.rmSync(base, { recursive: true, force: true }));
const home = path.join(base, "home");
const work = path.join(home, "git", "repo");
fs.mkdirSync(path.join(work, "scripts"), { recursive: true });
fs.mkdirSync(path.join(work, ".git"), { recursive: true });
const env: FloorEnv = { cwd: work, home, agentDir: path.join(home, ".pi", "agent"), writeRoots: [work], scratch: [] };
const bash = (l: string): string | null => lineFloors(l, parseShell(l, { cwd: work }), env)?.rule ?? null;

test("bash: a relative or in-worktree search root is no scan hit", () => {
  for (const l of ["grep -r 'def scan_line' scripts --include='*.py'", "grep -rl scan_line scripts", "grep -rn x ./scripts", `grep -rn x ${work}/scripts`, "grep -r x ."]) assert.equal(bash(l), null, l);
});

test("bash: `/`, `~`, and the home dir still hit", () => {
  for (const l of ["grep -r x /", "grep -r x ~", `grep -r x ${home}`]) assert.equal(bash(l), "danger-fs-scan", l);
});

test("grep, find tools: a relative path field is checked as a path; the pattern and glob are text", () => {
  for (const tool of ["grep", "find"]) {
    for (const input of [{ pattern: "def scan_line", path: "scripts", glob: "*.py" }, { pattern: "/", path: "scripts" }, { pattern: "x" }, { pattern: "x", path: work }]) {
      assert.equal(scanToolFloor(tool, input, work, env), null, `${tool} ${JSON.stringify(input)}`);
    }
  }
  assert.equal(scanToolFloor("grep", { pattern: "x", path: "/" }, work, env)?.rule, "danger-fs-scan");
  assert.equal(scanToolFloor("find", { pattern: "x", path: home }, work, env)?.rule, "danger-fs-scan");
});

test("gate: the grep tool with a repo-relative path is not denied by fs-scan or secret-path", () => {
  const r = gateEvaluate("grep", { pattern: "def scan_line", path: "scripts", glob: "*.py" }, work, { env: (cwd) => baseFloorEnv(cwd, {}) });
  assert.ok(!(r && "block" in r && r.block), JSON.stringify(r));
});
