import { test } from "node:test";
import assert from "node:assert/strict";
import { GateCache, gateReview } from "../gatereview.ts";
import type { GateReviewDeps, GateReviewRequest } from "../gatereview.ts";
import { policyHash } from "../policy.ts";
import type { LoadedPolicy, PolicyEntry } from "../policy.ts";

const E = (section: PolicyEntry["section"], id: string): PolicyEntry => ({ id, section, text: `${id} text`, source: "t.md" });
const entries = [E("allow", "ok-read"), E("deny", "no-secret"), E("ask", "ask-install"), E("context", "ctx")];
const policy: LoadedPolicy = { trusted: { entries }, project: null, hash: policyHash(entries), warnings: [] };
const config = { providers: { p: { review: { model: "m" } } } };
const req = (over: Partial<GateReviewRequest> = {}): GateReviewRequest => ({ surface: "bash", tool: "bash", role: "builder", kind: "child", cwd: "/w", worktree: "/w", owned: ["/o"], branch: "b", head: "h1", mergeHead: null, remotes: ["origin"], ownerMessages: ["do it"], payload: "ls", ...over });
const V = (verdict: string, entry: string): string => JSON.stringify({ verdict, entry, reason: "r" });

function setup(replies: string[]) {
  let n = 0;
  const registry = { find: () => ({ id: "m" }), complete: async () => ({ content: [{ type: "text", text: replies[Math.min(n++, replies.length - 1)] }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
  const deps: GateReviewDeps = { policy, registry: registry as never, config, provider: "p", cache: new GateCache() };
  return { deps, calls: () => n };
}

test("bash: a denied commit message does not deny a different message", async () => {
  const s = setup([V("deny", "no-secret"), V("allow", "ok-read")]);
  assert.equal((await gateReview(req({ payload: 'git commit -m "a"' }), s.deps)).kind, "deny");
  assert.equal((await gateReview(req({ payload: 'git commit -m "b"' }), s.deps)).kind, "allow");
  assert.equal(s.calls(), 2);
});

test("bash: an allowed command does not allow a different one", async () => {
  const s = setup([V("allow", "ok-read"), V("deny", "no-secret")]);
  assert.equal((await gateReview(req({ payload: 'git commit -m "a"' }), s.deps)).kind, "allow");
  assert.equal((await gateReview(req({ payload: 'git commit -m "b"' }), s.deps)).kind, "deny");
  assert.equal(s.calls(), 2);
});

test("file tools: a denied write to path A does not deny path B", async () => {
  const s = setup([V("deny", "no-secret"), V("allow", "ok-read")]);
  const w = (p: string) => req({ surface: "file", tool: "write", pathKeys: ["path", "content"], payload: `path=${p} content=x` });
  assert.equal((await gateReview(w("/a"), s.deps)).kind, "deny");
  assert.equal((await gateReview(w("/b"), s.deps)).kind, "allow");
  assert.equal(s.calls(), 2);
});

test("different tools with the same payload do not share a verdict", async () => {
  const s = setup([V("deny", "no-secret"), V("allow", "ok-read")]);
  assert.equal((await gateReview(req({ surface: "mcp", tool: "intercom", payload: "{}" }), s.deps)).kind, "deny");
  assert.equal((await gateReview(req({ surface: "mcp", tool: "codemode", payload: "{}" }), s.deps)).kind, "allow");
});

test("identical calls still hit the cache", async () => {
  const s = setup([V("deny", "no-secret"), V("allow", "ok-read")]);
  await gateReview(req({ payload: 'git commit -m "a"' }), s.deps);
  const again = await gateReview(req({ payload: 'git commit -m "a"' }), s.deps);
  assert.equal((again as { cached: boolean }).cached, true);
  assert.equal(s.calls(), 1);
  await gateReview(req({ payload: "ls" }), s.deps);
  const ls = await gateReview(req({ payload: "ls" }), s.deps);
  assert.equal((ls as { cached: boolean }).cached, true);
  assert.equal(s.calls(), 2);
});
