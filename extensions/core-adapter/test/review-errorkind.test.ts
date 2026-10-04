import { test } from "node:test";
import assert from "node:assert/strict";
import { errorKind, ForemanReview } from "../review.ts";
import type { RegistryLike } from "../review.ts";

const config = { providers: { a: { review: { model: "a/small", timeoutMs: 200 } } } };
const bash = { requestId: "r1", surface: "bash", command: "git push origin main" };

test("errorKind classifies auth, abort and provider errors and never carries the value", () => {
  assert.equal(errorKind("Not logged in · Please run /login"), "auth");
  assert.equal(errorKind("Provider is not configured: x"), "auth");
  assert.equal(errorKind("Aborted"), "aborted");
  const capture = "prompt-capture: no capture for this 34-char system prompt, and it embeds none of the 3 known.";
  assert.equal(errorKind(capture), `provider_error:${capture.slice(0, 60)}`);
  assert.equal(errorKind("bad request: git push origin main rejected", "git push origin main"), "provider_error:bad request: <value> rejected");
  assert.equal(errorKind(""), "provider_error:unknown");
});

test("authorize logs and traces errorKind; the call is a one-shot (cacheRetention none)", async () => {
  const run = async (registry: RegistryLike) => {
    const logged: Record<string, unknown>[] = [];
    const traced: Record<string, unknown>[] = [];
    const r = new ForemanReview();
    r.upsert("s", { isChild: false, cwd: "/w", provider: "a", config: () => config, registry, intent: "", trace: (t) => void traced.push(t) });
    assert.deepEqual(await r.authorize("s", bash, { review: (_e, d) => void logged.push(d ?? {}) }), { kind: "defer" });
    assert.equal(JSON.stringify(logged).includes("git push"), false);
    return { log: logged[0], trace: traced[0] };
  };
  let opts: { cacheRetention?: string } | undefined;
  const failing: RegistryLike = {
    find: () => ({}),
    complete: async (_m, _c, o) => {
      opts = o as never;
      return { stopReason: "error", errorMessage: "prompt-capture: no capture for this 900-char system prompt" };
    },
  };
  const a = await run(failing);
  assert.equal(opts?.cacheRetention, "none");
  assert.equal(a.log.outcome, "error");
  assert.equal(a.log.errorKind, "provider_error:prompt-capture: no capture for this 900-char system prompt");
  assert.equal(a.trace.errorKind, a.log.errorKind);
  const b = await run({ find: () => undefined, complete: async () => ({}) });
  assert.equal(b.log.errorKind, "no_model");
  const c = await run({ find: () => ({}), complete: async () => { throw new Error("Not logged in"); } });
  assert.equal(c.log.errorKind, "auth");
  const d = await run({ find: () => ({}), complete: async () => ({ content: [{ type: "text", text: '{"verdict":"defer"}' }], stopReason: "stop" }) });
  assert.equal(d.log.errorKind, null);
});
