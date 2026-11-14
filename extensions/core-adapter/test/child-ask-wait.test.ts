// Plan asks-wait-for-owner D2: a child's ask has no deadline and a wait cannot hang on nobody. The child's wait (awaitChildRuling) ends by a ruling,
// the call's abort signal, or "the starting session is gone"; the parent re-adds its ask dirs after a reload and a closed dialog writes no ruling.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { awaitChildRuling, ChildAskWatch, writeChildAsk, childAskParentDir } from "../childask.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

type T = Parameters<typeof r11Rig>[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<X>(f: () => X | undefined | false, ms = 4000): Promise<X> {
  for (let i = 0; i < ms / 10; i++) {
    const v = f();
    if (v) return v;
    await sleep(10);
  }
  throw new Error("timed out");
}
const tmp = (t: T): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ask-wait-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const FIELDS = { tool: "bash", payload: "pip install requests", cwd: "/w", session: "child-s", role: "builder", run: "L9", cause: "no rule matches", reason: "r" };

// ------------------------------------------------------------------ awaitChildRuling: no limit, abort, gone

test("awaitChildRuling: an infinite timeout waits and a later ruling applies", async (t) => {
  const dir = tmp(t);
  const p = awaitChildRuling(dir, 1, Infinity, 5);
  await sleep(120);
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "ALLOW\n");
  assert.equal((await p).answer, "allow");
});

test("awaitChildRuling: the abort signal ends the wait with aborted, and an existing ruling is not taken then", async (t) => {
  const dir = tmp(t);
  const ac = new AbortController();
  const p = awaitChildRuling(dir, 1, Infinity, 5, undefined, undefined, undefined, { signal: ac.signal });
  await sleep(40);
  ac.abort();
  assert.equal((await p).answer, "aborted");
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "ALLOW\n");
  assert.equal((await awaitChildRuling(dir, 1, 2000, 5, undefined, undefined, undefined, { signal: ac.signal })).answer, "aborted");
});

test("awaitChildRuling: a missing ask dir is gone at the next check", async (t) => {
  const dir = path.join(tmp(t), "asks");
  fs.mkdirSync(dir);
  const p = awaitChildRuling(dir, 1, 3000, 5, undefined, undefined, undefined, { gone: { everyMs: 30 } });
  await sleep(50);
  fs.rmSync(dir, { recursive: true });
  assert.equal((await p).answer, "gone");
});

function liveFile(t: T): { file: string; beat: (at: number | null) => void } {
  const file = path.join(tmp(t), "live.json");
  return { file, beat: (at) => (at === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, JSON.stringify({ heartbeatAt: new Date(at).toISOString() }))) };
}

test("awaitChildRuling: a missing or stale live file on two checks in a row is gone; one check is not", async (t) => {
  const dir = tmp(t);
  const live = liveFile(t);
  const clock = { t: 1_700_000_000_000 };
  live.beat(clock.t - 500_000); // stale: older than staleMs
  const gone = { everyMs: 100, liveFile: live.file, staleMs: 1000, now: () => clock.t };
  const p = awaitChildRuling(dir, 1, 1500, 5, undefined, undefined, undefined, { gone });
  clock.t += 100;
  await sleep(60); // check 1: stale, counted once
  let done = false;
  void p.then(() => (done = true));
  await sleep(40);
  assert.equal(done, false, "one stale check does not end the wait");
  clock.t += 100;
  assert.equal((await p).answer, "gone", "the second stale check does");
});

test("awaitChildRuling: a fresh heartbeat keeps waiting; a ruling then applies", async (t) => {
  const dir = tmp(t);
  const live = liveFile(t);
  const clock = { t: 1_700_000_000_000 };
  const p = awaitChildRuling(dir, 1, 3000, 5, undefined, undefined, undefined, { gone: { everyMs: 100, liveFile: live.file, staleMs: 1000, now: () => clock.t } });
  for (let i = 0; i < 6; i++) {
    clock.t += 100;
    live.beat(clock.t);
    await sleep(40);
  }
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "DENY\nno\n");
  assert.equal((await p).answer, "deny");
});

test("awaitChildRuling: one stale check after a clock jump does not end the wait (the count restarts)", async (t) => {
  const dir = tmp(t);
  const live = liveFile(t);
  const clock = { t: 1_700_000_000_000 };
  live.beat(clock.t);
  const p = awaitChildRuling(dir, 1, 3000, 5, undefined, undefined, undefined, { gone: { everyMs: 100, liveFile: live.file, staleMs: 1000, now: () => clock.t } });
  clock.t += 100;
  await sleep(50); // check 1: fresh
  clock.t += 50_000; // the machine slept: the heartbeat now looks old
  await sleep(50); // check 2: the jump, not counted although stale
  live.beat(clock.t); // the parent's heartbeat is current again
  clock.t += 100;
  await sleep(50); // check 3: fresh
  clock.t += 100;
  await sleep(50); // check 4: fresh
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "ALLOW\n");
  assert.equal((await p).answer, "allow");
});

// ------------------------------------------------------------------ ChildAskWatch: add after a reload

const FAKE = { set: () => 1, clear: () => undefined };

test("ChildAskWatch.add: an unanswered ask is shown, one whose ruling exists is not; a dir already watched changes nothing", async (t) => {
  const open = tmp(t);
  const answered = tmp(t);
  writeChildAsk(open, FIELDS);
  writeChildAsk(answered, FIELDS);
  fs.writeFileSync(path.join(answered, "ruling-1.md"), "ALLOW\n");
  const seen: string[] = [];
  const w = new ChildAskWatch(async (a) => (seen.push(a.dir), { allow: false, reason: "x" }), () => undefined, FAKE);
  w.add(open);
  w.add(answered);
  w.poll();
  await until(() => seen.length > 0);
  await sleep(30);
  assert.deepEqual(seen, [open]);
  w.add(open); // watched already: nothing is shown again
  w.add(answered);
  w.poll();
  await sleep(30);
  assert.deepEqual(seen, [open]);
});

