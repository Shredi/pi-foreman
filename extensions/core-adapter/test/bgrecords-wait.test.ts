import { test } from "node:test";
import assert from "node:assert/strict";
import { WaitRuntime } from "../wait.ts";
import { createBgRecords } from "../bgrecords.ts";

const LIMITS = { batchWindowSeconds: 300, maxSeconds: 100, maxActive: 8, ci: true };

function rig(alive: () => boolean) {
  let now = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  const timers = {
    set: (fn: () => void, ms: number) => (due.set(++seq, { at: now + ms, fn }), seq),
    clear: (h: unknown) => void due.delete(h as number),
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const [id, t] = [...due.entries()].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined) break;
      due.delete(id);
      now = t!.at;
      t!.fn();
    }
    now = end;
  };
  const out: string[] = [];
  createBgRecords({ write: (d) => out.push(d), env: { HERDR_PANE_ID: "p" }, mode: () => "tui", isTTY: true });
  const rt = new WaitRuntime({
    timers, now: () => now, limits: () => LIMITS, stat: () => null, alive, gh: () => Promise.reject(new Error("unused")), wake: () => undefined, trace: () => undefined,
  });
  return { rt, advance, out };
}

// foreman_bg and its fb- records are gone: a pid wait ends (exit, cancel) without writing a sidebar record.
test("a pid wait writes no record when the process exits or the wait is cancelled", () => {
  let up = true;
  const r = rig(() => up);
  const s = r.rt.start({ kind: "pid", pid: 77, note: "other" }) as { id: string };
  up = false;
  r.advance(60_000);
  const t = r.rt.start({ kind: "pid", pid: 78, note: "other2" }) as { id: string };
  r.rt.cancel(t.id);
  assert.ok(s.id);
  assert.equal(r.out.length, 0);
});
