import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession, PrTracker } from "../gitpack.ts";
import { baselineOf, prDelta, PrWatches } from "../prwatch.ts";
import type { Timers, WatchSnapshot } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

test("pr_create: a non-Error throw while arming still returns the created PR and a not armed line", async () => {
  const tools = new Map<string, Tool>();
  const spawner: Spawner = async (_c, _a, o) => {
    const op = JSON.parse(o.input ?? "{}").op;
    if (op === "pr_create") return { code: 0, stdout: JSON.stringify({ ok: true, action: "pr_create", number: 5, url: "https://github.com/acme/app/pull/5" }) + "\n", stderr: "", timedOut: false };
    throw "plain string";
  };
  const timers: Timers = { set: () => 1, clear: () => {} };
  const watches = new PrWatches({ poll: async () => ({ error: "x" }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers });
  const tracker: PrTracker = { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/app" }) };
  const session: PrPackSession = { python: "/py", isChild: false, packOn: true, config: {}, gateOn: false, reviewed: async () => [], watches, trace: () => {}, tracker };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as { name: string }).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const r = await tools.get("pr_create")!.execute("id1", { title: "t", body: "b" }, undefined, undefined, { cwd: process.cwd() });
  assert.match(r.content[0].text, /pull\/5/);
  assert.match(r.content[0].text, /\npr_watch: not armed \(.*plain string.*\)$/);
});

const snap = (over: Partial<WatchSnapshot> = {}): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head: "abc1234567", base: "main", updatedAt: "t1", runs: [{ id: "1", name: "ci", bucket: "pending", url: "u" }], status: {}, ...over });

test("prDelta: an UNKNOWN baseline followed by CONFLICTING sends the conflict; a known baseline and UNKNOWN stay quiet", () => {
  const b = baselineOf(snap({ mergeable: "unknown" }));
  assert.equal(prDelta(b, snap({ mergeable: "unknown" }), true).delta, null);
  const c = prDelta(b, snap({ mergeable: "conflicting" }), true);
  assert.deepEqual(c.delta?.events, ["mergeable CONFLICTING"]);
  assert.equal(c.delta?.conflict, true);
  // a first MERGEABLE is only the baseline
  assert.equal(prDelta(b, snap({ mergeable: "mergeable" }), true).delta, null);
  // a known conflicting baseline is unchanged
  assert.equal(prDelta(baselineOf(snap({ mergeable: "conflicting" })), snap({ mergeable: "conflicting" }), true).delta, null);
});

test("a pending watch whose first good poll is CONFLICTING sends the conflict; MERGEABLE and UNKNOWN stay quiet", async () => {
  for (const [mergeable, expectEvent] of [["conflicting", true], ["mergeable", false], ["unknown", false]] as const) {
    const fns: (() => void)[] = [];
    const sent: { content: string }[] = [];
    const timers: Timers = { set: (fn) => fns.push(fn), clear: () => {} };
    const watches = new PrWatches({
      poll: async () => ({ snap: snap({ mergeable }) }),
      send: (m) => void sent.push(m),
      idle: () => true,
      trace: () => {},
      intervalMs: () => 60_000,
      now: () => 0,
      timers,
      child: () => true,
    });
    watches.startPending({ host: "github.com", repo: "acme/app", n: 7 }, "boom");
    fns[0]();
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, expectEvent ? 1 : 0, mergeable);
    if (expectEvent) assert.match(sent[0].content, /mergeable CONFLICTING[\s\S]*merge main into the branch/);
  }
});
