// Pressure surfaces (R5 P1c): the presence file field and the doctor and status lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveState, liveDir } from "../livestate.ts";
import { pressureDoctorLine, pressureStatusLine } from "../pressure.ts";
import type { PressureState } from "../pressure.ts";

const read = (d: string, id: string) => JSON.parse(fs.readFileSync(path.join(liveDir(d), `${id}.json`), "utf8"));
const start = (pressure: () => { level: string; reasons: string[] } | null) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ls-pr-"));
  const l = LiveState.start({ agentDir: d, sessionId: "p", cwd: "/w", mode: "rpc", env: {} }, () => [], undefined, undefined, pressure)!;
  return { d, l };
};

test("snapshot carries pressure only when the level is high or critical", () => {
  let cur: { level: string; reasons: string[] } | null = { level: "high", reasons: ["load", "mem"] };
  const { d, l } = start(() => cur);
  assert.deepEqual(read(d, "p").pressure, { level: "high", reasons: ["load", "mem"] });
  cur = { level: "ok", reasons: ["stale"] };
  assert.equal("pressure" in l.snapshot(), false);
  cur = null;
  assert.equal("pressure" in l.snapshot(), false);
  cur = { level: "critical", reasons: ["disk"] };
  assert.deepEqual(l.snapshot().pressure, { level: "critical", reasons: ["disk"] });
  l.stop();
});

test("a throwing pressure source leaves the snapshot without the field", () => {
  const { l } = start(() => {
    throw new Error("boom");
  });
  assert.equal("pressure" in l.snapshot(), false);
  l.stop();
});

const state = (over: Partial<PressureState>): PressureState => ({ level: "ok", reasons: [], at: "2026-01-01T12:00:00Z", host: {}, ...over });

test("doctor line: values, reasons and unknown fields", () => {
  assert.equal(
    pressureDoctorLine(state({ level: "high", reasons: ["load", "mem"], host: { loadPerCore: 1.8, load1PerCore: 3.25, freeMemMB: 512, freeDiskGB: 40.25 } })),
    "INFO pressure: high (load, mem) load5/core=1.80 load1/core=3.25 freeMem=512MB freeDisk=40.3GB",
  );
  assert.equal(pressureDoctorLine(state({ host: { loadPerCore: null, freeMemMB: 2048 } })), "INFO pressure: ok (none) load5/core=unknown load1/core=unknown freeMem=2048MB freeDisk=unknown");
});

test("status line: level, reasons and the age of the sample", () => {
  const now = Date.parse("2026-01-01T12:00:42Z");
  assert.equal(pressureStatusLine(state({ level: "critical", reasons: ["disk"] }), now), "pressure: critical (disk) sampled 42s ago");
  assert.equal(pressureStatusLine(state({}), now), "pressure: ok (none) sampled 42s ago");
});
