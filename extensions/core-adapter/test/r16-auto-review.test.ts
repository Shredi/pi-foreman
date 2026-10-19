// R16 P1 item 3: the auto reviewer in front of the overlay's ask dialog (review.ts overlayAutoReview, spliced into index.ts overlayBlock),
// with a stubbed reviewer (`reply(text)` as in review.test.ts). The fixture lines run in index.ts's tool_call order: the self_ruling
// guard (ruling.ts), the overlay (checkToolCall), the auto reviewer, then today's dialog (resolveDecision).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp } from "./_tmpbase.ts";
import { buildOverlayRules, checkToolCall, readBaseline, resolveDecision } from "../permoverlay.ts";
import type { Decision, MatchCtx, OverlayRules } from "../permoverlay.ts";
import { ForemanReview, overlayAutoReview } from "../review.ts";
import type { OverlayAskEnv, RegistryLike, ReviewSession } from "../review.ts";
import { asyncResultReads, ownTaskReadable, ownUsageReadable, piScratchReadable } from "../roundsurface.ts";
import { childHandoffDirs } from "../owned.ts";
import { selfRulingRefusal } from "../ruling.ts";
import { dialogFamily, dialogReport } from "../dialogs.ts";
import { sanitizeTrace } from "../trace.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..", "..", "..");
type Case = { name: string; line: string; expect?: string; note?: string };
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "r16-auto-review.json"), "utf8")) as { friction: Case[]; hardDeny: Case[]; selfMod: Case[]; rulesFileWrite: Case; reviewable: Case[] };
const RULES_TEXT = fs.readFileSync(path.join(PKG, "config", "permissions.rules.md"), "utf8");
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r16-ar-")));
after(() => rmTestTmp(w));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const tmp = path.join(w, "tmp");
const SID = "01a16000-own";
const hand = path.join(ag, "pi-foreman", "handoffs");
// H: the own handoff dir (the chair writes its rulings there), C: another one; this session is the child of both
const H = path.join(hand, "own");
const C = path.join(hand, "up");
for (const d of [ws, path.join(ws, ".workflow", "scratch"), H, C, tmp]) fs.mkdirSync(d, { recursive: true });
for (const d of [H, C]) {
  fs.writeFileSync(path.join(d, "parent"), "chair\n");
  fs.writeFileSync(path.join(d, "child"), "me\n");
}
const fill = (line: string): string =>
  line.replace(/\{sid\}/g, SID).replace(/\{id\}/g, "bc00d3ee1").replace(/\{run\}/g, "abc123").replace(/\{other\}/g, "01a16999-other").replace(/\{tmp\}/g, inBash(tmp)).replace(/\{H\}/g, inBash(H)).replace(/\{C\}/g, inBash(C)).replace(/\{agentDir\}/g, inBash(ag));

const baseline = readBaseline(PKG)!;
// the project/session layer adds one bash ask rule (an ask the overlay enforces, no protect hit)
const rules: OverlayRules = buildOverlayRules(baseline, { ask: ["make deploy*"] }, { ask: [] }, ag, PKG, undefined, false);
// as index.ts builds the foreman's ctx: own bg outputs and .pi/scratch (ownTasks), own records (ownReads)
const ownTasks = [...ownTaskReadable([ws], SID), ...piScratchReadable([ws])];
const ownReads = [...ownUsageReadable(ag, process.platform, SID), ...ownTaskReadable([ws], SID), ...asyncResultReads([path.join(tmp, "pi-subagents-uid-501", "async-subagent-results", "abc123.json")])];
const main: MatchCtx = { cwd: ws, home, platform: process.platform, role: "main", ownTasks, ownReads };

const config = { providers: { a: { review: { model: "a/small", timeoutMs: 50 } } } };
type Stub = RegistryLike & { calls: number; sent: { system: string; text: string }[] };
const stub = (complete: () => Promise<{ content?: unknown; stopReason?: string }>): Stub => {
  const s: Stub = {
    calls: 0,
    sent: [],
    find: () => ({}),
    complete: (_m, context) => {
      s.calls++;
      const c = context as unknown as { systemPrompt: string; messages: { content: string }[] };
      s.sent.push({ system: c.systemPrompt, text: c.messages[0].content });
      return complete();
    },
  };
  return s;
};
const reply = (text: string): Stub => stub(async () => ({ content: [{ type: "text", text }], stopReason: "stop" }));
const ALLOW = '{"verdict":"allow"}';

