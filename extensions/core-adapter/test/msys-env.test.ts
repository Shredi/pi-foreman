// Item 5: MSYS path conversion switches, win32 orientation lines, and own scripts passing native paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { msysEnv, patchShellEnv } from "../env.ts";
import { buildOrientation } from "../orient.ts";
import { tmpRoots } from "../pathrules.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("msysEnv: win32 default on (key absent), off with false, nothing elsewhere", () => {
  const on = { MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" };
  assert.deepEqual(msysEnv("win32", {}), on);
  assert.deepEqual(msysEnv("win32", undefined), on);
  assert.deepEqual(msysEnv("win32", { shell: { msysNoPathconv: true } }), on);
  assert.deepEqual(msysEnv("win32", { shell: { msysNoPathconv: false } }), {});
  assert.deepEqual(msysEnv("linux", {}), {});
});

test("patchShellEnv applies the switches on win32 only", () => {
  const w: Record<string, string | undefined> = { Path: "C:\\x" };
  patchShellEnv({ env: w, binDir: "C:\\bin", python: null, markerDir: "C:\\m", delimiter: ";", platform: "win32", config: {} });
  assert.equal(w.MSYS_NO_PATHCONV, "1");
  assert.equal(w.MSYS2_ARG_CONV_EXCL, "*");
  const p: Record<string, string | undefined> = { PATH: "/x" };
  patchShellEnv({ env: p, binDir: "/bin", python: null, markerDir: "/m", platform: "linux", config: {} });
  assert.equal(p.MSYS_NO_PATHCONV, undefined);
});

test("patchShellEnv removes the switches when the key turns false (win32 sim)", () => {
  const env: Record<string, string | undefined> = { Path: "C:\\x" };
  const mk = (config: unknown) => ({ env, binDir: "C:\\bin", python: null, markerDir: "C:\\m", delimiter: ";", platform: "win32", config });
  patchShellEnv(mk({}));
  assert.equal(env.MSYS_NO_PATHCONV, "1");
  patchShellEnv(mk({ shell: { msysNoPathconv: false } }));
  assert.equal(env.MSYS_NO_PATHCONV, undefined);
  assert.equal(env.MSYS2_ARG_CONV_EXCL, undefined);
});

test("orientation names the shell and the native-path rule on win32 only", () => {
  const base = { files: ["a.txt"], agentsMd: null, readmeMd: null, packageJson: null, reads: { warn: 5, every: 5 }, maxLines: 120 };
  const win = buildOrientation({ ...base, platform: "win32", msysNoPathconv: true });
  assert.match(win, /git-bash/);
  assert.match(win, /`C:\/x\/y\.py`, not `\/c\/x\/y\.py`/);
  assert.doesNotMatch(buildOrientation({ ...base, platform: "linux" }), /git-bash/);
});

test("bin/foreman and bin/ledger take the native path on MSYS (stubbed pwd -W)", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-msys-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    // the copy sits in <dir>/bin; a stub python prints its script argument
    for (const n of ["foreman", "ledger"]) fs.copyFileSync(path.join(PKG, "bin", n), path.join(bin, n));
    const py = path.join(dir, "py");
    fs.writeFileSync(py, "#!/bin/sh\nprintf '%s\\n' \"$3\"\n", { mode: 0o755 });
    // wrapper shell function: `pwd -W` answers C:/native/bin (like git-bash)
    const wrap = `pwd() { if [ "$1" = "-W" ]; then printf 'C:/native/bin\\n'; else command pwd "$@"; fi; }\n`;
    for (const [n, args] of [["foreman", "session"], ["ledger", "status"]] as const) {
      const r = spawnSync("sh", ["-c", `${wrap}. ${path.join(bin, n)} ${args}`], { env: { ...process.env, PI_FOREMAN_PYTHON: py }, encoding: "utf8" });
      assert.match(r.stdout + r.stderr, /C:\/native\/bin\/\.\.\//, `${n}: ${r.stdout}${r.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tmpRoots: win32 adds the native long form next to the current one", () => {
  const real = (p: string): string => p;
  assert.deepEqual(tmpRoots("C:\\Users\\RUNNER~1\\Temp", "win32", real, () => "C:\\Users\\runneradmin\\Temp"), ["C:\\Users\\RUNNER~1\\Temp", "C:\\Users\\runneradmin\\Temp"]);
  assert.deepEqual(tmpRoots("C:\\t", "win32", real, () => "C:\\t"), ["C:\\t"]);
  assert.deepEqual(tmpRoots("C:\\t", "win32", real, () => null), ["C:\\t"]);
  assert.deepEqual(tmpRoots("/var/t", "linux", real), ["/var/t", "/tmp"]);
});
