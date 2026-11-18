// A child session never closes itself on a PR merge (docs/close.md): a merge gives one notice (pane, and the intercom parent unless the
// parent is remote) and starts no close. Only a close request (the parent's foreman:close, a remote parent's, the owner's `/foreman close`)
// closes, and it runs the merge cleanup. Real PrWatches, real CloseFlow and the real mergeNotifier wired as index.ts wires them; no child process.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CloseFlow, mergeNotifier } from "../close.ts";
import type { CloseDeps, CloseRequest } from "../close.ts";
import { latestWatches, PRWATCH_ENTRY, PrWatches } from "../prwatch.ts";
import type { WatchRecord, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import { clearStoreCache, storeKey, trackedStateFile } from "../prstore.ts";
import { world } from "./_r46world.ts";
import { storeFromPoll } from "./_storefake.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const K9: PrKey = { host: "github.com", repo: "acme/app", n: 9 };
const HANDOFF = "/h/20261102-120000-demo";
const FILE = `${HANDOFF}/result.md`;
const snap = (state: WatchSnapshot["state"] = "open"): WatchSnapshot => ({ state, mergeable: "mergeable", head: "abcdef0123456789", base: "main", updatedAt: "t0", runs: [] });
const NOTICE = (n: number, label = "demo"): string => `PR #${n} merged; ${label} stays open: it sends Result from when its brief is done, then close it with foreman:close (a session never closes itself)`;
const idle = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Opts {
  handoff?: string | undefined;
  parent?: string | undefined;
  remote?: boolean;
  runs?: number;
  waits?: { id: string; kind: string; note: string }[];
  ceremonyNote?: string;
}

/** A real PrWatches (child) whose `onMerged` is the one-line notifier wiring of index.ts, and a real CloseFlow over the same watches. */
function rig(o: Opts = {}) {
  const log: string[] = [];
  const pane: string[] = [];
  const intercom: [string, string][] = [];
  const traces: Record<string, unknown>[] = [];
  const cancelled: string[][] = [];
  const merged = new Set<number>();
  const persisted: { watches: WatchRecord[]; merged: PrKey[] }[] = [];
  let runs = o.runs ?? 0;
  let waits = o.waits ?? [];
  const armed: (() => void)[] = [];
  const notifier = mergeNotifier({
    handoff: "handoff" in o ? o.handoff : HANDOFF,
    parent: "parent" in o ? o.parent : "parent-1",
    remote: o.remote ?? false,
    notify: (t) => void pane.push(t),
    reply: (to, t) => void intercom.push([to, t]),
    trace: (r) => void traces.push(r),
  });
  const mkWatches = (): PrWatches => {
    const w: PrWatches = new PrWatches({
      storeEntry: storeFromPoll(async (key) => ({ snap: snap(merged.has(key.n) ? "merged" : "open") })),
      send: () => undefined,
      idle: () => true,
      trace: () => undefined,
      intervalMs: () => 5000,
      now: () => 0,
      timers: { set: (fn) => (armed.push(fn), 0), clear: () => undefined },
      child: () => true,
      rememberMerged: () => true,
      persist: (watches, m) => void persisted.push({ watches, merged: m }),
      onMerged: (info) => notifier(info.key.n),
    });
    return w;
  };
  let watches = mkWatches();
  const flowFor = (w: () => PrWatches): CloseFlow => {
    const deps: CloseDeps = {
      activeWaits: () => waits,
      activeRuns: () => runs,
      cancelWaits: () => (cancelled.push(waits.map((x) => x.id)), []),
      sendUserMessage: (t) => void log.push(`prompt:${t}`),
      runSync: async () => ({ text: "sync ok", ok: true }),
      retro: async () => "",
      reply: (to, t) => void log.push(`reply:${to}:${t}`),
      notify: (t) => void log.push(`notify:${t}`),
      trace: (r) => void (log.push(`trace:${String(r.decision ?? r.event)}`), traces.push(r)),
      markCause: () => undefined,
      writeStub: () => undefined,
      exists: () => true,
      setTimer: () => () => undefined,
      markClosed: () => void log.push("markClosed"),
      watchedPrs: () => w().numbers(),
      refreshWatched: () => w().refresh(),
      mergedPr: () => w().mergedPrs().at(-1)?.n ?? null,
      ceremonyNote: o.ceremonyNote === undefined ? undefined : () => o.ceremonyNote!,
      selfFinish: async (req) => (log.push(`selfFinish:${req.pr?.n}`), { lines: ["cleanup: started (fake)"], spawn: () => void log.push("spawn") }),
      appendResult: () => undefined,
    };
    return new CloseFlow(deps);
  };
  let flow = flowFor(() => watches);
  const ctx = { isIdle: () => true, shutdown: () => void log.push("shutdown") };
  /** The tracker's store says `ns` merged; every armed watch tick runs. */
  const merge = async (...ns: number[]): Promise<void> => {
    for (const n of ns) merged.add(n);
    for (let i = 0; i < 200; i++) {
      const fns = armed.splice(0);
      if (fns.length === 0) break;
      fns.forEach((f) => f());
      await idle();
    }
    await idle();
  };
  const close = async (req: CloseRequest): Promise<void> => {
    await flow.request(req, ctx);
    await idle();
    const prompt = log.filter((l) => l.startsWith("prompt:")).at(-1)?.slice("prompt:".length);
    if (prompt) flow.onInput(prompt, "extension");
    flow.onModelReply("stop");
    await flow.onSettled(ctx);
  };
  const noClose = (): void => {
    assert.equal(flow.active, false, "no close is active");
    assert.ok(!log.some((l) => l.startsWith("prompt:") || l === "shutdown" || l.startsWith("reply:") || l === "trace:accepted" || l === "trace:refused" || l.startsWith("selfFinish")), log.join("\n"));
    assert.ok(!traces.some((r) => r.event === "close" && (r.decision === "accepted" || r.decision === "refused")), JSON.stringify(traces));
  };
  return {
    log, pane, intercom, traces, cancelled, persisted, notifier, merge, close, noClose, ctx,
    watches: () => watches,
    flow: () => flow,
    setRuns: (n: number) => void (runs = n),
    setWaits: (x: typeof waits) => void (waits = x),
    /** A reload: a new PrWatches over the same fakes, restored from the last persisted entry; the close flow follows it. */
    reload: (): PrWatches => {
      const last = persisted.at(-1)!;
      const entries = [{ type: "custom", customType: PRWATCH_ENTRY, data: { v: 2, piSessionId: "s1", watches: JSON.parse(JSON.stringify(last.watches)), ...(last.merged.length ? { merged: last.merged } : {}) } }];
      watches = mkWatches();
      flow = flowFor(() => watches);
      watches.restore(latestWatches(entries, "s1"));
      return watches;
    },
  };
}

const parentClose: CloseRequest = { source: "intercom-parent", file: FILE, replyTo: "parent-1" };

test("(a) html-plans sequence: a merge while a child run is active, a foreman_wait pending, then the run ends: no close at any point", async () => {
  const r = rig({ runs: 1, waits: [{ id: "w1", kind: "pr", note: "" }] });
  r.watches().start(K, snap());
  await r.merge(7);
  r.setRuns(0);
  await idle();
  r.noClose();
  assert.deepEqual(r.cancelled, [], "the pending wait was not cancelled");
  assert.deepEqual(r.intercom, [["parent-1", NOTICE(7)]], "the parent hears the notice and nothing else");
  assert.equal(r.pane.length, 1);
  assert.deepEqual(r.watches().mergedPrs().map((k) => k.n), [7]);
});

test("(b) a child's merge gives one pane notice and one parent line naming the PR number and the label", async () => {
  const r = rig();
  r.watches().start(K, snap());
  await r.merge(7);
  assert.deepEqual(r.pane, [`pi-foreman: ${NOTICE(7)}`]);
  assert.deepEqual(r.intercom, [["parent-1", NOTICE(7)]]);
  assert.ok(r.traces.some((t) => t.event === "close" && t.cause === "merge" && t.decision === "noticed"));
  r.noClose();
});

test("(c) a second merge of another PR gives a second notice", async () => {
  const r = rig();
  r.watches().start(K, snap());
  r.watches().start(K9, snap());
  await r.merge(7);
  await r.merge(9);
  assert.deepEqual(r.intercom.map(([, t]) => t), [NOTICE(7), NOTICE(9)]);
  assert.equal(r.pane.length, 2);
  r.noClose();
});

test("(d) the hook called twice for one PR gives one notice", () => {
  const r = rig();
  r.notifier(7);
  r.notifier(7);
  assert.equal(r.pane.length, 1);
  assert.equal(r.intercom.length, 1);
});

test("(e) with no parent id the notice goes to the pane only", () => {
  const r = rig({ parent: undefined });
  r.notifier(7);
  assert.equal(r.pane.length, 1);
  assert.deepEqual(r.intercom, []);
});

test("(f) a remote parent (PI_FOREMAN_REMOTE_PARENT=1) gets no intercom line: pane only", () => {
  const r = rig({ remote: true });
  r.notifier(7);
  assert.equal(r.pane.length, 1);
  assert.deepEqual(r.intercom, []);
});

test("(g) a main session (no handoff dir) gives no notice and starts no close", async () => {
  const r = rig({ handoff: undefined });
  r.watches().start(K, snap());
  await r.merge(7);
  assert.deepEqual(r.pane, []);
  assert.deepEqual(r.intercom, []);
  assert.deepEqual(r.traces, []);
  r.noClose();
});

test("(h) reload: a watch restored from an entry with the merged PR gives no notice and no close; a later parent close runs the self-finish for it", async () => {
  const r = rig();
  r.watches().start(K, snap());
  await r.merge(7);
  assert.equal(r.pane.length, 1);
  const w = r.reload();
  await idle();
  assert.deepEqual(w.mergedPrs().map((k) => k.n), [7]);
  assert.equal(r.pane.length, 1, "no second notice");
  assert.equal(r.intercom.length, 1);
  r.noClose();
  await r.close(parentClose);
  assert.ok(r.log.includes("selfFinish:7"), r.log.join("\n"));
  assert.ok(r.log.includes("spawn"));
  assert.equal(r.log.at(-1), "shutdown");
});

test("(i) the owner's /foreman close in the child pane after a merge is accepted and runs the self-finish", async () => {
  const r = rig();
  r.watches().start(K, snap());
  await r.merge(7);
  await r.close({ source: "herdr", file: FILE });
  assert.ok(r.log.includes("trace:accepted"), r.log.join("\n"));
  assert.ok(r.log.includes("selfFinish:7"));
  assert.ok(r.log.includes("spawn"));
  assert.equal(r.log.at(-1), "shutdown");
});

test("(j) a parent foreman:close with ledger items open is accepted (a merge and open items never hold or start it)", async () => {
  const r = rig({ ceremonyNote: "ledger items 2, 3 are open" });
  r.watches().start(K, snap());
  await r.merge(7);
  await r.close(parentClose);
  assert.ok(r.log.includes("trace:accepted"), r.log.join("\n"));
  assert.ok(r.log.includes("selfFinish:7"));
  assert.ok(r.log.some((l) => l.startsWith("reply:parent-1:foreman:closed ")));
  assert.equal(r.log.at(-1), "shutdown");
});

test("the adapter wires the watch's merged event to the notice and to no close (the real index.ts over a restored watch)", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  const agentDir = path.resolve(path.dirname(w.sessionFile), "..", "..");
  const sid = path.basename(w.sessionFile, ".jsonl").replace(/^2026_/, "");
  const cfgFile = path.join(agentDir, "foreman.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, tools: { pr: true, prGithubHosts: ["github.com"] }, radar: { openPrs: { enabled: true } } }));
  // the tracker's state says PR #7 merged; the session's stored watch still has it open, so the restore polls at once and sees the merge
  clearStoreCache();
  fs.mkdirSync(path.dirname(trackedStateFile(agentDir)), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(trackedStateFile(agentDir), JSON.stringify({ v: 1, trackedAt: now, prs: { [storeKey(K.repo, K.n)]: { repo: K.repo, number: K.n, at: now, snap: snap("merged"), okAt: now } } }));
  const open = rig();
  open.watches().start(K, snap());
  w.entries.push({ type: "custom", customType: PRWATCH_ENTRY, data: { v: 2, piSessionId: sid, watches: JSON.parse(JSON.stringify(open.persisted[0].watches)) } });
  const a = await w.adapter("startup");
  const notices = (): string[] => w.notes.filter((n) => n.includes("PR #7 merged; round stays open"));
  for (let i = 0; i < 100 && notices().length === 0; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(notices().length, 1, w.notes.join("\n"));
  assert.match(notices()[0], /a session never closes itself/);
  const closeEvents = async (): Promise<Record<string, unknown>[]> => (await w.traceEvents()).filter((e) => e.event === "close");
  assert.deepEqual((await closeEvents()).map((e) => e.decision), ["noticed"]);
  await a.down();
  // a reload over the same session file restores the merged PR from the entry: no second notice, no close
  const b = await w.adapter("reload");
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(notices().length, 1, w.notes.join("\n"));
  assert.deepEqual((await closeEvents()).map((e) => e.decision), ["noticed"]);
  await b.down();
});
