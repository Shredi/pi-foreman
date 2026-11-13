// A r11Rig of the g8 tests that starts no child process: the rig's session start probes python (the adapter's injectable spawner) and asks git
// (permconfig's spawnSync, where.ts and prhost.ts's execFile, none injectable), and the tool_call handler under test needs neither. The spawner
// answers the python probe and fails everything else; git calls go to an in-process stand-in that reports "not a repository" (status 1 / an error),
// installed on node:child_process for the test and restored after it.
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PROBE_CODE } from "../python.ts";
import type { Spawner } from "../spawn.ts";
import { r11Rig } from "./_r11rig.ts";

const spawner: Spawner = async (_command, args) =>
  args.includes(PROBE_CODE) ? { code: 0, stdout: "3.13\n/usr/bin/python3\n/usr/bin/python3\n/usr\n", stderr: "", timedOut: false } : { code: 1, stdout: "", stderr: "", timedOut: false };

export async function r11RigNoSpawn(t: Parameters<typeof r11Rig>[0], opts: { child?: boolean } = {}) {
  const origSync = cp.spawnSync;
  const origFile = cp.execFile;
  const fakeSync = ((file: string, ...rest: unknown[]) => (file === "git" ? { status: 1, stdout: "", stderr: "" } : (origSync as (...a: unknown[]) => unknown)(file, ...rest))) as typeof cp.spawnSync;
  const fakeFile = ((file: string, ...rest: unknown[]) => {
    if (file !== "git") return (origFile as (...a: unknown[]) => unknown)(file, ...rest);
    const cb = rest.find((x) => typeof x === "function") as ((err: Error | null, out: string) => void) | undefined;
    setImmediate(() => cb?.(new Error("git is not started by this rig"), ""));
    return undefined;
  }) as unknown as typeof cp.execFile;
  cp.spawnSync = fakeSync;
  cp.execFile = fakeFile;
  syncBuiltinESMExports();
  const r = await r11Rig(t, {}, { ...opts, deps: { spawner } });
  t.after(() => {
    cp.spawnSync = origSync;
    cp.execFile = origFile;
    syncBuiltinESMExports();
  });
  return r;
}
