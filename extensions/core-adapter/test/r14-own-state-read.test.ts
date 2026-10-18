// R14 P1 item 1: the foreman's own state reads (state/usage, its own live file and its own trace file) pass without the protected-config
// dialog in the two R13 literal lines: a binding-only `f=~/…/<own file>;` segment before a python3 argv read, and a leading `cd <worktree> &&`
// before a worktree scratch script (`.workflow/scratch/*.mjs|*.py`) given the own file. Another session's file, a child, a write into state/
// and a script outside `.workflow/scratch/` stay protected. Each case runs through the overlay (checkToolCall).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { ownUsageReadable } from "../roundsurface.ts";
import { traceFile } from "../trace.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const posix = process.platform !== "win32";
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r14-state-")));
after(async () => {
  await waitQuiet(path.join(w, "home", ".pi", "agent", "pi-foreman", "state"));
  rmTestTmp(w);
});
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const state = path.join(ag, "pi-foreman", "state");
const live = path.join(state, "live");
const SID = "01a1500b-own";
const OTHER = "01a1599c-other";
for (const d of [path.join(ws, ".workflow", "scratch"), path.join(ws, "tools"), path.join(state, "usage"), live]) fs.mkdirSync(d, { recursive: true });
for (const id of [SID, OTHER]) {
  fs.writeFileSync(path.join(live, `${id}.json`), "{}\n");
  fs.writeFileSync(path.join(state, `trace-${id}.jsonl`), "{}\n");
}
fs.writeFileSync(path.join(ws, ".workflow", "scratch", "dialogs.mjs"), "\n");
fs.writeFileSync(path.join(ws, ".workflow", "scratch", "dialogs.py"), "\n");
fs.writeFileSync(path.join(ws, "tools", "dialogs.mjs"), "\n");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ownReads = ownUsageReadable(ag, process.platform, SID, { dir: undefined, stateDir: state });
const main: MatchCtx = { cwd: ws, home, platform: process.platform, role: "main", ownReads };
const child: MatchCtx = { cwd: ws, home, platform: process.platform, role: "child" };
const sh = (command: string, ctx: MatchCtx = main): string => checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";

const liveLine = (id: string): string => `f=~/.pi/agent/pi-foreman/state/live/${id}.json; python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[\\"state\\"])" $f`;
const traceLine = (id: string, script = ".workflow/scratch/dialogs.mjs"): string => `cd ${inBash(ws)} && node --experimental-strip-types ${script} ~/.pi/agent/pi-foreman/state/trace-${id}.jsonl 2>&1 | head -80`;

test("own_state_read_trace_file_in_own_reads", () => {
  // the own trace file follows traceFile (trace.dir when set, else the state dir), never another session's
  assert.ok(ownReads.includes(traceFile(undefined, state, SID)));
  assert.ok(!ownReads.some((p) => p.includes(OTHER)));
  const moved = ownUsageReadable(ag, process.platform, SID, { dir: path.join(w, "traces"), stateDir: state });
  assert.ok(moved.includes(path.join(w, "traces", `trace-${SID}.jsonl`)));
  assert.ok(!moved.includes(traceFile(undefined, state, SID)));
  assert.deepEqual(ownUsageReadable(ag, process.platform, undefined, { dir: undefined, stateDir: state }).filter((p) => p.includes("trace-")), []);
});

test("own_state_read_live_binding_python_literal_passes", { skip: !posix }, () => {
  assert.equal(sh(liveLine(SID)), "pass");
});

test("own_state_read_cd_worktree_scratch_script_literal_passes", { skip: !posix }, () => {
  assert.equal(sh(traceLine(SID)), "pass");
  assert.equal(sh(`cd ${inBash(ws)} && node .workflow/scratch/dialogs.mjs ~/.pi/agent/pi-foreman/state/trace-${SID}.jsonl`), "pass");
  assert.equal(sh(`cd ${inBash(ws)} && python3 .workflow/scratch/dialogs.py ~/.pi/agent/pi-foreman/state/trace-${SID}.jsonl | head -5`), "pass");
  assert.equal(sh(`f=~/.pi/agent/pi-foreman/state/trace-${SID}.jsonl; node ${inBash(path.join(ws, ".workflow", "scratch", "dialogs.mjs"))} $f`), "pass");
});

test("own_state_read_other_session_lines_ask", { skip: !posix }, () => {
  assert.equal(sh(liveLine(OTHER)), "ask");
  assert.equal(sh(traceLine(OTHER)), "ask");
});

test("own_state_read_child_lines_denied", { skip: !posix }, () => {
  assert.equal(sh(liveLine(SID), child), "deny");
  assert.equal(sh(traceLine(SID), child), "deny");
  // a child keeps the deny also when handed the foreman's own-read set
  assert.equal(sh(traceLine(SID), { ...child, ownReads }), "deny");
});

test("own_state_read_writes_into_state_still_protected", { skip: !posix }, () => {
  const T = `~/.pi/agent/pi-foreman/state/trace-${SID}.jsonl`;
  for (const cmd of [
    `cd ${inBash(ws)} && node .workflow/scratch/dialogs.mjs ${T} > ~/.pi/agent/pi-foreman/state/x`,
    `cd ${inBash(ws)} && node .workflow/scratch/dialogs.mjs ${T} 2> ~/.pi/agent/pi-foreman/state/x`,
    `cd ${inBash(ws)} && node .workflow/scratch/dialogs.mjs ${T} 2>1`,
    `cd ${inBash(ws)} && node .workflow/scratch/dialogs.mjs ${T} >>&1`,
    `cd ${inBash(ws)} && node .workflow/scratch/dialogs.mjs ${T} | tee ~/.pi/agent/pi-foreman/state/x`,
    `cd ${inBash(ws)} && node .workflow/scratch/dialogs.mjs ${T}; touch ~/.pi/agent/pi-foreman/state/x`,
    `cd ${inBash(ws)} && node .workflow/scratch/dialogs.mjs ${T} ~/.pi/agent/pi-foreman/state/rounds.json`,
    `cd ${inBash(ws)} && node .workflow/scratch/dialogs.mjs ${T} ~/.pi/agent/pi-foreman/state/trace-${OTHER}.jsonl`,
    `cd ${inBash(ws)} && node -e "require('fs').writeFileSync('${inBash(path.join(state, "x"))}','x')" ${T}`,
    `f=~/.pi/agent/pi-foreman/state/live/${SID}.json; echo x > $f`,
  ]) assert.notEqual(sh(cmd), "pass", cmd);
});

test("own_state_read_script_outside_workflow_scratch_not_passed", { skip: !posix }, () => {
  for (const cmd of [
    traceLine(SID, "tools/dialogs.mjs"),
    traceLine(SID, ".workflow/scratch/missing.mjs"),
    traceLine(SID, ".workflow/scratch/../../tools/dialogs.mjs"),
    traceLine(SID, ".workflow/scratch/dialogs.py"),
    `cd ${inBash(path.join(ws, "tools"))} && node ../.workflow/scratch/dialogs.mjs ~/.pi/agent/pi-foreman/state/trace-${SID}.jsonl`,
    `cd ${inBash(w)} && node ws/.workflow/scratch/dialogs.mjs ~/.pi/agent/pi-foreman/state/trace-${SID}.jsonl`,
    `cd ${inBash(ws)} || node .workflow/scratch/dialogs.mjs ~/.pi/agent/pi-foreman/state/trace-${SID}.jsonl`,
  ]) assert.notEqual(sh(cmd), "pass", cmd);
});
