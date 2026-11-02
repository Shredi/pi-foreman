import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolUsageTracker, packageOf } from "../toolusage.ts";
import { aggregate, isCostLine, parseLines, usageLine } from "../usage.ts";
import type { ToolUsageLine } from "../usage.ts";
import { costReport } from "../costreport.ts";
import { addMessage, zeroTotals } from "../footer.ts";

const INIT = {
  declared: ["bash", "read", "example_tool"],
  hidden: ["example_hidden"],
  skillsListed: ["example-listed-skill"],
  skillsHidden: ["example-domain-skill"],
  skillFiles: { "example-domain-skill": "/skills/example-domain-skill/SKILL.md" },
  sources: { example_tool: "example-package", bash: "builtin" },
};
const CTX = { session: "s1", role: "foreman" };
const call = (name: string, args: unknown = {}) => ({ role: "assistant", content: [{ type: "text", text: "x" }, { type: "toolCall", id: "c", name, arguments: args }] });

test("first turn writes the line with the declared, hidden and listed sets", () => {
  const u = new ToolUsageTracker();
  assert.equal(u.take(CTX), null, "nothing before start");
  u.start(INIT);
  const line = u.take(CTX, new Date("2026-01-01T00:00:00Z"))!;
  assert.equal(line.kind, "tool-usage");
  assert.equal(line.session, "s1");
  assert.equal(line.role, "foreman");
  assert.deepEqual(line.declared, ["bash", "example_tool", "read"]);
  assert.deepEqual(line.hidden, ["example_hidden"]);
  assert.deepEqual(line.skillsListed, ["example-listed-skill"]);
  assert.deepEqual(line.skillsHidden, ["example-domain-skill"]);
  assert.deepEqual([line.used, line.found, line.skillsRead], [[], [], []]);
  assert.equal(line.sources.example_tool, "example-package");
  assert.equal(u.take(CTX), null, "unchanged: no second line");
});

test("a changed used, found or skillsRead rewrites the line; an unchanged turn does not", () => {
  const u = new ToolUsageTracker();
  u.start(INIT);
  u.take(CTX);
  u.noteMessage(call("example_tool"));
  assert.deepEqual(u.take(CTX)!.used, ["example_tool"]);
  u.noteMessage(call("example_tool"));
  assert.equal(u.take(CTX), null);
  u.noteFound("example_hidden");
  assert.deepEqual(u.take(CTX)!.found, ["example_hidden"]);
  u.noteMessage(call("read", { path: "/skills/example-domain-skill/SKILL.md" }));
  const l = u.take(CTX)!;
  assert.deepEqual(l.skillsRead, ["example-domain-skill"]);
  assert.deepEqual(l.used, ["example_tool", "read"]);
  u.noteMessage(call("read", { path: "/elsewhere/other.md" }));
  assert.equal(u.take(CTX), null, "a plain read changes nothing");
  u.noteMessage(call("read", { path: "/other/example-listed-skill/SKILL.md" }));
  assert.deepEqual(u.take(CTX)!.skillsRead, ["example-domain-skill", "example-listed-skill"]);
});

test("packageOf: npm source, node_modules path, scoped name, builtin, pi-foreman, unknown", () => {
  assert.equal(packageOf({ source: "npm:example-package@1.2.3", path: "/x/y.ts" }), "example-package");
  assert.equal(packageOf({ source: "npm:@scope/example@1", path: "/x" }), "@scope/example");
  assert.equal(packageOf({ source: "local", path: "/a/node_modules/example-package/src/index.ts" }), "example-package");
  assert.equal(packageOf({ path: "/a/node_modules/@scope/example/index.ts" }), "@scope/example");
  assert.equal(packageOf({ path: "builtin:read" }), "builtin");
  assert.equal(packageOf({ path: "/pkg/extensions/core-adapter/index.ts" }), "pi-foreman");
  assert.equal(packageOf({ path: "/somewhere/else.ts" }), "unknown");
  assert.equal(packageOf(undefined), "unknown");
});

const toolLine = (): ToolUsageLine => ({ ts: "2026-01-01T00:00:00.000Z", kind: "tool-usage", session: "s1", role: "builder", declared: ["bash"], hidden: [], used: ["bash"], found: [], skillsListed: [], skillsHidden: [], skillsRead: [], sources: {} });
const modelLine = () => usageLine({ workspace: "/w", foremanSession: "f1", role: "builder", launchId: "L1", kind: "first" }, { provider: "p", model: "m", usage: { input: 10, output: 5, cost: { total: 0.01 } } });

test("tool-usage lines parse but no cost reader counts them", () => {
  const text = [modelLine(), toolLine()].map((l) => JSON.stringify(l)).join("\n");
  const lines = parseLines(text);
  assert.equal(lines.length, 2);
  assert.equal(isCostLine(lines[1]), false);
  assert.equal(isCostLine(lines[0]), true);
  const sum = aggregate(lines);
  assert.equal(sum.total.calls, 1);
  assert.equal(sum.byRole.get("builder")!.calls, 1);
  assert.equal(sum.keepalive.calls, 0);
  assert.equal([...sum.byKind.values()].reduce((n, k) => n + k.calls, 0), 1);
  const rep = costReport(lines, null);
  assert.equal(rep.total.calls, 1);
  assert.equal(rep.byRole.length, 1);
  assert.equal(rep.keepalive.calls, 0);
  const t = zeroTotals();
  addMessage(t, { ...toolLine(), usage: { input: 99, output: 99 } });
  assert.equal(t.input, 0);
  assert.equal(t.output, 0);
});
