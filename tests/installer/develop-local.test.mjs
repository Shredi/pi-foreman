import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");

function setupEnv(globalPackages) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-develop-local-")));
  process.on("exit", () => fs.rmSync(base, { recursive: true, force: true }));
  const agentDir = path.join(base, "agent");
  fs.mkdirSync(agentDir);
  const installed = path.join(base, "installed");
  fs.mkdirSync(installed);
  fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "pi-foreman" }));
  const checkout = path.join(base, "checkout");
  fs.mkdirSync(checkout);
  for (const f of ["setup.mjs", "packages.lock.json", "package.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(checkout, f));
  fs.cpSync(path.join(ROOT, "scripts"), path.join(checkout, "scripts"), { recursive: true });
  fs.cpSync(path.join(ROOT, "config"), path.join(checkout, "config"), { recursive: true });
  fs.mkdirSync(path.join(checkout, "extensions", "core-adapter"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "extensions", "core-adapter", "profiles.mjs"), path.join(checkout, "extensions", "core-adapter", "profiles.mjs"));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: globalPackages({ agentDir, installed, checkout }) }));
  const r = spawnSync(process.execPath, [path.join(checkout, "setup.mjs"), "--develop", "--agent-dir", agentDir], {
    cwd: base, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: `${base}-calls.jsonl` },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return { installed, written: JSON.parse(fs.readFileSync(path.join(checkout, ".pi", "settings.json"), "utf8")) };
}

test("--develop overrides a relative local-path global pi-foreman entry with its absolute path", () => {
  const { installed, written } = setupEnv(({ agentDir, installed }) => [path.relative(agentDir, installed)]);
  assert.deepEqual(written.packages, ["..", { source: installed, extensions: [], skills: [], prompts: [], themes: [] }]);
});

test("--develop writes Pi's identity path (no realpath) for a symlinked global entry", () => {
  let link;
  const { installed, written } = setupEnv(({ agentDir, installed }) => {
    link = path.join(agentDir, "installed-link");
    fs.symlinkSync(installed, link);
    return ["installed-link"];
  });
  assert.notEqual(link, installed);
  assert.deepEqual(written.packages, ["..", { source: link, extensions: [], skills: [], prompts: [], themes: [] }]);
});

test("--develop writes no override for a global entry that is the checkout itself", () => {
  const { written } = setupEnv(({ checkout }) => [checkout]);
  assert.deepEqual(written.packages, [".."]);
});