test("ChildAskWatch.add: a dir seen while a dialog is open is not queued twice by a second add", async (t) => {
  const dir = tmp(t);
  writeChildAsk(dir, FIELDS);
  const seen: string[] = [];
  let release: () => void = () => undefined;
  const w = new ChildAskWatch((a) => new Promise((res) => (seen.push(a.dir), (release = () => res({ allow: true })))), () => undefined, FAKE);
  w.add(dir);
  w.poll();
  await until(() => seen.length === 1);
  w.add(dir);
  w.poll();
  release();
  await sleep(40);
  assert.equal(seen.length, 1);
});

// ------------------------------------------------------------------ the gate: parent rig and child rig

function registry() {
  return { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ verdict: "allow", entry: "x", reason: "x" }) }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
}
const ROLES = ["explorer", "builder", "reviewer"];
const cfg = (extra?: Record<string, unknown>) => ({ providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } }, presence: { enabled: false }, ...extra });

/** A parent whose dialogs stay open until `pending[i]` is called or the dialog's signal aborts (then undefined, as Pi's selector does). */
async function parentRig(t: T) {
  const titles: string[] = [];
  const pending: ((v: string | undefined) => void)[] = [];
  const ui = {
    notify: () => undefined,
    confirm: async () => false,
    select: (title: string, _o: string[], opts?: { signal?: AbortSignal }) =>
      new Promise<string | undefined>((res) => {
        titles.push(title);
        pending.push(res);
        opts?.signal?.addEventListener("abort", () => res(undefined), { once: true });
      }),
    input: async () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const r = await r11Rig(t, {}, { ctx: { ui, modelRegistry: registry() }, config: cfg() });
  const launch = async () => {
    const input: Record<string, unknown> = { agent: "builder", task: "go" };
    await r.launch(input);
    return (input.extensionBindings as Record<string, Record<string, unknown>>)[BINDING_NS].askDir as string;
  };
  return { ...r, titles, pending, launch };
}

test("a reload keeps the ask dirs and re-adds them: an unanswered ask is shown again, an answered one is not", async (t) => {
  const r = await parentRig(t);
  const open = await r.launch();
  const done = await r.launch();
  writeChildAsk(open, { ...FIELDS, run: "A" });
  await until(() => r.titles.length === 1);
  writeChildAsk(done, { ...FIELDS, run: "B" });
  r.pending[0]("allow once");
  await until(() => fs.existsSync(path.join(open, "ruling-1.md")));
  await until(() => r.titles.length === 2); // B's dialog is open now; A is answered
  await r.fire("session_shutdown", { reason: "reload" });
  assert.ok(fs.existsSync(open) && fs.existsSync(done), "a reload leaves the dirs");
  assert.equal(fs.existsSync(path.join(done, "ruling-1.md")), false, "the dialog closed by the shutdown wrote no ruling");
  await r.restart();
  await until(() => r.titles.length === 3);
  assert.match(r.titles[2], /run B/);
  await sleep(1200);
  assert.equal(r.titles.length, 3, "the answered ask is not shown again");
  r.pending[2]("allow once");
  await until(() => fs.existsSync(path.join(done, "ruling-1.md")));
  assert.equal(fs.readFileSync(path.join(done, "ruling-1.md"), "utf8").split("\n")[0], "ALLOW");
});

for (const reason of ["quit", "new", "resume", "fork", undefined]) {
  test(`a shutdown with reason ${reason} deletes the ask dirs`, async (t) => {
    const r = await parentRig(t);
    const dir = await r.launch();
    assert.ok(fs.existsSync(dir));
    await r.fire("session_shutdown", reason ? { reason } : {});
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(childAskParentDir(r.agentDir, r.sessionId)), false);
  });
}

async function childRig(t: T, askDir: string, ctx: Record<string, unknown> = {}) {
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role: "builder", launchId: "L9", kind: "first", model: null, askDir } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  const escalate = JSON.stringify({ verdict: "ask", entry: "package-install", reason: "because" });
  const reg = { ...registry(), complete: async () => ({ content: [{ type: "text", text: escalate }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
  return r11Rig(t, {}, { ctx: { modelRegistry: reg, ...ctx }, config: cfg({ gate: { askTimeoutMs: 50 } }), child: true });
}
const CMD = { command: "pip install requests" };

test("child gate: a missing ask dir is the gone denial; the child creates no dir and no ask.md", async (t) => {
  const dir = path.join(tmp(t), "no-such-dir");
  const r = await childRig(t, dir);
  const res = await r.call("bash", CMD);
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /the session that started this helper has ended or no longer watches it/);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(r.events("dialog").at(-1)!.decision, "parent-gone");
});

test("child gate: the call's abort signal blocks the call, takes no ruling and leaves ask.md", async (t) => {
  const dir = tmp(t);
  const ac = new AbortController();
  const r = await childRig(t, dir, { signal: ac.signal });
  const p = r.call("bash", CMD);
  await until(() => fs.existsSync(path.join(dir, "ask.md")));
  ac.abort();
  const res = await p;
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /aborted/);
  assert.ok(fs.existsSync(path.join(dir, "ask.md")));
  assert.equal(fs.existsSync(path.join(dir, "ruling-1.md")), false);
  assert.equal(r.events("dialog").at(-1)!.decision, "parent-aborted");
});
