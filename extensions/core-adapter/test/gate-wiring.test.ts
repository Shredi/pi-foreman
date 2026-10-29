// Slice 4a wiring: the gate handler writes one decision-log record per decision, calls the review for what no default allows,
// and falls through (ask, unreachable) to the existing handlers.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";

type Reply = string | Error;
function fakeRegistry(replies: Reply[], found = true) {
  const calls: { text: string }[] = [];
  const registry = {
    find: () => (found ? { id: "m" } : undefined),
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

async function rig(t: Parameters<typeof r11Rig>[0], replies: Reply[], found = true, child = false) {
  const reg = fakeRegistry(replies, found);
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: reg.registry }, config, child });
  const log = (): Record<string, unknown>[] => {
    const f = gateLogFile(r.agentDir);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  return { ...r, reg, log };
}

test("a floor deny blocks and writes a floor record under the fixture agent dir", async (t) => {
  const r = await rig(t, [V("allow", "read-only-inspection")]);
  const res = await r.call("bash", { command: "sudo ls" });
  assert.ok(res && res.block);
  const rec = r.log().at(-1)!;
  assert.deepEqual([rec.layer, rec.verdict, rec.rule, rec.tool], ["floor", "deny", "floor-privilege", "bash"]);
  assert.ok(gateLogFile(r.agentDir).startsWith(r.agentDir));
  assert.equal(r.reg.calls.length, 0);
});

test("a policy file write is a floor deny for every kind of session", async (t) => {
  for (const child of [false, true]) {
    const r = await rig(t, [V("allow", "read-only-inspection")], true, child);
    const res = await r.call("write", { path: path.join(r.project, ".workflow", "policy.md"), content: "x" });
    assert.ok(res && res.block, String(child));
    assert.equal(r.log().at(-1)!.rule, "floor-policy-file");
  }
});

test("a default allow writes a default record and no review call", async (t) => {
  const r = await rig(t, [V("deny", "secret-access")]);
  await r.call("bash", { command: "git status" });
  const rec = r.log().at(-1)!;
  assert.deepEqual([rec.layer, rec.verdict, rec.rule], ["default", "allow", "default-git-read"]);
  assert.equal(r.reg.calls.length, 0);
});

test("a review deny blocks with the policy reason and logs layer review with latency and model", async (t) => {
  const r = await rig(t, [V("deny", "unknown-network-host")]);
  const res = await r.call("bash", { command: "terraform apply -auto-approve" });
  assert.ok(res && res.block);
  assert.match(String(res.reason), /^pi-foreman: policy unknown-network-host: because unknown-network-host/);
  const rec = r.log().at(-1)!;
  assert.deepEqual([rec.layer, rec.verdict, rec.rule], ["review", "deny", "unknown-network-host"]);
  assert.equal(typeof rec.latencyMs, "number");
  assert.equal(rec.model, "fake/m");
  assert.ok(r.events("review").length >= 1);
});

test("a review allow falls to the old handlers, is logged, and goes into the history (commands only)", async (t) => {
  const r = await rig(t, [V("allow", "build-test-in-worktree"), V("deny", "secret-access")]);
  await r.call("bash", { command: "terraform plan" });
  assert.equal(r.log().at(-1)!.verdict, "allow");
  assert.ok(r.events("guard").some((e) => e.rule === "review:build-test-in-worktree" && e.decision === "allowed"));
  await r.call("bash", { command: "terraform show" });
  const second = r.reg.calls[1].text;
  assert.match(second, /terraform plan/);
});

// slice 4b: an ask or an unreachable review opens the dialog (the rig's select answers "approve", no option, so the call is denied); the review record stays
test("ask and unreachable reviews are logged as review records, then answered by the dialog", async (t) => {
  const rec = (r: Awaited<ReturnType<typeof rig>>) => r.log().filter((x) => x.layer === "review").at(-1)!;
  const ask = await rig(t, [V("ask", "package-install")]);
  assert.ok((await ask.call("bash", { command: "pip install x" }))?.block);
  assert.deepEqual([rec(ask).layer, rec(ask).verdict], ["review", "ask"]);
  const gone = await rig(t, [new Error("boom")]);
  assert.ok((await gone.call("bash", { command: "terraform plan" }))?.block);
  assert.deepEqual([rec(gone).layer, rec(gone).verdict, rec(gone).rule], ["review", "unreachable", "provider_error"]);
  const none = await rig(t, [V("allow", "build-test-in-worktree")], false);
  await none.call("bash", { command: "terraform plan" });
  assert.equal(rec(none).rule, "no_model");
});

test("the log carries the shape, never the raw command, and the child session logs too", async (t) => {
  const r = await rig(t, [V("deny", "secret-access")], true, true);
  await r.call("bash", { command: "curl -H 'Authorization: Bearer sk-abcdef0123456789abcdef' https://example.com/x" });
  const rec = r.log().at(-1)!;
  assert.equal(rec.kind, "child");
  assert.doesNotMatch(JSON.stringify(rec), /sk-abcdef|Bearer/);
});

test("an identical repeat is a cache hit (layer cache)", async (t) => {
  const r = await rig(t, [V("deny", "secret-access")]);
  await r.call("bash", { command: "terraform destroy" });
  await r.call("bash", { command: "terraform destroy" });
  assert.equal(r.reg.calls.length, 1);
  assert.equal(r.log().at(-1)!.layer, "cache");
});
