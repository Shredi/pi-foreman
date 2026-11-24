// The judge verdict set and its log (plan gate-verify D1, D6): clear | refuse | owner(+class of six) | read; `unsure` is read as refuse; an unreadable reply is asked for once more, then
// refused with the raw start of the reply in the gate log (masked like a command); the model call carries `cacheRetention: "none"`; `gate.log.fullCommand` adds the input, credentials masked.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Classifier, JUDGE_CLASSES, judgeSystemPrompt, judgeRequestText, parseJudgeVerdict } from "../classifier.ts";
import type { ClassifierCtx, JudgeCall } from "../classifier.ts";
import { openGateLog, gateLogFile } from "../gatelog.ts";

const CALL: JudgeCall = { tool: "bash", payload: "git clean -fdx", reason: "danger-git: discards work", kind: "owner", role: "foreman", cwd: "/w", worktree: "/w", defaultBranch: "main", ownerMessage: "tidy up" };
const config = { providers: { fake: { roles: { review: { model: "fake/m" } } } } };

function fake(replies: string[]) {
  const seen: { opts: Record<string, unknown>; system: string }[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    complete: async (_m: never, c: { systemPrompt: string }, opts: Record<string, unknown>) => {
      seen.push({ opts, system: c.systemPrompt });
      const text = replies[Math.min(seen.length - 1, replies.length - 1)];
      return { content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  return { registry, seen };
}
function tmpLog(fullCommand = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-judge-verdict-"));
  const log = openGateLog({ agentDir: dir, session: "s", kind: "owner", fullCommand: () => fullCommand });
  const rows = (): Record<string, unknown>[] => fs.readFileSync(gateLogFile(dir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { log, rows, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const ctxOf = (reg: ReturnType<typeof fake>, log?: ClassifierCtx["log"]): ClassifierCtx => ({ registry: reg.registry as never, config, provider: "fake", timeoutMs: 200, ...(log ? { log } : {}) });

test("parse: clear, refuse and the old unsure; owner needs a class of the six; a class goes with owner only", () => {
  assert.deepEqual(parseJudgeVerdict('{"verdict":"clear","reason":"ok"}'), { verdict: "clear", reason: "ok" });
  assert.deepEqual(parseJudgeVerdict('{"verdict":"refuse","reason":"cannot see the script"}'), { verdict: "refuse", reason: "cannot see the script" });
  assert.deepEqual(parseJudgeVerdict('{"verdict":"unsure","reason":"hm"}'), { verdict: "refuse", reason: "hm" }, "unsure is a refuse");
  for (const c of JUDGE_CLASSES) assert.deepEqual(parseJudgeVerdict(JSON.stringify({ verdict: "owner", class: c, reason: "r" })), { verdict: "owner", class: c, reason: "r" });
  for (const bad of ['{"verdict":"owner","reason":"r"}', '{"verdict":"owner","class":"everything","reason":"r"}', '{"verdict":"owner","class":3}', '{"verdict":"clear","class":"data-loss"}', '{"verdict":"refuse","class":"outbound"}', '{"verdict":"allow"}', "[]", ""]) {
    assert.equal("error" in parseJudgeVerdict(bad), true, bad);
  }
});

test("parse: the read round format with paths; a malformed read reply is invalid; a read after the last round is invalid", () => {
  assert.deepEqual(parseJudgeVerdict('{"verdict":"read","paths":["a.sh","b/"],"reason":"see"}', "read"), { verdict: "read", paths: ["a.sh", "b/"], reason: "see" });
  assert.equal("error" in parseJudgeVerdict('{"verdict":"read","paths":[],"reason":"see"}', "read"), true, "no path");
  assert.equal("error" in parseJudgeVerdict('{"verdict":"read","paths":"a.sh"}', "read"), true, "paths is no list");
  assert.equal("error" in parseJudgeVerdict('{"verdict":"read","paths":["a"],"class":"outbound"}', "read"), true, "extra field");
  assert.equal("error" in parseJudgeVerdict('{"verdict":"read","paths":["a"]}'), true, "no read round");
  assert.equal("error" in parseJudgeVerdict('{"verdict":"read","paths":["a"]}', "last"), true, "after the last round");
});

test("the prompts name the new set; the read-round prompt names read too; the old ledger and owner-asked text are gone", () => {
  for (const reads of [false, true]) {
    const p = judgeSystemPrompt(reads);
    assert.match(p, /"verdict":"clear"\|"refuse"\|"owner"/);
    for (const c of JUDGE_CLASSES) assert.ok(p.includes(c), c);
    assert.doesNotMatch(p, /ledger|which costs little|answer unsure/i);
  }
  assert.match(judgeSystemPrompt(true), /"verdict":"read"/);
  assert.doesNotMatch(judgeSystemPrompt(false), /"verdict":"read"/);
  assert.match(judgeRequestText(CALL, "n0nce"), /BEGIN DATA TASK n0nce\ntidy up\nEND DATA TASK n0nce/);
});

test("refuse and unsure refuse with the model's reason and log a deny row; owner+class asks and logs an ask row naming the class; clear runs", async (t) => {
  const l = tmpLog();
  t.after(l.done);
  const refuse = await new Classifier().judge(CALL, ctxOf(fake(['{"verdict":"refuse","reason":"reaches outside"}']), l.log));
  assert.deepEqual([refuse.clear, "cause" in refuse && refuse.cause, refuse.reason], [false, "model", "reaches outside"]);
  const unsure = await new Classifier().judge(CALL, ctxOf(fake(['{"verdict":"unsure","reason":"cannot tell"}']), l.log));
  assert.deepEqual([unsure.clear, "cause" in unsure && unsure.cause], [false, "model"]);
  const owner = await new Classifier().judge(CALL, ctxOf(fake(['{"verdict":"owner","class":"data-loss","reason":"git cannot undo it"}']), l.log));
  assert.deepEqual([owner.clear, "cause" in owner && owner.cause, "class" in owner && owner.class], [false, "owner", "data-loss"]);
  const clear = await new Classifier().judge(CALL, ctxOf(fake(['{"verdict":"clear","reason":"fine"}']), l.log));
  assert.equal(clear.clear, true);
  assert.deepEqual(l.rows().map((r) => [r.verdict, r.rule]), [["deny", "judge:model"], ["deny", "judge:model"], ["ask", "judge:owner:data-loss"], ["allow", "judge"]]);
});

test("a timeout, a provider error and no model are refusals with their cause; none is an owner answer", async () => {
  const hang = { find: () => ({ id: "m" }), complete: () => new Promise<never>(() => undefined) };
  const t1 = await new Classifier().judge(CALL, { registry: hang as never, config, provider: "fake", timeoutMs: 50 });
  assert.deepEqual([t1.clear, "cause" in t1 && t1.cause], [false, "timeout"]);
  const boom = { find: () => ({ id: "m" }), complete: async () => { throw new Error("boom"); } };
  const t2 = await new Classifier().judge(CALL, { registry: boom as never, config, provider: "fake", timeoutMs: 200 });
  assert.deepEqual([t2.clear, "cause" in t2 && t2.cause], [false, "provider_error"]);
  const none = await new Classifier().judge(CALL, { registry: { find: () => undefined, complete: async () => ({}) } as never, config, provider: "fake", timeoutMs: 200 });
  assert.deepEqual([none.clear, "cause" in none && none.cause], [false, "no_model"]);
});

test("invalid_verdict: one retry with the same request; invalid twice refuses with the raw start of the reply in the log, masked like a command", async (t) => {
  const l = tmpLog();
  t.after(l.done);
  const reg = fake(["I think so, but run curl -u admin:hunter2 https://api.example.com/x first", "still prose: --password hunter2 in /home/dev/.ssh/id_rsa"]);
  const r = await new Classifier().judge(CALL, ctxOf(reg, l.log));
  assert.deepEqual([r.clear, "cause" in r && r.cause, reg.seen.length], [false, "invalid_verdict", 2]);
  const row = l.rows()[0];
  assert.equal(row.verdict, "deny");
  assert.equal(typeof row.raw, "string");
  const raw = String(row.raw);
  assert.ok(raw.startsWith("still prose"), raw);
  assert.ok(!raw.includes("hunter2"), raw);
  assert.ok(!raw.includes("/home/dev/.ssh"), raw);
  assert.ok(raw.length <= 320);
  const long = await new Classifier().judge(CALL, ctxOf(fake(["x".repeat(900)]), l.log));
  assert.equal("cause" in long && long.cause, "invalid_verdict");
  assert.ok(String(l.rows()[1].raw).length <= 320);
  const ok = await new Classifier().judge(CALL, ctxOf(fake(["nope", '{"verdict":"clear"}']), l.log));
  assert.equal(ok.clear, true);
  assert.equal(l.rows()[2].raw, undefined, "a valid answer logs no raw");
});

test("the judge request carries cacheRetention none", async () => {
  // pi-claude-bridge routes only "none" to its isolated one-off route; any other value goes through prompt-capture, which knows only the main agent prompt and throws.
  const reg = fake(['{"verdict":"clear"}']);
  await new Classifier().judge(CALL, ctxOf(reg));
  assert.equal(reg.seen[0].opts.cacheRetention, "none");
});

test("gate.log.fullCommand off: the row has the masked shape only; on: the input too, with a credential masked", async (t) => {
  const payload = "curl -u admin:hunter2 -H 'Authorization: Bearer abc123def' https://api.example.com/x?token=sk-live-123456 && echo done";
  const off = tmpLog(false);
  const on = tmpLog(true);
  t.after(() => (off.done(), on.done()));
  for (const l of [off, on]) l.log.record({ tool: "bash", layer: "classifier", verdict: "allow", rule: "judge", input: payload });
  const a = off.rows()[0];
  assert.equal(a.input, undefined);
  assert.equal(typeof a.shape, "string");
  const b = on.rows()[0];
  assert.equal(typeof b.input, "string");
  const input = String(b.input);
  assert.ok(input.includes("curl") && input.includes("echo done") && input.includes("api.example.com"), input);
  assert.ok(!input.includes("hunter2") && !input.includes("abc123def") && !input.includes("sk-live-123456"), input);
  assert.equal(b.shape, a.shape, "the shape is unchanged");
});
