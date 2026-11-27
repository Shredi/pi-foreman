// setup.mjs never runs `npm ci` through a node_modules link: npm would empty the link target (another checkout's node_modules).
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./_sandbox-home.mjs";
import { linkedNodeModules } from "../../setup.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");

function temp() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-linked-nm-")));
  process.on("exit", () => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test("linkedNodeModules: null for none and for a real dir", () => {
  const root = temp();
  assert.equal(linkedNodeModules(root), null);
  fs.mkdirSync(path.join(root, "node_modules"));
  assert.equal(linkedNodeModules(root), null);
});

test("linkedNodeModules: a dir symlink returns its target", { skip: process.platform === "win32" && "symlinks need privileges on win32" }, () => {
  const base = temp();
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  const root = path.join(base, "root");
  fs.mkdirSync(root);
  fs.symlinkSync(outside, path.join(root, "node_modules"), "dir");
  assert.equal(linkedNodeModules(root), outside);
});

test("linkedNodeModules: a junction returns its target (a plain dir symlink off win32)", () => {
  const base = temp();
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  const root = path.join(base, "root");
  fs.mkdirSync(root);
  fs.symlinkSync(outside, path.join(root, "node_modules"), "junction");
  assert.equal(linkedNodeModules(root), outside);
});

function checkoutWithLink(base) {
  const checkout = path.join(base, "checkout");
  fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
  for (const f of ["packages.lock.json", "package.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(checkout, f));
  for (const d of ["scripts", "setup", "config"]) fs.cpSync(path.join(ROOT, d), path.join(checkout, d), { recursive: true });
  const source = fs.readFileSync(path.join(ROOT, "setup.mjs"), "utf8");
  fs.writeFileSync(path.join(checkout, "setup.mjs"), source);
  for (const m of source.matchAll(/^(?:import|\}) .*?from\s+"(\.\/[^"]+\.mjs)";?\s*$/gm)) {
    const rel = m[1].slice(2);
    fs.mkdirSync(path.dirname(path.join(checkout, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(checkout, rel));
  }
  const outside = path.join(base, "outside-nm");
  fs.mkdirSync(path.join(outside, "sentinel-pkg"), { recursive: true });
  fs.writeFileSync(path.join(outside, ".package-lock.json"), "{}");
  fs.utimesSync(path.join(outside, ".package-lock.json"), 1000, 1000);
  fs.writeFileSync(path.join(checkout, "package-lock.json"), "{}");
  fs.utimesSync(path.join(checkout, "package-lock.json"), 2000, 2000);
  fs.symlinkSync(outside, path.join(checkout, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return { checkout, outside };
}

for (const dry of [false, true]) {
  test(`setup ${dry ? "--dry-run " : ""}stops on a linked node_modules and runs no npm ci`, () => {
    const base = temp();
    const { checkout, outside } = checkoutWithLink(base);
    const agentDir = path.join(base, "agent");
    const calls = path.join(base, "npm-calls.log");
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    const WIN = process.platform === "win32";
    if (WIN) fs.writeFileSync(path.join(bin, "npm.cmd"), `@echo %* >> "${calls}"\r\n@exit /b 0\r\n`);
    else fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "$@" >> "${calls}"\nexit 0\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [path.join(checkout, "setup.mjs"), "--develop", "--agent-dir", agentDir, ...(dry ? ["--dry-run"] : [])], {
      cwd: base, encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: path.join(base, "pi.jsonl") },
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.match(out, dry ? /would stop: .*is a link to/ : /is a link to .*npm ci would empty that target/, out);
    if (!dry) assert.notEqual(r.status, 0, out);
    assert.equal(fs.existsSync(calls) && fs.readFileSync(calls, "utf8").includes("ci"), false, "npm ci was invoked");
    assert.deepEqual(fs.readdirSync(outside).sort(), [".package-lock.json", "sentinel-pkg"]);
  });
}
