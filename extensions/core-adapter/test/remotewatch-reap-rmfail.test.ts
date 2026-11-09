// Reap follow-up: the result of `hc rm` is checked. A failed rm is retried once; a second failure is reported, never silent.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RemoteWatcher } from "../remotewatch.ts";
import type { HcResult, HcRun } from "../remotewatch.ts";
import { writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const rpc = (type: string, terminal: string, data: unknown) => ({ jsonrpc: "2.0", method: "event", params: { type, terminal, seq: 1, data } });

async function run(rmCodes: number[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-reap-rm-"));
  try {
    const mirror = path.join(dir, "m");
    const e = {
      label: "demo", child: CHILD, parent: "p", handoff: mirror, status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: "/h/x", mirror,
      remote: { platform: "linux" }, backend: "hc", hc: { address: "alpha/t7", space: null, tab: null }, briefs: 0, lastError: null, last: null,
    } as unknown as SessionEntry;
    writeRegistry(dir, { version: 1, sessions: [e] });
    const calls: string[][] = [];
    const notes: string[] = [];
    let rms = 0;
    const hc: HcRun = async (args) => {
      calls.push(args);
      const res = (o: Partial<HcResult>): HcResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, overflow: false, ...o });
      if (args[0] === "get") return res({ stdout: Buffer.from(JSON.stringify({ state: "finished" })) });
      if (args[0] === "rm") return res({ code: rmCodes[Math.min(rms++, rmCodes.length - 1)] });
      return res({});
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
    w.start();
    line?.(JSON.stringify(rpc("labels", "alpha/t7", { labels: { "fm.notice": "1:closed:-:0" } })));
    await w.idle();
    for (let i = 0; i < 20; i++) {
      for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
      const t = timers.find((x) => x.live && x.ms === 3000);
      if (!t) break;
      t.fn();
    }
    w.stop();
    return { rms: calls.filter((c) => c[0] === "rm").length, notes };
  } finally {
    rmTestTmp(dir);
  }
}

test("reap: a failed hc rm is retried once and then succeeds quietly", async () => {
  const r = await run([1, 0]);
  assert.equal(r.rms, 2);
  assert.equal(r.notes.some((n) => n.includes("hc rm")), false);
});

test("reap: two failed hc rm calls are reported, not swallowed", async () => {
  const r = await run([1, 1]);
  assert.equal(r.rms, 2);
  assert.equal(r.notes.filter((n) => n.includes("`hc rm` failed")).length, 1);
});
