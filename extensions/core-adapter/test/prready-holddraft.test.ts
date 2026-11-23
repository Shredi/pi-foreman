// pr_create `holdDraft` (gitpack.ts, prwatch.ts WatchRecord.holdDraft): the PR opens as a draft and stays one; the watch still reports CI, never changes the draft
// state and sets no ready label. And the draft flow without it: a PR leaves draft once a `[pre-pr]` PASS stands on the head, even while CI runs (prready.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession, TrackOutcome } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import type { ReviewFacts } from "../prready.ts";
import type { PrKey } from "../prhost.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };
const URL = "https://ghe.example.com/acme/app/pull/12";
const created = { ok: true, action: "pr_create", number: 12, url: URL, head: "feat", base: "main" };
const out = (o: Record<string, unknown>) => ({ code: 0, stdout: JSON.stringify(o) + "\n", stderr: "", timedOut: false });
const flush = () => new Promise((r) => setImmediate(r));

function setup(o: { flow?: boolean; tracked?: TrackOutcome; store?: () => StoreRead; repoFor?: boolean } = {}) {
  const tools = new Map<string, Tool>();
  const ops: { op: string; args: Record<string, unknown> }[] = [];
  const spawner: Spawner = async (_c, _a, opt) => {
    const req = JSON.parse(opt.input ?? "{}") as { op: string; args: Record<string, unknown> };
    ops.push({ op: req.op, args: req.args });
    if (req.op === "pr_create") return out(created);
    if (req.op === "pr_draft") return out({ ok: true, action: "pr_draft", number: 12, draft: req.args.draft });
    return out({ ok: false, error: "x", message: "unexpected op " + req.op });
  };
  const watches = new PrWatches({ storeEntry: o.store ?? (() => ({ kind: "waiting" })), githubHosts: () => ({ hosts: ["ghe.example.com"] }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} } });
  const session: PrPackSession = {
    python: "/py",
    isChild: false,
    packOn: true,
    config: { prHost: "auto" },
    gateOn: false,
    reviewed: async () => [],
    watches,
    trace: () => {},
    tracker: { hostAllowed: async () => true, repoFor: async () => (o.repoFor === false ? null : { host: "ghe.example.com", repo: "acme/app" }) },
    track: async () => o.tracked ?? "added",
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    ...(o.flow === false ? {} : { draftFlow: () => true }),
  };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const create = (extra: Record<string, unknown> = {}) => tools.get("pr_create")!.execute("id", { title: "T", body: "B", ...extra }, undefined, undefined, { cwd: process.cwd() });
  const call = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("id", params, undefined, undefined, { cwd: process.cwd() });
  return { create, call, ops, watches, creates: () => ops.filter((x) => x.op === "pr_create"), drafts: () => ops.filter((x) => x.op === "pr_draft") };
}

test("holdDraft: opens as a draft, the host op never sees the field, the watch is held and not owned, the result says so", async () => {
  const x = setup();
  const r = await x.create({ holdDraft: true });
  assert.equal(x.creates()[0].args.draft, true);
  assert.equal("holdDraft" in x.creates()[0].args, false);
  const [rec] = x.watches.records();
  assert.equal(rec.holdDraft, true);
  assert.equal(rec.owned, undefined);
  assert.match(r.content[0].text, /stays one \(holdDraft\)/);
  assert.deepEqual(x.drafts(), []);
});

test("holdDraft: a draft even with the flow off, no tracker repository, an untracked PR or an arm failure, and never taken out of draft", async () => {
  const cases = [{ flow: false }, { repoFor: false }, { tracked: "unavailable" as TrackOutcome }, { store: () => { throw new Error("store unreadable"); } }];
  for (const c of cases) {
    const x = setup(c);
    const r = await x.create({ holdDraft: true });
    assert.equal(x.creates()[0].args.draft, true, JSON.stringify(Object.keys(c)));
    assert.deepEqual(x.drafts(), [], JSON.stringify(Object.keys(c)));
    assert.match(r.content[0].text, /stays one \(holdDraft\)/);
  }
});

