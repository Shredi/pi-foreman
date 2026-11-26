// D181 (owner ruling 2026-11-26): core/ledger.py holds no lock; the adapter's runner and the shim helper hold `<ledger>.lock`
// around the whole ledger.py run. Runner + shim lose nothing; a stale lock is taken over; a held lock runs nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LEDGER_RUN_WAIT_MS, LOCK_STALE_MS } from "../ledgerlockfs.ts";
import { setup } from "./_hsrig.ts";
const { buildLedgerRun } = (await import("../../../bin/ledger-run.mjs")) as {
  buildLedgerRun: (argv: string[], snippet?: string) => { run: { cmd: string; args: string[] }; resolve: { cmd: string; args: string[] } } | null;
};

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the run wait exceeds a crashed holder's lock", () => {
  assert.ok(LEDGER_RUN_WAIT_MS > LOCK_STALE_MS);
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

test("a stale lock is taken over by the runner", async (t) => {
  const { a, w } = await setup(t);
  const file = path.join(w.project, ".workflow", "LEDGER-x.md");
  fs.writeFileSync(`${file}.lock`, `999999 ${Date.now() - 3_600_000}\n`);
  const r = (await a.tool("foreman_ledger")!.execute("s1", { action: "add", text: "after stale" }, undefined, undefined, a.ctx)) as { isError?: boolean };
  assert.ok(!r.isError);
  assert.match(fs.readFileSync(file, "utf8"), / after stale\n/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("a lock held past the wait: the runner fails with the lock text and ledger.py does not run", { timeout: 60_000 }, async (t) => {
  const { a, w } = await setup(t);
  const file = path.join(w.project, ".workflow", "LEDGER-x.md");
  const before = fs.readFileSync(file, "utf8");
  // a live holder: its stamp stays fresh (a lock older than LOCK_STALE_MS is a crashed holder's and taken over)
  const beat = () => fs.writeFileSync(`${file}.lock`, `${process.pid} ${Date.now()}\n`);
  beat();
  const timer = setInterval(beat, 1_000);
  const r = (await a.tool("foreman_ledger")!.execute("h1", { action: "add", text: "never" }, undefined, undefined, a.ctx).finally(() => clearInterval(timer))) as { isError?: boolean; content: { text: string }[] };
  assert.equal(r.isError, true);
  assert.match(r.content[0]?.text ?? "", /locked by another writer/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.existsSync(`${file}.lock`), true);
});

test("the helper's argv: the run and the resolve command keep the shim's python, prefix and arguments (the .cmd/.ps1 call shape)", () => {
  const script = path.join("C:", "pf", "core", "scripts", "ledger.py");
  const plan = buildLedgerRun([script, "py", "-3", "--", "-f", "L.md", "add", "x y"], "SNIP");
  assert.ok(plan);
  assert.deepEqual(plan.run, { cmd: "py", args: ["-3", "-E", "-s", script, "-f", "L.md", "add", "x y"] });
  assert.deepEqual(plan.resolve, { cmd: "py", args: ["-3", "-I", "-c", "SNIP", path.dirname(script), "-f", "L.md", "add", "x y"] });
  assert.equal(buildLedgerRun(["only-script"], ""), null);
  assert.deepEqual(buildLedgerRun([script, "python", "--"], "")?.run.args, ["-E", "-s", script]);
});
