// POSIX launchers (bin/ledger, bin/foreman, bin/foreman-worktree-setup) refuse Python below 3.13 before they run a script.
// The PATH is controlled: only a fake python3 and dirname are reachable, so no real interpreter is picked up.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { writeFakePython } from "./fixtures/fake-python.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const posix = { skip: process.platform === "win32" };

const MSG = "pi-foreman needs Python 3.13+; found python3 3.9. Set PI_FOREMAN_PYTHON or install Python 3.13 (macOS: brew install python@3.13).";

// [launcher, its arguments, the script it execs (relative to bin/)]
const CASES = [
  ["bin/ledger", ["sample-arg"], "../core/scripts/ledger.py"],
  ["bin/foreman", ["config", "sample-arg"], "../scripts/foreman_config.py"],
  ["bin/foreman-worktree-setup", ["sample-arg"], "../scripts/foreman_worktree_setup.py"],
];

let tmp;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-launcher-floor-")));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A sandbox whose PATH holds `dirname` and the fake python3 of `version` (and nothing else). */
function sandbox(name, version) {
  const dir = path.join(tmp, name);
  const tools = path.join(dir, "tools");
  const fake = path.join(dir, "fake");
  fs.mkdirSync(tools, { recursive: true });
  fs.mkdirSync(fake);
  fs.symlinkSync("/usr/bin/dirname", path.join(tools, "dirname"));
  const log = path.join(dir, "calls.log");
  writeFakePython(path.join(fake, "python3"), version, log);
  return { dir, log, path: `${fake}:${tools}` };
}

const calls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);

function launch(rel, args, sb, extraEnv = {}) {
  return spawnSync(path.join(ROOT, rel), args, { encoding: "utf8", env: { PATH: sb.path, ...extraEnv } });
}

for (const [rel, args, script] of CASES) {
  test(`${rel} exits 2 with the 3.13 message when python3 is 3.9`, posix, () => {
    const sb = sandbox(`old-${path.basename(rel)}`, "3.9");
    const r = launch(rel, args, sb);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stderr.trim(), MSG);
    assert.equal(r.stdout, "");
    assert.deepEqual(calls(sb.log).filter((l) => l.includes(" -E -s ")), []);
  });

  test(`${rel} execs a python3 3.13 with the script and its arguments`, posix, () => {
    const sb = sandbox(`new-${path.basename(rel)}`, "3.13");
    const r = launch(rel, args, sb);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls(sb.log).at(-1), `-E -s ${ROOT}/bin/${script} sample-arg`);
  });

  test(`${rel} with PI_FOREMAN_PYTHON set uses it without a version probe`, posix, () => {
    const sb = sandbox(`env-${path.basename(rel)}`, "3.9");
    const recorder = path.join(sb.dir, "recorder");
    writeFakePython(recorder, "3.9", sb.log);
    const r = launch(rel, args, sb, { PI_FOREMAN_PYTHON: recorder });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(calls(sb.log), [`-E -s ${ROOT}/bin/${script} sample-arg`]);
  });
}
