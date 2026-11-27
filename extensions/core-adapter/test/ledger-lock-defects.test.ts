// Round-2 fixes of D181: a folder or a dangling link at `<ledger>.lock` ends in the lock error within the wait (it never spins),
// the lock's host names the platform, an unlockable runner run says so, redirects to the screen devices are no write outside.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { takeLedgerLock, takeLedgerLockAsync, LedgerLockedError } from "../ledgerlockfs.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { setup } from "./_hsrig.ts";
import { posixOnly } from "./_platform.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), "lld-"));
const kinds: [string, (lock: string, dir: string) => void, boolean][] = [
  ["a folder", (lock) => fs.mkdirSync(lock), false],
  ["a dangling symlink", (lock, dir) => fs.symlinkSync(path.join(dir, "nowhere"), lock), true],
];

for (const [name, make, posix] of kinds) {
  test(`${name} at the lock path: sync and async end in the lock error within the wait`, { skip: posix ? posixOnly : false, timeout: 20_000 }, async () => {
    const dir = mk();
    try {
      const file = path.join(dir, "L.md");
      make(`${file}.lock`, dir);
      const t0 = Date.now();
      assert.throws(() => takeLedgerLock(file, 200), LedgerLockedError);
      await assert.rejects(takeLedgerLockAsync(file, 200), LedgerLockedError);
      assert.ok(Date.now() - t0 < 5_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${name} at the lock path: the shim helper prints the lock text and exits 1`, { skip: posix ? posixOnly : false, timeout: 30_000 }, () => {
    const dir = mk();
    try {
      const file = path.join(dir, "L.md");
      const before = "# Ledger: x\nTier: standard\n\n- [ ] 1. a\n";
      fs.writeFileSync(file, before);
      make(`${file}.lock`, dir);
      const script = path.join(root, "core", "scripts", "ledger.py");
      const r = spawnSync(process.execPath, ["--experimental-strip-types", path.join(root, "bin", "ledger-run.mjs"), script, "python3", "--", "-f", file, "add", "x"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, PI_FOREMAN_LEDGER_RUN_WAIT_MS: "300" } });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /is locked by another writer/);
      assert.equal(fs.readFileSync(file, "utf8"), before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the host field names the platform: a dead pid of another platform's host is foreign, of this one is taken over", async () => {
  const dir = mk();
  try {
    const file = path.join(dir, "L.md");
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const host = os.hostname().replace(/\s+/g, "_");
    fs.writeFileSync(`${file}.lock`, `${dead} ${Date.now()} n ${host}/${process.platform === "win32" ? "linux" : "win32"}\n`);
    assert.throws(() => takeLedgerLock(file, 100), LedgerLockedError);
    fs.writeFileSync(`${file}.lock`, `${dead} ${Date.now()} n ${host}\n`); // an old lock without a platform: foreign too
    assert.throws(() => takeLedgerLock(file, 100), LedgerLockedError);
    fs.writeFileSync(`${file}.lock`, `${dead} ${Date.now()} n ${host}/${process.platform}\n`);
    takeLedgerLock(file, 100)();
    fs.writeFileSync(`${file}.lock`, `${dead} ${Date.now()} n\n`); // an old 3-field lock still reads
    takeLedgerLock(file, 100)();
    const release = takeLedgerLock(file, 100);
    assert.match(fs.readFileSync(`${file}.lock`, "utf8"), new RegExp(` ${host}/${process.platform}\\n$`));
    release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the runner says so when the lock file cannot be created (read-only folder)", { skip: posixOnly }, async (t) => {
  const { a, w } = await setup(t);
  const dir = path.join(w.project, ".workflow");
  if (process.getuid?.() === 0) return;
  fs.chmodSync(dir, 0o555);
  try {
    const r = (await a.tool("foreman_ledger")!.execute("ro1", { action: "add", text: "ro" }, undefined, undefined, a.ctx)) as { content: { text: string }[] };
    assert.match(r.content[0]?.text ?? "", /ledger: running without the ledger lock/);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

const base = fs.realpathSync(mk());
const wt = path.join(base, "wt");
fs.mkdirSync(wt, { recursive: true });
const roots: GateRoots = { worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false, builder: true };
const seen = (command: string): string => {
  const o = gateEvaluate("bash", { command }, wt, { env: (c) => baseFloorEnv(c, { child: true }), roots: () => roots }) as { result?: { block?: boolean; rule?: string } };
  return o.result?.block ? `block:${o.result.rule}` : "ok";
};

test("redirects to /dev/null, /dev/stdout and /dev/stderr are no write outside; other devices still are", { skip: posixOnly }, () => {
  for (const c of ["echo x > /dev/null", "echo x > /dev/stderr", "echo x >> /dev/stdout", "make 2> /dev/stderr", "make 2> /dev/stdout", "make &> /dev/null"]) assert.equal(seen(c), "ok", c);
  for (const c of ["echo x > /dev/sda", "echo x > /dev/tty", "echo x > /dev/fd/3", "echo x > /dev/null/../x", "echo x > /dev/stderr/x"]) assert.match(seen(c), /^block:/, c);
});

test.after(() => fs.rmSync(base, { recursive: true, force: true }));
