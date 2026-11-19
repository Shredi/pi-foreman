// The fetched `reports.jsonl` is written to the session's mirror dir (remotewatch.ts fetchReports) before the import, at result, update and closed;
// a failed import leaves it for `foreman reports import <file>`, a failed mirror write does not stop the import; the mirrored notice files stay as they are.
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
import { HANDOFF_REPORTS, importFile, importText } from "../reportsimport.ts";
import { readRows, storeFor } from "../reports.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rwatch-mir-")));
const sha = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const HANDOFF = "/home/u/.pi/handoff/20261103-120000-demo";
const label = (seq: number, kind: string, body: string): string => `${seq}:${kind}:${sha(body)}:${Buffer.byteLength(body)}`;
const ev = (value: string) => ({ jsonrpc: "2.0", method: "event", params: { type: "labels", terminal: "alpha/t7", seq: 1, data: { labels: { "herdr.tab": "x", "fm.notice": value } } } });
const REPORT = JSON.stringify({ row: "report", id: "00000000a1", kind: "rule", subject: "guard x", what: "it blocked a read", effect: "blocked", repo: "acme/app", session: "remote-s1", ts: new Date().toISOString() });

function rig(importReports: (data: Buffer) => void | Promise<void>, mirrorOf?: (dir: string) => string) {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  const mirror = mirrorOf ? mirrorOf(dir) : path.join(dir, "m");
  const e = { label: "demo", child: CHILD, parent: "p", status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: HANDOFF, mirror, handoff: mirror, remote: { platform: "linux" }, backend: "hc", hc: { address: "alpha/t7", space: null, tab: null }, briefs: 0, lastError: null, last: null } as SessionEntry;
  writeRegistry(dir, { version: 1, sessions: [e] });
  const files = new Map<string, Buffer>();
  const hc: HcRun = async (args) => {
    const res = (over: Partial<HcResult>): HcResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, overflow: false, ...over });
    if (args[0] === "get") return res({ stdout: Buffer.from(JSON.stringify({ address: "alpha/t7", labels: {}, state: "live", status: { app: "pi", state: "working" } })) });
    const f = files.get(args[4]);
    return f ? res({ stdout: f }) : res({ code: 4, stderr: "no such file" });
  };
  let onLine: (l: string) => void = () => undefined;
  const w = new RemoteWatcher({ agentDir: dir, opener: () => "p", hc, wake: () => undefined, now: () => Date.parse("2026-11-03T12:00:00Z"), timer: () => () => undefined, events: (line) => ((onLine = line), { kill: () => undefined }), importReports });
  w.start();
  return {
    dir, mirror, w,
    put: (file: string, body: string): void => void files.set(`${HANDOFF}/${file}`, Buffer.from(body)),
    send: async (value: string): Promise<void> => (onLine(JSON.stringify(ev(value))), await w.idle()),
    reg: (): SessionEntry => readRegistry(dir).sessions[0],
  };
}

test("a result, update and closed notice each write the fetched file to the mirror dir, byte for byte, before the import", async () => {
  for (const kind of ["result", "update", "closed"]) {
    let seenAtImport: string | null = null;
    let m = "";
    const r = rig((d) => void (seenAtImport = fs.readFileSync(path.join(m, HANDOFF_REPORTS), "utf8") === d.toString("utf8") ? "same" : "differs"));
    m = r.mirror;
    r.put("result.md", "done\n");
    r.put(HANDOFF_REPORTS, `${REPORT}\n`);
    await r.send(label(1, kind, "done\n"));
    assert.equal(fs.readFileSync(path.join(r.mirror, HANDOFF_REPORTS), "utf8"), `${REPORT}\n`, kind);
    assert.equal(seenAtImport, "same", `${kind}: the mirror exists when the import runs`);
    assert.deepEqual(fs.readdirSync(r.mirror).filter((f) => f.endsWith(".tmp")), [], "no temp file left");
    r.w.stop();
  }
});

test("a plan notice writes no report mirror", async () => {
  const r = rig(() => assert.fail("no import"));
  r.put("plan.md", "the plan\n");
  r.put(HANDOFF_REPORTS, `${REPORT}\n`);
  await r.send(label(1, "plan", "the plan\n"));
  assert.equal(fs.existsSync(path.join(r.mirror, HANDOFF_REPORTS)), false);
  r.w.stop();
});

test("an import that fails on a busy store lock leaves the mirror; the rerun by file imports the row", async () => {
  const proj = fs.mkdtempSync(path.join(root, "proj-"));
  const store = storeFor(proj);
  fs.mkdirSync(store.dir, { recursive: true });
  const r = rig(() => {
    throw new Error("locked: reports.jsonl.lock");
  });
  r.put("result.md", "done\n");
  r.put(HANDOFF_REPORTS, `${REPORT}\n`);
  await r.send(label(1, "closed", "done\n"));
  const file = path.join(r.mirror, HANDOFF_REPORTS);
  assert.equal(fs.readFileSync(file, "utf8"), `${REPORT}\n`, "the mirror stays after the failed import");
  assert.equal(readRows(store.file).length, 0);
  assert.equal(importFile(store, "acme/app", file).added, 1, "foreman reports import <file> on the mirror");
  r.w.stop();
});

test("a mirror dir that cannot be written does not stop the import", async () => {
  const got: string[] = [];
  const r = rig((d) => void got.push(d.toString("utf8")), (dir) => {
    const m = path.join(dir, "m");
    fs.mkdirSync(path.join(m, HANDOFF_REPORTS), { recursive: true }); // a directory where the file goes: the rename fails
    return m;
  });
  r.put("result.md", "done\n");
  r.put(HANDOFF_REPORTS, `${REPORT}\n`);
  await r.send(label(1, "update", "done\n"));
  assert.deepEqual(got, [`${REPORT}\n`]);
  assert.equal(fs.statSync(path.join(r.mirror, HANDOFF_REPORTS)).isDirectory(), true);
  r.w.stop();
});

test("the mirror of an import through the real importer survives a busy store", async () => {
  const proj = fs.mkdtempSync(path.join(root, "proj-"));
  const store = storeFor(proj);
  fs.mkdirSync(store.dir, { recursive: true });
  fs.writeFileSync(store.lock, JSON.stringify({ pid: process.pid, at: Date.now() })); // a held lock
  const r = rig((d) => void importText(store, "acme/app", d.toString("utf8")));
  r.put("result.md", "done\n");
  r.put(HANDOFF_REPORTS, `${REPORT}\n`);
  await r.send(label(1, "closed", "done\n"));
  assert.equal(fs.existsSync(path.join(r.mirror, HANDOFF_REPORTS)), true);
  r.w.stop();
});