test("holdDraft that is not a boolean is refused before any call", async () => {
  const x = setup();
  const r = await x.create({ holdDraft: "yes" });
  assert.equal(r.isError, true);
  assert.deepEqual(x.ops, []);
});

test("without holdDraft the watch is owned and the record carries no holdDraft", async () => {
  const x = setup();
  await x.create();
  const [rec] = x.watches.records();
  assert.equal(rec.owned, true);
  assert.equal(rec.holdDraft, undefined);
});

test("pr_unwatch of a watch says its CI is no longer reported; with no watch it does not", async () => {
  const x = setup();
  await x.create({ holdDraft: true });
  assert.match((await x.call("pr_unwatch", { number: 12 })).content[0].text, /"unwatched":true\}\nCI of this PR is no longer reported/);
  assert.doesNotMatch((await x.call("pr_unwatch", { number: 12 })).content[0].text, /no longer reported/);
});

// ---------------------------------------------------------------- the watch

const K: PrKey = { host: "ghe.example.com", repo: "acme/app", n: 12 };
const A = "a".repeat(40);
const snap = (o: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: A, base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "pending", url: "u" }], comments: [], draft: true, mergeState: "clean", ...o });

function watching(hold: boolean) {
  const fns: (() => void)[] = [];
  const timers: Timers = { set: (fn) => (fns.push(fn), fns.length), clear: () => {} };
  const sent: string[] = [];
  const drafts: boolean[] = [];
  const labels: boolean[] = [];
  let read: StoreRead = { kind: "entry", snap: snap(), okAt: 1000 };
  let okAt = 1000;
  const watches = new PrWatches({
    storeEntry: () => read,
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    reviewFacts: (): ReviewFacts => "ok",
    reviewGate: () => true,
    draftFlow: () => true,
    draft: async (_k, _c, draft) => (drafts.push(draft), { kind: "ran", result: { ok: true } }),
    label: async (_k, _c, _l, on) => (labels.push(on), { kind: "ran", result: { changed: true } }),
    readyLabel: () => "ready",
    persist: () => {},
    cwd: () => "/work",
    child: () => false,
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    settleMs: () => 0,
    now: () => 0,
    timers,
  });
  const set = (s: WatchSnapshot) => {
    okAt += 1000;
    read = { kind: "entry", snap: { ...s, updatedAt: `t${okAt}` }, okAt };
  };
  const tick = async () => {
    fns.shift()?.();
    await flush();
    await flush();
  };
  watches.start(K, snap(), 1000, true, true, undefined, hold); // owned either way: holdDraft alone keeps the watch off the draft state
  return { watches, sent, drafts, labels, set, tick };
}

test("draft flow: a PASS on the head takes the PR out of draft while CI still runs; red checks change nothing", async () => {
  const x = watching(false);
  x.set(snap({ updatedAt: "t2" }));
  await x.tick();
  await x.watches.reconcileOwned();
  assert.deepEqual(x.drafts, [false]);
  const y = watching(false);
  y.set(snap({ runs: [{ id: "1", name: "ci", bucket: "failed", url: "u" }] }));
  await y.tick();
  await y.watches.reconcileOwned();
  assert.deepEqual(y.drafts, []);
});

test("holdDraft: PASS and green checks leave the draft alone, set no label, and CI is still reported", async () => {
  const x = watching(true);
  x.set(snap({ runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }] }));
  await x.tick();
  await x.watches.reconcileOwned();
  assert.deepEqual(x.drafts, []);
  assert.deepEqual(x.labels, []);
  assert.ok(x.sent.some((m) => /check|CI/i.test(m)), x.sent.join("\n"));
  const [rec] = x.watches.records();
  assert.equal(rec.holdDraft, true);
});
