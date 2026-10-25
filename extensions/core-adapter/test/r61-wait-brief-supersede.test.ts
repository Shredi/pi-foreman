import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveState, liveDir } from "../livestate.ts";
import { WaitRuntime } from "../wait.ts";
import type { Outcome, Timers, WaitLimits } from "../wait.ts";

const LIMITS: WaitLimits = { batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true };

function fakeClock() {
  let now = 1_000_000;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set(fn, ms) {
      due.set(++next, { at: now + ms, fn });
      return next;
    },
    clear(h) {
      due.delete(h as number);
    },
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const [id, t] = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined) break;
      due.delete(id);
      now = t!.at;
      t!.fn();
    }
    now = end;
  };
  return { timers, advance, now: () => now };
}

/** A runtime with a fake clock; `briefs`/`mtime` are injected only when `brief` is given. */
function rig(brief?: { name: string; mtimeMs: number }, over: { mtime?: boolean } = {}) {
  const clock = fakeClock();
  const wakes: Outcome[][] = [];
  const changed = { n: 0 };
  const rt = new WaitRuntime({
    timers: clock.timers,
    now: clock.now,
    limits: () => LIMITS,
    stat: () => null,
    alive: () => true,
    gh: () => Promise.reject(new Error("unused")),
    wake: (o) => wakes.push(o),
    trace: () => {},
    changed: () => changed.n++,
    ...(brief ? { briefs: () => [brief, { name: "notes.md", mtimeMs: 9e15 }] } : {}),
    ...(brief && over.mtime !== false ? { mtime: () => null } : {}),
  });
  return { rt, clock, wakes, changed };
}

const dir = "/w/.workflow/handoff";

test("a ruling-named file wait resolves 'superseded by brief' when a newer brief lands beside it, and the wake carries it", () => {
  const r = rig({ name: "brief-fix.md", mtimeMs: 1_000_001 });
  r.rt.start({ kind: "file", path: `${dir}/ruling.md`, note: "ruling" });
  r.clock.advance(2000);
  assert.equal(r.wakes.length, 1);
  assert.deepEqual(r.wakes[0].map((o) => [o.kind, o.outcome]), [["file", `superseded by brief ${path.join(dir, "brief-fix.md")}`]]);
  assert.equal(r.rt.active, 0);
  r.rt.dispose();
});

test("ruling-<n>.md is a ruling name too", () => {
  const r = rig({ name: "brief-x.md", mtimeMs: 1_500_000 });
  r.rt.start({ kind: "file", path: `${dir}/ruling-2.md`, note: "" });
  r.clock.advance(2000);
  assert.match(r.wakes[0][0].outcome, /^superseded by brief .*brief-x\.md$/);
  r.rt.dispose();
});

test("a brief older than the wait does not supersede it", () => {
  const r = rig({ name: "brief-fix.md", mtimeMs: 999_999 });
  r.rt.start({ kind: "file", path: `${dir}/ruling.md`, note: "" });
  r.clock.advance(10_000);
  assert.equal(r.wakes.length, 0);
  assert.equal(r.rt.active, 1);
  r.rt.dispose();
});

test("a non-ruling file wait is not superseded by a newer brief", () => {
  const r = rig({ name: "brief-fix.md", mtimeMs: 2_000_000 });
  r.rt.start({ kind: "file", path: `${dir}/done.flag`, note: "" });
  r.clock.advance(10_000);
  assert.equal(r.wakes.length, 0);
  r.rt.dispose();
});

test("without briefs, or without mtime, nothing supersedes", () => {
  const none = rig();
  none.rt.start({ kind: "file", path: `${dir}/ruling.md`, note: "" });
  none.clock.advance(10_000);
  assert.equal(none.wakes.length, 0);
  none.rt.dispose();
  const noMtime = rig({ name: "brief-fix.md", mtimeMs: 2_000_000 }, { mtime: false });
  noMtime.rt.start({ kind: "file", path: `${dir}/ruling.md`, note: "" });
  noMtime.clock.advance(10_000);
  assert.equal(noMtime.wakes.length, 0);
  noMtime.rt.dispose();
});

test("regression: a resolved or cancelled wait fires changed once and the next presence file no longer lists it", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "r61w-"));
  const clock = fakeClock();
  let rt!: WaitRuntime;
  let live!: LiveState;
  const listed = () => JSON.parse(fs.readFileSync(path.join(liveDir(agentDir), "s1.json"), "utf8")).waits.map((w: { id: string }) => w.id);
  const changed = { n: 0 };
  rt = new WaitRuntime({
    timers: clock.timers,
    now: clock.now,
    limits: () => LIMITS,
    stat: () => null,
    alive: () => true,
    gh: () => Promise.reject(new Error("unused")),
    wake: () => {},
    trace: () => {},
    // what index.ts registers through waits.onChange
    changed: () => {
      changed.n++;
      live.touch();
      live.flush();
    },
  });
  live = LiveState.start({ agentDir, sessionId: "s1", cwd: "/w", mode: "rpc", env: {} }, () => [], undefined, () => rt.list())!;
  const a = rt.start({ kind: "timer", seconds: 5, note: "a" }) as { id: string };
  const b = rt.start({ kind: "timer", seconds: 500, note: "b" }) as { id: string };
  assert.equal(changed.n, 2);
  assert.deepEqual(listed(), [a.id, b.id]);
  clock.advance(5000);
  assert.equal(changed.n, 3, "resolve fires changed once");
  assert.deepEqual(listed(), [b.id], "the resolved wait is gone from the presence file");
  rt.cancel(b.id);
  assert.equal(changed.n, 4, "cancel fires changed once");
  assert.deepEqual(listed(), []);
  live.stop();
  rt.dispose();
});
