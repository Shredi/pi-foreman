import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRun, parseHookStdout, translateStop, translateToolCall } from "../translate.ts";
import type { AskEnv } from "../translate.ts";
import { runGuard } from "../runguard.ts";
import type { GuardRun } from "../runguard.ts";
import type { Spawner } from "../spawn.ts";

const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "DESTRUCTIVE GUARD: no" } });
const ask = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "DESTRUCTIVE GUARD: sure?" } });
const ran = (stdout: string, code = 0): GuardRun => ({ status: "ran", code, stdout, stderr: "" });
const tui: AskEnv = { isChild: false, mode: "tui", hasUI: true };

test("deny -> block with the core reason", async () => {
  const t = await translateToolCall({ guard: "destructive_guard", outcome: evaluateRun("destructive_guard", ran(deny), "py"), piTool: "bash", input: { command: "x" }, ask: tui });
  assert.deepEqual(t.result, { block: true, reason: "DESTRUCTIVE GUARD: no" });
});

test("updatedInput mutates event.input in place for bash, not for powershell", async () => {
  const upd = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "PREFIX; rm a" } } });
  const input = { command: "rm a", timeout: 3 };
  const t = await translateToolCall({ guard: "destructive_guard", outcome: evaluateRun("destructive_guard", ran(upd), "py"), piTool: "bash", input, ask: tui });
  assert.equal(t.result, undefined);
  assert.deepEqual(input, { command: "PREFIX; rm a", timeout: 3 });
  const ps = { command: "rm a" };
  await translateToolCall({ guard: "destructive_guard", outcome: evaluateRun("destructive_guard", ran(upd), "py"), piTool: "powershell", input: ps, ask: tui });
  assert.equal(ps.command, "rm a");
});

test("ask: TUI and RPC confirm; print/JSON block; detached child blocks with 'ask the foreman'", async () => {
  const outcome = evaluateRun("destructive_guard", ran(ask), "py");
  const titles: string[] = [];
  for (const mode of ["tui", "rpc"]) {
    const yes = await translateToolCall({ guard: "destructive_guard", outcome, piTool: "bash", input: { command: "x" }, ask: { isChild: false, mode, hasUI: true, confirm: async (t) => (titles.push(t), true) } });
    assert.equal(yes.result, undefined);
    const no = await translateToolCall({ guard: "destructive_guard", outcome, piTool: "bash", input: { command: "x" }, ask: { isChild: false, mode, hasUI: true, confirm: async () => false } });
    assert.match(no.result!.reason, /Denied by the user/);
  }
  assert.equal(titles.length, 2);
  for (const mode of ["print", "json"]) {
    const t = await translateToolCall({ guard: "destructive_guard", outcome, piTool: "bash", input: { command: "x" }, ask: { isChild: false, mode, hasUI: false } });
    assert.match(t.result!.reason, /needs approval, no UI/);
  }
  const child = await translateToolCall({ guard: "destructive_guard", outcome, piTool: "bash", input: { command: "x" }, ask: { isChild: true, mode: "json", hasUI: false, confirm: async () => true } });
  assert.match(child.result!.reason, /ask the foreman/);
});

test("allow / empty output -> no result", async () => {
  const t = await translateToolCall({ guard: "destructive_guard", outcome: evaluateRun("destructive_guard", ran(""), "py"), piTool: "bash", input: { command: "ls" }, ask: tui });
  assert.deepEqual(t, {});
});

test("destructive guard fails closed: missing python, timeout, crash, garbage", async () => {
  const cases: GuardRun[] = [
    { status: "failed", failure: "no-python", detail: "" },
    { status: "failed", failure: "timeout", detail: "no answer within 5 s" },
    { status: "failed", failure: "spawn", detail: "ENOENT" },
    ran("", 1),
    ran("Traceback (most recent call last)", 0),
  ];
  for (const run of cases) {
    const t = await translateToolCall({ guard: "destructive_guard", outcome: evaluateRun("destructive_guard", run, "py"), piTool: "bash", input: { command: "ls" }, ask: tui });
    assert.equal(t.result?.block, true, JSON.stringify(run));
    assert.match(t.result!.reason, /pi-foreman: destructive guard could not run/);
  }
  const noPy = await translateToolCall({ guard: "destructive_guard", outcome: evaluateRun("destructive_guard", cases[0], null), piTool: "bash", input: {}, ask: tui });
  assert.match(noPy.result!.reason, /no Python ≥ 3\.9 found\). Install Python 3\.9\+ or set python\.path \/ PI_FOREMAN_PYTHON; run \/foreman doctor\./);
});

test("runGuard maps a 5 s timeout and a spawn error to failures", async () => {
  const slow: Spawner = async (_c, _a, o) => ({ code: null, stdout: "", stderr: "", timedOut: o.timeoutMs === 5000 });
  const r1 = await runGuard({ python: "py", coreDir: "/c", guard: "destructive_guard", payload: {}, env: {}, cwd: "/", spawner: slow });
  assert.deepEqual(r1.status === "failed" && r1.failure, "timeout");
  const r2 = await runGuard({ python: null, coreDir: "/c", guard: "destructive_guard", payload: {}, env: {}, cwd: "/", spawner: slow });
  assert.deepEqual(r2.status === "failed" && r2.failure, "no-python");
});

test("ledger gate policies: write closed only for ledger targets, bind/stop open, spawn closed", async () => {
  const fail = evaluateRun("ledger_guard_write", { status: "failed", failure: "no-python", detail: "" }, null);
  const other = await translateToolCall({ guard: "ledger_guard_write", outcome: fail, piTool: "write", input: {}, ask: tui, ledgerTarget: false });
  assert.equal(other.result, undefined);
  assert.ok(other.openFailure);
  const ledger = await translateToolCall({ guard: "ledger_guard_write", outcome: fail, piTool: "write", input: {}, ask: tui, ledgerTarget: true });
  assert.equal(ledger.result?.block, true);
  const spawn = await translateToolCall({ guard: "ledger_guard_spawn", outcome: evaluateRun("ledger_guard_spawn", ran("", 2), "py"), piTool: "subagent", input: {}, ask: tui });
  assert.equal(spawn.result?.block, true);
  const stop = translateStop(evaluateRun("ledger_guard_stop", ran("", 1), "py"));
  assert.equal(stop.hold, false);
  assert.ok(stop.openFailure);
});

test("stop gate block -> hold with reason", () => {
  const r = translateStop(evaluateRun("ledger_guard_stop", ran(JSON.stringify({ decision: "block", reason: "LEDGER GUARD: 2 open" })), "py"));
  assert.deepEqual(r, { hold: true, reason: "LEDGER GUARD: 2 open" });
  assert.deepEqual(parseHookStdout("not json"), { ok: false });
});
