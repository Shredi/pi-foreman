// R5 P2 S2 (ledger 11, R1 + k): the owned READ roots: the foreman's own subagent run dirs and the main checkout's .workflow for a round worktree.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asyncRunDirs, mainWorkflowReadable } from "../roundsurface.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-s2-link-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const rt = path.join(base, "repo.worktrees", "round");
const uidDir = path.join(base, "pi-subagents-uid-501");
const run = path.join(uidDir, "async-subagent-runs", "abc123");
const results = path.join(uidDir, "async-subagent-results");

test("asyncRunDirs: the run dir of a recorded file and that run's results file, nothing else", { skip: !posix }, () => {
  assert.deepEqual(asyncRunDirs([path.join(run, "status.json"), "/x/other/file"], "linux").sort(), [path.join(results, `${path.basename(run)}.json`), run].sort());
  assert.deepEqual(asyncRunDirs([path.join(results, "abc123.json")], "linux"), [path.join(results, "abc123.json")]);
  assert.deepEqual(asyncRunDirs(["/home/u/pi-subagents-notuid/async-subagent-runs/r/x"], "linux"), []);
});

test("mainWorkflowReadable: a round worktree names the main checkout's .workflow dir and its glob", { skip: !posix }, () => {
  assert.deepEqual(mainWorkflowReadable([rt], "linux").length, 2);
});
