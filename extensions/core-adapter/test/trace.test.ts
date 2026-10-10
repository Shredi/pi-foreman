import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openTrace, sanitizeTrace, TRACE_FIELDS } from "../trace.ts";

test("trace: non-allowlisted keys and non-primitive values are dropped", () => {
  const out = sanitizeTrace({
    event: "guard",
    guard: "destructive_guard",
    decision: "deny",
    latencyMs: 41,
    prompt: "secret prompt",
    command: "rm -rf x",
    path: "/some/where",
    output: "tool output",
    input: { command: "x" },
    permissionDecisionReason: "DESTRUCTIVE GUARD: ...",
    model: { id: "nested" },
    cost: Number.NaN,
  });
  assert.deepEqual(out, { event: "guard", guard: "destructive_guard", decision: "deny", latencyMs: 41 });
  assert.deepEqual([...TRACE_FIELDS], ["ts", "event", "role", "toolFamily", "guard", "decision", "latencyMs", "model", "tokensIn", "tokensOut", "cost", "exit", "tier", "precondition", "errorKind", "cause", "cacheRead", "cacheWrite", "requested", "wakeKinds", "pollBash", "from", "to", "files", "lines", "newFiles", "missing", "kind", "mode", "reason", "by", "phase", "count", "action", "runId", "outcome", "ms", "codemode", "after", "allowed", "items", "attested", "agent", "signals", "policy", "foreman", "turns", "rung", "cmd", "chars", "cut", "climb_available", "trimmed_lines", "skipped", "bytes", "segments", "class", "item", "hits", "policy_override", "note"]);
});

test("trace: ask and overlay events carry no command text", () => {
  for (const event of ["ask", "overlay"]) {
    const out = sanitizeTrace({ event, toolFamily: "bash", decision: "deny", command: "curl http://x/secret", title: "t", message: "m", permissionDecisionReason: "r", input: { command: "x" } });
    assert.deepEqual(out, { event, toolFamily: "bash", decision: "deny" });
  }
  // shell write refusals carry the write form only, never the command
  assert.deepEqual(sanitizeTrace({ event: "shell_write_refused", kind: "redirect", command: "echo x > src/a.go" }), { event: "shell_write_refused", kind: "redirect" });
  // edit-mode refusals and escalations carry slugs only
  assert.deepEqual(sanitizeTrace({ event: "foreman_edit_refused", mode: "scratchpad", kind: "edit", path: "src/a.go" }), { event: "foreman_edit_refused", mode: "scratchpad", kind: "edit" });
  assert.deepEqual(sanitizeTrace({ event: "triage_escalated", from: "trivial", to: "standard", reason: "edit_mode" }), { event: "triage_escalated", from: "trivial", to: "standard", reason: "edit_mode" });
  // the orientation event carries the packet line count only
  assert.deepEqual(sanitizeTrace({ event: "orientation", lines: 57, text: "packet" }), { event: "orientation", lines: 57 });
  // read budget events carry phase, count and action only
  assert.deepEqual(sanitizeTrace({ event: "read_budget", phase: "before", count: 6, action: "warn", command: "cat x" }), { event: "read_budget", phase: "before", count: 6, action: "warn" });
  // plan checkpoint events keep `by`, never plan or note text
  assert.deepEqual(sanitizeTrace({ event: "checkpoint", decision: "approve", by: "rig", tier: "heavy", note: "owner words", path: "p" }), { event: "checkpoint", decision: "approve", by: "rig", tier: "heavy" });
  assert.deepEqual(sanitizeTrace({ event: "friction", role: "builder", runId: "r1", kind: "prompt", note: "brief thin", path: "p" }), { event: "friction", role: "builder", runId: "r1", kind: "prompt", note: "brief thin" });
  assert.deepEqual(sanitizeTrace({ event: "plan_written", tier: "heavy", by: "planner", file: "plan-x.md" }), { event: "plan_written", tier: "heavy", by: "planner" });
});

test("trace: disabled writes nothing; enabled writes one sanitized JSONL line per event", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-trace-"));
  assert.equal(openTrace({ enabled: false, dir: null, stateDir: dir, sessionId: "s1" }), null);
  assert.equal(openTrace({ enabled: "true", dir: null, stateDir: dir, sessionId: "s1" }), null);
  const w = openTrace({ enabled: true, dir: null, stateDir: dir, sessionId: "s/1", now: () => new Date(0) })!;
  assert.equal(w.file, path.join(dir, "trace-s1.jsonl"));
  w.emit({ event: "tier", tier: "standard", ts: "forged", args: ["x"] });
  w.emit({ event: "role_launch", role: "explorer", task: "do the thing" });
  const lines = fs.readFileSync(w.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { ts: "1970-01-01T00:00:00.000Z", event: "tier", tier: "standard" },
    { ts: "1970-01-01T00:00:00.000Z", event: "role_launch", role: "explorer" },
  ]);
});
