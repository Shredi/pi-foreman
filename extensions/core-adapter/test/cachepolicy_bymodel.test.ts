import { test } from "node:test";
import assert from "node:assert/strict";
import { matchModel, resolveCachePolicy } from "../cachepolicy.ts";

const cfg = (cache: unknown, provider = "claude-bridge") => ({ providers: { [provider]: { cache } } });

test("byModel: glob and substring match", () => {
  assert.equal(matchModel("claude-*", "claude-opus-5-5"), true);
  assert.equal(matchModel("opus", "claude-opus-5-5"), true);
  assert.equal(matchModel("claude-?pus*", "claude-opus-5-5"), true);
  assert.equal(matchModel("sonnet", "claude-opus-5-5"), false);
  assert.equal(matchModel("claude-opus", "claude-opus-5-5"), true);
});

test("byModel: the first matching row wins over the provider ttl", () => {
  const c = cfg({ ttlSeconds: 300, billing: "token", byModel: [{ match: "haiku", ttlSeconds: 120 }, { match: "claude-*", ttlSeconds: 600 }] });
  assert.equal(resolveCachePolicy(c, "claude-bridge", "claude-bridge/claude-opus-5-5").ttlSeconds, 600);
  assert.equal(resolveCachePolicy(c, "claude-bridge", "claude-haiku-5-5").ttlSeconds, 120);
  assert.equal(resolveCachePolicy(c, "claude-bridge", "other-model").ttlSeconds, 300);
  assert.equal(resolveCachePolicy(c, "claude-bridge").ttlSeconds, 300);
});

test("byModel: keep-alive follows the matched ttl", () => {
  const c = cfg({ byModel: [{ match: "claude-*", ttlSeconds: 600 }, { match: "long", ttlSeconds: 3600 }] });
  const p = resolveCachePolicy(c, "claude-bridge", "claude-opus-5-5");
  assert.equal(p.active, true);
  assert.equal(p.intervalSeconds, 540);
  assert.equal(resolveCachePolicy(c, "claude-bridge", "long-model").skip, "ttl_long");
  assert.equal(resolveCachePolicy({}, "claude-bridge", "claude-opus-5-5").intervalSeconds, 270);
});

test("byModel: request billing never starts the keep-alive", () => {
  const c = cfg({ ttlSeconds: 300, billing: "token", keepalive: { enabled: true }, byModel: [{ match: "gpt-*", ttlSeconds: 600, billing: "request" }] });
  const p = resolveCachePolicy(c, "claude-bridge", "gpt-6");
  assert.equal(p.active, false);
  assert.equal(p.skip, "billing_request");
  assert.equal(resolveCachePolicy(c, "claude-bridge", "claude-opus-5-5").active, true);
});
