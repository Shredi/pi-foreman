// r75 item 7: a codemode script's inner calls are decided by the gate like direct calls. Pi runs each one through its tool pipeline
// (dist/core/agent-session.js _executeNestedToolCall -> beforeToolCall -> extension `tool_call`, id `<callerId>/<n>`), so the adapter's one
// tool_call handler sees them: floors, defaults, review and ask. Item 6: the review cache never carries a verdict from one call to another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { GateCache, gateReview } from "../gatereview.ts";
import type { GateReviewDeps, GateReviewRequest } from "../gatereview.ts";
import { policyHash } from "../policy.ts";
import type { LoadedPolicy, PolicyEntry } from "../policy.ts";

const V = (verdict: string, entry: string): string => JSON.stringify({ verdict, entry, reason: `because ${entry}` });
const config = { providers: { fake: { review: { model: "m" }, roles: {} } } };

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
  /** A nested call: the id is `<callerId>/<n>`, as Pi gives it. */
  const inner = async (toolName: string, input: Record<string, unknown>, id: string): Promise<{ block?: boolean; reason?: string } | undefined> =>
    (await r.fire("tool_call", { toolName, toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  return { ...r, reg, inner };
}

test("inner bash and write of a codemode script that are floor denials when direct are denied inside codemode", async (t) => {
  const r = await rig(t, [V("allow", "ok-read")]);
  assert.equal((await r.call("bash", { command: "rm -rf /" }))?.block, true);
  assert.equal((await r.call("write", { path: "~/.ssh/id_rsa", content: "x" }))?.block, true);
  // the outer codemode call is no floor: a no-match decision asks (the rig's dialog says no)
  assert.match((await r.call("codemode", { code: "return 1" }))?.reason ?? "", /dialog was dismissed/);
  const before = r.reg.calls.length;
  const bash = await r.inner("bash", { command: "rm -rf /" }, "cm1/1");
  assert.equal(bash?.block, true);
  const write = await r.inner("write", { path: "~/.ssh/id_rsa", content: "x" }, "cm1/2");
  assert.equal(write?.block, true);
  assert.equal(r.reg.calls.length, before, "floors decide without a review call");
});

test("an inner call that the review denies is denied too, and an inner call reaches the review at all", async (t) => {
  const r = await rig(t, [V("deny", "unknown-network-host")]);
  const res = await r.inner("fetch", { url: "https://example.org/api", method: "POST", body: "x" }, "cm2/1");
  assert.equal(res?.block, true);
  assert.equal(r.reg.calls.length, 1);
  assert.match(r.reg.calls[0], /tool: fetch/);
});

// ------------------------------------------------------------------ item 6: the cache key

const E = (section: PolicyEntry["section"], id: string): PolicyEntry => ({ id, section, text: `${id} text`, source: "t.md" });
const entries = [E("allow", "ok-read"), E("deny", "no-secret"), E("ask", "ask-install")];
const policy: LoadedPolicy = { trusted: { entries }, project: null, hash: policyHash(entries), warnings: [] };
const json = (tool: string, payload: string): GateReviewRequest => ({ surface: "json", tool, role: "foreman", kind: "owner", cwd: "/w", worktree: "/w", owned: [], branch: "b", head: "h", mergeHead: null, remotes: [], ownerMessages: [], payload });
const deps = (replies: string[], cache: GateCache): GateReviewDeps => ({ policy, registry: fakeRegistry(replies).registry as never, config: { providers: { p: { review: { model: "m" } } } }, provider: "p", cache });

test("two different calls in a row never share a verdict: deny then allow, allow then deny", async () => {
  for (const [first, second] of [["deny", "allow"], ["allow", "deny"]] as const) {
    const cache = new GateCache();
    const entry = (v: string): string => (v === "deny" ? "no-secret" : "ok-read");
    const reg = fakeRegistry([V(first, entry(first)), V(second, entry(second))]);
    const d = { ...deps([], cache), registry: reg.registry as never };
    // the same masked JSON shape, different tools: foreman_session_open then intercom
    const a = await gateReview(json("foreman_session_open", '{"cmd":"x"}'), d);
    const b = await gateReview(json("intercom", '{"to":"y"}'), d);
    assert.equal(a.kind, first);
    assert.equal(b.kind, second);
    assert.equal((b as { cached: boolean }).cached, false);
    // the same tool, a different input of the same masked shape
    const c = await gateReview(json("codemode", '{"code":"await bash(1)"}'), { ...d, registry: fakeRegistry([V(first, entry(first)), V(second, entry(second))]).registry as never });
    const e = await gateReview(json("codemode", '{"code":"await sub(2)"}'), { ...d, registry: fakeRegistry([V(second, entry(second))]).registry as never });
    assert.equal(c.kind, first);
    assert.equal(e.kind, second);
    assert.equal((e as { cached: boolean }).cached, false);
    // the identical call still hits
    assert.equal((await gateReview(json("codemode", '{"code":"await sub(2)"}'), d) as { cached: boolean }).cached, true);
  }
});
