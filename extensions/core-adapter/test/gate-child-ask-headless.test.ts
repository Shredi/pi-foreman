// r79 items 5, 11: the child's ask is denied at once with the no-pane text. A parent that cannot answer (no UI, not a session opened by another session) gives its children no ask dir, so a child's ask is denied at once
// (never after gate.askTimeoutMs) and the trace carries the reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { r11Rig } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

type T = Parameters<typeof r11Rig>[0];
const ROLES = ["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"];
const ASK = JSON.stringify({ verdict: "ask", entry: "package-install", reason: "because package-install" });
const ALLOW = JSON.stringify({ verdict: "allow", entry: "read-only-inspection", reason: "because" });
function registry(reply: string) {
  return { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
}
// a long askTimeoutMs: a wait on a ruling nobody writes would blow the 10 s bound
const config = { gate: { askTimeoutMs: 600000 }, presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } } };

test("headless parent: the launch binding has no askDir, and the child's ask is denied within 10 s with the reason in the log", async (t: T) => {
  const parent = await r11Rig(t, {}, { ctx: { hasUI: false, mode: "print", modelRegistry: registry(ALLOW) }, config });
  const input: Record<string, unknown> = { agent: "builder", task: "go" };
  const launched = await parent.launch(input);
  assert.equal(launched.res, undefined, "the parent's launch itself is allowed");
  const binding = (input.extensionBindings as Record<string, Record<string, unknown>>)[BINDING_NS];
  assert.equal(binding.askDir, undefined);

  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { ...binding } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  const child = await r11Rig(t, {}, { ctx: { modelRegistry: registry(ASK) }, config, child: true });
  const t0 = Date.now();
  const res = await child.call("bash", { command: "pip install requests" });
  assert.ok(Date.now() - t0 < 10000);
  assert.ok(res?.block);
  assert.match(String(res.reason), /nobody is at this session \(no pane\)/);
  const f = gateLogFile(child.agentDir);
  const recs = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const rec = recs.filter((x) => x.layer === "dialog").at(-1)!;
  assert.deepEqual([rec.verdict, rec.kind], ["deny", "child"]);
  assert.match(String(rec.reason), /no pane|no-parent|nobody/);
});
