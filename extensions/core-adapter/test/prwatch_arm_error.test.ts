import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession, PrTracker } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { Timers, WatchPoll, WatchSnapshot } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

const snap = (over: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abc1234567", base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "failed", url: "u" }], comments: [], status: {}, ...over });

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
  const tracker: PrTracker = { hostAllowed: async () => true, resolveRepo: async () => ({ host: "github.com", repo: "acme/app" }), trackTool: () => {}, untrack: () => {} };
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

test("a later successful poll takes the baseline without events, the next change is reported", async () => {
  const h = setup("error");
  await h.call("pr_create", { title: "t", body: "b" });
  h.ticks.push({ snap: snap() });
  h.timers[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sent.length, 0);
  assert.equal(h.watches.size(), 1);
  assert.equal(h.timers.length, 2);
  h.ticks.push({ snap: snap({ head: "def7654321", updatedAt: "t2", runs: [{ id: "2", name: "ci", bucket: "failed", url: "u" }] }) });
  h.timers[1]();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sent.length, 1);
});

test("pr_not_found on the first poll does not arm", async () => {
  const h = setup("not_found");
  const r = await h.call("pr_create", { title: "t", body: "b" });
  assert.equal(h.watches.size(), 0);
  assert.doesNotMatch(r.content[0].text, /armed/);
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
