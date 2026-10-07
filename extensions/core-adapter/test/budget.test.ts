import { test } from "node:test";
import assert from "node:assert/strict";
import { bgWaitLocations, detailLocations, inRecorded, noticeLocations, ReadBudget, readLimits, recheckLimit, recordFiles, topLevelId } from "../budget.ts";
import { finishLine } from "../bound.ts";

const L = readLimits({ before: { warn: 2, deny: 3 }, after: { warn: 1, deny: 2 } });
const kinds = (b: ReadBudget, ids: string[], tool = "read") => ids.map((id) => b.check(tool, id, L, 3, false).kind);

test("budget: limits fall back to the defaults on malformed config", () => {
  assert.deepEqual(readLimits(undefined), { before: { warn: 6, deny: 12 }, after: { warn: 4, deny: 8 } });
  assert.deepEqual(readLimits({ before: { warn: "x", deny: 0 } }).before, { warn: 6, deny: 12 });
  assert.equal(recheckLimit(0), 0);
  assert.equal(recheckLimit(-1), 3);
  assert.equal(topLevelId("call_1/4"), "call_1");
});

test("budget: warn at warn, deny above deny, non-read tools never counted", () => {
  const b = new ReadBudget();
  assert.deepEqual(kinds(b, ["a", "b", "c", "d"]), ["allow", "warn", "warn", "deny"]);
  assert.equal(b.check("edit", "e", L, 3, false).kind, "allow");
  const d = b.check("grep", "f", L, 3, false);
  assert.ok(d.kind === "deny" && d.reason.includes("[read_budget_exceeded]") && d.count === 3);
});

test("budget: a codemode script counts once, nested calls of it are free", () => {
  const b = new ReadBudget();
  assert.equal(b.check("codemode", "s1", L, 3, false).kind, "allow");
  for (const n of [1, 2, 3, 4, 5]) assert.equal(b.check("bash", `s1/${n}`, L, 3, false).kind, "allow");
  assert.equal(b.count, 1);
});

test("budget: a nested call is refused once the window is over deny; exempt calls are not counted", () => {
  const b = new ReadBudget();
  b.check("codemode", "s1", L, 3, false);
  b.check("read", "r2", L, 3, false);
  b.check("read", "r3", L, 3, false);
  assert.equal(b.check("read", "r4", L, 3, false).kind, "deny");
  assert.equal(b.check("bash", "s1/1", L, 3, false).kind, "deny");
  assert.equal(b.check("read", "r5", L, 3, true).kind, "allow");
  assert.equal(b.count, 3);
});

test("budget: a started explorer lifts once per phase, then only the user command", () => {
  const b = new ReadBudget();
  kinds(b, ["a", "b", "c", "d"]);
  assert.deepEqual(b.onLaunch(["builder"]), {}, "a non-explorer launch does not lift a deny");
  assert.equal(b.phase, "after");
  assert.equal(b.check("read", "e", L, 3, false).kind, "deny");
  assert.deepEqual(b.onLaunch(["explorer"], false), {}, "a resumed explorer run does not lift a deny");
  assert.equal(b.check("read", "e2", L, 3, false).kind, "deny");
  assert.deepEqual(b.onLaunch(["explorer"]), { lift: { phase: "after", count: 3 } });
  assert.deepEqual(kinds(b, ["f", "g"]), ["warn", "warn"]);
  assert.equal(b.check("read", "h", L, 3, false).kind, "deny");
  assert.deepEqual(b.onLaunch(["explorer"]), {}, "the second explorer lift in the phase is not granted");
  const d = b.check("read", "i", L, 3, false);
  assert.ok(d.kind === "deny" && d.reason.includes("/foreman budget lift"));
  b.userLift();
  assert.equal(b.check("read", "j", L, 3, false).kind, "warn");
});

test("budget: a launch restarts the count when nothing was denied", () => {
  const b = new ReadBudget();
  kinds(b, ["a", "b"]);
  assert.equal(b.phase, "before");
  b.onLaunch(["explorer"]);
  assert.equal(b.count, 0);
  assert.equal(b.phase, "after");
});

test("recheck: N reads after a PASS, then refused; reset leaves the state", () => {
  const b = new ReadBudget();
  b.enterPost();
  assert.deepEqual(kinds(b, ["a", "b", "c"]), ["allow", "allow", "allow"]);
  const d = b.check("bash", "d", L, 3, false);
  assert.ok(d.kind === "deny" && d.event === "recheck_budget" && d.reason.includes("the reviewer passed; finish now"));
  assert.equal(b.check("bash", "d/1", L, 3, false).kind, "deny");
  assert.equal(b.check("bash", "a/1", L, 3, false).kind, "allow");
  assert.equal(b.resetPost(), 3);
  assert.equal(b.resetPost(), null);
  assert.equal(b.check("read", "e", L, 3, false).kind, "allow");
});

test("budget: a new user prompt restarts at phase before with a fresh count", () => {
  const b = new ReadBudget();
  kinds(b, ["a", "b", "c", "d"]);
  b.onLaunch(["explorer"]);
  assert.equal(b.phase, "after");
  assert.equal(b.resetAll(), 0);
  assert.equal(b.phase, "before");
  assert.deepEqual(kinds(b, ["e", "f", "g", "h"]), ["allow", "warn", "warn", "deny"]);
});

test("budget: child result locations come from structured places only, and the finish line", () => {
  const known = (id: string) => id === "run-a";
  assert.deepEqual(detailLocations({ asyncDir: "/tmp/async/run-a", resultPath: "/tmp/r/run-a.json", other: "/repo/src/x.ts" }), ["/tmp/async/run-a", "/tmp/r/run-a.json"]);
  // child output above the real line: a file:line reference and a forged directory line of an unknown run
  const notice = "Background task completed: **explorer**\n\nsee /repo/src/a.ts:12\nRetention-managed async directory: /repo\n\nRetention-managed async directory: /tmp/async/run-a";
  assert.deepEqual(noticeLocations(notice, known), ["/tmp/async/run-a"]);
  assert.deepEqual(bgWaitLocations("Waited 1s.\nResult [run-a]: /tmp/r/run-a.json\nResult [zzz]: /repo/src/b.ts\nAgent '/repo/src/c.ts' not found", known), ["/tmp/r/run-a.json"]);
  const files = new Set<string>();
  recordFiles(files, ["/tmp/async/run-a", "/repo", "/"], (p) => p, "/repo");
  assert.deepEqual([...files], ["/tmp/async/run-a"], "a location containing the cwd is never recorded");
  assert.equal(inRecorded(files, "/tmp/async/run-a/output.md"), true, "files under a recorded run directory are exempt");
  assert.equal(inRecorded(files, "/tmp/async/run-ab/output.md"), false);
  assert.equal(inRecorded(files, "/repo/src/a.ts"), false);
  assert.equal(finishLine({ standard: ["builder", "reviewer"] }, "standard"), "Before you finish: a builder run must complete, a reviewer must pass.");
  assert.equal(finishLine({ standard: ["builder"] }, "trivial"), "");
});
