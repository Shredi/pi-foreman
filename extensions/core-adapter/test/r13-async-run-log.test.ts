// R13 item 4 (hub 282): the run of a launch result text is recorded at launch, so its output log is an owned read root.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchLocations } from "../budget.ts";
import { asyncRunDirs } from "../roundsurface.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r13-async-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const uidDir = path.join(base, "pi-subagents-uid-501");
const run = path.join(uidDir, "async-subagent-runs", "abc123");
fs.mkdirSync(run, { recursive: true });
fs.writeFileSync(path.join(run, "output-0.log"), "x\n");

const LAUNCH = "Async: builder [abc123]\n\nThe async run is detached and running in the background.";

test("launchLocations: details and the Async id; a Result path sentence is free text and adds nothing; a bad id adds nothing", () => {
  assert.deepEqual(launchLocations("Async: builder [r1]", { asyncDir: "/t/pi-subagents-uid-1/async-subagent-runs/r1" }, "/t/pi-subagents-uid-1"), ["/t/pi-subagents-uid-1/async-subagent-runs/r1", "/t/pi-subagents-uid-1/async-subagent-runs/r1"]);
  assert.deepEqual(launchLocations("run r1 ended. Result path: /t/x/r1. No bg_wait", undefined, null), []);
  assert.deepEqual(launchLocations("Async: builder [..]", undefined, "/t/u"), []);
  assert.deepEqual(launchLocations("Async: builder [a/b]", undefined, "/t/u"), []);
});

test("asyncRunDirs covers the run dir (so its output-*.log) of a recorded launch location", { skip: !posix }, () => {
  assert.ok(asyncRunDirs(launchLocations(LAUNCH, undefined, uidDir), "linux").includes(run));
});
