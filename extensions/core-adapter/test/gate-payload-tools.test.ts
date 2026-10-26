// Payload tools (fetch, subagent, intercom, codemode, pr_create, foreman_session_open, unknown tools) go through the whole gate
// pipeline on their JSON payload: floors, review, dialog, log.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { r11Rig } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";
import { gateDecide } from "../gate.ts";
import { baseFloorEnv } from "../gate.ts";

type Reply = string | Error;
function fakeRegistry(replies: Reply[]) {
  const calls: { text: string }[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, ctx: { messages: { content: string }[] }) => {
      calls.push({ text: ctx.messages[0].content });
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (r instanceof Error) throw r;
      return { content: [{ type: "text", text: r }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  return { registry, calls };
}
const V = (verdict: string, entry: string): string => JSON.stringify({ verdict, entry, reason: `because ${entry}` });
const config = { providers: { fake: { review: { model: "m" }, roles: {} } } };

async function rig(t: Parameters<typeof r11Rig>[0], replies: Reply[]) {
  const reg = fakeRegistry(replies);
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: reg.registry }, config });
  const log = (): Record<string, unknown>[] => {
    const f = gateLogFile(r.agentDir);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  return { ...r, reg, log };
}

test("fetch POST reaches the review and writes a gate log record", async (t) => {
  const r = await rig(t, [V("deny", "unknown-network-host")]);
  const res = await r.call("fetch", { url: "https://example.org/api", method: "POST", body: "x" });
  assert.ok(res && res.block);
  assert.equal(r.reg.calls.length, 1);
  assert.match(r.reg.calls[0].text, /surface: json/);
  assert.match(r.reg.calls[0].text, /tool: fetch/);
  assert.match(r.reg.calls[0].text, /"method":"POST"/);
  const rec = r.log().at(-1)!;
  assert.deepEqual([rec.layer, rec.verdict, rec.tool], ["review", "deny", "fetch"]);
});

test("a subagent launch reaches the review and its record carries tool subagent", async (t) => {
  const r = await rig(t, [V("allow", "read-only-inspection")]);
  await r.call("subagent", { agent: "builder", task: "fix the thing" });
  assert.equal(r.reg.calls.length, 1);
  const rec = r.log().at(-1)!;
  assert.deepEqual([rec.layer, rec.verdict, rec.tool], ["review", "allow", "subagent"]);
});

test("pr_create goes through the review", async (t) => {
  const r = await rig(t, [V("allow", "read-only-inspection")]);
  await r.call("pr_create", { title: "t", body: "b" });
  assert.equal(r.reg.calls.length, 1);
  assert.equal(r.log().at(-1)!.tool, "pr_create");
});

test("a codemode payload with rm -rf / is a floor deny, no review call", async (t) => {
  const r = await rig(t, [V("allow", "read-only-inspection")]);
  const res = await r.call("codemode", { code: "await sh('rm -rf /')" });
  assert.ok(res && res.block);
  assert.equal(r.reg.calls.length, 0);
  assert.deepEqual([r.log().at(-1)!.layer, r.log().at(-1)!.verdict], ["floor", "deny"]);
});

test("an unknown tool gets surface json", async (t) => {
  const r = await rig(t, [V("allow", "read-only-inspection")]);
  await r.call("some_new_tool", { a: "b" });
  assert.match(r.reg.calls[0].text, /surface: json/);
});

// Prose fields are not floored on raw text: a builder brief legitimately says "never use sudo". Only structured fields are floored.
test("subagent and intercom prose is not floored on raw text; structured fields are", () => {
  const env = (cwd: string) => baseFloorEnv(cwd);
  const deps = { env };
  assert.equal(gateDecide("subagent", { agent: "builder", task: "never use sudo; do not run rm -rf /" }, process.cwd(), deps), undefined);
  assert.equal(gateDecide("intercom", { message: "sudo reboot is forbidden" }, process.cwd(), deps), undefined);
  const hit = gateDecide("subagent", { agent: "builder", task: "x", cwd: "/Users/someone/.ssh/id_rsa" }, process.cwd(), { env: (cwd) => baseFloorEnv(cwd, { home: "/Users/someone" }) });
  assert.ok(hit && "block" in hit);
  assert.ok((gateDecide("codemode", { code: "sudo ls" }, process.cwd(), deps) as { block?: true }).block);
});

// An unreachable review never hangs: no UI and no review model denies at once with the headless text.
test("a payload tool with no review model and no UI denies within 1 s", async (t) => {
  const r = await r11Rig(t, {}, { ctx: { hasUI: false, mode: "print" } });
  const t0 = Date.now();
  const res = await r.call("subagent", { agent: "builder", task: "fix the thing" });
  assert.ok(res && res.block);
  assert.ok(Date.now() - t0 < 1000);
});
