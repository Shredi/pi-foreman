// PR C: the judge-first question (classifier.ts Classifier.judge): only a well-formed `clear` clears; unsure, invalid answers and failures do not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Classifier, JUDGE_REASONING, NO_MODEL_NOTICE, judgeRequestText, judgeSystemPrompt, parseJudgeVerdict } from "../classifier.ts";
import type { ClassifierCtx, JudgeCall } from "../classifier.ts";

type Reply = string | Error | "hang";
function fakeRegistry(replies: Reply[], found = true) {
  const calls: { system: string; text: string }[] = [];
  const registry = {
    find: () => (found ? { id: "m" } : undefined),
    complete: async (_m: never, ctx: { systemPrompt: string; messages: { content: string }[] }) => {
      calls.push({ system: ctx.systemPrompt, text: ctx.messages[0].content });
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (r instanceof Error) throw r;
      if (r === "hang") return new Promise<never>(() => undefined);
      return { content: [{ type: "text", text: r }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  return { registry, calls };
}
const V = (verdict: string, reason = "because"): string => JSON.stringify({ verdict, reason });
const CALL: JudgeCall = { tool: "bash", payload: "git config core.hooksPath x", reason: "danger-git-config: changes git config", kind: "owner", role: "foreman", cwd: "/w", worktree: "/w", branch: "main", remotes: ["origin"], ownerMessage: "set the hooks path" };
const config = { providers: { fake: { roles: { review: { model: "fake/m" } } } } };

function ctx(replies: Reply[], found = true) {
  const reg = fakeRegistry(replies, found);
  const notes: string[] = [];
  const c: ClassifierCtx = { registry: reg.registry as never, config, provider: "fake", notify: (t) => notes.push(t), timeoutMs: 200 };
  return { c, reg, notes };
}

test("a clear runs the call and is cached for the exact call; clearCache forgets it", async () => {
  const k = new Classifier();
  const { c, reg } = ctx([V("clear")]);
  assert.equal((await k.judge(CALL, c)).clear, true);
  const again = await k.judge(CALL, c);
  assert.deepEqual([again.clear, again.clear && again.cached], [true, true]);
  assert.equal(reg.calls.length, 1);
  await k.judge({ ...CALL, payload: "git remote add x y" }, c);
  assert.equal(reg.calls.length, 2);
  k.clearCache();
  await k.judge(CALL, c);
  assert.equal(reg.calls.length, 3);
});

test("unsure is no clear and is not cached", async () => {
  const k = new Classifier();
  const { c, reg } = ctx([V("unsure", "cannot tell")]);
  const r = await k.judge(CALL, c);
  assert.deepEqual([r.clear, r.reason], [false, "cannot tell"]);
  await k.judge(CALL, c);
  assert.equal(reg.calls.length, 2);
});

test("bad JSON, extra fields, an old verdict word, an empty reply: no clear", async () => {
  for (const reply of ["not json", JSON.stringify({ verdict: "clear", reason: "x", extra: 1 }), JSON.stringify({ verdict: "allow", reason: "x" }), "", V("clear").replace("clear", "CLEAR")]) {
    const { c } = ctx([reply]);
    assert.equal((await new Classifier().judge(CALL, c)).clear, false, reply);
  }
});

test("timeout and provider error are no clear", async () => {
  assert.equal((await new Classifier().judge(CALL, ctx([new Error("boom")]).c)).clear, false);
  assert.equal((await new Classifier().judge(CALL, ctx(["hang"]).c)).clear, false);
});

test("no model configured: no clear, one notice per session; an unknown model counts the same", async () => {
  const k = new Classifier();
  const none = ctx([V("clear")]);
  none.c.config = {};
  assert.equal((await k.judge(CALL, none.c)).clear, false);
  await k.judge(CALL, none.c);
  assert.deepEqual(none.notes, [NO_MODEL_NOTICE]);
  assert.equal((await new Classifier().judge(CALL, ctx([V("clear")], false).c)).clear, false);
});

test("the prompt: the call is fenced data, the owner message is included, the reasoning level is high", () => {
  const text = judgeRequestText(CALL, "abc");
  assert.match(text, /git config core\.hooksPath x/);
  assert.match(text, /set the hooks path/);
  assert.ok(judgeSystemPrompt().length > 100);
  assert.equal(JUDGE_REASONING, "high");
  assert.deepEqual(parseJudgeVerdict(V("clear")), { verdict: "clear", reason: "because" });
});

test("a nonce inside the command cannot close its fence", () => {
  const text = judgeRequestText({ ...CALL, payload: "echo abc" }, "abc");
  assert.equal(text.split("END DATA CALL abc").length, 2);
  assert.ok(!text.includes("echo abc"));
});
