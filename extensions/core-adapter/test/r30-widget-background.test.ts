import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildWidget, MAX_ROWS, type BackgroundRow, type WidgetOpts, type WidgetRows } from "../childwidget.ts";
import { PrWatches } from "../prwatch.ts";
import { WaitRuntime, type Timers, waitLimits } from "../wait.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "r30-widget-"));

/** Timers that run on `advance`; a handle is due at its time and runs once. */
function fakeClock() {
  let now = 100_000;
  const pending: { at: number; fn: () => void; cleared: boolean }[] = [];
  const timers: Timers = {
    set(fn, ms) {
      const h = { at: now + ms, fn, cleared: false };
      pending.push(h);
      return h;
    },
    clear(h) {
      (h as { cleared: boolean }).cleared = true;
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const h of pending.filter((x) => !x.cleared && x.at <= now)) {
      h.cleared = true;
      h.fn();
    }
  };
  return { timers, advance, now: () => now };
}

/** A tui ctx whose setWidget keeps the last component (`st.rows`) and counts the calls. */
function stubCtx() {
  const st = { sets: 0, rows: null as WidgetRows | null };
  const ctx = {
    mode: "tui",
    ui: {
      setWidget: (_k: string, c: ((tui: { requestRender(): void }) => WidgetRows) | undefined) => {
        st.sets++;
        st.rows = c ? c({ requestRender: () => undefined }) : null;
      },
    },
  };
  return { st, ctx };
}

/** The rendered rows without the leading space of each row (blank padding stays blank). */
const shown = (st: { rows: WidgetRows | null }): string[] => (st.rows ? st.rows.render(80).map((l) => l.slice(1)) : []);

/**
 * A foreman's registries wired the way index.ts wires them: a WaitRuntime (foreman_wait and foreman_bg pid waits)
 * and a PrWatches, both calling `show` on every change; the provider maps them like index.ts `backgroundOf`.
 */
function wiring(clock: ReturnType<typeof fakeClock>, dead: Set<number>) {
  const { st, ctx } = stubCtx();
  const dir = tmp();
  const w = new ChildWidget(path.join(dir, "u.jsonl"));
  const rows = (): BackgroundRow[] => [
    ...rt.list().filter((e) => e.kind !== "pressure").map((e) => ({ label: e.bg ? "bg" : "wait", detail: e.note || e.kind, startedAt: clock.now() - e.ageSeconds * 1000 })),
    ...pw.list().map((p) => ({ label: `pr #${p.n}`, detail: p.until, startedAt: p.startedAt })),
  ];
  const opts: WidgetOpts = { enabled: true, agentDir: dir, intercomId: null, background: rows };
  const show = () => w.request(ctx, opts, clock.now());
  const rt = new WaitRuntime({
    timers: clock.timers,
    now: clock.now,
    limits: () => waitLimits(() => undefined),
    stat: () => null,
    alive: (pid) => !dead.has(pid),
    gh: async () => ({ status: "", conclusion: "", url: "" }),
    trace: () => undefined,
    wake: () => undefined,
    changed: show,
  });
  const pw = new PrWatches({
    poll: async () => ({ error: "unused" }),
    send: () => undefined,
    idle: () => true,
    trace: () => undefined,
    intervalMs: () => 60_000,
    now: clock.now,
    timers: clock.timers,
    changed: show,
  });
  return { st, ctx, w, opts, show, rt, pw, dispose: () => w.dispose() };
}

const baseline = () => ({ checks: new Map<string, string>(), commentIds: new Set<string>() });

test("a foreman_wait row appears when a wait starts and goes on fire and on cancel", () => {
  const clock = fakeClock();
  const h = wiring(clock, new Set());
  h.rt.start({ kind: "timer", seconds: 60, note: "nightly build" });
  assert.deepEqual(shown(h.st), ["wait · nightly build · 0s"]);
  clock.advance(1000);
  const b = h.rt.start({ kind: "timer", seconds: 600, note: "" }) as { id: string };
  assert.deepEqual(shown(h.st), ["wait · nightly build · 1s", "wait · timer · 0s"]);
  clock.advance(59_000); // the 60 s wait fires: its row leaves, the other stays
  assert.deepEqual(shown(h.st), ["wait · timer · 59s", ""]); // padded to the height reached
  clock.advance(1000);
  h.rt.cancel(b.id); // the last row cancelled: the widget is hidden
  assert.equal(h.st.rows, null);
  h.dispose();
});

