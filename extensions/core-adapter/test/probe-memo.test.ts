import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PROBE_CODE } from "../python.ts";
import type { SpawnResult, Spawner } from "../spawn.ts";
import { probeSpawner, resetProbeMemo } from "./_probe-memo.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PROBE = ["-E", "-c", PROBE_CODE];
const OPTS = { timeoutMs: 1000 };
const EXE = path.join(os.tmpdir(), "pf-probe-memo-python");
const OK: SpawnResult = { code: 0, stdout: "3.13\n/usr/bin/python3\n/usr/bin/python3\n/usr/bin\n", stderr: "", timedOut: false };

/** A base spawner that counts its calls and answers `r` (over OK). */
function counting(r: Partial<SpawnResult> = {}): { base: Spawner; calls: string[] } {
  const calls: string[] = [];
  const base: Spawner = async (command) => {
    calls.push(command);
    return { ...OK, ...r };
  };
  return { base, calls };
}

/** A fresh directory holding a file named `name`: enough for the PATH lookup. */
function dirWith(name: string): string {
  const dir = mkTestTmp("pf-probe-memo-");
  fs.writeFileSync(path.join(dir, name), "");
  return dir;
}

test("a probe that succeeded is answered from memory the next time", async () => {
  resetProbeMemo();
  const { base, calls } = counting();
  const spawn = probeSpawner(base);
  const first = await spawn(EXE, PROBE, OPTS);
  const second = await spawn(EXE, PROBE, OPTS);
  assert.equal(calls.length, 1);
  assert.deepEqual(second, first);
});

test("a probe that failed, timed out or could not start is never remembered", async () => {
  resetProbeMemo();
  for (const r of [{ code: 1 }, { code: null, timedOut: true }, { code: null, error: new Error("ENOENT") }]) {
    const { base, calls } = counting(r);
    const spawn = probeSpawner(base);
    await spawn(EXE, PROBE, OPTS);
    await spawn(EXE, PROBE, OPTS);
    assert.equal(calls.length, 2, JSON.stringify(r));
  }
});

test("a probe that resolves to another executable on PATH is probed again", async () => {
  resetProbeMemo();
  const { base, calls } = counting();
  const spawn = probeSpawner(base);
  const a = dirWith("pf-probe-py");
  const b = dirWith("pf-probe-py");
  try {
    await spawn("pf-probe-py", PROBE, { ...OPTS, env: { PATH: a } });
    await spawn("pf-probe-py", PROBE, { ...OPTS, env: { PATH: a } });
    await spawn("pf-probe-py", PROBE, { ...OPTS, env: { PATH: b } });
    assert.equal(calls.length, 2);
  } finally {
    rmTestTmp(a);
    rmTestTmp(b);
  }
});

test("a command on no PATH runs each time and its probe is not remembered", async () => {
  resetProbeMemo();
  const { base, calls } = counting({ error: new Error("ENOENT") });
  const spawn = probeSpawner(base);
  const empty = mkTestTmp("pf-probe-memo-");
  try {
    await spawn("pf-probe-no-such-python", PROBE, { ...OPTS, env: { PATH: empty } });
    await spawn("pf-probe-no-such-python", PROBE, { ...OPTS, env: { PATH: empty } });
    assert.equal(calls.length, 2);
  } finally {
    rmTestTmp(empty);
  }
});

test("a call without the probe code goes to the base spawner every time", async () => {
  resetProbeMemo();
  const { base, calls } = counting();
  const spawn = probeSpawner(base);
  await spawn(EXE, ["--version"], OPTS);
  await spawn(EXE, ["--version"], OPTS);
  assert.equal(calls.length, 2);
});
