// PR D3: the judge's input and thinking level (classifier.ts): a helper's own folders in the request, the configured level, the log row's fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Classifier, JUDGE_REASONING, classifierTarget, judgeLevel, judgeRequestText, judgeSystemPrompt } from "../classifier.ts";
import type { ClassifierCtx, JudgeCall } from "../classifier.ts";
import type { GateRecord } from "../gatelog.ts";

const CALL: JudgeCall = { tool: "bash", payload: "python3 - <<EOF\nprint(1)\nEOF", reason: "danger-inline-code: runs inline code", kind: "child", role: "builder", cwd: "/w", worktree: "/w", defaultBranch: null };
const DIRS = { out: "/agent/child-out/s/l", scratch: "/tmp/pi-foreman-scratch/s/l" };
const V = JSON.stringify({ verdict: "clear", reason: "ok" });

function rig(config: Record<string, unknown>) {
  const seen: { options: Record<string, unknown>; text: string }[] = [];
  const rows: GateRecord[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    complete: async (_m: never, c: { messages: { content: string }[] }, options: Record<string, unknown>) => {
      seen.push({ options, text: c.messages[0].content });
      return { content: [{ type: "text", text: V }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  const c: ClassifierCtx = { registry: registry as never, config, provider: "fake", log: { file: "", record: (r) => (rows.push(r), "id") }, timeoutMs: 200 };
  return { c, seen, rows };
}
const cfg = (review: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ providers: { fake: { roles: { review } } }, ...extra });

test("a child's request names $FOREMAN_OUT and $FOREMAN_SCRATCH with their paths; an owner's request is unchanged", () => {
  const child = judgeRequestText({ ...CALL, childDirs: DIRS }, "n");
  assert.match(child, /^\$FOREMAN_OUT = \/agent\/child-out\/s\/l$/m);
  assert.match(child, /^\$FOREMAN_SCRATCH = \/tmp\/pi-foreman-scratch\/s\/l$/m);
  const owner = judgeRequestText({ ...CALL, kind: "owner", role: "foreman" }, "n");
  assert.doesNotMatch(owner, /FOREMAN_OUT|FOREMAN_SCRATCH/);
  assert.equal(owner, judgeRequestText({ ...CALL, kind: "owner", role: "foreman" }, "n"));
});

test("the system text names the folder facts and judges a script whose text is in the command by what it does", () => {
  const s = judgeSystemPrompt();
  assert.match(s, /\$FOREMAN_OUT and \$FOREMAN_SCRATCH/);
  assert.match(s, /A script whose text is in the command \(inline code, a heredoc body\) is judged by what that text does/);
  assert.doesNotMatch(s, /a script you do not know/);
});

test("the cache key holds the folders: a clear for one pair is not reused for another", async () => {
  const k = new Classifier();
  const a = rig(cfg({ model: "fake/m" }));
  await k.judge({ ...CALL, childDirs: DIRS }, a.c);
  await k.judge({ ...CALL, childDirs: DIRS }, a.c);
  assert.equal(a.seen.length, 1);
  await k.judge({ ...CALL, childDirs: { ...DIRS, out: "/other" } }, a.c);
  assert.equal(a.seen.length, 2);
});

test("thinking level: the thinking field, else the model's :level suffix, else high; maxThinking caps", async () => {
  const run = async (config: Record<string, unknown>) => {
    const r = rig(config);
    await new Classifier().judge(CALL, r.c);
    return { reasoning: r.seen[0].options.reasoning, row: r.rows[0].reasoning };
  };
  assert.deepEqual(await run(cfg({ model: "fake/m", thinking: "low" })), { reasoning: "low", row: "low" });
  assert.deepEqual(await run(cfg({ model: "fake/m:medium" })), { reasoning: "medium", row: "medium" });
  assert.deepEqual(await run(cfg({ model: "fake/m:medium", thinking: "minimal" })), { reasoning: "minimal", row: "minimal" });
  assert.deepEqual(await run(cfg({ model: "fake/m" })), { reasoning: JUDGE_REASONING, row: JUDGE_REASONING });
  assert.deepEqual(await run(cfg({ model: "fake/m", thinking: "xhigh" }, { maxThinking: "medium" })), { reasoning: "medium", row: "medium" });
  assert.deepEqual(await run(cfg({ model: "fake/m" }, { maxThinking: "low" })), { reasoning: "low", row: "low" });
  // off: the call carries no reasoning option, the row says off
  assert.deepEqual(await run(cfg({ model: "fake/m", thinking: "off" })), { reasoning: undefined, row: "off" });
  assert.equal(JUDGE_REASONING, "high");
});

test("judgeLevel and classifierTarget agree; the level of a fallback model is the default", () => {
  const registry = { find: () => ({ cost: { input: 1 } }), complete: async () => ({}) };
  const t = classifierTarget(cfg({ model: "fake/m", thinking: "low" }), "fake", registry);
  assert.equal(t?.level, "low");
  assert.equal(judgeLevel(cfg({ model: "fake/m", thinking: "low" }), t), "low");
  const auto = classifierTarget({ providers: { fake: { roles: { builder: { model: "fake/b" } } } } }, "fake", registry);
  assert.equal(auto?.auto, true);
  assert.equal(judgeLevel({}, auto), "high");
});

test("the log row carries promptChars and timeoutMs", async () => {
  const r = rig(cfg({ model: "fake/m" }));
  await new Classifier().judge({ ...CALL, childDirs: DIRS }, r.c);
  assert.equal(r.rows[0].promptChars, r.seen[0].text.length);
  assert.equal(r.rows[0].timeoutMs, 200);
  const r2 = rig(cfg({ model: "fake/m" }, { gate: { reviewTimeoutMs: 7000 } }));
  delete r2.c.timeoutMs;
  await new Classifier().judge(CALL, r2.c);
  assert.equal(r2.rows[0].timeoutMs, 7000);
});
