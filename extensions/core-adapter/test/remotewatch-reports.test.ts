// The watcher imports the remote session's `reports.jsonl` at a result, update or closed notice (remotewatch.ts fetchReports, reportsimport.ts): best effort,
// from the remote handoff dir only, and the notice handling stays what it was. The remote file read is the fake `hc` of the watcher tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RemoteWatcher } from "../remotewatch.ts";
import type { HcResult, HcRun } from "../remotewatch.ts";
import { applyRemoteNotice } from "../remotesession.ts";
import { readRegistry, writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";
import { HANDOFF_REPORTS, importText } from "../reportsimport.ts";
import { readRows, storeFor } from "../reports.ts";
import { realPath } from "../workspacekey.ts";

const root = realPath(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rwatch-rep-")));
const sha = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const HANDOFF = "/home/u/.pi/handoff/20261103-120000-demo";
const label = (seq: number, kind: string, body: string): string => `${seq}:${kind}:${sha(body)}:${Buffer.byteLength(body)}`;
const ev = (value: string) => ({ jsonrpc: "2.0", method: "event", params: { type: "labels", terminal: "alpha/t7", seq: 1, data: { labels: { "herdr.tab": "x", "fm.notice": value } } } });
const REPORT = JSON.stringify({ row: "report", id: "00000000a1", kind: "rule", subject: "guard x", what: "it blocked a read", effect: "blocked", repo: "acme/app", session: "remote-s1", ts: "2026-11-03T11:00:00.000Z" });

function rig(o: { importReports?: (data: Buffer) => void | Promise<void> } = {}) {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  const e = { label: "demo", child: CHILD, parent: "p", status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: HANDOFF, mirror: path.join(dir, "m"), handoff: path.join(dir, "m"), remote: { platform: "linux" }, backend: "hc", hc: { address: "alpha/t7", space: null, tab: null }, briefs: 0, lastError: null, last: null } as SessionEntry;
  writeRegistry(dir, { version: 1, sessions: [e] });
  const files = new Map<string, Buffer>();
  const calls: string[][] = [];
  const hc: HcRun = async (args) => {
    calls.push(args);
    const res = (over: Partial<HcResult>): HcResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, overflow: false, ...over });
    if (args[0] === "get") return res({ stdout: Buffer.from(JSON.stringify({ address: "alpha/t7", labels: {}, state: "live", status: { app: "pi", state: "working" } })) });
    const f = files.get(args[4]);
    return f ? res({ stdout: f }) : res({ code: 4, stderr: "no such file" });
  };
  let onLine: (l: string) => void = () => undefined;
  const wakes: string[] = [];
  const w = new RemoteWatcher({
    agentDir: dir, opener: () => "p", hc, wake: (l, k, t) => wakes.push(`child ${l}: ${k} ${t}`), now: () => Date.parse("2026-11-03T12:00:00Z"), timer: () => () => undefined,
    events: (line) => ((onLine = line), { kill: () => undefined }),
    ...(o.importReports ? { importReports: o.importReports } : {}),
  });
  w.start();
  return {
    dir, w, calls, wakes, files,
    put: (file: string, body: string): void => void files.set(`${HANDOFF}/${file}`, Buffer.from(body)),
    send: async (value: string): Promise<void> => (onLine(JSON.stringify(ev(value))), await w.idle()),
    reg: (): SessionEntry => readRegistry(dir).sessions[0],
    reportReads: (): number => calls.filter((c) => c[0] === "file" && c[4] === `${HANDOFF}/${HANDOFF_REPORTS}`).length,
  };
}

test("a result, update and closed notice each fetch reports.jsonl from the remote handoff dir and import it", async () => {
  for (const kind of ["result", "update", "closed"]) {
    const got: string[] = [];
    const r = rig({ importReports: (d) => void got.push(d.toString("utf8")) });
    r.put("result.md", "done\n");
    r.put(HANDOFF_REPORTS, `${REPORT}\n`);
    await r.send(label(1, kind, "done\n"));
    assert.deepEqual(got, [`${REPORT}\n`], kind);
    assert.deepEqual(r.calls.filter((c) => c[0] === "file").at(-1), ["file", "read", "--on", "alpha", `${HANDOFF}/reports.jsonl`], "the file of the remote handoff dir, nothing else");
    assert.equal(r.wakes.length, 1);
    r.w.stop();
  }
});

