// Owner decision (e): a child's ask ends after DEFAULT_ASK_TIMEOUT_MS (15 min). The gate writes the deadline into ask.md and waits no longer than it; the
// parent aborts its dialog for that ask at the deadline so the queue moves on and nothing is written or parked; the child gets its own timeout text and a
// timeout never counts towards the repeat stop. The child never creates the ask dir (a missing one means the starting session is gone, also on the protected
// path); a parked allow covers only the first ask of the resumed run and only for the same call.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { ChildAskWatch, writeChildAsk, readChildAsk, type AskTimers, type ChildAskEvent } from "../childask.ts";
import { ChildAskPark, parkKey } from "../childaskpark.ts";
import { DEFAULT_ASK_TIMEOUT_MS } from "../gatedialog.ts";
import { CHILD_ASK_TIMEOUT_TEXT, CHILD_GONE_TEXT } from "../presencewait.ts";
import { gateLogFile } from "../gatelog.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

type T = Parameters<typeof r11Rig>[0];
const realSetTimeout = setTimeout; // captured before a test mocks the timers
const sleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));
async function until<X>(f: () => X | undefined | false, ms = 4000): Promise<X> {
  for (let i = 0; i < ms / 10; i++) {
    const v = f();
    if (v) return v;
    await sleep(10);
  }
  throw new Error("timed out");
}
const tmp = (t: T): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ask-deadline-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const FIELDS = { tool: "bash", payload: "pip install requests", cwd: "/w", session: "child-s", role: "builder", run: "L9", cause: "no rule matches", reason: "r", inputHash: "h1" };
const ASK = JSON.stringify({ verdict: "owner", class: "data-loss", reason: "cannot tell" });
const registry = (reply: string) => ({ find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }) });
const cfg = () => ({ providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } }, presence: { enabled: false } });
const logOf = (agentDir: string): Record<string, unknown>[] => {
  const f = gateLogFile(agentDir);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};

// ------------------------------------------------------------------ the constant and the ask file

test("the child ask limit is 15 minutes", () => {
  assert.equal(DEFAULT_ASK_TIMEOUT_MS, 15 * 60 * 1000);
});

test("writeChildAsk with a missing ask dir does not create it and throws: the child counts as gone", (t) => {
  const dir = path.join(tmp(t), "launch-gone");
  assert.throws(() => writeChildAsk(dir, FIELDS));
  assert.equal(fs.existsSync(dir), false, "the child never creates the ask dir");
  fs.mkdirSync(dir);
  assert.equal(writeChildAsk(dir, { ...FIELDS, deadline: 5000 }), 1);
  assert.equal(readChildAsk(dir)?.deadline, 5000);
});

// ------------------------------------------------------------------ parent side: the deadline aborts the dialog and the queue moves on

function fakeTimers() {
  const live = new Map<number, { f: () => void; ms: number }>();
  let id = 0;
  const timers: AskTimers = { set: (f, ms) => (live.set(++id, { f, ms }), id), clear: (h) => void live.delete(h as number) };
  return { timers, live };
}

test("a shown ask is aborted at its deadline: no ruling, the queue moves on to the next ask, and nothing is parked", async (t) => {
  const a = tmp(t);
  const b = tmp(t);
  let clock = 1000;
  const ft = fakeTimers();
  const events: ChildAskEvent[] = [];
  const signals: AbortSignal[] = [];
  const answered: string[] = [];
  const w = new ChildAskWatch(
    (ask, signal) => {
      signals.push(signal);
      answered.push(ask.payload);
      // a dialog that closes with no answer when its signal aborts (Pi's select does)
      return new Promise((res) => signal.addEventListener("abort", () => res({ allow: false, noRuling: true }), { once: true }));
    },
    (e) => void events.push(e),
    ft.timers,
    () => clock,
  );
  writeChildAsk(a, { ...FIELDS, payload: "first", deadline: 5000 });
  writeChildAsk(b, { ...FIELDS, payload: "second", deadline: 900_000 });
  w.add(a);
  w.add(b);
  w.poll();
  await until(() => signals.length === 1);
  const deadlineTimer = [...ft.live.values()].find((x) => x.ms === 4000);
  assert.ok(deadlineTimer, "a timer for the time left to the deadline");
  clock = 5001;
  deadlineTimer.f();
  assert.equal(signals[0].aborted, true, "the dialog of the ask is aborted");
  await until(() => signals.length === 2);
  assert.deepEqual(answered, ["first", "second"], "the queue moved on");
  assert.equal(fs.existsSync(path.join(a, "ruling-1.md")), false, "nothing written for the timed-out ask");
  assert.deepEqual(events.map((e) => [e.kind, e.ask.payload]), [["late", "first"]]);
  assert.equal(events.some((e) => e.kind === "answered"), false);
  w.stop();
});

