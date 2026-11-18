import "./_sandbox-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npmAllowGitBroken } from "../../setup.mjs";

// npm 11.9 to 11.12 refuses the project's own git dependencies under allow-git=root (EALLOWGIT): setup stops before `npm ci` there.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const posix = { skip: process.platform === "win32" ? "POSIX shell stub" : false };

test("npmAllowGitBroken: 11.9.0 up to (not including) 11.13.0", () => {
  for (const v of ["10.9.4", "11.8.0", "11.13.0", "12.2.2", "", "garbage", undefined]) assert.equal(npmAllowGitBroken(v), false, String(v));
  for (const v of ["11.9.0", "11.10.0", "11.12.1", "11.12.1\n"]) assert.equal(npmAllowGitBroken(v), true, v);
});

function setupCheckout() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-npmver-")));
  const checkout = path.join(base, "checkout");
  fs.mkdirSync(checkout);
  for (const f of ["setup.mjs", "packages.lock.json", "package.json", "package-lock.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(checkout, f));
  for (const d of ["scripts", "setup", "config"]) fs.cpSync(path.join(ROOT, d), path.join(checkout, d), { recursive: true });
  fs.mkdirSync(path.join(checkout, "extensions", "core-adapter"), { recursive: true });
  for (const f of ["profiles.mjs", "bridgelogin.mjs"]) fs.copyFileSync(path.join(ROOT, "extensions", "core-adapter", f), path.join(checkout, "extensions", "core-adapter", f));
  fs.mkdirSync(path.join(checkout, ".git"));
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const log = path.join(base, "npm.log");
  return { base, checkout, bin, log, agentDir: path.join(base, "agent"), cwd: base };
}

function fakeNpm(env, { version, versionFails = false }) {
  const file = path.join(env.bin, "npm");
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  ${versionFails ? "exit 1" : `echo ${version}; exit 0`}\nfi\necho "$@" >> "${env.log}"\nexit 0\n`, { mode: 0o755 });
}

function run(env, extra) {
  fs.mkdirSync(env.agentDir, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(env.checkout, "setup.mjs"), "--develop", ...extra, "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${env.bin}${path.delimiter}${process.env.PATH}`, PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: path.join(env.base, "pi.log") },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const ciCalled = (env) => fs.existsSync(env.log) && /^ci\b/m.test(fs.readFileSync(env.log, "utf8"));

test("setup stops before npm ci on npm 11.12.1 (real run)", posix, () => {
  const env = setupCheckout();
  try {
    fakeNpm(env, { version: "11.12.1" });
    const r = run(env, []);
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /11\.12\.1/);
    assert.match(r.out, /EALLOWGIT/);
    assert.match(r.out, /npm-stops-with-eallowgit/);
    assert.equal(ciCalled(env), false);
  } finally {
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test("setup dry run on npm 11.12.1 says it would stop and goes on", posix, () => {
  const env = setupCheckout();
  try {
    fakeNpm(env, { version: "11.12.1" });
    const r = run(env, ["--dry-run"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /would stop: .*EALLOWGIT/);
    assert.equal(ciCalled(env), false);
  } finally {
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test("setup runs npm ci when npm --version fails", posix, () => {
  const env = setupCheckout();
  try {
    fakeNpm(env, { version: "", versionFails: true });
    const r = run(env, []);
    assert.doesNotMatch(r.out, /EALLOWGIT/);
    assert.equal(ciCalled(env), true, r.out);
  } finally {
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});

test("setup runs npm ci on npm 11.13.0", posix, () => {
  const env = setupCheckout();
  try {
    fakeNpm(env, { version: "11.13.0" });
    const r = run(env, []);
    assert.doesNotMatch(r.out, /EALLOWGIT/);
    assert.equal(ciCalled(env), true, r.out);
  } finally {
    fs.rmSync(env.base, { recursive: true, force: true });
  }
});
