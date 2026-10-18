// R13 item 4 (hub 282): the foreman's own async run output log is readable with read-only verbs, the run recorded at launch.
// Cause of the R12 dialogs (`tail -c 2500 $TMPDIR/pi-subagents-uid-<uid>/async-subagent-runs/<run>/output-0.log`): the classifier never
// expanded `$TMPDIR` (the word stayed a variable, class unknown), and the run dir was recorded only from a completion notice or a
// details.asyncDir, not from the launch result text.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launchLocations } from "../budget.ts";
import { readBaseline } from "../permoverlay.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { asyncRunDirs } from "../roundsurface.ts";
import { bashRules } from "../timeoutallow.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = bashRules(readBaseline(pkgRoot)!, {});
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r13-async-")));
const savedTmp = process.env.TMPDIR;
process.env.TMPDIR = base;
after(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  fs.rmSync(base, { recursive: true, force: true });
});
const main = path.join(base, "repo");
const uidDir = path.join(base, "pi-subagents-uid-501");
const run = path.join(uidDir, "async-subagent-runs", "abc123");
fs.mkdirSync(path.join(main, ".git"), { recursive: true });
fs.mkdirSync(run, { recursive: true });
fs.writeFileSync(path.join(run, "output-0.log"), "x\n");
const reg: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
const session = (extra: Partial<ReviewSession>): ReviewSession => ({ isChild: false, cwd: main, provider: "a", config: () => ({}), registry: reg, intent: "", bashRules: () => rules, ...extra });
const ask = (r: ForemanReview, value: string) => r.authorize("s", { requestId: "r", surface: "bash", agentName: "foreman", value, toolName: "bash" });

const CHAIR = "tail -c 2500 $TMPDIR/pi-subagents-uid-501/async-subagent-runs/abc123/output-0.log";
const LAUNCH = "Async: builder [abc123]\n\nThe async run is detached and running in the background.";

/** The foreman session as index.ts builds it: read roots = recorded launch locations + asyncRunDirs of them. */
const afterLaunch = (text: string, details: unknown): ReviewSession => {
  const files = launchLocations(text, details, uidDir);
  return session({ readOnlyRoots: () => [...files, ...asyncRunDirs(files, "linux")] });
};

test("chair line, before: the run is not recorded, so the literal line is not allowed", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", session({ readOnlyRoots: () => [] }));
  assert.notEqual((await ask(r, CHAIR)).kind, "allow");
});

test("chair line, after: the run recorded from the launch result text (Async: <agent> [<id>]) is allowed", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", afterLaunch(LAUNCH, { runId: "abc123" }));
  assert.deepEqual(await ask(r, CHAIR), { kind: "allow" });
  assert.deepEqual(await ask(r, "cat $TMPDIR/pi-subagents-uid-501/async-subagent-runs/abc123/output-0.log"), { kind: "allow" });
});

test("chair line, after: the absolute spelling is allowed too, a write or another run is not", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", afterLaunch(LAUNCH, undefined));
  assert.deepEqual(await ask(r, `tail -c 2500 ${path.join(run, "output-0.log")}`), { kind: "allow" });
  assert.notEqual((await ask(r, "tail -c 2500 $TMPDIR/pi-subagents-uid-501/async-subagent-runs/other/output-0.log")).kind, "allow");
  assert.notEqual((await ask(r, "echo x > $TMPDIR/pi-subagents-uid-501/async-subagent-runs/abc123/output-0.log")).kind, "allow");
  assert.notEqual((await ask(r, "TMPDIR=/etc; tail -c 2500 $TMPDIR/pi-subagents-uid-501/async-subagent-runs/abc123/output-0.log")).kind, "allow");
});

test("launchLocations: details and the Async id; a Result path sentence is free text and adds nothing; a bad id adds nothing", () => {
  assert.deepEqual(launchLocations("Async: builder [r1]", { asyncDir: "/t/pi-subagents-uid-1/async-subagent-runs/r1" }, "/t/pi-subagents-uid-1"), ["/t/pi-subagents-uid-1/async-subagent-runs/r1", "/t/pi-subagents-uid-1/async-subagent-runs/r1"]);
  assert.deepEqual(launchLocations("run r1 ended. Result path: /t/x/r1. No bg_wait", undefined, null), []);
  assert.deepEqual(launchLocations("Async: builder [..]", undefined, "/t/u"), []);
  assert.deepEqual(launchLocations("Async: builder [a/b]", undefined, "/t/u"), []);
});

test("asyncRunDirs covers the run dir (so its output-*.log) of a recorded launch location", { skip: !posix }, () => {
  assert.ok(asyncRunDirs(launchLocations(LAUNCH, undefined, uidDir), "linux").includes(run));
});
