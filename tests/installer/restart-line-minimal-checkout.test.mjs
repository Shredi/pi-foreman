// D105: a real (non-dry) setup run from a minimal checkout, holding only what setup.mjs imports statically, prints the restart line of an older live session.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./_sandbox-home.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");

test("setup in a minimal checkout lists an older live session with its restart command", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-restart-line-")));
  process.on("exit", () => fs.rmSync(base, { recursive: true, force: true }));
  const agentDir = path.join(base, "agent");
  const checkout = path.join(base, "checkout");
  fs.mkdirSync(checkout);
  for (const f of ["packages.lock.json", "package.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(checkout, f));
  for (const d of ["scripts", "setup", "config"]) fs.cpSync(path.join(ROOT, d), path.join(checkout, d), { recursive: true });
  // every relative module setup.mjs imports statically, so a new import cannot be missed here
  const source = fs.readFileSync(path.join(ROOT, "setup.mjs"), "utf8");
  fs.writeFileSync(path.join(checkout, "setup.mjs"), source);
  const imports = [...source.matchAll(/^(?:import|\}) .*?from\s+"(\.\/[^"]+\.mjs)";?\s*$/gm)].map((m) => m[1].slice(2));
  assert.ok(imports.includes("extensions/core-adapter/harnessid.mjs"));
  for (const rel of imports) {
    fs.mkdirSync(path.dirname(path.join(checkout, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(checkout, rel));
  }
  const live = path.join(agentDir, "pi-foreman", "state", "live");
  fs.mkdirSync(live, { recursive: true });
  const rec = { sessionId: "older-1", label: "job", cwd: "/w/job", pid: process.pid, parentIntercom: "fm-parent", heartbeatAt: new Date().toISOString(), state: "idle", harness: { version: "0.0.0", commit: "old1234" } };
  fs.writeFileSync(path.join(live, "older-1.json"), JSON.stringify(rec));
  const r = spawnSync(process.execPath, [path.join(checkout, "setup.mjs"), "--develop", "--agent-dir", agentDir], {
    cwd: base, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: `${base}-calls.jsonl` },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /still runs older pi-foreman code/);
  assert.match(r.stdout, /job: foreman session restart job/);
});
