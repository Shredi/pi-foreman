// MCP_LAUNCH_NOTE names `mcp` as a top-level key of the subagent call, never inside `options`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_LAUNCH_NOTE, subagentDescription } from "../sizing.ts";

test("MCP_LAUNCH_NOTE: top-level placement, not options, none by default", () => {
  assert.match(MCP_LAUNCH_NOTE, /top-level key of this call, beside `agent` and `task`/);
  assert.match(MCP_LAUNCH_NOTE, /never inside `options` or `args`/);
  assert.match(MCP_LAUNCH_NOTE, /no `mcp` or `\[\]` means none/);
});

test("subagentDescription: sizing on appends the MCP sentence once", () => {
  const d = subagentDescription([{ name: "subagent", description: "Delegate." }], true);
  assert.ok(d?.includes(MCP_LAUNCH_NOTE));
  assert.equal(subagentDescription([{ name: "subagent", description: d! }], true), null);
});
