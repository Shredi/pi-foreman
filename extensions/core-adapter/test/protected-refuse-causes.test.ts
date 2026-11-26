// The protected-target cause mapping (plan gate-verify D1): the owner is asked only for `mode`, `read_only`, `local_write`, `remote_write`, `away` and `judge_ask`; every other cause is a
// refusal with its reason (`low_confidence`, `unknown_effect`, `judge_unsure`, `local_opaque`, `remote_opaque`, `no_classes`, `provider_error`, `wrong_entry`, timeout, invalid, no model).
// A line the code cannot fully read is refused first: before the check mode, the cache and the model call, whatever the model would answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProtectedCache, parseProtectedVerdict } from "../classifier.ts";
import type { ProtectedCall, ProtectedCheckCtx, ProtectedCause } from "../classifier.ts";
import { PROTECTED_ASK_CAUSES, PROTECTED_COUNTED_CAUSES, acceptProtected, judgeProtected } from "../protected.ts";
import type { ProtectedFacts, ProtectedMatch, ProtectedVerdict } from "../protected.ts";

const facts = (o: Partial<ProtectedFacts> = {}): ProtectedFacts => ({ classes: ["read"], remoteClasses: [], opaque: false, remoteOpaque: false, away: false, mode: "model", denyEntryExists: false, ...o });
const verdict = (o: Partial<ProtectedVerdict> = {}): ProtectedVerdict => ({ verdict: "allow", effect: "read", confidence: "high", entry: null, ...o });

test("judgeProtected: every cause maps to its decision", () => {
  const rows: [string, ProtectedVerdict, ProtectedFacts, string, ProtectedCause | undefined][] = [
    ["allow read", verdict(), facts(), "allow", undefined],
    ["write allowed with the owner present", verdict({ effect: "write" }), facts({ classes: ["write-in"] }), "allow", undefined],
    ["mode ask", verdict(), facts({ mode: "ask" }), "ask", "mode"],
    ["read-only mode, write verdict", verdict({ effect: "write" }), facts({ mode: "read-only" }), "ask", "read_only"],
    ["a read verdict on a local write", verdict(), facts({ classes: ["write-in"] }), "ask", "local_write"],
    ["a remote write", verdict(), facts({ remoteClasses: ["write-out"] }), "ask", "remote_write"],
    ["owner away, write verdict", verdict({ effect: "deploy" }), facts({ away: true }), "ask", "away"],
    ["the model says ask", verdict({ verdict: "ask" }), facts(), "ask", "judge_ask"],
    ["deny without a deny entry", verdict({ verdict: "deny", entry: "D1" }), facts(), "ask", "judge_ask"],
    ["deny with a deny entry", verdict({ verdict: "deny", entry: "D1" }), facts({ denyEntryExists: true }), "deny", undefined],
    ["the model is unsure", verdict({ verdict: "unsure", effect: "unknown", confidence: "low" }), facts(), "refuse", "judge_unsure"],
    ["low confidence", verdict({ confidence: "low" }), facts(), "refuse", "low_confidence"],
    ["unknown effect", verdict({ effect: "unknown" }), facts(), "refuse", "unknown_effect"],
    ["no classes", verdict(), facts({ classes: [] }), "refuse", "no_classes"],
    ["opaque line, allow", verdict(), facts({ opaque: true }), "refuse", "local_opaque"],
    ["remote opaque line, allow", verdict(), facts({ remoteOpaque: true }), "refuse", "remote_opaque"],
  ];
  for (const [name, v, f, decision, cause] of rows) {
    const r = judgeProtected(v, f);
    assert.deepEqual([r.decision, r.cause], [decision, cause], name);
    assert.equal(acceptProtected(v, f), decision, name);
    if (cause) assert.equal(PROTECTED_ASK_CAUSES.has(cause), decision === "ask", `${name}: ask set`);
  }
});

test("an opaque line is refused whatever the model answers and before the check mode: allow, ask, unsure, deny, mode ask", () => {
  for (const mode of ["model", "read-only", "ask"] as const) {
    for (const v of [verdict(), verdict({ verdict: "ask" }), verdict({ verdict: "unsure", confidence: "low" }), verdict({ verdict: "deny", entry: "D1" })]) {
      assert.deepEqual(judgeProtected(v, facts({ opaque: true, mode, denyEntryExists: true })), { decision: "refuse", cause: "local_opaque" }, `${mode} ${v.verdict}`);
      assert.deepEqual(judgeProtected(v, facts({ remoteOpaque: true, mode })), { decision: "refuse", cause: "remote_opaque" }, `${mode} ${v.verdict}`);
    }
  }
});

test("the counted causes are what the model answered or the code saw, never a failure", () => {
  assert.deepEqual([...PROTECTED_COUNTED_CAUSES].sort(), ["judge_unsure", "local_opaque", "low_confidence", "no_classes", "remote_opaque", "unknown_effect"]);
  for (const never of ["timeout", "invalid_verdict", "no_model", "provider_error", "wrong_entry", "exception"] as const) assert.ok(!PROTECTED_COUNTED_CAUSES.has(never), never);
});

