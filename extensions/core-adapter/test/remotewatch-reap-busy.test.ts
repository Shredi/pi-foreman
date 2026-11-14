// rw3b item 4 (watcher): after the verified `closed` notice and the full wait, a program in the foreground is ended whatever it is, but
// only when the closed label with the number of the applied notice is on the terminal at that read. Also `reaped` (item 3).
// Fixture note: the label rides in the reply of `hc get` as `labels["fm.notice"]`. Checked once, by experiment, on one platform: a
// process the way `selffinish.ts` starts the cleanup (detached, stdio ignored, unref) was alive but not reported as the terminal's
// foreground program (the shell was), and a normal command was reported while it ran; Windows is not checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RemoteWatcher } from "../remotewatch.ts";
import type { HcResult, HcRun } from "../remotewatch.ts";
import { readRegistry, writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-reapb-")));
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const rpc = (type: string, terminal: string, data: unknown) => ({ jsonrpc: "2.0", method: "event", params: { type, terminal, seq: 1, data } });

type Reply = { code: number; body?: unknown };

function rig() {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  const mirror = path.join(dir, "m");
  const e = {
    label: "demo", child: CHILD, parent: "p", handoff: mirror, status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: "/h/x", mirror,
    remote: { platform: "linux" }, backend: "hc", hc: { address: "alpha/t7", space: null, tab: null }, briefs: 0, lastError: null, last: null,
  } as unknown as SessionEntry;
  writeRegistry(dir, { version: 1, sessions: [e] });
  const calls: string[][] = [];
  const notes: string[] = [];
  const state: { get: (n: number) => Reply; gets: number } = { get: () => ({ code: 0, body: { state: "live", foreground: { name: "pi" } } }), gets: 0 };
  const killed = { v: false, atGet: -1 };
  const rmCode = { v: 0 };
  const hc: HcRun = async (args) => {
    calls.push(args);
    const res = (o: Partial<HcResult>): HcResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, overflow: false, ...o });
    if (args[0] === "kill") (killed.v = true), (killed.atGet = state.gets);
    if (args[0] === "rm") return res({ code: rmCode.v });
    if (args[0] !== "get") return res({});
    const r = state.get(state.gets++);
    return res({ code: r.code, stdout: Buffer.from(JSON.stringify(r.body ?? {})), stderr: r.code ? JSON.stringify({ error: { kind: "not_found", message: "no terminal" } }) : "" });
  };
  let line: ((l: string) => void) | undefined;
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const w = new RemoteWatcher({
    agentDir: dir, opener: () => "p", hc,
    events: (onLine) => ((line = onLine), { kill: () => undefined }),
    wake: () => undefined,
    notify: (m: string) => void notes.push(m),
    timer: (fn, ms) => {
      const t = { fn: () => { t.live = false; fn(); }, ms, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    now: () => Date.parse("2026-11-03T12:00:00Z"),
  } as ConstructorParameters<typeof RemoteWatcher>[0]);
  const closed = async (seq = 1): Promise<void> => {
    w.start();
    line?.(JSON.stringify(rpc("labels", "alpha/t7", { labels: { "fm.notice": `${seq}:closed:-:0` } })));
    await w.idle();
  };
  const drain = async (max = 200): Promise<void> => {
    for (let i = 0; i < max; i++) {
      for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
      const t = timers.find((x) => x.live && x.ms === 3000);
      if (!t) return;
      t.fn();
    }
  };
  const verbs = (): string[] => calls.map((c) => c[0]);
  const reaped = (): unknown => readRegistry(dir).sessions[0].reaped;
  return { w, calls, notes, state, closed, drain, verbs, killed, reaped, rmCode };
}

const live = (name: string, notice: string | undefined, killed: { v: boolean }): Reply => ({
  code: 0,
  body: killed.v ? { state: "finished" } : { state: "live", foreground: { name }, ...(notice !== undefined ? { labels: { "fm.notice": notice } } : {}) },
});

test("busy: pi and node.exe are ended at the bound when the closed label with the applied number is on the terminal, then removed", async () => {
  for (const name of ["pi", "node.exe"]) {
    const r = rig();
    r.state.get = () => live(name, "1:closed:-:0", r.killed);
    await r.closed(1);
    await r.drain();
    assert.deepEqual(r.calls.filter((c) => c[0] === "kill"), [["kill", "alpha/t7"]], name);
    assert.deepEqual(r.calls.filter((c) => c[0] === "rm"), [["rm", "alpha/t7"]], name);
    assert.ok(r.killed.atGet > 40, `ended only at the bound (after ${String(r.killed.atGet)} reads)`);
    assert.equal(r.notes.filter((n) => n === `ended ${name} in alpha/t7 after the session closed`).length, 1, name);
    assert.equal(r.reaped(), true, name);
  }
});

test("busy: a gone label, another number, a refused or a malformed label end nothing and are reported", async () => {
  const cases: (string | undefined)[] = [undefined, "2:closed:-:0", "1:refused:no-way", "closed", "1:result:-:0", "0:closed:-:0"];
  for (const notice of cases) {
    const r = rig();
    r.state.get = () => live("pi", notice, r.killed);
    await r.closed(1);
    await r.drain();
    assert.equal(r.verbs().includes("kill"), false, String(notice));
    assert.equal(r.verbs().includes("rm"), false, String(notice));
    assert.equal(r.notes.filter((n) => n.includes("left alone")).length, 1, String(notice));
    assert.equal(r.reaped(), undefined, String(notice));
  }
});

test("busy: the label is read at the bound, not earlier: a label that is gone by then ends nothing", async () => {
  const r = rig();
  r.state.get = (n) => live("pi", n < 40 ? "1:closed:-:0" : undefined, r.killed);
  await r.closed(1);
  await r.drain();
  assert.equal(r.verbs().includes("kill"), false);
});

test("busy: nothing is ended before the bound", async () => {
  const r = rig();
  r.state.get = (n) => (n < 39 ? live("pi", "1:closed:-:0", r.killed) : { code: 0, body: { state: "finished" } });
  await r.closed(1);
  await r.drain();
  assert.equal(r.verbs().includes("kill"), false);
  assert.deepEqual(r.calls.filter((c) => c[0] === "rm"), [["rm", "alpha/t7"]]);
});

test("busy: the foreground name is only printed, control-stripped", async () => {
  const r = rig();
  r.state.get = () => live("pi\u0007\nx", "1:closed:-:0", r.killed);
  await r.closed(1);
  await r.drain();
  const ended = r.notes.find((n) => n.startsWith("ended"));
  assert.ok(ended && !/[\u0000-\u001f]/.test(ended), String(ended));
  for (const c of r.calls) assert.ok(!c.some((a) => a.includes("pi\u0007")), "no foreground text in a command line");
});

test("reaped: set when the terminal was found gone and when it was removed; not set when the rm failed", async () => {
  const gone = rig();
  gone.state.get = () => ({ code: 3 });
  await gone.closed();
  await gone.drain();
  assert.equal(gone.reaped(), true);
  const fin = rig();
  fin.state.get = () => ({ code: 0, body: { state: "finished" } });
  await fin.closed();
  await fin.drain();
  assert.equal(fin.reaped(), true);
  const bad = rig();
  bad.state.get = () => ({ code: 0, body: { state: "finished" } });
  bad.rmCode.v = 1;
  await bad.closed();
  await bad.drain();
  assert.equal(bad.reaped(), undefined);
});
