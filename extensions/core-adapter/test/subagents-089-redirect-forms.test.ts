// D63+ (defect report pages 7 and 8): `2>&1` and `2>/dev/null` are shown as written files by the old guard. pi-subagents 0.89 reads no `&1` or
// `/dev/null` path from these commands; `| tee test.log` still reports `test.log` (and only that). Regression test over the installed guard.
import { test } from "node:test";
import assert from "node:assert/strict";

const guardUrl = new URL("../../../node_modules/pi-subagents/src/runs/shared/long-running-guard.js", import.meta.url);
const guard = (await import(guardUrl.href)) as {
  resolveCurrentPath(tool: string, args: Record<string, unknown>): string | undefined;
  isMutatingTool(tool: string, args: Record<string, unknown>): boolean;
};

const bash = (command: string): { path: string | undefined; mutating: boolean } => ({ path: guard.resolveCurrentPath("bash", { command }), mutating: guard.isMutatingTool("bash", { command }) });

test("0.89: stderr merges and /dev/null redirects name no written path and are not mutating", () => {
  for (const command of ["cargo test 2>&1; echo done", "cargo test 2>&1;", "grep -rn x . 2>/dev/null", "cargo test 2>&1 | tee"]) {
    assert.deepEqual(bash(command), { path: undefined, mutating: false }, command);
  }
});

test("0.89: `cargo test 2>&1 | tee test.log` names test.log and nothing else", () => {
  const out = bash("cargo test 2>&1 | tee test.log");
  assert.equal(out.path, "test.log");
  assert.equal(out.mutating, true);
  for (const bad of ["&1", "/dev/null"]) assert.notEqual(out.path, bad);
});
