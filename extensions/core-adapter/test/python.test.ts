import { test } from "node:test";
import assert from "node:assert/strict";
import { PythonCache, isStoreAliasStub, pythonCandidates, resolvePython } from "../python.ts";
import type { SpawnResult, Spawner } from "../spawn.ts";

function fake(table: Record<string, Partial<SpawnResult>>): { spawner: Spawner; calls: string[] } {
  const calls: string[] = [];
  const spawner: Spawner = async (cmd, args) => {
    const key = [cmd, ...args.filter((a) => a === "-3")].join(" ");
    calls.push(key);
    const r = table[key] ?? { error: new Error("ENOENT") };
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...r };
  };
  return { spawner, calls };
}

test("candidate order: python.path, PI_FOREMAN_PYTHON, then per-OS defaults", () => {
  assert.deepEqual(pythonCandidates({ configPath: "/opt/py", envPath: "/env/py", platform: "linux" }).map((c) => c.source), ["python.path", "PI_FOREMAN_PYTHON", "python3", "python"]);
  assert.deepEqual(pythonCandidates({ platform: "win32" }).map((c) => [c.command, ...c.args].join(" ")), ["py -3", "python"]);
});

test("first working candidate wins and reports sys.executable", async () => {
  const { spawner, calls } = fake({ "/opt/py": { stdout: "3.12\n/opt/py/bin/python3.12\n" } });
  const r = await resolvePython({ configPath: "/opt/py", platform: "linux", spawner });
  assert.ok(r.ok);
  assert.equal(r.info.executable, "/opt/py/bin/python3.12");
  assert.deepEqual(r.info.version, [3, 12]);
  assert.deepEqual(calls, ["/opt/py"]);
});

test("too old or broken interpreters are skipped", async () => {
  const { spawner } = fake({ python3: { stdout: "3.8\n/usr/bin/python3\n" }, python: { stdout: "3.9\n/usr/bin/python\n" } });
  const r = await resolvePython({ platform: "darwin", spawner });
  assert.ok(r.ok);
  assert.equal(r.info.source, "python");
  assert.match(r.rejected[0], /3\.8 is older than 3\.9/);
});

test("Windows Store alias stub is rejected; a real Store install is not", async () => {
  const stub = "D:\\p\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe";
  assert.equal(isStoreAliasStub(stub, "win32"), true);
  assert.equal(isStoreAliasStub("D:\\p\\AppData\\Local\\Microsoft\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_x\\python.exe", "win32"), false);
  const { spawner } = fake({
    "py -3": { error: new Error("ENOENT") },
    python: { stdout: `3.12\n${stub}\n` },
  });
  const r = await resolvePython({ platform: "win32", spawner });
  assert.equal(r.ok, false);
  assert.match(r.rejected.join("|"), /Windows Store alias stub/);
});

test("probe failure (exit 9009, timeout) rejects; none found -> ok false", async () => {
  const { spawner } = fake({ "py -3": { code: 9009 }, python: { timedOut: true, code: null } });
  const r = await resolvePython({ platform: "win32", spawner });
  assert.equal(r.ok, false);
  assert.equal(r.rejected.length, 2);
});

test("resolution is cached per session", async () => {
  const cache = new PythonCache();
  let n = 0;
  const resolve = async () => {
    n++;
    return { ok: false as const, rejected: [] };
  };
  await cache.get("a", resolve);
  await cache.get("a", resolve);
  await cache.get("b", resolve);
  assert.equal(n, 2);
});
