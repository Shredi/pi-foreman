// D116++: after a remote restart the registry holds the new terminal address; a notice from that terminal wakes the parent's `foreman_wait kind child`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RemoteWatcher } from "../remotewatch.ts";
import { readRegistry, writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";
import { WaitRuntime } from "../wait.ts";
import type { Outcome } from "../wait.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-restartwait-")));
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const BODY = "r\n";
const value = `1:result:${crypto.createHash("sha256").update(BODY).digest("hex")}:${Buffer.byteLength(BODY)}`;
const notice = (terminal: string) => ({ jsonrpc: "2.0", method: "event", params: { type: "labels", terminal, seq: 1, data: { labels: { "fm.notice": value } } } });

test("a notice from the restarted terminal wakes the child wait; the old address is no longer read", async () => {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  const mirror = path.join(dir, "m");
  const e = { label: "demo", child: CHILD, parent: "p", handoff: mirror, status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: "/h/x", mirror, remote: { platform: "linux" }, backend: "hc", hc: { address: "alpha/t7", space: null, tab: null }, briefs: 0, lastError: null, last: null } as unknown as SessionEntry;
  writeRegistry(dir, { version: 1, sessions: [e] });
  const outcomes: Outcome[][] = [];
  const rt = new WaitRuntime({ timers: { set: () => 1, clear: () => undefined }, now: () => 0, limits: () => ({ batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true }), stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => outcomes.push(o), trace: () => undefined });
  assert.ok("id" in rt.start({ kind: "child", label: "demo", note: "n" }));
  // the restart stored the new address (foreman_session.py restart)
  const reg = readRegistry(dir);
  reg.sessions[0].hc = { address: "alpha/t9", space: null, tab: null } as never;
  writeRegistry(dir, reg);
  let onLine: (l: string) => void = () => undefined;
  const w = new RemoteWatcher({
    agentDir: dir, opener: () => "p",
    hc: async (a) => ({ code: 0, stdout: a[0] === "get" ? Buffer.from("{}") : Buffer.from(BODY), stderr: "", timedOut: false, overflow: false }),
    events: (cb) => { onLine = cb; return { kill() {} }; },
    wake: (l, k, t) => void rt.childNotice(l, k, t),
  });
  w.start();
  await w.idle();
  onLine(JSON.stringify(notice("alpha/t7")));
  await w.idle();
  assert.equal(outcomes.length, 0, "a notice from the old terminal does nothing");
  onLine(JSON.stringify(notice("alpha/t9")));
  await w.idle();
  w.stop();
  assert.match(outcomes[0][0].outcome, /^child demo: result /);
  assert.equal(rt.active, 0);
});
