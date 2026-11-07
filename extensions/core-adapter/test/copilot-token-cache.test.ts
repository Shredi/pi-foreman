// github-copilot is token-billed by default (since 2026-06-01): the built-in per-model TTL rows switch the keep-alive on for
// Claude and GPT ids; `billing: request` (provider or byModel row) turns it off; `keepalive.children: false` stops a child's warms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCachePolicy, resolveWarmPolicy } from "../cachepolicy.ts";
import type { WarmSignals } from "../selfwarm.ts";
import { childrenOff, createWarm } from "../warmwire.ts";

const NONE: WarmSignals = { strongA: null, turn: false, question: false, dialog: false, command: false };
const cfg = (cache: unknown, provider = "github-copilot") => ({ providers: { [provider]: { cache } } });

test("copilot claude-opus-5.5: active, 300 s, token", () => {
  const p = resolveCachePolicy({}, "github-copilot", "claude-opus-5.5");
  assert.equal(p.active, true);
  assert.equal(p.ttlSeconds, 300);
  assert.equal(p.billing, "token");
});

test("copilot GPT ids: active, 1800 s", () => {
  for (const id of ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.6-luna", "gpt-6-sol"]) {
    const p = resolveCachePolicy({}, "github-copilot", id);
    assert.equal(p.active, true, id);
    assert.equal(p.ttlSeconds, 1800, id);
    assert.equal(p.billing, "token", id);
  }
});

test("copilot GPT: the warm owner is on", () => {
  assert.equal(resolveWarmPolicy({}, "github-copilot", "gpt-6.1-sol").keepaliveOwned, true);
});

test("copilot model without a TTL row: ttl_unknown", () => {
  const p = resolveCachePolicy({}, "github-copilot", "gemini-3.8-flash");
  assert.equal(p.active, false);
  assert.equal(p.skip, "ttl_unknown");
});

test("copilot billing: request at provider level gives billing_request", () => {
  const p = resolveCachePolicy(cfg({ billing: "request" }), "github-copilot", "claude-opus-5.5");
  assert.equal(p.active, false);
  assert.equal(p.skip, "billing_request");
});

test("copilot byModel row with billing: request gives billing_request for that model only", () => {
  const c = cfg({ byModel: [{ match: "gpt-*", billing: "request" }] });
  assert.equal(resolveCachePolicy(c, "github-copilot", "gpt-6.1-sol").skip, "billing_request");
  assert.equal(resolveCachePolicy(c, "github-copilot", "claude-opus-5.5").active, true);
});

let seq = 0;
function wire(config: unknown, isChild: boolean, provider: string, modelId: string) {
  const traces: Record<string, unknown>[] = [];
  const id = `copilot-${++seq}-${Date.now()}`;
  const { selfWarm } = createWarm({
    pi: { getAllTools: () => [], getActiveTools: () => [], getThinkingLevel: () => "off", getSettings: () => ({}) } as never,
    pkgRoot: "/nonexistent",
    isChild,
    bridgeTtl: () => 300,
    ctx: () => ({ model: { provider, id: modelId }, sessionManager: { getSessionId: () => id }, modelRegistry: {} }) as never,
    config: () => config,
    usage: () => ({ file: "/nonexistent/usage.jsonl", line: {} as never }),
    trace: (r) => void traces.push(r),
    signals: () => NONE,
    queued: () => false,
    compact: () => null,
  });
  selfWarm.capture([{ role: "system", content: "s" }]);
  selfWarm.noteRequest(100_000);
  return { selfWarm, traces };
}

test("a copilot child warms by default", () => {
  const h = wire({}, true, "github-copilot", "claude-opus-5.5");
  assert.equal(h.selfWarm.owns(), true);
  assert.equal(h.traces.some((r) => r.reason === "child_off" || r.reason === "bridge_child_off"), false);
  assert.equal(h.selfWarm.state(), "watching");
});

test("a copilot child with keepalive.children: false is skipped child_off, traced once", () => {
  const c = cfg({ keepalive: { children: false } });
  assert.equal(childrenOff(c, "github-copilot"), true);
  const h = wire(c, true, "github-copilot", "claude-opus-5.5");
  assert.equal(h.selfWarm.owns(), false);
  h.selfWarm.noteRequest(100_000);
  assert.equal(h.traces.filter((r) => r.reason === "child_off").length, 1);
  assert.equal(h.selfWarm.state(), "off");
  const f = wire(c, false, "github-copilot", "claude-opus-5.5");
  assert.equal(f.selfWarm.owns(), true);
});

test("a bridge child keeps bridge_child_off", () => {
  const h = wire({}, true, "claude-bridge", "claude-opus-4-7");
  assert.equal(h.selfWarm.owns(), false);
  assert.equal(h.traces.filter((r) => r.reason === "bridge_child_off").length, 1);
  assert.equal(h.traces.some((r) => r.reason === "child_off"), false);
});
