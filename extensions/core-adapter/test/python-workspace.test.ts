// U7: an interpreter (or its venv) inside the workspace is never used. Temp dirs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePython } from "../python.ts";
import type { SpawnResult, Spawner } from "../spawn.ts";

function tempDir(t: { after(fn: () => void): void }, repo: boolean): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-pyws-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (repo) fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, "sub"));
  return dir;
}

function fake(table: Record<string, Partial<SpawnResult>>): { spawner: Spawner; calls: string[] } {
  const calls: string[] = [];
  const spawner: Spawner = async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...(table[cmd] ?? { error: new Error("ENOENT") }) };
  };
  return { spawner, calls };
}

const out = (...lines: string[]) => ({ stdout: lines.join("\n") + "\n" });

test("python.path inside the git workspace is rejected before it is probed", async (t) => {
  const repo = tempDir(t, true);
  const venvPy = path.join(repo, ".venv", "bin", "python");
  const { spawner, calls } = fake({ python3: out("3.12", "/usr/bin/python3", "/usr/bin/python3", "/usr") });
  const r = await resolvePython({ configPath: venvPy, platform: "linux", spawner, cwd: path.join(repo, "sub"), env: { PATH: "" } });
  assert.ok(r.ok);
  assert.equal(r.info.source, "python3");
  assert.deepEqual(calls, ["python3"]);
  assert.match(r.rejected[0], /inside the workspace/);
});

test("a symlinked venv (realpath outside) is caught by sys.prefix; the next candidate wins", async (t) => {
  const repo = tempDir(t, true);
  const { spawner } = fake({
    python3: out("3.12", path.join(repo, ".venv", "bin", "python3"), "/usr/bin/python3.12", path.join(repo, ".venv")),
    python: out("3.11", "/usr/bin/python", "/usr/bin/python", "/usr"),
  });
  const r = await resolvePython({ platform: "linux", spawner, cwd: repo, env: { PATH: "" } });
  assert.ok(r.ok);
  assert.equal(r.info.executable, "/usr/bin/python");
  assert.match(r.rejected.join("|"), /python3 \(python3\): .*\.venv.* inside the workspace/);
});

test("outside a repo only a venv/.venv below the cwd is rejected", async (t) => {
  const dir = tempDir(t, false);
  const tool = path.join(dir, "tools", "python3");
  const venv = path.join(dir, "venv", "bin", "python3");
  const { spawner } = fake({ [venv]: out("3.12", venv, "/usr/bin/python3", path.join(dir, "venv")), [tool]: out("3.12", tool, tool, path.join(dir, "tools")) });
  const bad = await resolvePython({ configPath: venv, platform: "linux", spawner, cwd: dir, env: { PATH: "" } });
  assert.equal(bad.ok, false);
  const good = await resolvePython({ configPath: tool, platform: "linux", spawner, cwd: dir, env: { PATH: "" } });
  assert.ok(good.ok);
  assert.equal(good.info.executable, tool);
});

// Simulates a POSIX PATH (":"-separated); Windows temp paths carry a drive letter, so this one
// runs on POSIX hosts only. The win32 variant below runs everywhere.
test("a bare name found on PATH inside the workspace is not probed", { skip: process.platform === "win32" }, async (t) => {
  const repo = tempDir(t, true);
  const bin = path.join(repo, ".venv", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "python3"), "");
  const { spawner, calls } = fake({ python: out("3.12", "/usr/bin/python", "/usr/bin/python", "/usr") });
  const r = await resolvePython({ platform: "linux", spawner, cwd: repo, env: { PATH: bin } });
  assert.ok(r.ok);
  assert.deepEqual(calls, ["python"]);
});

test("win32: a bare name found on PATH inside the workspace is not probed", async (t) => {
  const repo = tempDir(t, true);
  const bin = path.join(repo, ".venv", "Scripts");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "python.exe"), "");
  const { spawner, calls } = fake({ python: out("3.12", "C:/Python312/python.exe", "C:/Python312/python.exe", "C:/Python312") });
  const r = await resolvePython({ platform: "win32", spawner, cwd: repo, env: { PATH: bin } });
  assert.ok(!r.ok);
  assert.deepEqual(calls, ["py"]);
});