test("the imported rows land in the store of the parent's repository", async () => {
  const store = storeFor(fs.mkdtempSync(path.join(root, "proj-")));
  const r = rig({ importReports: (d) => void importText(store, "acme/app", d.toString("utf8")) });
  r.put("result.md", "done\n");
  r.put(HANDOFF_REPORTS, `${REPORT}\n${REPORT.replace("00000000a1", "00000000a2").replace("acme/app", "other/app")}\n`);
  await r.send(label(1, "result", "done\n"));
  assert.deepEqual(readRows(store.file).map((x) => x.id), ["00000000a1"]);
  r.w.stop();
});

test("a plan or ask notice fetches no report file", async () => {
  const got: Buffer[] = [];
  const r = rig({ importReports: (d) => void got.push(d) });
  r.put(HANDOFF_REPORTS, `${REPORT}\n`);
  r.put("plan.md", "the plan\n");
  r.put("ask.md", "which?\n");
  await r.send(label(1, "plan", "the plan\n"));
  await r.send(label(2, "ask", "which?\n"));
  assert.equal(got.length, 0);
  assert.equal(r.reportReads(), 0);
  r.w.stop();
});

test("a missing report file, a failing import and a throwing import leave the notice handling as it was", async () => {
  const plain = rig();
  plain.put("result.md", "done\n");
  await plain.send(label(1, "result", "done\n"));
  const base = { wakes: plain.wakes.map((x) => x.replace(plain.dir, "D")), reg: { status: plain.reg().status, noticeSeq: plain.reg().noticeSeq, lastError: plain.reg().lastError, result: String(plain.reg().result).replace(plain.dir, "D") } };
  assert.equal(plain.reportReads(), 0, "no importer, no fetch");
  plain.w.stop();
  const variants: { name: string; importReports: (d: Buffer) => void | Promise<void>; file: boolean }[] = [
    { name: "missing file", importReports: () => assert.fail("nothing to import"), file: false },
    { name: "throws", importReports: () => { throw new Error("store locked"); }, file: true },
    { name: "rejects", importReports: async () => { throw new Error("store locked"); }, file: true },
  ];
  for (const v of variants) {
    const r = rig({ importReports: v.importReports });
    r.put("result.md", "done\n");
    if (v.file) r.put(HANDOFF_REPORTS, `${REPORT}\n`);
    await r.send(label(1, "result", "done\n"));
    assert.equal(r.reportReads(), 1, v.name);
    assert.deepEqual({ wakes: r.wakes.map((x) => x.replace(r.dir, "D")), reg: { status: r.reg().status, noticeSeq: r.reg().noticeSeq, lastError: r.reg().lastError, result: String(r.reg().result).replace(r.dir, "D") } }, base, v.name);
    r.w.stop();
  }
});

test("an empty report file imports nothing; a file the read refuses is not an error", async () => {
  const got: Buffer[] = [];
  const r = rig({ importReports: (d) => void got.push(d) });
  r.put("result.md", "done\n");
  r.put(HANDOFF_REPORTS, "");
  await r.send(label(1, "result", "done\n"));
  assert.equal(got.length, 0);
  assert.equal(r.reg().lastError, null);
  r.w.stop();
});

test("the notice files stay the three mirrored names: a remote path named reports.jsonl is still ignored by applyRemoteNotice", () => {
  const entry = { label: "demo", child: CHILD, machine: "alpha", originMachine: "alpha", status: "open", remoteHandoff: HANDOFF, mirror: path.join(root, "pin"), remote: { platform: "linux" } } as SessionEntry;
  const body = `${REPORT}\n`;
  const notice = { kind: "result" as const, label: "demo", path: `${HANDOFF}/reports.jsonl`, sha256: sha(body), bytes: Buffer.byteLength(body), truncated: false, content: body };
  const hit = applyRemoteNotice({ version: 1, sessions: [entry] }, { machine: "alpha", sessionId: CHILD }, notice, () => assert.fail("must not mirror"));
  assert.equal(hit?.changed, false);
  assert.match(hit?.message ?? "", /ignored \(its path is not a file of the remote handoff dir\)/);
});
