import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, Timers, WatchSnapshot } from "../prwatch.ts";
import { clearStoreCache, readStoreEntry, SERVE_FRESH_MS, trackedStateFile } from "../prstore.ts";
import type { ReviewFacts } from "../prready.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

const URL = "https://ghe.example.com/acme/app/pull/12";
const created = { ok: true, action: "pr_create", number: 12, url: URL, head: "feat", base: "main" };
const out = (o: Record<string, unknown>) => ({ code: 0, stdout: JSON.stringify(o) + "\n", stderr: "", timedOut: false });
const DOWN_HOW = "start herdr-app or run `foreman prs poll`";

function setup(o: { flow?: boolean; store?: () => StoreRead; undoFails?: boolean } = {}) {
  const tools = new Map<string, Tool>();
  const ops: { op: string; args: Record<string, unknown> }[] = [];
  const spawner: Spawner = async (_c, _a, opt) => {
    const req = JSON.parse(opt.input ?? "{}") as { op: string; args: Record<string, unknown> };
    ops.push({ op: req.op, args: req.args });
    if (req.op === "pr_create") return out(created);
    if (req.op === "pr_draft") return o.undoFails ? out({ ok: false, error: "pr_host_failed", message: "no" }) : out({ ok: true, action: "pr_draft", number: 12, draft: req.args.draft });
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
    tracker: { hostAllowed: async () => true, repoFor: async () => ({ host: "ghe.example.com", repo: "acme/app" }) },
    track: async () => "added",
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    ...(o.flow === false ? {} : { draftFlow: () => true }),
  };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const create = (extra: Record<string, unknown> = {}) => tools.get("pr_create")!.execute("id", { title: "T", body: "B", ...extra }, undefined, undefined, { cwd: process.cwd() });
  return { create, ops, watches, creates: () => ops.filter((x) => x.op === "pr_create"), drafts: () => ops.filter((x) => x.op === "pr_draft") };
}

test("tracker live (also not yet polled): a draft the watch owns; the line says who takes it out", async () => {
  const x = setup();
  const r = await x.create();
  assert.equal(x.creates()[0].args.draft, true);
  assert.equal(x.watches.records()[0].owned, true);
  assert.deepEqual(x.drafts(), []);
  assert.match(r.content[0].text, /the PR is a draft: the watch takes it out of draft once the PR tracker reports it, a `\[pre-pr\]` reviewer PASS is the newest code review on its head, its checks have settled green \(or none are confirmed\), the host says it is mergeable and the merge state is not behind, dirty or unknown/);
});

test("tracker never ran or died (store down): no draft asked, nothing to undo, the line says why", async () => {
  const x = setup({ store: () => ({ kind: "down" }) });
  const r = await x.create();
  assert.equal("draft" in x.creates()[0].args, false);
  assert.deepEqual(x.drafts(), []);
  assert.equal(x.watches.records()[0].owned, undefined);
  assert.ok(r.content[0].text.includes("the PR is not a draft: no PR tracker is running, so nothing would take it out of draft"));
  assert.equal(r.content[0].text.split("no PR tracker running").length - 1, 1);
  assert.ok(r.content[0].text.includes(DOWN_HOW));
});

test("tracker live at the ask, down after the arm: the undo runs and the line says so", async () => {
  let n = 0;
  const x = setup({ store: () => (++n === 1 ? { kind: "waiting" } : { kind: "down" }) });
  const r = await x.create();
  assert.equal(x.creates()[0].args.draft, true);
  assert.deepEqual(x.drafts().map((d) => d.args.draft), [false]);
  assert.notEqual(x.watches.records()[0]?.owned, true);
  assert.ok(r.content[0].text.includes("the PR is not a draft: no PR tracker is running, so it was taken out of draft"));
  assert.equal(r.content[0].text.split("no PR tracker running").length - 1, 1);
});

test("tracker down after the arm and the undo fails: the by-hand line", async () => {
  let n = 0;
  const x = setup({ undoFails: true, store: () => (++n === 1 ? { kind: "waiting" } : { kind: "down" }) });
  const r = await x.create();
  assert.equal(x.drafts().length, 1);
  assert.ok(r.content[0].text.includes("take it out of draft by hand"));
});

test("flow off: the line says the PR is not a draft; the caller's draft: true stays a draft nobody takes out", async () => {
  const x = setup({ flow: false });
  const r = await x.create();
  assert.ok(r.content[0].text.includes("the PR is not a draft (draft handling is off or does not cover this host)"));
  const y = setup({ flow: false });
  const r2 = await y.create({ draft: true });
  assert.equal(y.creates()[0].args.draft, true);
  assert.deepEqual(y.drafts(), []);
  assert.ok(r2.content[0].text.includes("the PR is a draft (draft: true) and nothing takes it out of draft automatically"));
});

test("readStoreEntry down: missing, unparseable, off, stale, fresh", () => {
  const NOW = 10_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-live-"));
  const file = trackedStateFile(dir);
  const write = (body: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    clearStoreCache();
  };
  const K = { host: "github.com", repo: "acme/app", n: 1 };
  const agree = (live: boolean, feedOn = true) => assert.equal(readStoreEntry(dir, K, NOW, feedOn).kind === "down", !live);
  clearStoreCache();
  agree(false);
  write("{not json");
  agree(false);
  write(JSON.stringify({ v: 1, trackedAt: NOW - 1000, off: true, prs: {} }));
  agree(false);
  write(JSON.stringify({ v: 1, trackedAt: NOW - SERVE_FRESH_MS - 1, prs: {} }));
  agree(false);
  write(JSON.stringify({ v: 1, trackedAt: NOW - 1000, prs: {} }));
  agree(true);
  agree(false, false);
});

function watchHarness() {
  const sent: string[] = [];
  const h = { read: { kind: "down" } as StoreRead };
  const timers: Timers = { set: () => 1, clear: () => {} };
  const fns: (() => void)[] = [];
  timers.set = (fn) => (fns.push(fn), fns.length);
  const watches = new PrWatches({
    storeEntry: () => h.read,
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    reviewFacts: () => "ok" as ReviewFacts,
    draftFlow: () => true,
    draft: async () => ({ kind: "ran", result: { ok: true } }),
    send: (m) => void sent.push(m.content),
    idle: () => true,
    trace: () => {},
    intervalMs: () => 60_000,
    now: () => 0,
    timers,
  });
  const snap: WatchSnapshot = { state: "open", mergeable: "mergeable", head: "a".repeat(40), base: "main", updatedAt: "t1", runs: [], comments: [], draft: true };
  const tick = async () => {
    fns.shift()?.();
    await new Promise((r) => setImmediate(r));
  };
  return { watches, sent, tick, snap };
}

test("watch tracker-down notice: a watch that manages a draft says the PR may still be a draft", async () => {
  const x = watchHarness();
  x.watches.start({ host: "ghe.example.com", repo: "acme/app", n: 7 }, x.snap, null, true);
  await x.tick();
  assert.equal(x.sent.length, 1);
  assert.match(x.sent[0], /no PR tracker running/);
  assert.match(x.sent[0], /may still be a draft, and nothing takes it out of draft until a tracker runs/);
});

test("watch tracker-down notice: an unmanaged watch gets the plain notice", async () => {
  const x = watchHarness();
  x.watches.start({ host: "ghe.example.com", repo: "acme/app", n: 7 }, x.snap, null, false);
  await x.tick();
  assert.equal(x.sent.length, 1);
  assert.match(x.sent[0], /no PR tracker running/);
  assert.doesNotMatch(x.sent[0], /draft/);
});
