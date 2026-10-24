// Presence gate (presence.ts): fake probe, fake clock, fake timers; parsers; the hook path never probes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Presence, parseIoreg, probeIdleSeconds, type PresenceConfig } from "../presence.ts";

interface Slot {
  fn: () => void;
  at: number;
  dead: boolean;
}

function make(idle: number | null | (() => Promise<number | null>), cfg: Partial<PresenceConfig> = {}) {
  const clock = { t: 1_000_000 };
  const slots: Slot[] = [];
  const traces: Record<string, unknown>[] = [];
  let probes = 0;
  const p = new Presence({
    now: () => clock.t,
    timers: {
      set: (fn, ms) => {
        const s: Slot = { fn, at: clock.t + ms, dead: false };
        slots.push(s);
        return s;
      },
      clear: (h) => {
        if (h) (h as Slot).dead = true;
      },
    },
    config: () => ({ enabled: true, awayAfterMinutes: 11, command: null, ...cfg }),
    probe: async () => {
      probes += 1;
      return typeof idle === "function" ? idle() : idle;
    },
    trace: (r) => void traces.push(r),
  });
  return { p, clock, slots, traces, probes: () => probes };
}

test("present below awayAfterMinutes, away at or above it", async () => {
  const a = make(600);
  await a.p.refresh();
  assert.equal(a.p.sample()?.outcome, "present");
  assert.equal(a.p.away(), false);
  const b = make(660);
  await b.p.refresh();
  assert.equal(b.p.sample()?.outcome, "away");
  assert.equal(b.p.away(), true);
  assert.deepEqual(b.traces, [{ event: "presence", outcome: "away", idleSeconds: 660 }]);
});

test("unknown (probe failure) counts as present and is traced once", async () => {
  const h = make(null);
  await h.p.refresh();
  h.clock.t += 120_000;
  await h.p.refresh();
  assert.equal(h.p.sample()?.outcome, "unknown");
  assert.equal(h.p.away(), false);
  assert.equal(h.traces.filter((r) => r.outcome === "unknown").length, 1);
  assert.equal(h.probes(), 2);
});

test("a probe that throws is unknown", async () => {
  const h = make(async () => {
    throw new Error("boom");
  });
  await h.p.refresh();
  assert.equal(h.p.sample()?.outcome, "unknown");
});

test("at most one probe a minute; concurrent refreshes share one", async () => {
  const h = make(5);
  await Promise.all([h.p.refresh(), h.p.refresh()]);
  assert.equal(h.probes(), 1);
  h.clock.t += 59_000;
  await h.p.refresh();
  assert.equal(h.probes(), 1);
  h.clock.t += 2_000;
  await h.p.refresh();
  assert.equal(h.probes(), 2);
});

test("disabled: never probes, never away", async () => {
  const h = make(9999, { enabled: false });
  await h.p.refresh();
  h.p.armBefore(h.clock.t + 600_000);
  assert.equal(h.probes(), 0);
  assert.equal(h.slots.length, 0);
  assert.equal(h.p.away(), false);
});

test("armBefore probes 60 s before the due time on a timer, never synchronously; re-arming replaces the slot", async () => {
  const h = make(900);
  h.p.armBefore(h.clock.t + 300_000);
  assert.equal(h.probes(), 0, "arming does not probe");
  assert.equal(h.p.away(), false, "no sample yet reads as present");
  h.p.armBefore(h.clock.t + 600_000);
  const live = h.slots.filter((s) => !s.dead);
  assert.equal(live.length, 1);
  assert.equal(live[0].at - h.clock.t, 540_000);
  live[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.probes(), 1);
  assert.equal(h.p.away(), true);
});

test("parsers and platform dispatch", async () => {
  assert.equal(parseIoreg('    | |   "HIDIdleTime" = 12345678900\n'), 12.3456789);
  assert.equal(parseIoreg("nothing"), null);
  const calls: string[][] = [];
  const run = (out: string | null) => async (cmd: string, args: string[], ms: number, shell: boolean) => {
    calls.push([cmd, String(ms), String(shell)]);
    return out;
  };
  assert.equal(await probeIdleSeconds({ platform: "darwin", wsl: false, run: run('"HIDIdleTime" = 2000000000') }, null), 2);
  assert.equal(await probeIdleSeconds({ platform: "linux", wsl: false, run: run("90000\n") }, null), 90);
  assert.equal(await probeIdleSeconds({ platform: "linux", wsl: true, run: run("42.5\n") }, null), 42.5);
  assert.equal(await probeIdleSeconds({ platform: "win32", wsl: false, run: run("7") }, null), 7);
  assert.equal(await probeIdleSeconds({ platform: "linux", wsl: false, run: run("12 seconds") }, "my-idle-tool"), 12);
  assert.equal(await probeIdleSeconds({ platform: "freebsd", wsl: false, run: run("1") }, null), null);
  assert.equal(await probeIdleSeconds({ platform: "linux", wsl: false, run: run(null) }, null), null);
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [
    ["ioreg", "2000", "false"],
    ["xprintidle", "2000", "false"],
    ["powershell.exe", "5000", "false"],
    ["powershell", "5000", "false"],
    ["my-idle-tool", "2000", "true"],
    ["xprintidle", "2000", "false"],
  ]);
});