test("a parent dialog that honours its signal closes at the deadline of a real parent session; the next ask is shown and the park stays empty", async (t) => {
  const titles: string[] = [];
  const sent: { customType?: string }[] = [];
  const ui = {
    notify: () => undefined,
    confirm: async () => false,
    select: (title: string, _o: string[], opts?: { signal?: AbortSignal }) =>
      new Promise<string | undefined>((res) => {
        titles.push(title);
        opts?.signal?.addEventListener("abort", () => res(undefined), { once: true });
      }),
    input: async () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const r = await r11Rig(t, {}, { ctx: { ui, modelRegistry: registry(ASK) }, config: cfg(), piExtra: { sendMessage: (m: { customType?: string }) => void sent.push(m) } });
  const one = { agent: "builder", task: "go" } as Record<string, unknown>;
  const two = { agent: "builder", task: "go" } as Record<string, unknown>;
  await r.launch(one);
  await r.launch(two);
  const dirOf = (i: Record<string, unknown>): string => (i.extensionBindings as Record<string, Record<string, string>>)[BINDING_NS].askDir;
  writeChildAsk(dirOf(one), { ...FIELDS, payload: "first call", deadline: Date.now() + 700 });
  writeChildAsk(dirOf(two), { ...FIELDS, payload: "second call", deadline: Date.now() + 600_000 });
  await until(() => titles.length === 1);
  assert.match(titles[0], /first call/);
  await until(() => titles.length === 2, 6000);
  assert.match(titles[1], /second call/, "the queue moved on once the first dialog was closed at its deadline");
  assert.equal(fs.existsSync(path.join(dirOf(one), "ruling-1.md")), false);
  assert.ok(logOf(r.agentDir).some((x) => x.layer === "child-ask" && /late/.test(String(x.reason))));
  assert.equal(sent.some((m) => m.customType === "pi-foreman-ask-answered" || m.customType === "pi-foreman-ask-open"), false, "no parked answer, no still-open notice");
});

// ------------------------------------------------------------------ child side

async function childRig(t: T, askDir: string | null, reply = ASK, extra: Record<string, unknown> = {}) {
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role: "builder", launchId: "L9", kind: "first", model: null, ...(askDir ? { askDir } : {}) } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  return r11Rig(t, {}, { ctx: { modelRegistry: registry(reply), ...extra }, config: cfg(), child: true });
}
const CMD = { command: "git branch -D old-topic" };

test("child ask: no answer in 15 minutes ends the wait with its own text, logged parent-timeout; the same call twice never stops the run", async (t) => {
  const dir = tmp(t);
  const r = await childRig(t, dir);
  const results: { reason?: string; block?: boolean }[] = [];
  for (let i = 1; i <= 3; i++) {
    const p = r.call("bash", CMD);
    const ask = (await until(() => readChildAsk(dir)?.n === i && readChildAsk(dir)))!;
    assert.ok(ask.deadline > Date.now() && ask.deadline <= Date.now() + DEFAULT_ASK_TIMEOUT_MS, "the deadline is in ask.md");
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    let res: { reason?: string; block?: boolean } | undefined;
    try {
      let done = false;
      void p.then((v) => {
        res = v as typeof res;
        done = true;
      });
      // the wait polls every 250 ms; step past the deadline and let the pending promises run between steps
      for (let k = 0; k < 100 && !done; k++) {
        mock.timers.tick(DEFAULT_ASK_TIMEOUT_MS / 20);
        await sleep(30); // real time: a wait that began before the mock holds a real 250 ms timer
      }
      assert.ok(done, "the wait ended at the deadline");
    } finally {
      mock.timers.reset();
    }
    results.push(res ?? {});
  }
  for (const res of results) {
    assert.equal(res.block, true);
    assert.equal(res.reason, CHILD_ASK_TIMEOUT_TEXT);
  }
  assert.doesNotMatch(CHILD_ASK_TIMEOUT_TEXT, /still open|do not work around/);
  assert.deepEqual(r.events("dialog").map((d) => d.decision), ["parent-timeout", "parent-timeout", "parent-timeout"]);
  assert.equal(fs.existsSync(path.join(dir, "ruling-1.md")), false, "nothing was ruled");
});

