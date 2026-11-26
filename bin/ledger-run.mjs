// pi-foreman: one `ledger.py` run under the cross-process `<ledger>.lock`, for the ledger shims (bin/ledger, .cmd, .ps1).
// Usage: node --experimental-strip-types ledger-run.mjs <ledger.py> <python> [python prefix args...] -- [ledger.py args...]
// The env is the shim's (CLAUDE_CODE_SESSION_ID, TMPDIR already set). The lock target is the file ledger.py will write,
// resolved by ledger.py's own parser and resolver (RESOLVE_SNIPPET); none resolves -> the run is unlocked, as without this
// helper. A lock held past the wait prints the LedgerLockedError text, exit 1, and ledger.py does not run. Otherwise the
// exit code, stdout and stderr are ledger.py's. On Windows a scanner can hold the file ledger.py just renamed
// (os.replace: access denied), so a run is repeated on that marker, bounded, like the shim loop in bin/ledger.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 200, 200, 200, 200];
const RETRY_MARKER = /\[WinError 5\]|\[WinError 32\]|PermissionError/;

/** The argv after this file's name -> the two commands of a run (resolve the lock target, run ledger.py); null when malformed. */
export function buildLedgerRun(argv, snippet = "") {
  const sep = argv.indexOf("--");
  if (sep < 2) return null;
  const [script, py, ...pre] = argv.slice(0, sep);
  const args = argv.slice(sep + 1);
  if (!script || !py) return null;
  return {
    run: { cmd: py, args: [...pre, "-E", "-s", script, ...args] },
    resolve: { cmd: py, args: [...pre, "-I", "-c", snippet, path.dirname(script), ...args] },
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function exec(spec) {
  return spawnSync(spec.cmd, spec.args, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/** ledger.py with the bounded rerun on the Windows access-denied marker; passes its output and returns its exit code. */
function runLedger(spec) {
  let r;
  for (let i = 0; ; i++) {
    r = exec(spec);
    if (r.status !== 0 && i < RETRY_DELAYS_MS.length && RETRY_MARKER.test(r.stderr ?? "")) {
      sleep(RETRY_DELAYS_MS[i]);
      continue;
    }
    break;
  }
  if (r.error) {
    process.stderr.write(`ledger: ${r.error.message}\n`);
    return 1;
  }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status ?? 1;
}

/** The run goes on without the lock: one stderr line says so. */
function unlocked(plan, why) {
  process.stderr.write(`ledger-run: running without the ledger lock (${why})\n`);
  return runLedger(plan.run);
}

function main() {
  let lockMod = null;
  return import("../extensions/core-adapter/ledgerlockfs.ts").then(
    (m) => (lockMod = m),
    () => null, // the lock module cannot load (old Node): run unlocked, no new failure
  ).then(() => {
    const plan = buildLedgerRun(process.argv.slice(2), lockMod?.RESOLVE_SNIPPET ?? "");
    if (!plan) {
      process.stderr.write("ledger-run: bad arguments\n");
      return 2;
    }
    if (!lockMod) return unlocked(plan, "the lock module did not load");
    let target = "";
    const r = exec(plan.resolve);
    if (r.status === 0 && !r.error) target = (r.stdout ?? "").trim();
    // no target: ledger.py reports its own error (or the read-only use needs no lock), so this case stays quiet
    if (!target) return runLedger(plan.run);
    let release;
    try {
      release = lockMod.takeLedgerLock(path.resolve(target), lockMod.ledgerRunWaitMs());
    } catch (err) {
      if (err?.code === "ELEDGERLOCK") {
        process.stderr.write(`${err.message}\n`);
        return 1;
      }
      return unlocked(plan, "the lock file cannot be created"); // read-only directory: ledger.py reports its own failure
    }
    try {
      return runLedger(plan.run);
    } finally {
      release();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
