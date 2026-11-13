// The read question's cache key holds the deny sentences the question is asked with: a sentence added later misses the cache and the judge is asked again.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_read-clear-inproc.ts"; // first, as the other read-clear tests do
import { Classifier } from "../classifier.ts";
import type { ClassifierCtx } from "../classifier.ts";
import type { ReadCall } from "../readclear.ts";

const READ = JSON.stringify({ verdict: "read", check: { writes: "no", network: "no", runs: "no", secrets: "no", paths: "inside" }, reason: "plain read" });
const ESC = JSON.stringify({ verdict: "escalate", reason: "the new deny sentence covers it" });
const CALL: ReadCall = { tool: "bash", payload: "cat notes/a.txt", kind: "owner", role: "foreman", cwd: "/w", inside: ["/w"], notes: [] };
const config = { providers: { fake: { roles: { review: { model: "fake/m" } } } } };

function rig(replies: string[]) {
  let n = 0;
  const registry = {
    find: () => ({ id: "m" }),
    complete: async () => {
      const r = replies[Math.min(n++, replies.length - 1)];
      return { content: [{ type: "text", text: r }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  const ctx = (deny: { id: string; text: string; source: string }[]): ClassifierCtx => ({ prose: { allow: [], deny }, registry: registry as never, config, provider: "fake", timeoutMs: 200 });
  return { ctx, asked: () => n };
}

test("the same line twice with the same deny sentences asks the judge once", async () => {
  const k = new Classifier();
  const { ctx, asked } = rig([READ]);
  const deny = [{ id: "D1", text: "Never read secrets.", source: "user" }];
  const a = await k.readClear(CALL, ctx(deny));
  const b = await k.readClear(CALL, ctx(deny));
  assert.deepEqual([a.cleared, b.cleared, b.cleared && b.cached], [true, true, true]);
  assert.equal(asked(), 1);
});

test("a deny sentence added later asks the judge again, and an escalate then does not clear", async () => {
  const k = new Classifier();
  const { ctx, asked } = rig([READ, ESC]);
  const d1 = { id: "D1", text: "Never read secrets.", source: "user" };
  assert.equal((await k.readClear(CALL, ctx([d1]))).cleared, true);
  const r = await k.readClear(CALL, ctx([d1, { id: "D2", text: "Never read notes.", source: "project" }]));
  assert.equal(r.cleared, false);
  assert.equal(asked(), 2);
});
