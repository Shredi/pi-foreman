// remote-windows-2 item 1: after a `closed` notice the parent polls `hc get` until the terminal has finished, then `hc rm`.
// not_found: done, no rm. At the 120 s bound a shell in the foreground is killed (then polled and removed); anything else is reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isShellName, RemoteWatcher } from "../remotewatch.ts";
import type { HcResult, HcRun } from "../remotewatch.ts";
import { writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-reap-")));
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
  const killed = { v: false };
  const hc: HcRun = async (args) => {
    calls.push(args);
    const res = (o: Partial<HcResult>): HcResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, overflow: false, ...o });
    if (args[0] === "kill") killed.v = true;
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
  const closed = async (): Promise<void> => {
    w.start();
    line?.(JSON.stringify(rpc("labels", "alpha/t7", { labels: { "fm.notice": "1:closed:-:0" } })));
    await w.idle();
  };
  // fire the 3 s poll sleeps until none is left
  const drain = async (max = 100): Promise<void> => {
    for (let i = 0; i < max; i++) {
      for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
      const t = timers.find((x) => x.live && x.ms === 3000);
      if (!t) return;
      t.fn();
    }
  };
  const verbs = (): string[] => calls.map((c) => c[0]);
  return { w, calls, notes, state, closed, drain, verbs, killed };
}

test("reap: polls hc get until finished, then hc rm", async () => {
  const r = rig();
  r.state.get = (n) => ({ code: 0, body: { state: n < 2 ? "live" : "finished", foreground: { name: "pi" } } });
  await r.closed();
  await r.drain();
  assert.deepEqual(r.calls.filter((c) => c[0] === "rm"), [["rm", "alpha/t7"]]);
  assert.equal(r.verbs().includes("kill"), false);
});

test("reap: not_found is done, no rm", async () => {
  const r = rig();
  r.state.get = () => ({ code: 3 });
  await r.closed();
  await r.drain();
  assert.equal(r.verbs().includes("rm"), false);
  assert.equal(r.verbs().includes("kill"), false);
});

test("reap: at the bound a shell in the foreground is killed, then polled and removed", async () => {
  const r = rig();
  r.state.get = () => ({ code: 0, body: { state: r.killed.v ? "finished" : "live", foreground: { name: "Bash.EXE" } } });
  await r.closed();
  await r.drain(200);
  assert.deepEqual(r.calls.filter((c) => c[0] === "kill"), [["kill", "alpha/t7"]]);
  assert.deepEqual(r.calls.filter((c) => c[0] === "rm"), [["rm", "alpha/t7"]]);
});

test("reap: at the bound a non-shell foreground (pi, node.exe) is only reported", async () => {
  for (const name of ["pi", "node.exe"]) {
    const r = rig();
    r.state.get = () => ({ code: 0, body: { state: "live", foreground: { name } } });
    await r.closed();
    await r.drain(200);
    assert.equal(r.verbs().includes("kill"), false, name);
    assert.equal(r.verbs().includes("rm"), false, name);
    const left = r.notes.filter((n) => n.includes("left alone"));
    assert.equal(left.length, 1, name);
    assert.match(left[0], /alpha\/t7/);
  }
});

test("isShellName: case-folded, .exe stripped, pi and node are not shells", () => {
  for (const n of ["bash", "Bash.EXE", "zsh", "sh", "pwsh.exe", "powershell.exe", "cmd.exe"]) assert.equal(isShellName(n), true, n);
  for (const n of ["pi", "pi.exe", "node", "node.exe", "", undefined, 3]) assert.equal(isShellName(n), false, String(n));
});
