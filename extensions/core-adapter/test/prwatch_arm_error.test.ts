import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession, PrTracker } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { Timers, WatchPoll, WatchSnapshot } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

const snap = (over: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abc1234567", base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "failed", url: "u" }], comments: [], ...over });

function setup(firstPoll: "error" | "not_found" | "ok") {
  const tools = new Map<string, Tool>();
  const sent: unknown[] = [];
  const timers: (() => void)[] = [];
  const delays: number[] = [];
  const fakeTimers: Timers = { set: (fn, ms) => (timers.push(fn), delays.push(ms), timers.length), clear: () => {} };
  const ticks: WatchPoll[] = [];
  const spawner: Spawner = async (_c, _a, o) => {
    const op = JSON.parse(o.input ?? "{}").op;
    if (op === "pr_create") return { code: 0, stdout: JSON.stringify({ ok: true, action: "pr_create", number: 5, url: "https://github.com/acme/app/pull/5" }) + "\n", stderr: "", timedOut: false };
    if (firstPoll === "not_found") return { code: 0, stdout: JSON.stringify({ ok: true, prs: [], errors: [{ repo: "acme/app", number: 5, kind: "pr_not_found" }] }) + "\n", stderr: "", timedOut: false };
    return { code: 1, stdout: JSON.stringify({ ok: false, error: "host_error", message: "boom" }) + "\n", stderr: "", timedOut: false };
  };
  const watches = new PrWatches({ poll: async () => ticks.shift() ?? { error: "x" }, send: (m) => void sent.push(m), idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: fakeTimers });
  const tracker: PrTracker = { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/app" }) };
  const session: PrPackSession = { python: "/py", isChild: false, packOn: true, config: {}, gateOn: false, reviewed: async () => [], watches, trace: () => {}, tracker };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as { name: string }).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const call = (name: string, params: Record<string, unknown> = {}) => tools.get(name)!.execute("id1", params, undefined, undefined, { cwd: process.cwd() });
  return { call, watches, sent, timers, delays, ticks };
}

test("pr_create: a host error on the first poll keeps the watch armed and says it will retry", async () => {
  const h = setup("error");
  const r = await h.call("pr_create", { title: "t", body: "b" });
  assert.equal(h.watches.size(), 1);
  assert.match(r.content[0].text, /\npr_watch: armed \(until the PR is merged or closed; pr_unwatch ends it\); the first poll failed \(.*\), it will retry$/);
  assert.equal(h.timers.length, 1);
  assert.ok(h.delays[0] >= 60_000);
});

test("pr_watch: a host error on the first poll keeps the watch armed", async () => {
  const h = setup("error");
  const r = await h.call("pr_watch", { number: 5 });
  assert.equal(h.watches.size(), 1);
  assert.match(r.content[0].text, /armed, but the first poll failed .* it will retry/);
  assert.equal(r.details.decision, "watching");
});

const flush = () => new Promise((r) => setImmediate(r));
const texts = (sent: unknown[]) => sent.map((m) => (m as { content: string }).content);
const oldComment = { id: "c1", kind: "issue", author: "a", body: "old" };

test("a later successful poll reports the failed check once, the next change is reported", async () => {
  const h = setup("error");
  await h.call("pr_create", { title: "t", body: "b" });
  h.ticks.push({ snap: snap() });
  h.timers[0]();
  await flush();
  assert.equal(h.sent.length, 1);
  const t = texts(h.sent)[0];
  assert.equal(t.match(/checks finished: fail/g)?.length, 1);
  assert.match(t, /- failed ci/);
  assert.equal(h.watches.size(), 1);
  assert.equal(h.timers.length, 2);
  h.ticks.push({ snap: snap({ head: "def7654321", updatedAt: "t2", runs: [{ id: "2", name: "ci", bucket: "failed", url: "u" }] }) });
  h.timers[1]();
  await flush();
  assert.equal(h.sent.length, 2);
});

test("a pending start reports a failed check while other checks still run", async () => {
  const h = setup("error");
  await h.call("pr_create", { title: "t", body: "b" });
  h.ticks.push({ snap: snap({ runs: [{ id: "1", name: "ci", bucket: "failed", url: "u" }, { id: "2", name: "lint", bucket: "pending", url: "u" }] }) });
  h.timers[0]();
  await flush();
  assert.equal(h.sent.length, 1);
  assert.match(texts(h.sent)[0], /check failed/);
  assert.doesNotMatch(texts(h.sent)[0], /checks finished/);
});

test("a pending start baselines old comments and mergeable, and reports a settled green result once", async () => {
  const h = setup("error");
  await h.call("pr_create", { title: "t", body: "b" });
  const green = snap({ comments: [oldComment], runs: [{ id: "1", name: "ci", bucket: "passed", url: "u" }] });
  h.ticks.push({ snap: green });
  h.timers[0]();
  await flush();
  assert.equal(h.sent.length, 1);
  const t = texts(h.sent)[0];
  assert.match(t, /checks finished: pass/);
  assert.doesNotMatch(t, /new comments|mergeable (MERGEABLE|CONFLICTING)\b.*,|old/);
  h.ticks.push({ snap: green });
  h.timers[1]();
  await flush();
  assert.equal(h.sent.length, 1);
});

test("a pending start with an old comment and a mergeable state sends neither", async () => {
  const h = setup("error");
  await h.call("pr_create", { title: "t", body: "b" });
  h.ticks.push({ snap: snap({ comments: [oldComment], runs: [{ id: "1", name: "ci", bucket: "pending", url: "u" }] }) });
  h.timers[0]();
  await flush();
  assert.equal(h.sent.length, 0);
});

test("a restored arming record behaves like a pending start", async () => {
  const h = setup("error");
  await h.call("pr_create", { title: "t", body: "b" });
  const watches = h.watches.records();
  assert.equal(watches[0].state.last, "arming");
  h.watches.clear();
  h.ticks.push({ snap: snap({ comments: [oldComment] }) });
  h.watches.restore({ status: "ok", watches, bad: 0 });
  await flush();
  assert.equal(h.sent.length, 1);
  const t = texts(h.sent)[0];
  assert.equal(t.match(/checks finished: fail/g)?.length, 1);
  assert.doesNotMatch(t, /new comments/);
});

test("pr_create: a not-found first poll adds a not armed line", async () => {
  const h = setup("not_found");
  const r = await h.call("pr_create", { title: "t", body: "b" });
  assert.match(r.content[0].text, /\npr_watch: not armed \(the pull request was not found\)$/);
});

test("pr_not_found on the first poll does not arm", async () => {
  const h = setup("not_found");
  const r = await h.call("pr_create", { title: "t", body: "b" });
  assert.equal(h.watches.size(), 0);
  assert.doesNotMatch(r.content[0].text, /pr_watch: armed/);
});

test("pr_unwatch: repo ends only that repository's watch; a number alone prefers the current repository", async () => {
  const h = setup("ok");
  const a = { host: "github.com", repo: "acme/app", n: 5 };
  const b = { host: "github.com", repo: "acme/lib", n: 5 };
  h.watches.start(a, snap());
  h.watches.start(b, snap());
  assert.equal(h.watches.size(), 2);
  const r1 = await h.call("pr_unwatch", { number: 5, repo: "acme/lib" });
  assert.match(r1.content[0].text, /"unwatched":true/);
  assert.deepEqual(h.watches.list().map((w) => w.key.repo), ["acme/app"]);
  h.watches.start(b, snap());
  await h.call("pr_unwatch", { number: 5 }); // current repository acme/app
  assert.deepEqual(h.watches.list().map((w) => w.key.repo), ["acme/lib"]);
  await h.call("pr_unwatch", { number: 5 }); // none in the current repository: every watch of the number
  assert.equal(h.watches.size(), 0);
  const bad = await h.call("pr_unwatch", { number: 5, repo: "nope" });
  assert.equal(bad.details.decision, "bad_request");
});