test("child ask: a missing ask dir is not created; the call is denied with the gone text and no ask.md appears", async (t) => {
  const dir = path.join(tmp(t), "launch-gone");
  const r = await childRig(t, dir);
  const res = await r.call("bash", CMD);
  assert.equal(res?.block, true);
  assert.equal(res?.reason, CHILD_GONE_TEXT);
  assert.equal(fs.existsSync(dir), false);
});

// ------------------------------------------------------------------ protected path: a missing ask dir means away

const HOST = "prod-1.example.net";
const WRITE_ALLOW = JSON.stringify({ verdict: "allow", effect: "write", confidence: "high", entry: null, reason: "restarts the service" });

test("protected target: a child whose ask dir is missing counts as away (a write verdict asks); with the dir there it is not away", async (t) => {
  const seen: { dir: string; away: unknown; accepted: unknown }[] = [];
  for (const [name, make] of [["missing", false], ["present", true]] as const) {
    const dir = path.join(tmp(t), "launch");
    if (make) fs.mkdirSync(dir);
    const prev = process.env[BINDINGS_ENV];
    process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role: "builder", launchId: "L9", kind: "first", model: null, askDir: dir } });
    t.after(() => {
      if (prev === undefined) delete process.env[BINDINGS_ENV];
      else process.env[BINDINGS_ENV] = prev;
    });
    const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry(WRITE_ALLOW), [RIG_PERMISSIONS]: { protected: [{ host: "prod-*.example.net" }] } }, config: { ...cfg(), gate: { childAsk: "parent" } }, child: true });
    const call = r.call("bash", { command: `ssh ${HOST} uptime` });
    if (make) {
      await until(() => r.events("protected_check").length === 1);
      fs.rmSync(dir, { recursive: true, force: true }); // ends the child's wait at once (gone)
    }
    await call;
    const pc = r.events("protected_check")[0];
    seen.push({ dir: name, away: pc.away, accepted: pc.accepted });
  }
  assert.deepEqual(seen, [{ dir: "missing", away: true, accepted: "ask" }, { dir: "present", away: false, accepted: "allow" }]);
});

// ------------------------------------------------------------------ the parked allow

test("a parked allow covers the first ask of the resumed run only when it is the same call, and is gone after that ask", () => {
  const p = new ChildAskPark();
  const dir = "/x/child-asks/parent/L1";
  const key = parkKey(dir, "bash", "/w", "h1");
  p.park(key, true);
  p.dropDir("/x/child-asks/parent/L2");
  assert.equal(p.take(key), true, "another launch's ask drops nothing of this one");
  p.park(key, true);
  p.dropDir(dir);
  assert.equal(p.take(key), undefined, "dropped at the ask that follows");
});

test("a parked allow for ask n does not cover a different call as the next ask, nor the identical call as ask n+1", async (t) => {
  const titles: string[] = [];
  const pending: ((v: string | undefined) => void)[] = [];
  const sent: { customType?: string }[] = [];
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
  const r = await r11Rig(t, {}, { ctx: { ui, modelRegistry: registry(ASK) }, config: cfg(), piExtra: { sendMessage: (m: { customType?: string }) => void sent.push(m) } });
  const input: Record<string, unknown> = { agent: "builder", task: "go" };
  const { id } = await r.launch(input);
  const b = (input.extensionBindings as Record<string, Record<string, string>>)[BINDING_NS];
  await r.started(id, input, "run-1");
  writeChildAsk(b.askDir, { ...FIELDS, run: b.launchId });
  await until(() => titles.length === 1);
  r.end({ runId: "run-1" });
  pending[0]("allow once");
  await until(() => sent.some((m) => m.customType === "pi-foreman-ask-answered"));
  await r.launch({ action: "resume", id: "run-1", message: "go on" });
  // the resumed run's first ask is another call: the dialog shows, and the parked allow is gone with it
  writeChildAsk(b.askDir, { ...FIELDS, run: b.launchId, payload: "pip install flask", inputHash: "h2" });
  await until(() => titles.length === 2);
  assert.match(titles[1], /pip install flask/);
  pending[1]("deny with comment");
  await until(() => fs.existsSync(path.join(b.askDir, "ruling-1.md")));
  // the identical call of the ended run, now ask 2: it is not covered
  writeChildAsk(b.askDir, { ...FIELDS, run: b.launchId });
  await until(() => titles.length === 3);
  assert.equal(fs.existsSync(path.join(b.askDir, "ruling-2.md")), false, "a dialog, no answer from the park");
  assert.equal(r.events("ask_parked_used").length, 0);
});
