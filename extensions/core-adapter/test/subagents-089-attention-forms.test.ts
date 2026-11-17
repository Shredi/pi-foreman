// pi-subagents 0.89 long-running guard: four command forms from the defect report must raise no attention signal.
// Drives the installed guard's exported functions in the order foreground/execution.js calls them per tool result:
// resolveCurrentPath + isMutatingTool at the call, then recordMutatingFailure / shouldEscalateMutatingFailures on an error result
// of a mutating call, resetMutatingFailureState otherwise.
// 0.89 decides failure from the tool-result message (`isError`); 0.78 matched words such as "failed" in the output text.
import { test } from "node:test";
import assert from "node:assert/strict";

const guardUrl = new URL("../../../node_modules/pi-subagents/src/runs/shared/long-running-guard.js", import.meta.url);
const guard = (await import(guardUrl.href)) as {
  resolveCurrentPath(tool: string, args: Record<string, unknown>): string | undefined;
  isMutatingTool(tool: string, args: Record<string, unknown>): boolean;
  didMutatingToolFail(message: unknown): boolean;
  createMutatingFailureState(): { consecutiveFailures: number; repeatedPathFailures: number };
  recordMutatingFailure(state: unknown, input: { tool: string; path?: string; error: string; ts: number }, windowMs: number): void;
  shouldEscalateMutatingFailures(state: unknown, threshold: number): boolean;
  resetMutatingFailureState(state: unknown): void;
};

const WINDOW = 5 * 60_000;
const THRESHOLD = 3;

/** Feeds results through the guard as the foreground runner does; returns whether attention was raised and the recorded paths. */
function drive(calls: { command: string; isError: boolean; output?: string }[]): { escalated: boolean; paths: (string | undefined)[]; failures: number } {
  const state = guard.createMutatingFailureState();
  const paths: (string | undefined)[] = [];
  let escalated = false;
  let ts = 1_000;
  for (const call of calls) {
    const args = { command: call.command };
    const path = guard.resolveCurrentPath("bash", args);
    paths.push(path);
    const message = { isError: call.isError, content: [{ type: "text", text: call.output ?? (call.isError ? "failed" : "") }] };
    if (guard.isMutatingTool("bash", args) && guard.didMutatingToolFail(message)) {
      guard.recordMutatingFailure(state, { tool: "bash", path, error: "failed", ts: (ts += 1000) }, WINDOW);
      if (guard.shouldEscalateMutatingFailures(state, THRESHOLD)) escalated = true;
    } else if (guard.isMutatingTool("bash", args)) guard.resetMutatingFailureState(state);
  }
  return { escalated, paths, failures: state.consecutiveFailures };
}

test("0.89 attention (a): a read-only check exiting 0 with PASS output, repeated, raises no repeated-failure attention", () => {
  const command = "npm test > log 2>&1; echo PASS";
  const output = "PASS src/a.test.ts\nTests: 12 passed, 0 failed, 0 errors";
  assert.equal(guard.isMutatingTool("bash", { command }), true, "the redirect to a file counts as a write");
  assert.equal(guard.didMutatingToolFail({ isError: false, content: [{ type: "text", text: output }] }), false);
  const out = drive(Array.from({ length: 5 }, () => ({ command, isError: false, output })));
  assert.equal(out.escalated, false);
  assert.equal(out.failures, 0);
  // A read-only check is no write at all.
  assert.equal(guard.isMutatingTool("bash", { command: "test -f package.json && echo PASS" }), false);
});

test("0.89 attention (b): `bash(=400)` text yields no written path =400", () => {
  for (const command of ["echo 'bash(=400)'", 'grep "bash(=400)" notes.md', "echo bash\\(=400\\)", "awk '$9>=400' f", 'grep "status>=400" f', "echo 'bash(>=400)'"]) {
    assert.equal(guard.resolveCurrentPath("bash", { command }), undefined, command);
    assert.equal(guard.isMutatingTool("bash", { command }), false, command);
  }
  // An unquoted `>=400` is a real shell redirect to a file named =400, so the guard reporting it is correct, not a defect.
  assert.equal(guard.resolveCurrentPath("bash", { command: "[ $code >=400 ]" }), "=400");
});

test("0.89 attention (c): `2>&1` yields no path &1", () => {
  for (const command of ["make check 2>&1", "make check 2>&1 | tail -5", "make check >&1", "make check &>/dev/null"]) {
    assert.notEqual(guard.resolveCurrentPath("bash", { command }), "&1", command);
  }
});

test("0.89 attention (d): read-only calls redirecting to /dev/null yield no failure and no path /dev/null", () => {
  for (const command of ["grep x f > /dev/null", "systemctl status x >/dev/null 2>&1", "grep -q x f 2>/dev/null"]) {
    assert.equal(guard.resolveCurrentPath("bash", { command }), undefined, command);
    assert.equal(guard.isMutatingTool("bash", { command }), false, command);
    const out = drive(Array.from({ length: 4 }, () => ({ command, isError: true })));
    assert.equal(out.escalated, false, command);
    assert.equal(out.failures, 0, command);
  }
});
