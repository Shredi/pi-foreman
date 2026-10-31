// Shutdown of the pressure sampler: stop() kills and awaits the in-flight sample child, so nothing writes into the state dir afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PressureSampler } from "../pressure.ts";
import { defaultSpawner } from "../spawn.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const SLEEP = ["-e", "setTimeout(()=>{},10000)"];

test("spawn: abort kills a running child and resolves after it closed, quickly", async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const p = defaultSpawner(process.execPath, SLEEP, { timeoutMs: 30_000, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 200));
  ac.abort();
  const r = await p;
  assert.ok(Date.now() - t0 < 2500, "resolved well before the 2 s SIGKILL grace");
  assert.equal(r.timedOut, false);
  assert.ok(r.error);
});

test("spawn: an already aborted signal does not spawn", async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await defaultSpawner("/nonexistent/never-spawned", [], { timeoutMs: 1000, signal: ac.signal });
  assert.equal(r.code, null);
  assert.match(r.error?.message ?? "", /abort/);
});

test("PressureSampler.stop aborts the pending run, resolves after it settles, traces nothing, and later ticks are no-ops", async () => {
  const traces: Record<string, unknown>[] = [];
  let seen: AbortSignal | undefined;
  let calls = 0;
  let settle: () => void = () => undefined;
  const s = new PressureSampler({
    file: "/state/pressure.json",
    workspace: "/ws",
    config: () => ({}),
    run: (_args, signal) => {
      calls++;
      seen = signal;
      return new Promise((_r, rej) => (settle = () => rej(new Error("aborted"))));
    },
    trace: (r) => traces.push(r),
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  s.start();
  assert.equal(calls, 1);
  let stopped = false;
  const stopP = s.stop().then(() => (stopped = true));
  assert.equal(seen?.aborted, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, false, "stop waits for the run to settle");
  settle();
  await stopP;
  assert.deepEqual(traces, []);
  await s.tick();
  assert.equal(calls, 1);
  await s.stop();
});

test("stop while a sample child is in flight: the state dir stays unchanged afterwards", async (t) => {
  const dir = mkTestTmp("pf-sampler-stop-");
  t.after(() => rmTestTmp(dir));
  const state = path.join(dir, "state");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "pressure.json"), "{}");
  // Mimics foreman_pressure.py: writes a temp file, then renames it into place, after 600 ms unless killed.
  const code = "const fs=require('fs'),p=require('path');setTimeout(()=>{const f=p.join(process.argv[1],'pressure.json.x.tmp');fs.writeFileSync(f,'{}');fs.renameSync(f,p.join(process.argv[1],'pressure.json'));},600)";
  const s = new PressureSampler({
    file: path.join(state, "pressure.json"),
    workspace: dir,
    config: () => ({}),
    run: async (_args, signal) => {
      const r = await defaultSpawner(process.execPath, ["-e", code, state], { timeoutMs: 20_000, signal });
      return { ok: !r.error && r.code === 0, text: r.stdout };
    },
    trace: () => assert.fail("an aborted sample is not traced"),
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  const listing = (): string =>
    fs.readdirSync(state).sort().map((n) => { const st = fs.statSync(path.join(state, n)); return `${n}:${st.size}:${st.mtimeMs}`; }).join("|");
  s.start();
  await new Promise((r) => setTimeout(r, 200));
  const before = listing();
  await s.stop();
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(listing(), before);
  assert.deepEqual(fs.readdirSync(state).filter((n) => n.endsWith(".tmp")), []);
});
