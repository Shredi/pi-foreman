import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveState, liveDir } from "../livestate.ts";
import { WaitRuntime, registerWait } from "../wait.ts";
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

/** A runtime with a fake clock and an mtime source that knows no file. */
function rig() {
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
    mtime: () => null,
  });
  return { rt, clock, wakes, changed };
}

const dir = "/w/.workflow/handoff";

// PR 4 (the child owns its plan): the remote plan-first wait on ruling.md and its supersede by a newer brief are gone. A file wait on a
// ruling name is a plain file wait: it ends when the file exists, never because a brief landed beside it.
test("a ruling-named file wait is a plain file wait: no file, no wake", () => {
  const r = rig();
  for (const name of ["ruling.md", "ruling-2.md"]) r.rt.start({ kind: "file", path: `${dir}/${name}`, note: "" });
  r.clock.advance(10_000);
  assert.equal(r.wakes.length, 0);
  assert.equal(r.rt.active, 2);
  r.rt.dispose();
});

test("regression: a resolved or cancelled wait fires changed once and the next presence file no longer lists it", async () => {
  delete process.env.PI_SUBAGENT_CHILD;
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "r61w-"));
  let tool!: { execute: (...a: unknown[]) => Promise<{ details: Record<string, unknown> }> };
  const pi = { on: () => undefined, registerTool: (t: never) => (tool = t), sendMessage: () => undefined };
  const session = { id: "s1", isChild: false, cwd: agentDir, agentDir, roots: null, config: () => ({}), trace: () => undefined };
  const waits = registerWait(pi as never, { session: async () => session as never, home: agentDir, platform: process.platform });
  const ctx = { mode: "rpc", cwd: agentDir, isIdle: () => true, sessionManager: { getSessionId: () => "s1" } };
  const live = LiveState.start({ agentDir, sessionId: "s1", cwd: agentDir, mode: "rpc", env: {} }, () => [], undefined, () => waits.active("s1"))!;
  const listed = () => JSON.parse(fs.readFileSync(path.join(liveDir(agentDir), "s1.json"), "utf8")).waits.map((w: { id: string }) => w.id);
  let fired = 0;
  // the wiring of index.ts: a wait change touches the live file
  const off = waits.onChange("s1", () => {
    fired++;
    live.touch();
    live.flush();
  });
  try {
    const a = String((await tool.execute("c1", { action: "start", kind: "timer", seconds: 5, note: "a" }, undefined, undefined, ctx)).details.id);
    const b = String((await tool.execute("c2", { action: "start", kind: "timer", seconds: 500, note: "b" }, undefined, undefined, ctx)).details.id);
    assert.equal(fired, 2);
    assert.deepEqual(listed(), [a, b]);
    mock.timers.tick(6000);
    assert.equal(fired, 3, "resolve fires onChange once");
    assert.deepEqual(listed(), [b], "the resolved wait is gone from the presence file");
    await tool.execute("c3", { action: "cancel", id: b }, undefined, undefined, ctx);
    assert.equal(fired, 4, "cancel fires onChange once");
    assert.deepEqual(listed(), []);
    // the composed fm_a3 without the wait is pinned in tests/test_herdr_sidebar.py (PushJsonTest)
  } finally {
    off();
    live.stop();
    waits.cancelAll("s1");
    mock.timers.reset();
  }
});