interface Run {
  outcome: "pass" | "refused" | "deny" | "allow" | "dialog-denied";
  reason?: string;
  dialogs: number;
  decision: Decision | null;
}
async function run(line: string, reg: Stub, o: { env?: Partial<OverlayAskEnv>; rules?: OverlayRules; ctx?: MatchCtx; session?: Partial<ReviewSession> } = {}): Promise<Run> {
  const review = new ForemanReview();
  review.upsert("s", { isChild: o.env?.isChild ?? false, cwd: ws, provider: "a", config: () => config, registry: reg, intent: "run the round", ...o.session });
  const g = await selfRulingRefusal("bash", { command: line }, ws, childHandoffDirs(hand, "me"), {});
  if (g) return { outcome: "refused", reason: g, dialogs: 0, decision: null };
  const d = checkToolCall(o.rules ?? rules, "bash", { command: line }, o.ctx ?? main);
  const env: OverlayAskEnv = { enabled: true, isChild: false, mode: "tui", hasUI: true, session: SID, rules: () => RULES_TEXT, ...o.env };
  const auto = await overlayAutoReview(review, "s", d, "bash", { command: line }, env);
  if (auto === "allow") return { outcome: "allow", dialogs: 0, decision: d };
  if (auto) return { outcome: "deny", reason: auto.reason, dialogs: 0, decision: d };
  let dialogs = 0;
  const r = await resolveDecision(d, { isChild: env.isChild, mode: env.mode, hasUI: env.hasUI, confirm: async () => (dialogs++, false) });
  return { outcome: !r ? "pass" : d?.kind === "deny" || env.isChild || !env.hasUI ? "deny" : "dialog-denied", reason: r?.reason, dialogs, decision: d };
}

for (const c of FX.friction) {
  test(`r16 friction ${c.name}: ${c.expect} with an allowing stub`, async () => {
    const reg = reply(ALLOW);
    const r = await run(fill(c.line), reg);
    if (c.expect === "pass") assert.deepEqual([r.outcome, r.dialogs], ["pass", 0]);
    else if (c.expect === "refused") assert.deepEqual([r.outcome, r.reason, r.dialogs], ["refused", "a session cannot write its own parent's ruling", 0]);
    else if (c.expect === "dialog") assert.deepEqual([r.outcome, r.dialogs, r.decision?.selfMod], ["dialog-denied", 1, true]);
    else assert.fail(`unknown expect ${c.expect}`);
    assert.equal(reg.calls, 0, "no model call");
  });
}

for (const c of FX.reviewable) {
  test(`r16 reviewable ${c.name}: an allowing stub resolves the overlay ask with no dialog`, async () => {
    const reg = reply(ALLOW);
    const r = await run(fill(c.line), reg);
    assert.equal(r.decision?.kind, "ask");
    assert.equal(r.decision?.selfMod, undefined);
    assert.deepEqual([r.outcome, r.dialogs, reg.calls], ["allow", 0, 1]);
    // the rules replace the Allow/Deny/Defer paragraph; the rule/path line sits inside an UNTRUSTED fence; the whole prompt fits the budget
    const { system, text } = reg.sent[0];
    assert.ok(system.includes(RULES_TEXT.trim()));
    assert.ok(!system.includes("Allow: read-only inspection"));
    const ask = /BEGIN UNTRUSTED ASK (\w+)\n(rule: [^\n]*)\nEND UNTRUSTED ASK \1/.exec(text);
    assert.ok(ask, text);
    assert.match(ask[2], new RegExp(`^rule: ${r.decision!.rule!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| path: `));
    assert.ok(text.includes(fill(c.line)));
    assert.ok(!text.includes("Owned roots"));
    assert.ok(system.length + text.length <= 4000, String(system.length + text.length));
  });
}

test("r16 reviewer deny high/critical blocks with its reason; soft deny and defer go to the dialog", async () => {
  const line = fill(FX.reviewable[0].line);
  const hard = await run(line, reply('{"verdict":"deny","reason":"no","riskLevel":"high"}'));
  assert.deepEqual([hard.outcome, hard.reason, hard.dialogs], ["deny", "model review: no", 0]);
  for (const t of ['{"verdict":"deny","reason":"meh","riskLevel":"medium"}', '{"verdict":"defer"}']) {
    const r = await run(line, reply(t));
    assert.deepEqual([r.outcome, r.dialogs], ["dialog-denied", 1], t);
  }
});

for (const c of FX.hardDeny) {
  test(`r16 hard_deny ${c.name}: denied with no model call`, async () => {
    const reg = reply(ALLOW);
    const r = await run(fill(c.line), reg);
    assert.equal(r.outcome, c.expect === "deny" ? "deny" : "refused");
    if (c.expect === "deny") assert.equal(r.decision?.kind, "deny");
    assert.deepEqual([r.dialogs, reg.calls], [0, 0]);
  });
}

for (const c of FX.selfMod) {
  test(`r16 selfMod ${c.name}: the human dialog, no model call`, async () => {
    const reg = reply(ALLOW);
    const r = await run(fill(c.line), reg);
    assert.deepEqual([r.decision?.kind, r.decision?.selfMod, r.outcome, r.dialogs, reg.calls], ["ask", true, "dialog-denied", 1, 0]);
    // a later (non-protect) ask of a line with a protect hit carries selfMod too
    if (c.name === "probe_ask_after_protect_hit") assert.equal(r.decision?.rule, "toolchain-probe");
  });
}

