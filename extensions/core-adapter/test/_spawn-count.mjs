// Child-process counter for the spawn guard of scripts/foreman_test_run.mjs, loaded by _hermetic-env.mjs. Active only when the
// runner names a directory in FOREMAN_SPAWN_COUNT_DIR: it counts every child process this test process starts, per command kind,
// and writes one small file per process on exit. The wrapped functions behave as before (same arguments, result and errors).
// A test that runs a stub `npm` of its own on a temp PATH sets FOREMAN_SPAWN_GUARD_EXEMPT=1 around the call; nothing is counted then.
import cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const DIR = process.env.FOREMAN_SPAWN_COUNT_DIR;
if (DIR) {
  const counts = {};
  const count = (file) => {
    try {
      if (process.env.FOREMAN_SPAWN_GUARD_EXEMPT === "1") return;
      const kind = commandKind(file);
      counts[kind] = (counts[kind] ?? 0) + 1;
    } catch {}
  };
  const proto = cp.ChildProcess.prototype;
  const origSpawn = proto.spawn;
  proto.spawn = function (options) {
    count(options?.file);
    return origSpawn.apply(this, arguments);
  };
  for (const name of ["spawnSync", "execFileSync"]) {
    const orig = cp[name];
    cp[name] = function (file) {
      count(file);
      return orig.apply(this, arguments);
    };
  }
  const origExecSync = cp.execSync;
  cp.execSync = function () {
    count("sh");
    return origExecSync.apply(this, arguments);
  };
  syncBuiltinESMExports();
  // An `npm` reached through a shell or a grandchild is not seen by the wrappers above, but the fake `npm` of _hermetic-env.mjs (first
  // on PATH, POSIX only) logs one line per call in FOREMAN_FAKE_NPM_LOG. Rule: npm = max(direct count, log lines). A direct `npm`
  // spawn that hit the fake is in both numbers and counts once; a shell-started one is only in the log. The log is read on exit, before
  // _hermetic-env.mjs removes its dir (this module is imported first, so its exit handler runs first). Windows has no fake: direct only.
  process.on("exit", () => {
    try {
      const log = process.env.FOREMAN_FAKE_NPM_LOG;
      if (log && process.platform !== "win32") {
        const lines = fs.readFileSync(log, "utf8").split("\n").filter((l) => l !== "").length;
        if (lines > (counts.npm ?? 0)) counts.npm = lines;
      }
    } catch {}
    try {
      fs.writeFileSync(path.join(DIR, `${process.pid}.json`), JSON.stringify({ file: scriptLabel(), ...counts }));
    } catch {}
  });
}

/** The script this process runs (process.argv[1]) relative to the cwd; the basename when that is not inside the cwd; "-" for none. */
function scriptLabel() {
  const script = process.argv[1];
  if (!script) return "-";
  const rel = path.relative(process.cwd(), script);
  return rel.startsWith("..") || path.isAbsolute(rel) ? path.basename(script) : rel;
}

/** git, python, node, npm (also npm.cmd, npx, npx.cmd: npx runs npm's CLI) or other, by the command's file name. */
function commandKind(file) {
  const base = String(file).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  if (base === "npx") return "npm";
  if (base === "git" || base === "node" || base === "npm") return base;
  return base.startsWith("python") ? "python" : "other";
}
