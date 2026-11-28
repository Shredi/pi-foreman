// A file wait resolves on a file that appears or changes after the wait started; a file already there that never changes does not wake it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WaitRuntime } from "../wait.ts";
import type { Outcome, Timers, WaitLimits } from "../wait.ts";

const LIMITS: WaitLimits = { batchWindowSeconds: 0, maxSeconds: 3600, maxActive: 8, ci: true };

/** Fake clock: one-shot timers fired by advance(). */
function fakeClock() {
  let now = 0;
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

interface Stamp {
  size: number;
  mtime: number;
  ctime: number;
  ino: number;
}

/** An in-memory file system: the runtime's stat, mtime and signature deps read it. */
function fakeFiles() {
  const files = new Map<string, Stamp>();
  const put = (p: string, s: Stamp): void => void files.set(p, s);
  const rm = (p: string): void => void files.delete(p);
  const deps = {
    stat: (p: string) => files.get(p)?.size ?? null,
    mtime: (p: string) => files.get(p)?.mtime ?? null,
    signature: (p: string) => {
      const s = files.get(p);
      return s ? `${s.size}:${s.mtime}:${s.ctime}:${s.ino}` : null;
    },
  };
  return { files, put, rm, deps };
}

function runtime(fsd: ReturnType<typeof fakeFiles>["deps"], signature = true) {
  const clock = fakeClock();
  const wakes: Outcome[][] = [];
  const rt = new WaitRuntime({
    timers: clock.timers,
    now: clock.now,
    limits: () => LIMITS,
    stat: fsd.stat,
    mtime: fsd.mtime,
    ...(signature ? { signature: fsd.signature } : {}),
    alive: () => true,
    gh: () => Promise.reject(new Error("unused")),
    wake: (o) => wakes.push(o),
    trace: () => {},
  });
  return { rt, clock, wakes };
}

const STAMP: Stamp = { size: 7, mtime: 100, ctime: 100, ino: 1 };

test("file wait: a file already there when the wait starts does not fire; it waits to the timeout", () => {
  const f = fakeFiles();
  f.put("/marker", STAMP);
  const { rt, clock, wakes } = runtime(f.deps);
  rt.start({ kind: "file", path: "/marker", note: "" });
  clock.advance(10_000);
  assert.equal(wakes.length, 0, "a stale marker does not wake the wait");
  assert.equal(rt.active, 1);
  clock.advance(3600_000);
  assert.deepEqual(wakes.map((w) => w.map((o) => o.outcome)), [["timeout"]]);
});

test("file wait: a file written after the wait started fires once it exists", () => {
  const f = fakeFiles();
  const { rt, clock, wakes } = runtime(f.deps);
  rt.start({ kind: "file", path: "/marker", note: "" });
  clock.advance(2000);
  assert.equal(wakes.length, 0);
  f.put("/marker", STAMP);
  clock.advance(2000);
  assert.deepEqual(wakes.map((w) => w.map((o) => o.outcome)), [["exists, 7 bytes"]]);
  clock.advance(3600_000);
  assert.equal(wakes.length, 1, "one outcome per wait");
});

test("file wait: a file deleted and re-created (new inode and ctime) fires", () => {
  const f = fakeFiles();
  f.put("/marker", STAMP);
  const { rt, clock, wakes } = runtime(f.deps);
  rt.start({ kind: "file", path: "/marker", note: "" });
  clock.advance(2000);
  f.rm("/marker");
  clock.advance(2000);
  assert.equal(wakes.length, 0, "deleting alone does not wake");
  f.put("/marker", { size: 7, mtime: 300, ctime: 300, ino: 9 });
  clock.advance(2000);
  assert.deepEqual(wakes.map((w) => w.map((o) => o.outcome)), [["exists, 7 bytes"]]);
});

test("file wait: deleted and re-created with an identical stat still fires, because a poll saw it absent", () => {
  const f = fakeFiles();
  f.put("/marker", STAMP);
  const { rt, clock, wakes } = runtime(f.deps);
  rt.start({ kind: "file", path: "/marker", note: "" });
  clock.advance(2000);
  f.rm("/marker");
  clock.advance(2000);
  f.put("/marker", { ...STAMP });
  clock.advance(2000);
  assert.deepEqual(wakes.map((w) => w.map((o) => o.outcome)), [["exists, 7 bytes"]]);
});

test("file wait: deleted in the same turn with no write does not fire", () => {
  const f = fakeFiles();
  f.put("/marker", STAMP);
  const { rt, clock, wakes } = runtime(f.deps);
  rt.start({ kind: "file", path: "/marker", note: "" });
  f.rm("/marker");
  clock.advance(10_000);
  assert.equal(wakes.length, 0, "an absent file is not a trigger");
  assert.equal(rt.active, 1);
  rt.dispose();
});

test("file wait: a same-mtime rewrite with a changed size fires", () => {
  const f = fakeFiles();
  f.put("/marker", STAMP);
  const { rt, clock, wakes } = runtime(f.deps);
  rt.start({ kind: "file", path: "/marker", note: "" });
  clock.advance(2000);
  f.put("/marker", { size: 9, mtime: 100, ctime: 100, ino: 1 });
  clock.advance(2000);
  assert.deepEqual(wakes.map((w) => w.map((o) => o.outcome)), [["exists, 9 bytes"]]);
});

test("file wait: same mtime and size with a changed inode (or ctime) fires", () => {
  for (const changed of [{ ino: 2 }, { ctime: 101 }]) {
    const f = fakeFiles();
    f.put("/marker", STAMP);
    const { rt, clock, wakes } = runtime(f.deps);
    rt.start({ kind: "file", path: "/marker", note: "" });
    clock.advance(2000);
    f.put("/marker", { ...STAMP, ...changed });
    clock.advance(2000);
    assert.deepEqual(wakes.map((w) => w.map((o) => o.outcome)), [["exists, 7 bytes"]], JSON.stringify(changed));
    rt.dispose();
  }
});

test("file wait without a signature dep: size and mtime decide (a real file, real stat)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-wait-baseline-"));
  try {
    const file = path.join(dir, "marker");
    fs.writeFileSync(file, "abc");
    const clock = fakeClock();
    const wakes: Outcome[][] = [];
    const rt = new WaitRuntime({
      timers: clock.timers,
      now: clock.now,
      limits: () => LIMITS,
      stat: (p) => (fs.existsSync(p) ? fs.statSync(p).size : null),
      mtime: (p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : null),
      alive: () => true,
      gh: () => Promise.reject(new Error("unused")),
      wake: (o) => wakes.push(o),
      trace: () => {},
    });
    rt.start({ kind: "file", path: file, note: "" });
    clock.advance(2000);
    assert.equal(wakes.length, 0, "the stale file does not wake the wait");
    fs.writeFileSync(file, "abcdef");
    clock.advance(2000);
    assert.deepEqual(wakes.map((w) => w.map((o) => o.outcome)), [["exists, 6 bytes"]]);
    rt.dispose();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
