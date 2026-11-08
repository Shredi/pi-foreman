// The protected-target check (classifier.ts checkProtected / ProtectedCache): allow, ask, deny, every failure asks, the hard-floor classes cap the
// model, the owner-away rule, the mode test before the cache, the version drop, and the one-time no-model notice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProtectedCache, parseProtectedVerdict } from "../classifier.ts";
import type { ProtectedCall, ProtectedCheckCtx, ProtectedCheckResult } from "../classifier.ts";

const checkProtected = (call: ProtectedCall, c: ProtectedCheckCtx, cache: ProtectedCache = new ProtectedCache()): Promise<ProtectedCheckResult> => cache.check(call, c);
import type { ProtectedMatch } from "../protected.ts";

type Reply = string | Error | "hang";
function fakeRegistry(replies: Reply[], found = true) {
  const calls: string[] = [];
  const registry = {
    find: () => (found ? { id: "m" } : undefined),
    complete: async (_m: never, ctx: { messages: { content: string }[] }) => {
      calls.push(ctx.messages[0].content);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (r instanceof Error) throw r;
      if (r === "hang") return new Promise<never>(() => undefined);
      return { content: [{ type: "text", text: r }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  return { registry, calls };
}
const V = (o: Record<string, unknown>): string => JSON.stringify({ verdict: "allow", effect: "read", confidence: "high", entry: null, reason: "lists files", ...o });

const entry = { id: "P2", kind: "host" as const, glob: "prod-*", note: "production", source: "user" };
const MATCH = (over: Partial<ProtectedMatch> = {}): ProtectedMatch => ({ entries: [entry], classes: ["read"], remoteClasses: [], opaque: false, remoteOpaque: false, kinds: ["host"], ...over });
const CALL: ProtectedCall = { tool: "bash", payload: "ssh prod-1 ls /srv", kind: "owner", role: "foreman", cwd: "/w", worktree: "/w", branch: "main", remotes: [] };
const config = { providers: { fake: { roles: { review: { model: "fake/m" } } } } };
const DENY = [{ id: "D1", text: "Never touch the production database." }];

function ctx(replies: Reply[], over: Partial<ProtectedCheckCtx> = {}, found = true) {
  const reg = fakeRegistry(replies, found);
  const notes: string[] = [];
  const usage: { role?: string }[] = [];
  const c: ProtectedCheckCtx = { prose: { allow: [], deny: [] }, registry: reg.registry as never, config, provider: "fake", notify: (t) => notes.push(t), recordUsage: (u) => usage.push(u as never), timeoutMs: 200, match: MATCH(), task: "tidy up", denyEntries: DENY, checkMode: "model", version: 1, away: false, ...over };
  return { c, reg, notes, usage };
}

test("allow: a high-confidence read verdict on a read call is accepted, cached, and the cache hit still runs the acceptance", async () => {
  const cache = new ProtectedCache();
  const { c, reg, usage } = ctx([V({})]);
  const a = await checkProtected(CALL, c, cache);
  assert.deepEqual([a.accepted, a.effect, a.cached, a.model], ["allow", "read", false, "fake/m"]);
  assert.equal(usage.length, 1);
  const b = await checkProtected(CALL, c, cache);
  assert.deepEqual([b.accepted, b.cached], ["allow", true]);
  assert.equal(reg.calls.length, 1);
  cache.clearCache();
  await checkProtected(CALL, c, cache);
  assert.equal(reg.calls.length, 2);
});

test("ask: an ask verdict, a low confidence and an unknown effect all ask", async () => {
  for (const reply of [V({ verdict: "ask" }), V({ confidence: "low" }), V({ effect: "unknown" })]) {
    const r = await checkProtected(CALL, ctx([reply]).c);
    assert.equal(r.accepted, "ask", reply);
  }
});

test("deny: a cited deny entry denies; an unknown entry or none fails closed to ask", async () => {
  const d = await checkProtected(CALL, ctx([V({ verdict: "deny", effect: "write", entry: "D1", reason: "touches the prod db" })]).c);
  assert.deepEqual([d.accepted, d.entry], ["deny", "D1"]);
  for (const reply of [V({ verdict: "deny", entry: "D9" }), V({ verdict: "deny", entry: null })]) {
    assert.equal((await checkProtected(CALL, ctx([reply]).c)).accepted, "ask", reply);
  }
});

test("fail closed: a model error, a timeout, junk and no model all ask", async () => {
  for (const reply of [new Error("boom"), "hang" as const, "not json", "{\"verdict\":\"allow\"}", `${V({})} trailing`]) {
    const r = await checkProtected(CALL, ctx([reply]).c);
    assert.equal(r.accepted, "ask", String(reply));
  }
  const none = ctx([V({})], {}, false);
  const r = await checkProtected(CALL, none.c);
  assert.deepEqual([r.accepted, r.cause], ["ask", "no_model"]);
  assert.equal(none.reg.calls.length, 0);
});

test("the no-model notice is shown once per cache", async () => {
  const cache = new ProtectedCache();
  const { c, notes } = ctx([V({})], { config: { providers: { fake: { roles: {} } } } });
  const r = await checkProtected(CALL, c, cache);
  await checkProtected(CALL, c, cache);
  assert.deepEqual([r.accepted, r.cause], ["ask", "no_model"]);
  assert.equal(notes.length, 1);
});

test("hard floor: the model cannot allow a write-out or unknown class, nor an opaque line, nor a read verdict over a writing class", async () => {
  const allowWrite = V({ effect: "write" });
  assert.equal((await checkProtected(CALL, ctx([allowWrite], { match: MATCH({ classes: ["write-in"] }) }).c)).accepted, "allow");
  assert.equal((await checkProtected(CALL, ctx([V({})], { match: MATCH({ classes: ["write-out"] }) }).c)).accepted, "ask");
  assert.equal((await checkProtected(CALL, ctx([allowWrite], { match: MATCH({ classes: ["write-in"], opaque: true }) }).c)).accepted, "ask");
  assert.equal((await checkProtected(CALL, ctx([allowWrite], { match: MATCH({ classes: ["write-in"], remoteOpaque: true }) }).c)).accepted, "ask");
  assert.equal((await checkProtected(CALL, ctx([allowWrite], { match: MATCH({ classes: [] }) }).c)).accepted, "ask");
});

test("owner away: only a read-only verdict allows; a write verdict asks, and a cached read still allows while a write is never cached", async () => {
  const cache = new ProtectedCache();
  const w = MATCH({ classes: ["write-in"] });
  const away = await checkProtected(CALL, ctx([V({ effect: "write" })], { match: w, away: true }).c, cache);
  assert.equal(away.accepted, "ask");
  const present = ctx([V({ effect: "write" })], { match: w, away: false });
  const first = await checkProtected(CALL, present.c, cache);
  assert.equal(first.accepted, "allow");
  const again = await checkProtected(CALL, present.c, cache);
  assert.equal(again.cached, false);
  assert.equal(present.reg.calls.length, 2);
  const read = ctx([V({})], { away: true });
  assert.equal((await checkProtected(CALL, read.c, cache)).accepted, "allow");
});

test("mode: ask never calls the model nor reads the cache; read-only allows reads only", async () => {
  const cache = new ProtectedCache();
  const warm = ctx([V({})]);
  await checkProtected(CALL, warm.c, cache);
  const askMode = ctx([V({})], { checkMode: "ask" });
  const r = await checkProtected(CALL, askMode.c, cache);
  assert.deepEqual([r.accepted, r.cached, askMode.reg.calls.length], ["ask", false, 0]);
  const ro = ctx([V({ effect: "write" })], { checkMode: "read-only", match: MATCH({ classes: ["write-in"] }) });
  assert.equal((await checkProtected(CALL, ro.c)).accepted, "ask");
});

test("a version change drops the cached allow", async () => {
  const cache = new ProtectedCache();
  const { c, reg } = ctx([V({})]);
  await checkProtected(CALL, c, cache);
  await checkProtected(CALL, { ...c, version: 2 }, cache);
  assert.equal(reg.calls.length, 2);
});

test("the request fences the command and names the entries; parseProtectedVerdict is strict", async () => {
  const { c, reg } = ctx([V({})]);
  await checkProtected(CALL, c);
  assert.match(reg.calls[0], /ssh prod-1 ls \/srv/);
  assert.match(reg.calls[0], /P2/);
  assert.ok("error" in parseProtectedVerdict("[]", []));
  assert.ok("error" in parseProtectedVerdict(V({ extra: 1 }), []));
  assert.ok("error" in parseProtectedVerdict(V({ verdict: "allow", entry: "A1" }), []));
  assert.ok(!("error" in parseProtectedVerdict(`\`\`\`json\n${V({})}\n\`\`\``, [])));
});