test("a foreman_bg command shows as a bg row and leaves when its process exits; a pid wait without a note shows its kind", () => {
  const clock = fakeClock();
  const dead = new Set<number>();
  const h = wiring(clock, dead);
  h.rt.start({ kind: "pid", pid: 4242, note: "" });
  clock.advance(1000);
  h.rt.start({ kind: "pid", pid: 4243, note: "npm test", log: "/tmp/x.log", bg: true });
  assert.deepEqual(shown(h.st), ["wait · pid · 1s", "bg · npm test · 0s"]);
  clock.advance(0); // the first polls run: both alive
  dead.add(4243);
  clock.advance(2000); // the bg process is gone: its row leaves
  assert.deepEqual(shown(h.st), ["wait · pid · 3s", ""]); // padded to the height reached
  h.dispose();
});

test("a PR watch row shows its until and leaves when the watch ends", () => {
  const clock = fakeClock();
  const h = wiring(clock, new Set());
  clock.advance(1000);
  assert.equal(h.pw.reserve(7), true);
  h.pw.start(7, "checks", baseline(), 30_000);
  assert.deepEqual(shown(h.st), ["pr #7 · checks · 0s"]);
  clock.advance(30_000); // the watch times out (before its first poll)
  assert.equal(h.st.rows, null);
  h.dispose();
});

test("background rows keep the widget visible without child runs; the height holds while a row leaves, then the widget hides", () => {
  const clock = fakeClock();
  const { st, ctx } = stubCtx();
  const dir = tmp();
  const w = new ChildWidget(path.join(dir, "u.jsonl"));
  let list: BackgroundRow[] = [
    { label: "bg", detail: "make", startedAt: clock.now() - 5000 },
    { label: "pr #3", detail: "any", startedAt: clock.now() },
  ];
  const opts: WidgetOpts = { enabled: true, agentDir: dir, intercomId: null, background: () => list };
  w.request(ctx, opts, clock.now());
  assert.equal(st.sets, 1);
  assert.deepEqual(shown(st), ["bg · make · 5s", "pr #3 · any · 0s"]);
  clock.advance(1000);
  list = [list[0]];
  w.request(ctx, opts, clock.now());
  assert.deepEqual(shown(st), ["bg · make · 6s", ""]); // padded to the height reached
  clock.advance(1000);
  list = [];
  w.request(ctx, opts, clock.now());
  assert.equal(st.rows, null);
  w.dispose();
});

test("more than 8 rows fold the overflow into one `+<n> more` row; exactly 8 rows stay unfolded", () => {
  const clock = fakeClock();
  const { st, ctx } = stubCtx();
  const dir = tmp();
  const w = new ChildWidget(path.join(dir, "u.jsonl"));
  const rows = (n: number): BackgroundRow[] => Array.from({ length: n }, (_, i) => ({ label: "bg", detail: `c${i}`, startedAt: clock.now() }));
  w.request(ctx, { enabled: true, agentDir: dir, intercomId: null, background: () => rows(10) }, clock.now());
  const out = shown(st);
  assert.equal(out.length, MAX_ROWS);
  assert.deepEqual(out.slice(0, 2), ["bg · c0 · 0s", "bg · c1 · 0s"]);
  assert.equal(out[MAX_ROWS - 1], "+3 more");
  clock.advance(1000);
  w.request(ctx, { enabled: true, agentDir: dir, intercomId: null, background: () => rows(8) }, clock.now());
  assert.equal(shown(st).length, MAX_ROWS);
  assert.equal(shown(st)[MAX_ROWS - 1], "bg · c7 · 0s");
  w.dispose();
});

test("widget.children off hides every row, background included; nothing is set while it stays off", () => {
  const clock = fakeClock();
  const h = wiring(clock, new Set());
  h.rt.start({ kind: "timer", seconds: 600, note: "held" });
  assert.equal(h.st.sets, 1);
  clock.advance(1000);
  h.w.request(h.ctx, { ...h.opts, enabled: false }, clock.now());
  assert.equal(h.st.sets, 2); // the shown widget is removed
  assert.equal(h.st.rows, null);
  h.w.request(h.ctx, { ...h.opts, enabled: false }, clock.now());
  assert.equal(h.st.sets, 2);
  h.dispose();
  const { st, ctx } = stubCtx();
  const off = new ChildWidget(path.join(tmp(), "u.jsonl"));
  off.request(ctx, { enabled: false, agentDir: tmp(), intercomId: null, background: () => [{ label: "bg", detail: "x", startedAt: clock.now() }] }, clock.now());
  assert.equal(st.sets, 0);
});