test(`r16 selfMod ${FX.rulesFileWrite.name}: the user's rules file is a protect target, never reviewed`, async () => {
  const withFile = buildOverlayRules(baseline, { autoReview: { rulesFile: "my-rules.md" } }, { autoReview: { rulesFile: "my-rules.md" } }, ag, PKG, undefined, false);
  const reg = reply(ALLOW);
  const r = await run(fill(FX.rulesFileWrite.line), reg, { rules: withFile });
  assert.deepEqual([r.decision?.kind, r.decision?.selfMod, r.dialogs, reg.calls], ["ask", true, 1, 0]);
  // without the key the same write is no ask at all (the file is not protected)
  assert.equal(checkToolCall(rules, "bash", { command: fill(FX.rulesFileWrite.line) }, main), null);
});

test("r16 stub throw, hang (timeout) and garbage: the human dialog", async () => {
  const line = fill(FX.reviewable[0].line);
  const regs = [stub(async () => { throw new Error("boom"); }), stub(() => new Promise(() => {})), reply("looks fine to me"), reply("")];
  for (const reg of regs) {
    const t0 = Date.now();
    const r = await run(line, reg);
    assert.deepEqual([r.outcome, r.dialogs, reg.calls], ["dialog-denied", 1, 1]);
    assert.ok(Date.now() - t0 < 2000);
  }
});

test("r16 no model, no rules, over budget: the human dialog", async () => {
  const line = fill(FX.reviewable[0].line);
  const noModel = await run(line, reply(ALLOW), { session: { config: () => ({}) } });
  assert.deepEqual([noModel.outcome, noModel.dialogs], ["dialog-denied", 1]);
  const reg = reply(ALLOW);
  const noRules = await run(line, reg, { env: { rules: () => { throw new Error("gone"); } } });
  assert.deepEqual([noRules.outcome, noRules.dialogs, reg.calls], ["dialog-denied", 1, 0]);
  const big = reply(ALLOW);
  const long = await run(`make deploy-docs ${"x".repeat(3000)}`, big);
  assert.deepEqual([long.decision?.kind, long.outcome, long.dialogs, big.calls], ["ask", "dialog-denied", 1, 0]);
});

test("r16 flag off, child, no UI: today's path, no model call", async () => {
  const line = fill(FX.reviewable[0].line);
  const d = checkToolCall(rules, "bash", { command: line }, main);
  const today = await resolveDecision(d, { isChild: false, mode: "tui", hasUI: true, confirm: async () => false });
  const reg = reply(ALLOW);
  const off = await run(line, reg, { env: { enabled: false } });
  assert.deepEqual([off.outcome, off.reason, off.dialogs, reg.calls], ["dialog-denied", today?.reason, 1, 0]);
  assert.deepEqual(off.decision, d);
  const child = await run(line, reg, { env: { isChild: true } });
  assert.equal(child.reason, (await resolveDecision(d, { isChild: true, mode: "tui", hasUI: true }))?.reason);
  assert.equal(child.dialogs, 0);
  for (const env of [{ mode: "print", hasUI: false }, { mode: "json", hasUI: false }, { mode: "tui", hasUI: false }]) {
    const r = await run(line, reg, { env });
    assert.equal(r.reason, (await resolveDecision(d, { isChild: false, ...env }))?.reason);
  }
  assert.equal(reg.calls, 0);
});

test("r16 foreman_dialogs counts the family auto_review_allow", () => {
  const line = fill(FX.reviewable[0].line);
  const file = path.join(w, "trace.jsonl");
  // the records index.ts overlayBlock emits: an auto reviewer allow (event auto_review_allow) and a dialog (overlay ask-*)
  const recs = [
    { event: "auto_review_allow", toolFamily: "bash", family: dialogFamily(line), rule: "toolchain-probe", command: line },
    { event: "auto_review_allow", toolFamily: "bash", family: dialogFamily("make deploy-docs"), rule: "make deploy*", command: "make deploy-docs" },
    { event: "overlay", toolFamily: "bash", decision: "ask-denied", class: "other", command: "make deploy-docs", reason: "x", role: "foreman" },
  ].map((r) => sanitizeTrace({ ts: "t", ...r }));
  assert.equal(recs[0].family, dialogFamily(line));
  assert.equal(recs[1].rule, "make deploy*");
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const rep = dialogReport(file);
  assert.equal(rep.auto_review_allow.count, 2);
  assert.deepEqual(rep.auto_review_allow.lines.map((l) => l.length > 0), [true, true]);
  assert.equal(rep.other.count, 1);
});
