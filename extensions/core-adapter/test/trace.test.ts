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
    reason: "DESTRUCTIVE GUARD: ...",
    model: { id: "nested" },
    cost: Number.NaN,
  });
  assert.deepEqual(out, { event: "guard", guard: "destructive_guard", decision: "deny", latencyMs: 41 });
  assert.deepEqual([...TRACE_FIELDS], ["ts", "event", "role", "toolFamily", "guard", "decision", "latencyMs", "model", "tokensIn", "tokensOut", "cost", "exit", "tier", "precondition", "errorKind", "cause", "cacheRead", "cacheWrite", "requested", "wakeKinds"]);
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
