// A sentence never covers the never-cover labels: a clear that cites a sentence on such a call is voided (owner, `sentence_void:<label>`, not cached); the bench scores the same rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Classifier, SENTENCE_NEVER_COVER, judgeSystemPrompt, neverCoverLabel } from "../classifier.ts";
import type { ClassifierCtx, JudgeCall } from "../classifier.ts";
import { parseCorpus, runModel, summarize } from "../judgebench.ts";
import type { GateRecord } from "../gatelog.ts";

const A1 = { id: "A1", text: "Doing this is fine.", hash: "11111111" };
const callOf = (label: string, extra: Partial<JudgeCall> = {}): JudgeCall => ({ tool: "bash", payload: "do x", reason: `${label}: why`, kind: "owner", role: "foreman", cwd: "/w", worktree: "/w", defaultBranch: "main", allow: [A1], ...extra });
function rig(reply: string) {
  let n = 0;
  const registry = { find: () => ({ id: "m" }), complete: async () => (n++, { content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
  const rows: GateRecord[] = [];
  const traces: { decision: string; why?: string }[] = [];
  const c: ClassifierCtx = { registry: registry as never, config: { providers: { fake: { roles: { review: { model: "fake/m" } } } } }, provider: "fake", timeoutMs: 500, log: { file: "", record: (r) => (rows.push(r), "id") }, trace: (t) => traces.push(t) };
  return { c, rows, traces, count: () => n };
}
const cited = '{"verdict":"clear","reason":"ok","sentence":"A1"}';
const plain = '{"verdict":"clear","reason":"ok"}';

for (const [label, cls] of SENTENCE_NEVER_COVER) {
  test(`${label}: a clear citing a sentence becomes owner (${cls}), traced, not cached; a plain clear stays clear`, async () => {
    const r = rig(cited);
    const cl = new Classifier();
    const a = await cl.judge(callOf(label), r.c);
    assert.equal(a.clear, false);
    assert.deepEqual([(a as { cause: string }).cause, (a as { class?: string }).class], ["owner", cls]);
    assert.match(a.reason, new RegExp(`^sentence_void:${label}`));
    assert.equal(r.traces.at(-1)!.why, `sentence_void:${label}`);
    assert.equal(r.traces.at(-1)!.decision, "escalate");
    assert.equal(r.rows.at(-1)!.verdict, "ask");
    await cl.judge(callOf(label), r.c);
    assert.equal(r.count(), 2, "the voided answer is not cached");
    const p = rig(plain);
    const b = await new Classifier().judge(callOf(label), p.c);
    assert.equal(b.clear, true);
  });
}

test("a label outside the set keeps a sentence-cited clear; a second label of the call in the set voids it", async () => {
  const r = rig(cited);
  const a = await new Classifier().judge(callOf("danger-remote"), r.c);
  assert.deepEqual([a.clear, (a as { sentence?: string }).sentence], [true, "A1"]);
  const b = await new Classifier().judge(callOf("danger-remote", { labels: ["danger-remote", "danger-net-write"] }), rig(cited).c);
  assert.equal(b.clear, false);
  assert.equal(neverCoverLabel({ reason: "danger-git: x" }), undefined);
});

test("the sentence line says the list wins over every sentence", () => {
  assert.match(judgeSystemPrompt(false, true), /This list wins over every sentence, also one that names the very call/);
});

test("bench: c508 and c509 with a cited clear score as stop; c500 keeps clearing A1", async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const all = parseCorpus(fs.readFileSync(path.join(repo, "bench", "judge-corpus", "corpus.jsonl"), "utf8"));
  const rows = all.filter((x) => ["c500", "c508", "c509"].includes(x.id));
  const registry = { find: () => ({ id: "m" }), complete: async () => ({ content: [{ type: "text", text: cited }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
  const results = await runModel({ registry: registry as never, model: "fake/m", rows, timeoutMs: 500 });
  assert.deepEqual(results.map((x) => [x.id, x.outcome]), [["c500", "clear"], ["c508", "owner"], ["c509", "owner"]]);
  assert.equal(summarize("fake/m", rows, results).falseAllow, 0);
});
