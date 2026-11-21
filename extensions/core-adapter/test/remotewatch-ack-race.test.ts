// The receipt of a catch-up carries the seq the run committed (a refresh replaces the Watched objects mid-run) and follows the parent message (remotewatch.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RemoteWatcher } from "../remotewatch.ts";
import type { HcResult, HcRun } from "../remotewatch.ts";
import { readRegistry, writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rack-")));
const sha = (b: string): string => crypto.createHash("sha256").update(b).digest("hex");
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const HANDOFF = "/home/u/.pi/handoff/20261103-120000-demo";
const NOW = Date.parse("2026-11-03T12:00:00Z");
const BODY = "plan one\n";
const LABEL = `1:plan:${sha(BODY)}:${Buffer.byteLength(BODY)}`;

function rig(onQueueRead: (w: RemoteWatcher) => void) {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  const entry = { label: "demo", child: CHILD, parent: "p", handoff: path.join(dir, "m"), status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: HANDOFF, mirror: path.join(dir, "m"), remote: { platform: "linux" }, backend: "hc", hc: { address: "alpha/t7", space: null, tab: null }, briefs: 0, lastError: null, last: null } as unknown as SessionEntry;
  writeRegistry(dir, { version: 1, sessions: [entry] });
  const order: string[] = [];
  const receipts: string[] = [];
  const res = (o: Partial<HcResult>): HcResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, overflow: false, ...o });
  const hc: HcRun = async (args, _t, _s, input) => {
    if (args[0] === "get") return res({ stdout: Buffer.from(JSON.stringify({ address: "alpha/t7", labels: { "fm.notice": LABEL }, state: "live", status: { app: "pi", state: "working" } })) });
    if (args[1] === "write") {
      order.push("receipt");
      receipts.push((input ?? Buffer.alloc(0)).toString("utf8"));
      return res({});
    }
    if (args[4] === `${HANDOFF}/notices.jsonl`) {
      onQueueRead(w);
      return res({ stdout: Buffer.from(`${JSON.stringify({ seq: 1, kind: "plan", sha256: sha(BODY), bytes: Buffer.byteLength(BODY) })}\n`) });
    }
    if (args[4] === `${HANDOFF}/notices/1-plan.md`) return res({ stdout: Buffer.from(BODY) });
    return res({ code: 3, stderr: JSON.stringify({ error: { kind: "not_found", message: "no file" } }) });
  };
  const w: RemoteWatcher = new RemoteWatcher({
    agentDir: dir,
    opener: () => "p",
    hc,
    events: () => ({ kill() {} }),
    wake: () => undefined,
    flush: () => void order.push("flush"),
    timer: () => () => undefined,
    probeTimer: () => () => undefined,
    now: () => NOW,
  });
  return { dir, w, order, receipts };
}

test("a refresh landing during a catch-up still acks the committed seq", async () => {
  const r = rig((w) => w.refresh());
  r.w.start();
  await r.w.idle();
  assert.equal(readRegistry(r.dir).sessions[0].noticeSeq, 1);
  assert.equal(r.receipts.length, 1);
  assert.equal(JSON.parse(r.receipts[0]).seq, 1);
});

test("the parent message is flushed before the receipt is written", async () => {
  const r = rig(() => undefined);
  r.w.start();
  await r.w.idle();
  assert.ok(r.order.indexOf("flush") >= 0 && r.order.indexOf("receipt") >= 0);
  assert.ok(r.order.indexOf("flush") < r.order.indexOf("receipt"), r.order.join(","));
});
