// r79 item 6: the owner presence around a dialog (presencewait.ts): away denies at once, a watchdog aborts an open dialog when the owner turns
// away, unknown counts as present, presence.enabled false starts no watchdog. A real Presence with an injected probe is used for the unknown case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER_AWAY_REASON, withPresence } from "../presencewait.ts";
import type { PresenceLike, WaitTimers } from "../presencewait.ts";
import { Presence } from "../presence.ts";

function fakeTimers() {
  const fns: (() => void)[] = [];
  let cleared = 0;
  const timers: WaitTimers = { set: (fn) => (fns.push(fn), fns.length), clear: () => void cleared++ };
  return { timers, tick: () => fns.forEach((f) => f()), started: () => fns.length, cleared: () => cleared };
}
const presence = (state: { away: boolean }, refreshed = { n: 0 }): PresenceLike => ({ refresh: async () => void refreshed.n++, away: () => state.away });
const settle = () => new Promise((r) => setTimeout(r, 5));

test("away before the dialog: denied at once, the dialog is never opened", async () => {
  let opened = 0;
  const n = { n: 0 };
  const r = await withPresence(presence({ away: true }, n), async () => void opened++);
  assert.deepEqual(r, { away: true, during: false });
  assert.equal(opened, 0);
  assert.equal(n.n, 1, "refresh runs first");
});

test("present: the dialog opens with a signal and its value returns; the watchdog is cleared", async () => {
  const ft = fakeTimers();
  const r = await withPresence(presence({ away: false }), async (signal) => (assert.equal(signal.aborted, false), "answer"), { timers: ft.timers });
  assert.deepEqual(r, { away: false, value: "answer" });
  assert.equal(ft.started(), 1);
  assert.equal(ft.cleared(), 1);
});

test("the owner turns away while the dialog is open: the signal aborts with owner-away and the result says so", async () => {
  const ft = fakeTimers();
  const state = { away: false };
  const refreshed = { n: 0 };
  let release: (v: string | undefined) => void = () => undefined;
  const p = withPresence(
    presence(state, refreshed),
    (signal) =>
      new Promise<string | undefined>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve(undefined));
      }),
    { timers: ft.timers },
  );
  await settle();
  ft.tick(); // still present
  await settle();
  assert.equal(refreshed.n, 2);
  state.away = true;
  ft.tick();
  const r = await p;
  assert.deepEqual(r, { away: true, during: true });
  assert.equal(refreshed.n, 3, "the watchdog re-probed");
  release(undefined);
  assert.equal(OWNER_AWAY_REASON, "owner-away");
});

test("the abort reason is owner-away", async () => {
  const ft = fakeTimers();
  const state = { away: false };
  let reason: unknown;
  const p = withPresence(presence(state), (signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => ((reason = signal.reason), resolve()))), { timers: ft.timers });
  await settle();
  state.away = true;
  ft.tick();
  await p;
  assert.equal(reason, "owner-away");
});

test("unknown counts as present: a real Presence whose probe fails keeps the dialog open", async () => {
  const pr = new Presence({ now: () => Date.now(), config: () => ({ enabled: true, awayAfterMinutes: 5, command: null }) as never, probe: async () => null, trace: () => undefined });
  const ft = fakeTimers();
  let aborted = false;
  const p = withPresence(pr, (signal) => new Promise<string>((resolve) => (signal.addEventListener("abort", () => (aborted = true)), setTimeout(() => resolve("ok"), 20))), { timers: ft.timers });
  await settle();
  ft.tick();
  const r = await p;
  assert.equal(pr.sample()?.outcome, "unknown");
  assert.deepEqual(r, { away: false, value: "ok" });
  assert.equal(aborted, false);
});

test("a real Presence that samples away denies at once", async () => {
  const pr = new Presence({ now: () => Date.now(), config: () => ({ enabled: true, awayAfterMinutes: 5, command: null }) as never, probe: async () => 3600, trace: () => undefined });
  const r = await withPresence(pr, async () => "never");
  assert.deepEqual(r, { away: true, during: false });
});

test("presence.enabled false: no probe, no watchdog, the dialog just runs", async () => {
  const ft = fakeTimers();
  const n = { n: 0 };
  const r = await withPresence(presence({ away: true }, n), async () => "v", { enabled: false, timers: ft.timers });
  assert.deepEqual(r, { away: false, value: "v" });
  assert.equal(n.n, 0);
  assert.equal(ft.started(), 0);
});

test("no presence object: the dialog runs without a watchdog", async () => {
  const ft = fakeTimers();
  const r = await withPresence(undefined, async () => 1, { timers: ft.timers });
  assert.deepEqual(r, { away: false, value: 1 });
  assert.equal(ft.started(), 0);
});

test("a failing refresh counts as present", async () => {
  const bad: PresenceLike = { refresh: async () => Promise.reject(new Error("probe")), away: () => false };
  assert.deepEqual(await withPresence(bad, async () => 2), { away: false, value: 2 });
});
