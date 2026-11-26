// D179: the refused-cleanup reply names a merged PR only when the session opened it or watched it by number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { closePrompt, INTERCOM_OUTBOX_EVENT, registerClose } from "../close.ts";
import { latestWatches, PRWATCH_ENTRY, PrWatches } from "../prwatch.ts";
import type { Timers, WatchRecord, WatchSnapshot } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";
import { storeFromPoll } from "./_storefake.ts";
import { trackedTmp } from "./_tmpbase.ts";

const K: PrKey = { host: "github.com", repo: "acme/app", n: 7 };
const snap = (state: WatchSnapshot["state"] = "open"): WatchSnapshot => ({ state, mergeable: "mergeable", head: "abcdef0123456789", base: "main", updatedAt: "t0", runs: [] });

// ---------------------------------------------------------------- the watches

const watchesOf = () => {
  const entries: { watches: WatchRecord[]; merged: PrKey[]; mergedOwn: PrKey[] }[] = [];
  const timers: Timers = { set: () => 0, clear: () => undefined };
  const w = new PrWatches({
    storeEntry: storeFromPoll(async () => ({ snap: snap() })),
    send: () => undefined,
    idle: () => true,
    trace: () => undefined,
    intervalMs: () => 5000,
    now: () => 0,
    timers,
    child: () => true,
    fresh: async () => "merged",
    persist: (watches, merged, mergedOwn) => void entries.push({ watches, merged, mergedOwn }),
  });
  return { w, entries };
};

for (const [name, started, own] of [
  ["a bare pr_watch", (w: PrWatches) => w.start(K, snap()), false],
  ["a pr_create", (w: PrWatches) => w.start(K, snap(), null, false, true), true],
  ["a pr_watch with a number", (w: PrWatches) => w.start(K, snap(), null, false, false, undefined, false, true), true],
  ["a pending pr_watch with a number", (w: PrWatches) => w.startPending(K, undefined, undefined, false, false, undefined, false, true), true],
  ["a pending bare pr_watch", (w: PrWatches) => w.startPending(K), false],
] as const) {
  test(`${name}: the merged PR is ${own ? "" : "not "}own, and a reload keeps it`, async () => {
    const m = watchesOf();
    started(m.w);
    await m.w.refresh();
    assert.deepEqual(m.w.mergedPrs().map((k) => k.n), [7]);
    assert.equal(m.w.mergedOwn(7), own);
    const last = m.entries.at(-1)!;
    const entry = { type: "custom", customType: PRWATCH_ENTRY, data: { v: 2, piSessionId: "s1", watches: last.watches, merged: last.merged, ...(last.mergedOwn.length ? { mergedOwn: last.mergedOwn } : {}) } };
    const again = watchesOf();
    again.w.restore(latestWatches([entry], "s1"));
    assert.equal(again.w.mergedOwn(7), own);
  });
}

test("an older saved entry without the own list counts as not own; an older watch record with opened counts as own", async () => {
  const old = { type: "custom", customType: PRWATCH_ENTRY, data: { v: 2, piSessionId: "s1", watches: [], merged: [K] } };
  const a = watchesOf();
  a.w.restore(latestWatches([old], "s1"));
  assert.deepEqual(a.w.mergedPrs().map((k) => k.n), [7]);
  assert.equal(a.w.mergedOwn(7), false);
  const b = watchesOf();
  b.w.start(K, snap(), null, false, true);
  const saved = JSON.parse(JSON.stringify(b.entries.at(-1)!.watches));
  assert.equal(saved[0].own, true);
  delete saved[0].own;
  const c = watchesOf();
  c.w.restore(latestWatches([{ type: "custom", customType: PRWATCH_ENTRY, data: { v: 2, piSessionId: "s1", watches: saved } }], "s1"));
  await c.w.refresh();
  assert.equal(c.w.mergedOwn(7), true);
});

// ---------------------------------------------------------------- the session deps path

const cwd = fs.realpathSync.native(trackedTmp("pf-close-own-"));
fs.mkdirSync(path.join(cwd, ".workflow"));
execFileSync("git", ["init", "-q", cwd]);

type H = (e: unknown, c: unknown) => Promise<unknown>;

async function replies(own: boolean | undefined): Promise<string[]> {
  const handlers = new Map<string, H>();
  const out: string[] = [];
  const pi = {
    on: (n: string, h: H) => void handlers.set(n, h),
    sendUserMessage: () => undefined,
    events: {
      on: (_ev: string, fn: (d: unknown) => void) => {
        (pi as unknown as { fn: (d: unknown) => void }).fn = fn;
        return () => undefined;
      },
      emit: (ev: string, d: unknown) => {
        if (ev !== INTERCOM_OUTBOX_EVENT) return;
        out.push(String((d as { message: string }).message));
        queueMicrotask(() => (pi as unknown as { fn: (d: unknown) => void }).fn({ requestId: (d as { requestId: string }).requestId, status: "sent" }));
      },
    },
  };
  registerClose(pi as never, {
    platform: process.platform,
    activeWaits: () => [],
    activeRuns: () => 0,
    session: async () => ({
      id: "s1",
      isChild: false,
      cwd,
      config: () => ({}),
      trace: () => undefined,
      markCause: () => undefined,
      runSync: async () => ({ text: "", ok: true }),
      retro: async () => "",
      mergedPr: () => 7,
      ...(own === undefined ? {} : { mergedOwn: (n: number) => own && n === 7 }),
      selfFinish: async () => ({ lines: ["cleanup: not started (worktree_dirty)"] }),
    }),
  });
  const ctx = { hasUI: true, isIdle: () => true, shutdown: () => undefined, ui: { notify: () => undefined }, sessionManager: { getSessionId: () => "s1", getBranch: () => [] } };
  const file = ".workflow/r.md";
  const msg = { role: "custom", customType: "intercom_message", details: { from: { id: "parent-1", name: "p" }, message: { id: "m1", content: { text: `foreman:close ${file}` } } } };
  const before = [process.env.PI_FOREMAN_PARENT_INTERCOM, process.env.PI_FOREMAN_HANDOFF_DIR, process.env.PI_SUBAGENT_CHILD];
  process.env.PI_FOREMAN_PARENT_INTERCOM = "parent-1";
  delete process.env.PI_FOREMAN_HANDOFF_DIR;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    await handlers.get("message_end")!({ message: msg }, ctx);
    await handlers.get("input")!({ text: closePrompt(file), source: "extension" }, ctx);
    await handlers.get("message_end")!({ message: { role: "assistant", stopReason: "stop" } }, ctx);
    await handlers.get("agent_settled")!({}, ctx);
    await new Promise((r) => setImmediate(r));
  } finally {
    const [a, b, c] = before;
    for (const [k, v] of [["PI_FOREMAN_PARENT_INTERCOM", a], ["PI_FOREMAN_HANDOFF_DIR", b], ["PI_SUBAGENT_CHILD", c]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return out;
}

test("session deps: an own merged PR is named in the refused-cleanup reply", async () => {
  const out = await replies(true);
  assert.ok(out[0]?.startsWith("PR #7 merged, closing (cleanup: not started (worktree_dirty)"), out.join("|"));
});

test("session deps: a merged PR that is not own (or with no mergedOwn dep) leaves its number out; the reason stays", async () => {
  for (const own of [false, undefined]) {
    const out = await replies(own);
    assert.ok(out[0]?.startsWith("closing (cleanup: not started (worktree_dirty)"), out.join("|"));
    assert.ok(!out[0].includes("PR #"));
  }
});
