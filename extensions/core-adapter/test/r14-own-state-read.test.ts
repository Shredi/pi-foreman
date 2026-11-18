// R14 P1 item 1: the foreman's own state reads (state/usage, its own live file and its own trace file): the own-read set names the own
// trace file (traceFile) and never another session's.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { ownUsageReadable } from "../roundsurface.ts";
import { traceFile } from "../trace.ts";

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r14-state-")));
after(async () => {
  await waitQuiet(path.join(w, "home", ".pi", "agent", "pi-foreman", "state"));
  rmTestTmp(w);
});
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const state = path.join(ag, "pi-foreman", "state");
const live = path.join(state, "live");
const SID = "01a1500b-own";
const OTHER = "01a1599c-other";
for (const d of [path.join(state, "usage"), live]) fs.mkdirSync(d, { recursive: true });
for (const id of [SID, OTHER]) {
  fs.writeFileSync(path.join(live, `${id}.json`), "{}\n");
  fs.writeFileSync(path.join(state, `trace-${id}.jsonl`), "{}\n");
}

const ownReads = ownUsageReadable(ag, process.platform, SID, { dir: undefined, stateDir: state });

test("own_state_read_trace_file_in_own_reads", () => {
  // the own trace file follows traceFile (trace.dir when set, else the state dir), never another session's
  assert.ok(ownReads.includes(traceFile(undefined, state, SID)));
  assert.ok(!ownReads.some((p) => p.includes(OTHER)));
  const moved = ownUsageReadable(ag, process.platform, SID, { dir: path.join(w, "traces"), stateDir: state });
  assert.ok(moved.includes(path.join(w, "traces", `trace-${SID}.jsonl`)));
  assert.ok(!moved.includes(traceFile(undefined, state, SID)));
  assert.deepEqual(ownUsageReadable(ag, process.platform, undefined, { dir: undefined, stateDir: state }).filter((p) => p.includes("trace-")), []);
});
