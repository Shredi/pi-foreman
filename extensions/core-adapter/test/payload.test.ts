import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { asciiJson, postToolPayload, preToolPayload, stopPayload, subagentTaskText } from "../payload.ts";

const cwd = path.resolve("/work/repo");
const home = path.resolve("/hd/u");
const pc = { sessionId: "sess-1", cwd, home, transcriptPath: "/s/x.jsonl" };

test("destructive guard payload carries command, cwd and session id", () => {
  const p = preToolPayload("bash", { command: "rm -rf build", timeout: 5 }, pc);
  assert.equal(p.session_id, "sess-1");
  assert.equal(p.cwd, cwd);
  assert.equal(p.hook_event_name, "PreToolUse");
  assert.equal(p.tool_name, "Bash");
  assert.deepEqual(p.tool_input, { command: "rm -rf build" });
  assert.equal(preToolPayload("powershell", { command: "dir" }, pc).tool_name, "Bash");
});

test("write gate payload has an absolute file_path resolved like Pi", () => {
  assert.deepEqual(preToolPayload("write", { path: ".workflow/LEDGER-x.md", content: "c" }, pc).tool_input, {
    file_path: path.join(cwd, ".workflow", "LEDGER-x.md"),
    content: "c",
  });
  const tilde = preToolPayload("write", { path: "~/a.txt", content: "" }, pc).tool_input as Record<string, unknown>;
  assert.equal(tilde.file_path, path.join(home, "a.txt"));
  const at = preToolPayload("write", { path: "@src/b.ts", content: "" }, pc).tool_input as Record<string, unknown>;
  assert.equal(at.file_path, path.join(cwd, "src", "b.ts"));
});

test("spawn gate payload: tool Agent, prompt = all task text, no subagent_type", () => {
  const single = preToolPayload("subagent", { agent: "explorer", task: "find X" }, pc);
  assert.equal(single.tool_name, "Agent");
  assert.deepEqual(single.tool_input, { prompt: "find X", description: "explorer" });
  const multi = { tasks: [{ agent: "builder", task: "A" }, { agent: "reviewer", task: "B" }], chain: [{ parallel: [{ agent: "explorer", task: "C" }] }] };
  assert.equal(subagentTaskText(multi), "A\n\nB\n\nC");
  assert.ok(!("subagent_type" in (preToolPayload("subagent", { agent: "fork", task: "t" }, pc).tool_input as object)));
});

test("bind payload is PostToolUse with file_path; stop payload carries stop_hook_active", () => {
  const b = postToolPayload("edit", { path: "x.md", edits: [{ oldText: "a", newText: "b" }] }, pc, false);
  assert.equal(b.hook_event_name, "PostToolUse");
  assert.equal(b.tool_name, "Edit");
  assert.equal((b.tool_input as Record<string, unknown>).file_path, path.join(cwd, "x.md"));
  const s = stopPayload(pc, true);
  assert.equal(s.hook_event_name, "Stop");
  assert.equal(s.stop_hook_active, true);
  assert.equal(s.session_id, "sess-1");
});

test("stdin JSON is pure ASCII and round-trips", () => {
  const v = { command: "rm -rf Ä/ü €" };
  const text = asciiJson(v);
  assert.match(text, /^[\x00-\x7f]*$/);
  assert.deepEqual(JSON.parse(text), v);
});
