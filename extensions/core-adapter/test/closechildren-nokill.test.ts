// remote-windows-2 item 8 (plan decision 1): no kill or rm without a `closed` notice; `childWaitMs: 0` is "send, do not wait".
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeChildren } from "../closechildren.ts";
import { RemoteWatcher } from "../remotewatch.ts";
import type { HcResult, HcRun } from "../remotewatch.ts";
import { writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-nokill-")));
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";

function entry(dir: string): SessionEntry {
  const mirror = path.join(dir, "m");
  return {
    label: "demo", child: CHILD, parent: "p", handoff: mirror, status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: "/h/x", mirror,
    remote: { platform: "linux" }, backend: "hc", hc: { address: "alpha/t7", space: null, tab: null }, briefs: 0, lastError: null, last: null,
  } as unknown as SessionEntry;
}

for (const waitMs of [0, 3000]) {
  test(`closeChildren waitMs=${waitMs}: no closed notice -> only close-remote runs, outcome timeout`, async () => {
    const dir = fs.mkdtempSync(path.join(root, "agent-"));
    writeRegistry(dir, { version: 1, sessions: [entry(dir)] });
    const ran: string[][] = [];
    let slept = 0;
    const lines = await closeChildren({
      agentDir: dir, opener: "p", waitMs,
      send: async () => "sent",
      sleep: async (ms) => void (slept += ms),
      runRemote: async (args) => (ran.push(args), { code: 0, stdout: "", stderr: "", timedOut: false } as never),
    });
    assert.deepEqual(ran, [["close-remote", CHILD]]);
    assert.equal(slept, waitMs);
    assert.match(lines[0], new RegExp(`timeout after ${waitMs} ms`));
  });
}

test("RemoteWatcher: without a closed notice no hc kill or rm is issued, however long it runs", async () => {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  writeRegistry(dir, { version: 1, sessions: [entry(dir)] });
  const calls: string[][] = [];
  const hc: HcRun = async (args) => {
    calls.push(args);
    const res: HcResult = { code: 0, stdout: Buffer.from(JSON.stringify({ state: "live", foreground: { name: "bash" } })), stderr: "", timedOut: false, overflow: false };
    return res;
  };
  const timers: { fn: () => void; live: boolean }[] = [];
  const w = new RemoteWatcher({
    agentDir: dir, opener: () => "p", hc,
    events: () => ({ kill: () => undefined }),
    wake: () => undefined,
    notify: () => undefined,
    timer: (fn) => {
      const t = { fn: () => { t.live = false; fn(); }, live: true };
      timers.push(t);
      return () => void (t.live = false);
    },
    now: () => Date.parse("2026-11-03T12:00:00Z"),
  } as ConstructorParameters<typeof RemoteWatcher>[0]);
  w.start();
  for (let i = 0; i < 40; i++) {
    for (let k = 0; k < 10; k++) await new Promise((r) => setImmediate(r));
    for (const t of timers.filter((x) => x.live)) t.fn();
  }
  await w.idle();
  assert.equal(calls.some((c) => c[0] === "kill" || c[0] === "rm"), false, JSON.stringify(calls));
});
