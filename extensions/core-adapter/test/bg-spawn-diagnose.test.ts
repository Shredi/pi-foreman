// r9 item 1 (Windows CI ids 32, 33, 39 at 5fd754d): under win32 the foreman_bg log of a node grandchild stayed empty. The CI probes
// below showed the cause: cmd's own builtin reached the log, node spawned directly and under an attached cmd did, but a node under a
// detached (DETACHED_PROCESS) cmd did not, with the log opened "a" or "w". Fix: bgSpawnFlags spawns cmd not detached on win32.
// This test asserts the product behaviour on every host (a shell builtin and a node grandchild of spawnDetached both write to the
// log); the probes are only its failure message (see the `probes` keys):
//   builtin   spawnDetached `echo`: cmd.exe itself writes to the inherited log handle
//   node      spawnDetached `node -e`: the grandchild under a detached (DETACHED_PROCESS) cmd keeps the handle
//   direct    node spawned detached without cmd, log opened "a": an append-only handle (FILE_APPEND_DATA) works as stdout
//   directW   the same with the log opened "w"
//   attached  cmd not detached, log opened "a": the detached flag is what loses the output
//   detachedW cmd detached, log opened "w": the append-only handle under cmd is what loses the output
//   sync      spawnSync of the same shellFor argv with pipes: exit status, stdout, stderr (quoting, cmd errors)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { shellFor, spawnDetached } from "../bg.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (f: string): string => {
  try {
    return fs.readFileSync(f, "utf8");
  } catch (e) {
    return `<unreadable: ${(e as Error).message}>`;
  }
};

/** Spawn with the log as stdout and stderr; resolves with the exit code (or the spawn error) and the log text. */
function probe(file: string, args: string[], cwd: string, log: string, flags: "a" | "w", detached: boolean, verbatim: boolean): Promise<string> {
  return new Promise((resolve) => {
    const fd = fs.openSync(log, flags, 0o600);
    let done = false;
    const finish = (how: string) => {
      if (done) return;
      done = true;
      setTimeout(() => resolve(`${how}; log=${JSON.stringify(read(log))}`), 200);
    };
    try {
      const child = spawn(file, args, { cwd, detached, stdio: ["ignore", fd, fd], env: process.env, windowsHide: true, windowsVerbatimArguments: verbatim });
      child.on("error", (e) => finish(`error ${e.message}`));
      child.on("exit", (code, signal) => finish(`exit ${code} ${signal ?? ""}`.trim()));
      setTimeout(() => finish("no exit within 10s"), 10_000);
    } catch (e) {
      finish(`threw ${(e as Error).message}`);
    } finally {
      fs.closeSync(fd);
    }
  });
}

async function probes(dir: string, logs: { builtin: string; node: string }): Promise<string> {
  const nodeCmd = `node -e "console.log('pf-probe-ok')"`;
  const sh = shellFor(nodeCmd);
  const nodeArgs = ["-e", "console.log('pf-probe-ok')"];
  const sync = spawnSync(sh.file, sh.args, { cwd: dir, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: sh.verbatim, timeout: 10_000 });
  const out = {
    platform: process.platform,
    shell: [sh.file, ...sh.args],
    builtin: read(logs.builtin),
    node: read(logs.node),
    direct: await probe(process.execPath, nodeArgs, dir, path.join(dir, "direct.log"), "a", true, false),
    directW: await probe(process.execPath, nodeArgs, dir, path.join(dir, "directW.log"), "w", true, false),
    attached: await probe(sh.file, sh.args, dir, path.join(dir, "attached.log"), "a", false, sh.verbatim),
    detachedW: await probe(sh.file, sh.args, dir, path.join(dir, "detachedW.log"), "w", true, sh.verbatim),
    sync: { status: sync.status, signal: sync.signal, error: sync.error?.message, stdout: sync.stdout, stderr: sync.stderr },
  };
  return `spawnDetached log stayed without the expected line; probes: ${JSON.stringify(out, null, 1)}`;
}

test("spawnDetached: a shell builtin and a node grandchild both write to the log (win32: cmd not detached; CI ids 32, 33, 39)", async (t) => {
  const dir = mkTestTmp("pf-bgdiag-");
  t.after(() => rmTestTmp(dir));
  const logs = { builtin: path.join(dir, "builtin.log"), node: path.join(dir, "node.log") };
  const a = spawnDetached("echo pf-builtin-ok", dir, logs.builtin);
  const b = spawnDetached(`node -e "console.log('pf-node-ok')"`, dir, logs.node);
  assert.ok("pid" in a && "pid" in b, JSON.stringify([a, b]));
  const ok = (): boolean => /pf-builtin-ok/.test(read(logs.builtin)) && /pf-node-ok/.test(read(logs.node));
  for (let i = 0; i < 100 && !ok(); i++) await sleep(100);
  const why = ok() ? undefined : await probes(dir, logs);
  assert.match(read(logs.builtin), /pf-builtin-ok/, why);
  assert.match(read(logs.node), /pf-node-ok/, why);
});
