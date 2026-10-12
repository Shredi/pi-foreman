// Ledger 7c, owner ruling: per-child worktree ownership. The round worktree is written only by the foreman and its
// builder; every other child role reads it. An isolation worktree is written only by its own child.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { childSurface } from "../roundsurface.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-owner-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const rt = path.join(base, "repo.worktrees", "round");
const isoA = path.join(base, "repo.worktrees", "worktrees", "round", "pi-worktree-a");
const isoB = path.join(base, "repo.worktrees", "worktrees", "round", "pi-worktree-b");
for (const d of [path.join(rt, "src"), path.join(isoA, "src"), path.join(isoB, "src")]) fs.mkdirSync(d, { recursive: true });
for (const f of [path.join(rt, "src", "a.ts"), path.join(isoA, "src", "a.ts"), path.join(isoB, "src", "a.ts")]) fs.writeFileSync(f, "x\n");
const top = (d: string): string | null => (d.startsWith(isoA) ? isoA : d.startsWith(isoB) ? isoB : d.startsWith(rt) ? rt : null);
const r = buildOverlayRules(baseline, {}, {}, path.join(base, "agent"), pkgRoot, undefined, false);

const run = (role: string, cwd: string, tool: string, input: Record<string, unknown>): string => {
  const s = childSurface([rt], cwd, role, process.platform, top);
  return checkToolCall(r, tool, input, { cwd, home: base, platform: process.platform, role: "child", roundRoots: s.write, roundReadRoots: s.read })?.kind ?? "pass";
};

test("childSurface: write roots by role", { skip: !posix }, () => {
  assert.deepEqual(childSurface([rt], rt, "builder", process.platform, top), { write: [rt], read: [rt] });
  assert.deepEqual(childSurface([rt], rt, "reviewer", process.platform, top), { write: [], read: [rt] });
  assert.deepEqual(childSurface([rt], isoA, "builder", process.platform, top), { write: [isoA], read: [rt] });
  assert.deepEqual(childSurface([rt], path.join(base, "elsewhere"), "builder", process.platform, top), { write: [], read: [] });
});

test("owner rule: child A cannot write into child B's isolation worktree (path tool and bash redirect)", { skip: !posix }, () => {
  const t = path.join(isoB, "src", "a.ts");
  for (const role of ["builder", "reviewer"]) {
    assert.equal(run(role, isoA, "write", { path: t }), "deny", role);
    assert.equal(run(role, isoA, "bash", { command: `echo x > ${t}` }), "deny", role);
    assert.equal(run(role, isoA, "write", { path: path.join(isoA, "src", "a.ts") }), "pass", role);
  }
});

test("owner rule: a reviewer in the round worktree reads, never writes (path tool, redirect, mkdir, cp)", { skip: !posix }, () => {
  const f = path.join(rt, "src", "a.ts");
  assert.equal(run("reviewer", rt, "read", { path: f }), "pass");
  assert.equal(run("reviewer", rt, "bash", { command: `cat ${f}` }), "pass");
  assert.equal(run("reviewer", rt, "write", { path: f }), "deny");
  assert.equal(run("reviewer", rt, "edit", { path: f }), "deny");
  assert.equal(run("reviewer", rt, "bash", { command: `echo x > ${f}` }), "deny");
  assert.equal(run("reviewer", rt, "bash", { command: `mkdir ${rt}/newdir` }), "deny");
  assert.equal(run("reviewer", rt, "bash", { command: `cp ${f} ${rt}/src/b.ts` }), "deny");
});

test("owner rule: a builder in the round worktree writes it", { skip: !posix }, () => {
  const f = path.join(rt, "src", "a.ts");
  assert.equal(run("builder", rt, "write", { path: f }), "pass");
  assert.equal(run("builder", rt, "bash", { command: `echo x > ${f}` }), "pass");
});

test("owner rule: an isolation child reads the round worktree, never writes it", { skip: !posix }, () => {
  const f = path.join(rt, "src", "a.ts");
  for (const role of ["builder", "reviewer"]) {
    assert.equal(run(role, isoA, "read", { path: f }), "pass", role);
    assert.equal(run(role, isoA, "write", { path: f }), "deny", role);
    assert.equal(run(role, isoA, "bash", { command: `echo x > ${f}` }), "deny", role);
  }
});