test("parseProtectedVerdict: unsure is a verdict, it cites no entry", () => {
  const ok = parseProtectedVerdict('{"verdict":"unsure","effect":"unknown","confidence":"low","entry":null,"reason":"cannot see the script"}', ["D1"]);
  assert.deepEqual("error" in ok ? null : [ok.verdict, ok.entry], ["unsure", null]);
  assert.equal("error" in parseProtectedVerdict('{"verdict":"unsure","effect":"unknown","confidence":"low","entry":"D1"}', ["D1"]), true);
  assert.equal("error" in parseProtectedVerdict('{"verdict":"maybe","effect":"unknown","confidence":"low"}', ["D1"]), true);
});

// ------------------------------------------------------------------ the check

type Reply = string | Error;
function reg(replies: Reply[], found = true) {
  const calls: string[] = [];
  const registry = {
    find: () => (found ? { id: "m" } : undefined),
    complete: async (_m: never, c: { messages: { content: string }[] }) => {
      calls.push(c.messages[0].content);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (r instanceof Error) throw r;
      if (r === "hang") return new Promise<never>(() => undefined);
      return { content: [{ type: "text", text: r }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  return { registry, calls };
}
const V = (o: Record<string, unknown> = {}): string => JSON.stringify({ verdict: "allow", effect: "read", confidence: "high", entry: null, reason: "lists files", ...o });
const entry = { id: "P2", kind: "host" as const, glob: "prod-*", note: "production", source: "user" };
const MATCH = (over: Partial<ProtectedMatch> = {}): ProtectedMatch => ({ entries: [entry], classes: ["read"], remoteClasses: [], opaque: false, remoteOpaque: false, kinds: ["host"], ...over });
const CALL: ProtectedCall = { tool: "bash", payload: "ssh prod-1 ls /srv", kind: "owner", role: "foreman", cwd: "/w", worktree: "/w", branch: "main", remotes: [] };
const config = { providers: { fake: { roles: { review: { model: "fake/m" } } } } };
function run(replies: Reply[], over: Partial<ProtectedCheckCtx> = {}, found = true) {
  const r = reg(replies, found);
  const c: ProtectedCheckCtx = { registry: r.registry as never, config, provider: "fake", timeoutMs: 100, match: MATCH(), task: "tidy up", denyEntries: [{ id: "D1", text: "Never touch the production database." }], checkMode: "model", version: 1, ...over };
  return { r, c, check: () => new ProtectedCache().check(CALL, c) };
}

test("opaque line on an always-ask target: refused with no model call (the mode no longer comes first)", async () => {
  for (const match of [MATCH({ opaque: true }), MATCH({ remoteOpaque: true })]) {
    for (const checkMode of ["ask", "read-only", "model"] as const) {
      const x = run([V()], { match, checkMode });
      const res = await x.check();
      assert.deepEqual([res.accepted, res.cause, x.r.calls.length], ["refuse", match.opaque ? "local_opaque" : "remote_opaque", 0], `${checkMode}`);
    }
  }
  const ask = await run([V()], { checkMode: "ask" }).check();
  assert.deepEqual([ask.accepted, ask.cause], ["ask", "mode"], "a fully readable line on an always-ask target still asks");
});

test("protected local_opaque with a high-confidence allow refuses (and the model is not even asked)", async () => {
  const x = run([V()], { match: MATCH({ opaque: true }) });
  const res = await x.check();
  assert.deepEqual([res.accepted, res.cause, x.r.calls.length], ["refuse", "local_opaque", 0]);
  assert.match(res.reason, /could not be analysed/);
});

test("check: the model's unsure, low confidence, unknown effect and no classes refuse; ask and a remote write ask", async () => {
  const rows: [Reply, Partial<ProtectedCheckCtx>, string, string][] = [
    [V({ verdict: "unsure", effect: "unknown", confidence: "low" }), {}, "refuse", "judge_unsure"],
    [V({ confidence: "low" }), {}, "refuse", "low_confidence"],
    [V({ effect: "unknown" }), {}, "refuse", "unknown_effect"],
    [V(), { match: MATCH({ classes: [] }) }, "refuse", "no_classes"],
    [V({ verdict: "ask", effect: "write" }), {}, "ask", "judge_ask"],
    [V(), { match: MATCH({ remoteClasses: ["write-out"] }) }, "ask", "remote_write"],
    [V({ effect: "write" }), { checkMode: "read-only" }, "ask", "read_only"],
    [V({ effect: "write" }), { away: true }, "ask", "away"],
  ];
  for (const [reply, over, accepted, cause] of rows) {
    const res = await run([reply], over).check();
    assert.deepEqual([res.accepted, res.cause], [accepted, cause], String(reply));
  }
});

test("fail closed: no model, a timeout, a provider error, an unreadable verdict twice and a wrong entry all refuse", async () => {
  const rows: [Reply[], boolean, string][] = [
    [[V()], false, "no_model"],
    [["hang"], true, "timeout"],
    [[new Error("boom")], true, "provider_error"],
    [["nope", "still nope"], true, "invalid_verdict"],
    [[V({ verdict: "deny", entry: "D9" })], true, "wrong_entry"],
  ];
  for (const [replies, found, cause] of rows) {
    const res = await run(replies, {}, found).check();
    assert.deepEqual([res.accepted, res.cause], ["refuse", cause], cause);
    assert.ok(res.reason.length > 0);
  }
});
