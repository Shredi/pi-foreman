// D181 (owner ruling 2026-11-26): core/ledger.py holds no lock; the adapter's runner and the shim helper hold `<ledger>.lock`
// around the whole ledger.py run. Runner + shim lose nothing; a stale lock is taken over; a held lock runs nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LEDGER_RUN_WAIT_MS, LOCK_MAX_HOLD_MS } from "../ledgerlockfs.ts";
import { setup } from "./_hsrig.ts";
import { posixOnly } from "./_platform.ts";
const { buildLedgerRun } = (await import("../../../bin/ledger-run.mjs")) as {
  buildLedgerRun: (argv: string[], snippet?: string) => { run: { cmd: string; args: string[] }; resolve: { cmd: string; args: string[] } } | null;
};

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the run wait exceeds the lock ceiling", () => {
  assert.ok(LEDGER_RUN_WAIT_MS > LOCK_MAX_HOLD_MS);
});

test("runner and shim adding together keep every add", async (t) => {
  const { a, w } = await setup(t);
  const file = path.join(w.project, ".workflow", "LEDGER-x.md");
  const shim = path.join(root, "bin", "ledger");
  const adds = new Promise<number>((resolve) => {
    const code = `for i in $(seq 0 59); do sh ${JSON.stringify(shim)} -f ${JSON.stringify(file)} add sh$i >/dev/null || exit 1; done`;
    spawn("sh", ["-c", code], { stdio: "inherit", env: { ...process.env, PI_FOREMAN_PYTHON: "python3" } }).on("exit", (c) => resolve(c ?? 1));
  });
  const tool = a.tool("foreman_ledger")!;
  for (let i = 0; i < 60; i++) {
    const r = (await tool.execute(`r${i}`, { action: "add", text: `run${i}` }, undefined, undefined, a.ctx)) as { isError?: boolean; content: { text: string }[] };
    assert.ok(!r.isError, r.content[0]?.text);
  }
  assert.equal(await adds, 0);
  const text = fs.readFileSync(file, "utf8");
  for (let i = 0; i < 60; i++) {
    assert.match(text, new RegExp(` run${i}\\n`));
    assert.match(text, new RegExp(` sh${i}\\n`));
  }
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("a lock past the ceiling is taken over by the runner", async (t) => {
  const { a, w } = await setup(t);
  const file = path.join(w.project, ".workflow", "LEDGER-x.md");
  fs.writeFileSync(`${file}.lock`, `${process.pid} ${Date.now() - LOCK_MAX_HOLD_MS - 5_000}\n`);
  const r = (await a.tool("foreman_ledger")!.execute("s1", { action: "add", text: "after stale" }, undefined, undefined, a.ctx)) as { isError?: boolean };
  assert.ok(!r.isError);
  assert.match(fs.readFileSync(file, "utf8"), / after stale\n/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("a lock held past the wait: the runner fails with the lock text and ledger.py does not run", { timeout: 60_000 }, async (t) => {
  const { a, w } = await setup(t);
  const file = path.join(w.project, ".workflow", "LEDGER-x.md");
  const before = fs.readFileSync(file, "utf8");
  fs.writeFileSync(`${file}.lock`, `${process.pid} ${Date.now()}\n`); // a live holder (this process)
  process.env.PI_FOREMAN_LEDGER_RUN_WAIT_MS = "1500";
  const r = (await a.tool("foreman_ledger")!.execute("h1", { action: "add", text: "never" }, undefined, undefined, a.ctx).finally(() => delete process.env.PI_FOREMAN_LEDGER_RUN_WAIT_MS)) as { isError?: boolean; content: { text: string }[] };
  assert.equal(r.isError, true);
  assert.match(r.content[0]?.text ?? "", /locked by another writer/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.existsSync(`${file}.lock`), true);
});

test("the helper's argv: the run and the resolve command keep the shim's python, prefix and arguments (the .cmd/.ps1 call shape)", () => {
  const script = path.join("C:", "pf", "core", "scripts", "ledger.py");
  const plan = buildLedgerRun([script, "py", "-3", "--", "-f", "L.md", "add", "x y"], "SNIP");
  assert.ok(plan);
  assert.deepEqual(plan.run, { cmd: "py", args: ["-3", "-X", "utf8", "-E", "-s", script, "-f", "L.md", "add", "x y"] });
  assert.deepEqual(plan.resolve, { cmd: "py", args: ["-3", "-I", "-c", "SNIP", path.dirname(script), "-f", "L.md", "add", "x y"] });
  assert.equal(buildLedgerRun(["only-script"], ""), null);
  assert.deepEqual(buildLedgerRun([script, "python", "--"], "")?.run.args, ["-X", "utf8", "-E", "-s", script]);
});

test("a release leaves a lock that a takeover gave to another holder", async () => {
  const { takeLedgerLock } = await import("../ledgerlockfs.ts");
  const dir = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "llrel-"));
  try {
    const file = path.join(dir, "L.md");
    const release = takeLedgerLock(file);
    fs.writeFileSync(`${file}.lock`, `4242 ${Date.now()} other\n`); // another holder took over
    release();
    assert.equal(fs.readFileSync(`${file}.lock`, "utf8").startsWith("4242 "), true);
    fs.rmSync(`${file}.lock`);
    takeLedgerLock(file)();
    assert.equal(fs.existsSync(`${file}.lock`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the shim helper says so on stderr when ledger.py runs without the lock (lock file cannot be created)", { skip: posixOnly }, async () => {
  const os = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llun-"));
  try {
    fs.mkdirSync(path.join(dir, "ro"));
    const file = path.join(dir, "ro", "L.md");
    fs.writeFileSync(file, "# Ledger: x\nTier: standard\n\n- [ ] 1. a\n");
    fs.chmodSync(path.join(dir, "ro"), 0o555);
    const script = path.join(root, "core", "scripts", "ledger.py");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", path.join(root, "bin", "ledger-run.mjs"), script, "python3", "--", "-f", file, "status"], { encoding: "utf8" });
    if (process.getuid?.() === 0) return; // root can create the lock: nothing to see
    assert.match(r.stderr, /ledger-run: running without the ledger lock/);
  } finally {
    fs.chmodSync(path.join(dir, "ro"), 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function lockDir() {
  const os = await import("node:os");
  return fs.mkdtempSync(path.join(os.tmpdir(), "llst-"));
}

test("a live holder older than the old 10 s limit keeps its lock", async () => {
  const { takeLedgerLock, LedgerLockedError } = await import("../ledgerlockfs.ts");
  const dir = await lockDir();
  try {
    const file = path.join(dir, "L.md");
    const content = `${process.pid} ${Date.now() - 60_000} nonce\n`;
    fs.writeFileSync(`${file}.lock`, content);
    assert.throws(() => takeLedgerLock(file, 100), LedgerLockedError);
    assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), content);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock of a dead pid is taken over at once", async () => {
  const { spawnSync } = await import("node:child_process");
  const { takeLedgerLock } = await import("../ledgerlockfs.ts");
  const dir = await lockDir();
  try {
    const file = path.join(dir, "L.md");
    const dead = spawnSync(process.execPath, ["-e", ""]).pid; // spawned and reaped
    fs.writeFileSync(`${file}.lock`, `${dead} ${Date.now()} nonce\n`);
    const t0 = Date.now();
    const release = takeLedgerLock(file, 100);
    assert.ok(Date.now() - t0 < 100);
    assert.ok(fs.readFileSync(`${file}.lock`, "utf8").startsWith(`${process.pid} `));
    release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock past the ceiling is taken over even with a live pid; a foreign host's fresh lock is not", async () => {
  const { takeLedgerLock, LedgerLockedError } = await import("../ledgerlockfs.ts");
  const dir = await lockDir();
  try {
    const file = path.join(dir, "L.md");
    fs.writeFileSync(`${file}.lock`, `${process.pid} ${Date.now() - LOCK_MAX_HOLD_MS - 1_000} nonce\n`);
    takeLedgerLock(file, 100)();
    fs.writeFileSync(`${file}.lock`, `999999 ${Date.now()} nonce some-other-host\n`);
    assert.throws(() => takeLedgerLock(file, 100), LedgerLockedError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
