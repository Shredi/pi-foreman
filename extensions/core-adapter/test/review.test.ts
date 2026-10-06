import { test } from "node:test";
import assert from "node:assert/strict";
import { ForemanReview, parseVerdict, REVIEW_LINK, reviewTarget } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";

const config = { providers: { a: { review: { model: "a/small", timeoutMs: 50 } }, b: { roles: {} }, c: { review: { model: "tiny" } } } };

test("reviewTarget reads providers.<active>.review; none means review off", () => {
  assert.deepEqual(reviewTarget(config, "a"), { provider: "a", modelId: "small", timeoutMs: 50 });
  assert.deepEqual(reviewTarget(config, "c"), { provider: "c", modelId: "tiny", timeoutMs: 15000 });
  assert.equal(reviewTarget(config, "b"), null);
  assert.equal(reviewTarget(config, undefined), null);
});

test("parseVerdict: allow, hard deny final, everything else defers", () => {
  const kind = (t: string) => [parseVerdict(t).verdict.kind, parseVerdict(t).label];
  assert.deepEqual(kind('{"verdict":"allow"}'), ["allow", "allow"]);
  assert.deepEqual(kind('{"verdict":"deny","reason":"x","riskLevel":"critical"}'), ["deny", "deny"]);
  assert.deepEqual(kind('{"verdict":"deny","reason":"x"}'), ["deny", "deny"]);
  assert.deepEqual(kind('{"verdict":"deny","riskLevel":"medium"}'), ["defer", "soft-deny"]);
  assert.deepEqual(kind('```json\n{"verdict":"defer","lean":"allow"}\n```'), ["defer", "defer"]);
  assert.deepEqual(kind("looks fine"), ["defer", "garbage"]);
  assert.deepEqual(kind('{"verdict":"maybe"}'), ["defer", "garbage"]);
  assert.deepEqual(kind("  "), ["defer", "empty"]);
});

function session(registry: RegistryLike, over: Partial<ReviewSession> = {}): ReviewSession {
  return { isChild: false, cwd: "/w", provider: "a", config: () => config, registry, intent: "run the tests", ...over };
}
const bash = { requestId: "r1", surface: "bash", command: "uname -s" };
const reply = (text: string): RegistryLike => ({ find: () => ({}), complete: async () => ({ content: [{ type: "text", text }], stopReason: "stop" }) });

test("authorize: model reply decides; throw, hang, no model, child and other surfaces defer", async () => {
  const r = new ForemanReview();
  const logged: Record<string, unknown>[] = [];
  const log = { review: (_e: string, d?: Record<string, unknown>) => void logged.push(d ?? {}) };
  r.upsert("s", session(reply('{"verdict":"allow"}')));
  assert.deepEqual(await r.authorize("s", bash, log), { kind: "allow" });
  assert.equal(logged[0].outcome, "allow");
  assert.equal(JSON.stringify(logged[0]).includes("uname"), false);
  r.upsert("s", session({ find: () => ({}), complete: async () => { throw new Error("boom"); } }));
  assert.deepEqual(await r.authorize("s", bash), { kind: "defer" });
  r.upsert("s", session({ find: () => ({}), complete: () => new Promise(() => {}) }));
  const t0 = Date.now();
  assert.deepEqual(await r.authorize("s", bash, log), { kind: "defer" });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(logged.at(-1)?.outcome, "timeout");
  r.upsert("s", session(reply('{"verdict":"allow"}'), { provider: "b" }));
  assert.deepEqual(await r.authorize("s", bash), { kind: "defer" });
  r.setProvider("s", "a");
  assert.deepEqual(await r.authorize("s", bash), { kind: "allow" });
  assert.deepEqual(await r.authorize("s", { ...bash, surface: "path" }), { kind: "defer" });
  r.upsert("s", session(reply('{"verdict":"allow"}'), { isChild: true }));
  assert.deepEqual(await r.authorize("s", bash), { kind: "defer" });
  assert.deepEqual(await r.authorize("unknown", bash), { kind: "defer" });
});

test("onReady registers the link once on that session's permission service", () => {
  const key = Symbol.for("@gotgenes/pi-permission-system:session-services");
  const names: string[] = [];
  let disposed = 0;
  (globalThis as Record<symbol, unknown>)[key] = new Map([["s1", { registerAuthorizer: (n: string) => (names.push(n), () => void disposed++) }]]);
  const r = new ForemanReview();
  r.onReady({ sessionId: "s1" });
  r.onReady({ sessionId: "s1" });
  r.onReady({ sessionId: "other" });
  assert.deepEqual(names, [REVIEW_LINK]);
  r.drop("s1");
  assert.equal(disposed, 1);
  delete (globalThis as Record<symbol, unknown>)[key];
});
