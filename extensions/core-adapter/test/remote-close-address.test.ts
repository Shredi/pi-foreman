// rw3b: the address `<label>@<machine>` (resolution, list, wake line) and the watcher's address check, TypeScript side of
// .workflow/scratch/plan-rw3b-remote-close.md (sections 1.5, 5, 6). The address table is shared with the Python tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteWatcher, usableAddress, watchState } from "../remotewatch.ts";
import type { HcResult, HcRun } from "../remotewatch.ts";
import { formatList, readRegistry, resolveTarget, runSessionCommand, sessionBrief, sessionClose, writeRegistry } from "../session.ts";
import type { SessionDeps, SessionEntry } from "../session.ts";
import type { SpawnResult } from "../spawn.ts";
import { WaitRuntime } from "../wait.ts";
import type { Outcome } from "../wait.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-raddr-")));
const here = path.dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "tests", "fixtures", "remote-address-cases.json"), "utf8"));
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const sha = (b: string): string => crypto.createHash("sha256").update(b).digest("hex");

const mk = (over: Record<string, unknown> = {}): SessionEntry =>
  ({ label: "demo", child: CHILD, parent: "p", handoff: "/h", status: "open", machine: "alpha", originMachine: "alpha", remoteHandoff: "/r/x", mirror: "/m", remote: { platform: "linux" }, backend: "hc", hc: { address: "alpha/t7", space: null, tab: null }, briefs: 0, lastError: null, last: null, ...over }) as SessionEntry;

test("address table: usableAddress agrees with the shared table (watcher side)", () => {
  for (const c of TABLE.use) assert.equal(usableAddress(c.machine, c.address), c.ok, `${c.machine} ${String(c.address)}`);
});

test("watchState: an entry whose address is on another machine or not an id is not watched", () => {
  const good = mk({ child: "c-good" });
  const other = mk({ child: "c-other", hc: { address: "beta/t7" } });
  const bad = mk({ child: "c-bad", hc: { address: "alpha/a/b" } });
  const state = watchState({ sessions: [good, other, bad] }, undefined, "p");
  assert.deepEqual([...state.keys()], ["c-good"]);
});

test("watcher: a refused address makes no hc call for the entry and is named once", async () => {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  writeRegistry(dir, { version: 1, sessions: [mk({ hc: { address: "beta/t7" } })] });
  const calls: string[][] = [];
  const notes: string[] = [];
  const hc: HcRun = async (args) => (calls.push(args), { code: 0, stdout: Buffer.from("{}"), stderr: "", timedOut: false, overflow: false });
  let streams = 0;
  const w = new RemoteWatcher({ agentDir: dir, opener: () => "p", hc, events: () => (streams++, { kill() {} }), wake: () => undefined, notify: (m) => void notes.push(m), timer: () => () => undefined });
  w.start();
  w.refresh();
  w.refresh();
  await w.idle();
  w.stop();
  assert.deepEqual(calls, []);
  assert.equal(streams, 0);
  assert.equal(notes.filter((n) => /demo@alpha/.test(n)).length, 1);
});

test("resolveTarget: the address is tried only after the exact match fails; unknown targets pass through", () => {
  const reg = { version: 1, sessions: [mk({ child: "c-old" }), mk({ child: "c-new" }), mk({ label: "x", child: "c-b", machine: "beta" }), mk({ label: "w", child: "c-odd@alpha" })] };
  assert.equal(resolveTarget(reg, "demo@alpha"), "c-new");
  assert.equal(resolveTarget(reg, "x@beta"), "c-b");
  assert.equal(resolveTarget(reg, "demo"), "c-new");
  assert.equal(resolveTarget(reg, "c-odd@alpha"), "c-odd@alpha", "a child id containing @ matches exactly first");
  assert.equal(resolveTarget({ version: 1, sessions: [mk({ child: "c-a" }), mk({ label: "demo@alpha", child: "c-exact", machine: "beta" })] }, "demo@alpha"), "c-exact", "an exact label match wins over the address");
  assert.equal(resolveTarget(reg, "demo@nomachine"), "demo@nomachine");
  assert.equal(resolveTarget(reg, "nolabel@alpha"), "nolabel@alpha");
  assert.equal(resolveTarget(reg, "bad label@alpha"), "bad label@alpha");
});

const spawnOk = (stdout = "{}"): SpawnResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const deps = (agent: string, over: Partial<SessionDeps> = {}): SessionDeps =>
  ({ isChild: false, env: {}, agentDir: agent, cwd: root, piSessionId: "sess-1", pkgRoot: "/pkg", python: "/usr/bin/python3", spawner: async () => spawnOk(), send: async () => "sent", confirm: async () => true, ...over }) as SessionDeps;

