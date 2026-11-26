// The npm shim of tests/installer/_hermetic-env.mjs: installs are refused, other subcommands reach the real npm.
import "./_sandbox-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const PRELOAD = pathToFileURL(path.join(HERE, "_hermetic-env.mjs")).href;
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const WIN = process.platform === "win32";

/** A recording stand-in for the real npm: appends its arguments to `log`, answers --version with 99.0.0. Returns its path. */
function fakeRealNpm(base) {
  const log = path.join(base, "real-npm.log");
  const rec = path.join(base, "record.mjs");
  fs.writeFileSync(rec, `import * as fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");\nif (process.argv[2] === "--version") console.log("99.0.0");\n`);
  const file = path.join(base, WIN ? "real-npm.cmd" : "real-npm");
  if (WIN) fs.writeFileSync(file, `@"${process.execPath}" "${rec}" %*\r\n`);
  else fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${rec}" "$@"\n`, { mode: 0o755 });
  return { file, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

const PROBE = `
const { spawnSync } = require("node:child_process");
const win = process.platform === "win32";
const npm = (...a) => { const r = spawnSync(win ? "npm.cmd" : "npm", a, { encoding: "utf8", shell: win }); return { status: r.status, out: r.stdout, err: r.stderr }; };
console.log(JSON.stringify({ first: process.env.PATH.split(require("node:path").delimiter)[0], ci: npm("ci"), install: npm("install"), i: npm("i"), add: npm("add", "x"), version: npm("--version") }));
`;

test("the preload puts a shim first on PATH that refuses installs and forwards the rest to the real npm", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-npm-shim-test-")));
  try {
    const fake = fakeRealNpm(base);
    const r = spawnSync(process.execPath, ["--import", PRELOAD, "-e", PROBE], { encoding: "utf8", env: { ...process.env, FOREMAN_TEST_REAL_NPM: fake.file } });
    assert.equal(r.status, 0, r.stderr);
    const seen = JSON.parse(r.stdout);
    assert.match(path.basename(seen.first), /^pf-npm-shim-/);
    for (const [sub, key] of [["ci", "ci"], ["install", "install"], ["i", "i"], ["add", "add"]]) {
      assert.equal(seen[key].status, 1, sub);
      assert.match(seen[key].err, new RegExp(`npm ${sub} refused under the installer tests`));
    }
    assert.deepEqual(fake.calls(), ["--version"], "only --version reached the real npm");
    assert.equal(seen.version.status, 0);
    assert.equal(seen.version.out.trim(), "99.0.0");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("an inherited FOREMAN_TEST_REAL_NPM survives a nested preload", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-npm-shim-test-")));
  try {
    const fake = fakeRealNpm(base);
    const inner = `const { spawnSync } = require("node:child_process"); const r = spawnSync(process.execPath, ["--import", ${JSON.stringify(PRELOAD)}, "-e", "console.log(process.env.FOREMAN_TEST_REAL_NPM)"], { encoding: "utf8" }); process.stdout.write(r.stdout);`;
    const r = spawnSync(process.execPath, ["--import", PRELOAD, "-e", inner], { encoding: "utf8", env: { ...process.env, FOREMAN_TEST_REAL_NPM: fake.file } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), fake.file);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a real, non-dry setup.mjs run on a copied checkout with a stale node_modules marker never reaches the real npm for ci", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-npm-shim-setup-")));
  try {
    const checkout = path.join(base, "checkout");
    fs.mkdirSync(checkout);
    for (const f of ["setup.mjs", "packages.lock.json", "package.json", "package-lock.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(checkout, f));
    for (const d of ["scripts", "setup", "config"]) fs.cpSync(path.join(ROOT, d), path.join(checkout, d), { recursive: true });
    fs.mkdirSync(path.join(checkout, "extensions", "core-adapter"), { recursive: true });
    for (const f of ["profiles.mjs", "bridgelogin.mjs", "harnessid.mjs"]) fs.copyFileSync(path.join(ROOT, "extensions", "core-adapter", f), path.join(checkout, "extensions", "core-adapter", f));
    fs.mkdirSync(path.join(checkout, ".git"));
    fs.mkdirSync(path.join(checkout, "node_modules"));
    const marker = path.join(checkout, "node_modules", ".package-lock.json");
    fs.writeFileSync(marker, "{}");
    // copyFileSync may keep the source mtime (Windows), so age the marker relative to the copied lock, not the wall clock
    const old = new Date(fs.statSync(path.join(checkout, "package-lock.json")).mtimeMs - 3600_000);
    fs.utimesSync(marker, old, old);
    const fake = fakeRealNpm(base);
    const agentDir = path.join(base, "agent");
    fs.mkdirSync(agentDir);
    const r = spawnSync(process.execPath, ["--import", PRELOAD, path.join(checkout, "setup.mjs"), "--develop", "--agent-dir", agentDir], {
      cwd: base,
      encoding: "utf8",
      env: { ...process.env, FOREMAN_TEST_REAL_NPM: fake.file, PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: path.join(base, "pi.log") },
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, out);
    assert.match(out, /npm ci refused under the installer tests/);
    assert.deepEqual(fake.calls(), ["--version"], out);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
