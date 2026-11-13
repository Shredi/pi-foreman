// In-process stand-ins for the process starts of an adapter session (python at setup, config load and guards; git lookups of the gate), so the
// read-clear rig starts no child process. The adapter's own `spawner` dependency takes the python calls (the seam idle-router-wiring.test.ts and
// _session-open-rig.ts use); gate.ts, permconfig.ts, where.ts and prhost.ts call git through node:child_process directly with no seam, so the
// git calls are answered here at that module's functions, for the git command only. Every answer is what the real call gives in the rig's
// project dir (a temp dir that is no git repository: git fails, status 128) and in a session that reads: the guards allow a read line.
// A python call this file does not know goes to the real spawner (and so counts as a start).
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSpawner, type Spawner } from "../spawn.ts";
import { PROBE_CODE } from "../python.ts";
import { readDefaults, type Json } from "../config.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The interpreter the version probe reports; a call that must really run goes to the machine's python3 instead. */
const FAKE_PYTHON = "/rig/python3";
const isGit = (file: unknown): boolean => file === "git";
const merge = (a: Json, b: Json): Json => {
  const o: Json = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? merge(a[k] as Json, v as Json) : v;
  return o;
};
const READ_WORDS = new Set(["grep", "ls", "cat", "head", "tail", "wc", "sort", "uniq", "cut"]);
const WORD = /^[\w./~*@:=,+-]+$/;
/** True for `word args | word args ...` made only of the read words above with plain arguments. */
const plainRead = (cmd: string | null): boolean => !!cmd && cmd.split("|").every((seg) => {
  const w = seg.trim().split(/\s+/);
  return READ_WORDS.has(w[0]) && w.every((x) => WORD.test(x));
});
const commandOf = (input: unknown): string | null => {
  try {
    const c = (JSON.parse(String(input)) as { tool_input?: { command?: unknown } }).tool_input?.command;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
};
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });

/** The python calls of a session: the version probe, the merged config (L1 defaults under the agent dir's foreman.json, as the CLI merges them), the guards. */
export const inprocSpawner: Spawner = async (command, args, options) => {
  if (args.includes(PROBE_CODE)) return ok(`3.13\n${FAKE_PYTHON}\n${FAKE_PYTHON}\n/rig\n`);
  const script = args.find((a) => a.endsWith(".py"));
  const name = script ? path.basename(script) : "";
  if (name === "foreman_config.py" && args[args.indexOf(script!) + 1] === "merged") {
    let user: Json = {};
    try {
      user = JSON.parse(fs.readFileSync(path.join(args[args.indexOf("--agent-dir") + 1], "foreman.json"), "utf8")) as Json;
    } catch { /* no user file */ }
    return ok(JSON.stringify({ config: merge(readDefaults(PKG_ROOT), user), warnings: [], errors: [], safetyFallback: false, layers: ["L1", "L2"], basePermissions: null }));
  }
  if (name === "shell_write_guard.py" || name === "destructive_guard.py") {
    // A plain read pipeline is allowed by both guards (checked against the real ones for this rig's lines); anything else (a redirect, a substitution, a
    // write or push word, a floor line) goes to the real guard, so a refusal is still the real guard's.
    if (plainRead(commandOf(options.input))) return ok("");
  }
  return defaultSpawner(command === FAKE_PYTHON ? "python3" : command, args, options);
};

const failed = (): Error => Object.assign(new Error("git: not a git repository"), { status: 128 });
const orig = { execFileSync: cp.execFileSync, spawnSync: cp.spawnSync, execFile: cp.execFile };
cp.execFileSync = ((file: string, ...rest: unknown[]) => { if (isGit(file)) throw failed(); return (orig.execFileSync as (...a: unknown[]) => unknown)(file, ...rest); }) as typeof cp.execFileSync;
cp.spawnSync = ((file: string, ...rest: unknown[]) => (isGit(file) ? { status: 128, stdout: "", stderr: "", signal: null, pid: 0, output: [null, "", ""], error: undefined } : (orig.spawnSync as (...a: unknown[]) => unknown)(file, ...rest))) as typeof cp.spawnSync;
cp.execFile = ((file: string, ...rest: unknown[]) => {
  if (!isGit(file)) return (orig.execFile as (...a: unknown[]) => unknown)(file, ...rest);
  const cb = rest.find((x) => typeof x === "function") as ((e: Error | null, out: string, err: string) => void) | undefined;
  setImmediate(() => cb?.(failed(), "", ""));
  return undefined as never;
}) as typeof cp.execFile;
syncBuiltinESMExports();