test("/foreman session close and brief accept <label>@<machine>; an unknown address is passed on as today", async () => {
  const agent = fs.mkdtempSync(path.join(root, "agent-"));
  writeRegistry(agent, { version: 1, sessions: [mk()] });
  const calls: string[][] = [];
  const sent: string[] = [];
  const spawned: string[][] = [];
  const d = deps(agent, { send: async (to) => (sent.push(to), "sent"), runRemote: async (a) => (calls.push(a), spawnOk()), spawner: async (_p, a) => (spawned.push(a as string[]), spawnOk("brief sent")) });
  assert.equal((await sessionClose(d, "demo@alpha")).ok, true);
  assert.deepEqual(calls, [["close-remote", CHILD]]);
  await sessionBrief(d, "demo@alpha", "hello there");
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].includes("demo@alpha") && spawned[0].includes("brief"));
  const r = await runSessionCommand(d, "close demo@elsewhere");
  assert.equal(calls.length, 1, "no remote close for an unknown address");
  assert.deepEqual(sent, ["demo@elsewhere"], "passed on to the intercom as today");
  assert.equal(r.ok, true);
});

test("session lists show the address for machine entries only", () => {
  const text = formatList({ version: 1, sessions: [mk({ handoff: "/h" }), { label: "loc", child: "c2", status: "open", handoff: "/l" } as SessionEntry] });
  assert.match(text, /^demo {2}- {2}open {2}\/h {2}0a1b2c3d-0000-4000-8000-0123456789ab {2}address: demo@alpha$/m);
  assert.match(text, /^loc {2}- {2}open {2}\/l {2}c2$/m);
  const agent = fs.mkdtempSync(path.join(root, "agent-"));
  writeRegistry(agent, { version: 1, sessions: [mk()] });
  assert.equal(readRegistry(agent).sessions.length, 1);
});

// ---- the result wake and notice end with the close line

function wakeRig(mirrorTail = "") {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  const mirror = path.join(dir, "m", mirrorTail);
  writeRegistry(dir, { version: 1, sessions: [mk({ mirror, handoff: mirror })] });
  const body = "r\n";
  const wakes: string[] = [];
  const notes: string[] = [];
  const hc: HcRun = async (args) => {
    const res = (o: Partial<HcResult>): HcResult => ({ code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, overflow: false, ...o });
    if (args[0] === "file") return res({ stdout: Buffer.from(body) });
    return res({ stdout: Buffer.from("{}") });
  };
  const send = (kind: string): RemoteWatcher => {
    const value = kind === "closed" ? "1:closed:-:0" : `1:${kind}:${sha(body)}:${Buffer.byteLength(body)}`;
    const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "labels", terminal: "alpha/t7", seq: 1, data: { labels: { "fm.notice": value } } } });
    const w = new RemoteWatcher({ agentDir: dir, opener: () => "p", hc, events: (onLine) => (onLine(line), { kill() {} }), wake: (l, k, t) => wakes.push(`child ${l}: ${k}${t ? ` ${t}` : ""}`), notify: (m) => void notes.push(m), timer: () => () => undefined });
    w.start();
    return w;
  };
  return { send, wakes, notes, dir };
}

const CLOSE = "; close with: foreman session close-remote demo@alpha";

test("the result wake and notice end with the close line; closed, plan and update wakes are unchanged", async () => {
  const r = wakeRig();
  const w = r.send("result");
  await w.idle();
  w.stop();
  assert.match(r.wakes[0], /^child demo: result \S+result\.md; close with: foreman session close-remote demo@alpha$/);
  assert.match(r.notes[0], /demo@alpha: result \S+result\.md; close with: foreman session close-remote demo@alpha$/);
  for (const kind of ["plan", "update", "closed"]) {
    const q = wakeRig();
    const x = q.send(kind);
    await x.idle();
    x.stop();
    assert.doesNotMatch(q.wakes[0], /close with/, kind);
  }
});

test("the close line survives the 300-character cut of foreman_wait; the path part is cut first", async () => {
  const r = wakeRig(path.join(...Array(4).fill("p".repeat(100))));
  const w = r.send("result");
  await w.idle();
  w.stop();
  const outcomes: Outcome[][] = [];
  const rt = new WaitRuntime({ timers: { set: () => 1, clear: () => undefined }, now: () => 0, limits: () => ({ batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true }), stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => outcomes.push(o), trace: () => undefined });
  assert.ok("id" in rt.start({ kind: "child", label: "demo", note: "n" }));
  const text = r.wakes[0].replace(/^child demo: result /, "");
  assert.ok(text.length <= 300, String(text.length));
  rt.childNotice("demo", "result", text);
  assert.ok(outcomes[0][0].outcome.endsWith(CLOSE), outcomes[0][0].outcome);
});
