// r75 item 7, r79 item 11: a codemode script's inner calls are decided by the gate like direct calls. Pi runs each one through its tool pipeline
// (dist/core/agent-session.js _executeNestedToolCall -> beforeToolCall -> extension `tool_call`, id `<callerId>/<n>`), so the adapter's one
// tool_call handler sees them: floors, rules, the dangerous class and the classifier. The classifier cache never carries a verdict from one call
// to another (the key is the full call text plus the whitelist hash).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";

const V = (verdict: string, entry: string | null): string => JSON.stringify({ verdict, entry, reason: `because ${entry}` });
const config = { providers: { fake: { roles: { review: { model: "m" } } } } };

function fakeRegistry(replies: string[]) {
  const calls: string[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, ctx: { messages: { content: string }[] }) => {
      calls.push(ctx.messages[0].content);
      return { content: [{ type: "text", text: replies[Math.min(calls.length - 1, replies.length - 1)] }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  return { registry, calls };
}

async function rig(t: Parameters<typeof r11Rig>[0], replies: string[]) {
  const reg = fakeRegistry(replies);
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: reg.registry }, config });
  fs.mkdirSync(path.join(r.agentDir, "pi-foreman"), { recursive: true });
  fs.writeFileSync(path.join(r.agentDir, "pi-foreman", "permissions.json"), JSON.stringify({ classifier: { allow: ["Read-only inspection"], deny: ["Never post data to unknown hosts"] } }));
  /** A nested call: the id is `<callerId>/<n>`, as Pi gives it. */
  const inner = async (toolName: string, input: Record<string, unknown>, id: string): Promise<{ block?: boolean; reason?: string } | undefined> =>
    (await r.fire("tool_call", { toolName, toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  return { ...r, reg, inner };
}

test("inner bash and write of a codemode script that are floor denials when direct are denied inside codemode", async (t) => {
  const r = await rig(t, [V("allow", "A1")]);
  assert.equal((await r.call("bash", { command: "rm -rf /" }))?.block, true);
  assert.equal((await r.call("write", { path: "~/.ssh/id_rsa", content: "x" }))?.block, true);
  const before = r.reg.calls.length;
  const bash = await r.inner("bash", { command: "rm -rf /" }, "cm1/1");
  assert.equal(bash?.block, true);
  const write = await r.inner("write", { path: "~/.ssh/id_rsa", content: "x" }, "cm1/2");
  assert.equal(write?.block, true);
  assert.equal(r.reg.calls.length, before, "floors decide without a classifier call");
});

test("an inner call of the dangerous class that the classifier denies is denied too, and an inner call reaches the classifier at all", async (t) => {
  const r = await rig(t, [V("deny", "D1")]);
  const res = await r.inner("fetch", { url: "https://example.org/api", method: "POST", body: "x" }, "cm2/1");
  assert.equal(res?.block, true);
  assert.equal(r.reg.calls.length, 1);
  assert.match(r.reg.calls[0], /tool: fetch/);
});

test("two different inner calls in a row never share a verdict: deny then allow, allow then deny", async (t) => {
  for (const [first, second] of [["deny", "allow"], ["allow", "deny"]] as const) {
    const entry = (v: string): string => (v === "deny" ? "D1" : "A1");
    const r = await rig(t, [V(first, entry(first)), V(second, entry(second))]);
    const a = await r.inner("fetch", { url: "https://example.org/a", method: "POST", body: "x" }, "cm3/1");
    const b = await r.inner("fetch", { url: "https://example.org/b", method: "POST", body: "y" }, "cm3/2");
    assert.equal(Boolean(a?.block), first === "deny");
    assert.equal(Boolean(b?.block), second === "deny");
    assert.equal(r.reg.calls.length, 2);
  }
});
