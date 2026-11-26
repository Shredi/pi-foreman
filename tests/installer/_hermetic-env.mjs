// Preload for test:installer and the CI installer step (node --import): setup.mjs reads the herdr-app home, so an unset HERDR_APP_HOME would read the developer's installed mods. Tests that need a home set their own.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// A direct run gets its own temp root first, so the dirs below land inside it.
import "../../scripts/test_tmp_root_preload.mjs";
// setup.mjs writes the resume block under PI_FOREMAN_HOME (else the real home): an unset one gets its own temp directory.
import "./_sandbox-home.mjs";
import { scrubSessionEnv } from "../../scripts/session_env.mjs";

// A session's own variables (session-env.json) go first: the HERDR_ prefix would remove the HERDR_APP_HOME set below.
scrubSessionEnv(process.env);
// foreman_test_run.mjs must not answer a test's run from an earlier recorded pass; reuse tests set FOREMAN_TEST_REUSE=1.
process.env.FOREMAN_TEST_REUSE ??= "0";

// An empty temp directory, removed on exit (the same style as the npm-root seed in extensions/core-adapter/test/_hermetic-env.mjs).
const appHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-app-home-")));
process.env.HERDR_APP_HOME = appHome;
process.on("exit", () => fs.rmSync(appHome, { recursive: true, force: true }));

// An `npm` shim first on PATH: the real setup.mjs runs `npm ci` in the real checkout when node_modules is older than the lock, so the shim refuses installs and forwards every
// other subcommand to the real npm (found on the original PATH; an inherited FOREMAN_TEST_REAL_NPM wins, so a nested preload never points at an outer shim).
const WIN = process.platform === "win32";
function findNpm() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, WIN ? "npm.cmd" : "npm");
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return "";
}
const SHIM_SCRIPT = `const { spawnSync } = require("node:child_process");
const [sub, ...rest] = process.argv.slice(2);
if (["ci", "install", "i", "add"].includes(sub)) {
  console.error(\`npm \${sub} refused under the installer tests\`);
  process.exit(1);
}
const real = process.env.FOREMAN_TEST_REAL_NPM;
if (!real) {
  console.error("npm shim: no real npm found");
  process.exit(127);
}
const args = sub === undefined ? [] : [sub, ...rest];
const r = process.platform === "win32"
  ? spawnSync([real, ...args].map((a) => '"' + a.replace(/"/g, '\\\\"') + '"').join(" "), { stdio: "inherit", shell: true, windowsHide: true })
  : spawnSync(real, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
`;
process.env.FOREMAN_TEST_REAL_NPM ||= findNpm();
const shimDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-npm-shim-")));
fs.writeFileSync(path.join(shimDir, "npm-shim.cjs"), SHIM_SCRIPT);
fs.writeFileSync(path.join(shimDir, "npm"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(shimDir, "npm-shim.cjs")}" "$@"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(shimDir, "npm.cmd"), `@"${process.execPath}" "${path.join(shimDir, "npm-shim.cjs")}" %*\r\n`);
process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.on("exit", () => fs.rmSync(shimDir, { recursive: true, force: true }));

// A real `herdr` on PATH: setup.mjs would run `herdr integration install pi` (setup/herdr-pi.mjs) on every non-dry run. Each PATH directory that holds one is replaced by a temp directory
// of symlinks to its other entries, so the developer's Herdr never starts and every other tool still resolves; tests with a fake herdr put their own directory first.
if (!WIN) {
  const kept = [];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      kept.push(dir);
      continue;
    }
    if (!names.includes("herdr")) {
      kept.push(dir);
      continue;
    }
    const sub = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-no-herdr-")));
    for (const n of names) if (n !== "herdr") fs.symlinkSync(path.join(dir, n), path.join(sub, n));
    kept.push(sub);
    process.on("exit", () => fs.rmSync(sub, { recursive: true, force: true }));
  }
  process.env.PATH = kept.join(path.delimiter);
}
