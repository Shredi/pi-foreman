// rmTestTmp stops a pi-intercom broker that a session left under the removed dir, and disableIntercom writes the
// config that keeps the broker from spawning at all. The broker here is a dummy child that writes its pid the way
// the real broker does (<agentDir>/intercom/broker.pid), so no pi-intercom code runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { disableIntercom, mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

test("disableIntercom writes intercom/config.json with enabled: false", () => {
  const root = mkTestTmp("tmpbase-disable-");
  try {
    disableIntercom(root);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "intercom", "config.json"), "utf8"));
    assert.deepEqual(cfg, { enabled: false });
  } finally {
    rmTestTmp(root);
  }
});

test("rmTestTmp SIGTERMs a broker-pid'd child under the removed dir before removing it", async () => {
  const root = mkTestTmp("tmpbase-broker-");
  const agentDir = path.join(root, "agent");
  const dir = path.join(agentDir, "intercom");
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid !== undefined);
  fs.writeFileSync(path.join(dir, "broker.pid"), String(pid));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  rmTestTmp(root);
  await exited;
  assert.equal(alive(pid), false);
  assert.equal(fs.existsSync(root), false);
});

test("rmTestTmp ignores a broker.pid whose process is already gone (ESRCH)", () => {
  const root = mkTestTmp("tmpbase-esrch-");
  const dir = path.join(root, "agent", "intercom");
  fs.mkdirSync(dir, { recursive: true });
  // A pid no live process holds: spawn a short child, wait for it to exit, and reuse its pid.
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = gone.pid;
  assert.ok(pid !== undefined);
  fs.writeFileSync(path.join(dir, "broker.pid"), String(pid));
  return new Promise<void>((resolve) => gone.once("exit", () => {
    rmTestTmp(root);
    assert.equal(fs.existsSync(root), false);
    resolve();
  }));
});
