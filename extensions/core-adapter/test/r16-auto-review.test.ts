// R16 P1 item 3: the auto reviewer in front of the overlay's ask dialog (review.ts overlayAutoReview, spliced into index.ts overlayBlock),
// with a stubbed reviewer (the rig's model registry answers `reply(text)` as in review.test.ts). Every fixture line runs through the
// real adapter (test/_r11rig.ts): tool_call -> the self_ruling guard (ruling.ts) -> overlayBlock (checkToolCall, the auto reviewer,
// today's dialog) -> the later guards. The outcome is read from the session's trace, the dialogs from a counted ctx.ui.confirm.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";
import { ForemanReview, overlayAutoReview } from "../review.ts";
import { dialogFamily, dialogReport } from "../dialogs.ts";
import { sanitizeTrace } from "../trace.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..", "..", "..");
type Case = { name: string; line: string; expect?: string; note?: string };
type ToolCase = { name: string; tool: string; input: Record<string, unknown> };
type VerdictCase = { name: string; reply: string; expect: string };
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "r16-auto-review.json"), "utf8")) as { friction: Case[]; hardDeny: Case[]; selfMod: Case[]; cdRelativeGaps: Case[]; selfModTool: ToolCase[]; rulesFileWrite: Case; reviewable: Case[]; verdicts: VerdictCase[] };
const RULES_TEXT = fs.readFileSync(path.join(PKG, "config", "permissions.rules.md"), "utf8");
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const ALLOW = '{"verdict":"allow"}';

// the stubbed reviewer: `answer` is set per call; every model call is counted and its prompt kept
type Reply = { content?: unknown; stopReason?: string };
const text = (t: string) => async (): Promise<Reply> => ({ content: [{ type: "text", text: t }], stopReason: "stop" });
let answer: () => Promise<Reply> = text(ALLOW);
let found = true;
let calls = 0;
const sent: { system: string; text: string }[] = [];
const modelRegistry = {
  find: () => (found ? { cost: { input: 1 } } : undefined),
  getProviderAuthStatus: () => ({ configured: true }),
  complete: (_m: unknown, context: unknown) => {
    calls++;
    const c = context as { systemPrompt: string; messages: { content: string }[] };
    sent.push({ system: c.systemPrompt, text: c.messages[0].content });
    return answer();
  },
};
// the human: every dialog is counted and denied
let dialogs = 0;
const ui = { notify: () => undefined, confirm: async () => (dialogs++, false), select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
// a short review timeout for the hang case; the review model is set, so no auto pick is needed
const reviewCfg = { providers: { fake: { review: { model: "fake/small", timeoutMs: 50 } } } };

type Rig = Awaited<ReturnType<typeof r11Rig>>;
const rig = await r11Rig({ after }, {}, { ctx: { modelRegistry, ui }, config: reviewCfg });
// every top-level await stays above the first test(): node runs the root after hooks (the rig's shutdown) once the registered tests are done
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
/** A second adapter with other user config; the env of the default rig (agent dir, intercom id) is put back for its later calls. */
async function variant(config: Record<string, unknown>): Promise<Rig> {
  const keep = { agentDir: process.env.PI_CODING_AGENT_DIR, intercom: process.env.PI_INTERCOM_SESSION_ID };
  const v = await r11Rig({ after }, {}, { ctx: { modelRegistry, ui }, config: { ...reviewCfg, ...config } });
  process.env.PI_CODING_AGENT_DIR = keep.agentDir;
  process.env.PI_INTERCOM_SESSION_ID = keep.intercom;
  return v;
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r16-ar-")));
after(() => rmTestTmp(tmp));
fs.mkdirSync(path.join(rig.project, ".workflow", "scratch"), { recursive: true });
// H: the own handoff dir (the chair writes its rulings there), C: another one; this session is the child of both
const H = rig.handoff("own", "child");
const C = rig.handoff("up", "child");
const fill = (line: string, r: Rig = rig): string =>
  line.replace(/~\/\.pi\/agent(?=\/)/g, inBash(r.agentDir)).replace(/\{sid\}/g, r.sessionId).replace(/\{id\}/g, "bc00d3ee1").replace(/\{run\}/g, "abc123").replace(/\{other\}/g, "01a16999-other").replace(/\{tmp\}/g, inBash(tmp)).replace(/\{H\}/g, inBash(H)).replace(/\{C\}/g, inBash(C)).replace(/\{agentDir\}/g, inBash(r.agentDir));
const fillInput = (input: Record<string, unknown>, r: Rig = rig): Record<string, unknown> => JSON.parse(fill(JSON.stringify(input), r)) as Record<string, unknown>;

interface Run {
  /** pass: no overlay record; refused: the self_ruling guard; allow: auto_review_allow; deny: a deterministic overlay deny; model-deny: the reviewer's deny; dialog-denied: the human said no. */
  outcome: string;
  block: { block?: boolean; reason?: string } | undefined;
  dialogs: number;
  calls: number;
  recs: Record<string, unknown>[];
}
async function run(tool: string, input: Record<string, unknown>, o: { reply?: string | (() => Promise<Reply>); r?: Rig } = {}): Promise<Run> {
  const r = o.r ?? rig;
  answer = typeof o.reply === "function" ? o.reply : text(o.reply ?? ALLOW);
  const d0 = dialogs;
  const c0 = calls;
  const n0 = r.trace().length;
  const block = await r.call(tool, input);
  const recs = r.trace().slice(n0);
  const ov = recs.find((x) => x.event === "overlay");
  const outcome = recs.some((x) => x.event === "guard" && x.guard === "self_ruling")
    ? "refused"
    : recs.some((x) => x.event === "auto_review_allow")
      ? "allow"
      : !ov
        ? recs.some((x) => x.event === "guard" && x.guard === "gate" && x.decision === "blocked") ? "deny" : "pass" // R41: a floor denies in the gate, before any overlay record
        : ov.decision === "deny"
          ? ov.by === "auto" ? "model-deny" : "deny"
          : String(ov.decision);
  return { outcome, block, dialogs: dialogs - d0, calls: calls - c0, recs };
}
const bash = (line: string, o: { reply?: string | (() => Promise<Reply>); r?: Rig } = {}): Promise<Run> => run("bash", { command: fill(line, o.r) }, o);

for (const c of FX.friction) {
  test(`r16 friction ${c.name}: ${c.expect} with an allowing stub`, async () => {
    const r = await bash(c.line);
    if (c.expect === "pass") assert.deepEqual([r.outcome, r.dialogs, r.calls], ["pass", 0, 0]);
    else if (c.expect === "refused") assert.deepEqual([r.outcome, r.block?.reason, r.dialogs, r.calls], ["refused", "pi-foreman: a session cannot write its own parent's ruling.", 0, 0]);
    else if (c.expect === "allow") assert.deepEqual([r.outcome, r.dialogs, r.calls], ["allow", 0, 1]);
    else assert.fail(`unknown expect ${c.expect}`);
  });
}

for (const c of FX.reviewable) {
  test(`r16 reviewable ${c.name}: an allowing stub resolves the overlay ask with no dialog`, async () => {
    const r = await bash(c.line);
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["allow", 0, 1]);
    assert.ok(r.recs.find((x) => x.event === "auto_review_allow")!.rule);
    // the rules replace the Allow/Deny/Defer paragraph; the rule/path line sits inside an UNTRUSTED fence; the whole prompt fits the budget
    const { system, text: req } = sent[sent.length - 1];
    assert.ok(system.includes(RULES_TEXT.trim()));
    assert.ok(!system.includes("Allow: read-only inspection"));
    const ask = /BEGIN UNTRUSTED ASK (\w+)\n(rule: [^\n]*)\nEND UNTRUSTED ASK \1/.exec(req);
    assert.ok(ask, req);
    assert.match(ask[2], /^rule: \S.* \| path: .* \| surface: bash$/);
    assert.ok(req.includes(fill(c.line)));
    assert.ok(!req.includes("Owned roots"));
    assert.ok(system.length + req.length <= 4000, String(system.length + req.length));
  });
}

for (const c of FX.verdicts) {
  test(`r16 verdict ${c.name}: ${c.expect === "deny" ? "blocked with the reviewer's reason, no dialog" : "the human dialog"}`, async () => {
    const r = await bash(FX.reviewable[0].line, { reply: c.reply });
    if (c.expect === "deny") assert.deepEqual([r.outcome, r.block?.reason, r.dialogs, r.calls], ["model-deny", "model review: no", 0, 1]);
    else assert.deepEqual([r.outcome, r.dialogs, r.calls], ["ask-denied", 1, 1]);
  });
}

for (const c of FX.hardDeny) {
  test(`r16 hard_deny ${c.name}: denied with no model call`, async () => {
    const r = await bash(c.line);
    assert.equal(r.outcome, c.expect === "deny" ? "deny" : "refused");
    assert.ok(r.block?.block);
    assert.deepEqual([r.dialogs, r.calls], [0, 0]);
  });
}

for (const c of FX.selfMod) {
  test(`r16 selfMod ${c.name}: the human dialog, no model call`, async () => {
    const r = await bash(c.line);
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["ask-denied", 1, 0]);
  });
}

for (const c of FX.cdRelativeGaps) {
  test(`r16 known gap ${c.name}: today's outcome ${c.expect} (a cd-relative target is not resolved)`, async () => {
    const r = await bash(c.line);
    assert.deepEqual([r.outcome, r.dialogs, r.calls], c.expect === "allow" ? ["allow", 0, 1] : ["pass", 0, 0]);
  });
}

for (const c of FX.selfModTool) {
  test(`r16 selfMod tool ${c.name}: the human dialog, no model call`, async () => {
    const r = await run(c.tool, fillInput(c.input));
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["ask-denied", 1, 0]);
  });
}

test(`r16 selfMod ${FX.rulesFileWrite.name}: the user's rules file is a protect target, never reviewed`, async () => {
  // without the key the same write is no overlay ask at all (the file is not protected)
  const plain = await bash(FX.rulesFileWrite.line);
  assert.deepEqual([plain.outcome, plain.dialogs, plain.calls], ["pass", 0, 0]);
  const v = await variant({ safety: { permissions: { autoReview: { rulesFile: "my-rules.md" } } } });
  fs.writeFileSync(path.join(v.agentDir, "my-rules.md"), RULES_TEXT);
  const r = await bash(FX.rulesFileWrite.line, { r: v });
  assert.deepEqual([r.outcome, r.dialogs, r.calls], ["ask-denied", 1, 0]);
});

test("r16 stub throw, hang (timeout) and garbage: the human dialog", async () => {
  const replies = [async (): Promise<Reply> => { throw new Error("boom"); }, () => new Promise<Reply>(() => {}), text("looks fine to me"), text("")];
  for (const reply of replies) {
    const t0 = Date.now();
    const r = await bash(FX.reviewable[0].line, { reply });
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["ask-denied", 1, 1]);
    assert.ok(Date.now() - t0 < 5000);
  }
});

test("r16 no model, no rules, over budget: the human dialog", async () => {
  found = false;
  try {
    const noModel = await bash(FX.reviewable[0].line);
    assert.deepEqual([noModel.outcome, noModel.dialogs, noModel.calls], ["ask-denied", 1, 0]);
  } finally {
    found = true;
  }
  const v = await variant({ safety: { permissions: { autoReview: { rulesFile: "missing-rules.md" } } } });
  const noRules = await bash(FX.reviewable[0].line, { r: v });
  assert.deepEqual([noRules.outcome, noRules.dialogs, noRules.calls], ["ask-denied", 1, 0]);
  const long = await bash(`${FX.reviewable[0].line} ${"x".repeat(3000)}`);
  assert.deepEqual([long.outcome, long.dialogs, long.calls], ["ask-denied", 1, 0]);
});

test("r16 flag off: today's path byte for byte (block reason and overlay record as a deferring reviewer), no model call", async () => {
  const strip = (rec: Record<string, unknown> | undefined) => { const { ts: _t, ...rest } = rec ?? {}; return rest; };
  const today = await bash(FX.reviewable[0].line, { reply: '{"verdict":"defer"}' });
  const v = await variant({ safety: { permissions: { autoReview: { enabled: false } } } });
  const off = await bash(FX.reviewable[0].line, { r: v });
  assert.deepEqual([off.outcome, off.dialogs, off.calls], ["ask-denied", 1, 0]);
  assert.deepEqual(off.block, today.block);
  assert.deepEqual(strip(off.recs.find((x) => x.event === "overlay")), strip(today.recs.find((x) => x.event === "overlay")));
  assert.ok(!off.recs.some((x) => x.event === "review"));
});

test("r16 no UI: today's block, no dialog, no model call", async () => {
  const ctx = rig.ctx as { mode: string; hasUI: boolean };
  for (const env of [{ mode: "print", hasUI: false }, { mode: "json", hasUI: false }, { mode: "tui", hasUI: false }]) {
    Object.assign(ctx, env);
    try {
      const r = await bash(FX.reviewable[0].line);
      assert.deepEqual([r.outcome, r.dialogs, r.calls], ["ask-denied", 0, 0]);
      assert.match(r.block?.reason ?? "", new RegExp(`Needs approval, no UI \\(mode: ${env.mode}\\)\\.$`));
    } finally {
      Object.assign(ctx, { mode: "tui", hasUI: true });
    }
  }
});

test("r16 child: overlayAutoReview reaches the model headless (R18 ruling: allowed)", async () => {
  const before = calls;
  const review = new ForemanReview();
  review.upsert("c", { isChild: true, cwd: rig.project, provider: "fake", config: () => reviewCfg, registry: modelRegistry as never, intent: "" });
  const out = await overlayAutoReview(review, "c", { kind: "ask", reason: "x", rule: "toolchain-probe" }, "bash", { command: "ls ~/.local/bin | head -3" }, { enabled: true, isChild: true, mode: "json", hasUI: false, requester: "subagent explorer", rules: () => RULES_TEXT });
  assert.deepEqual([out, calls - before], ["allow", 1]);
  assert.ok(sent[sent.length - 1].text.includes("requester: subagent explorer"));
});

test("r16 the splice in overlayBlock: allow, model deny, a later guard after an allow, defer", { skip: py.ok ? false : "no python for the later guards" }, async () => {
  // a fresh adapter: the shared one has spent its read budget (a later layer that would block the allowed reads here)
  const r = await variant({});
  // allow: no dialog, the call goes on, an auto_review_allow record that foreman_dialogs counts
  const allow = await bash(FX.reviewable[0].line, { r });
  assert.deepEqual([allow.block, allow.dialogs, allow.calls], [undefined, 0, 1], JSON.stringify(allow.recs));
  const rec = allow.recs.find((x) => x.event === "auto_review_allow")!;
  assert.deepEqual([rec.toolFamily, rec.family, rec.rule], ["bash", dialogFamily(fill(FX.reviewable[0].line)), "toolchain-probe"]);
  assert.ok(!allow.recs.some((x) => x.event === "overlay"));
  const dir = path.join(r.agentDir, "pi-foreman", "state");
  const traceFile = path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl"))!);
  assert.ok(dialogReport(traceFile).auto_review_allow.count >= 1);
  // model deny: blocked with the reviewer's reason, an overlay deny record by the reviewer
  const deny = await bash(FX.reviewable[0].line, { r, reply: '{"verdict":"deny","reason":"no","riskLevel":"critical"}' });
  assert.deepEqual([deny.block, deny.dialogs, deny.calls], [{ block: true, reason: "model review: no" }, 0, 1]);
  assert.deepEqual([deny.recs.find((x) => x.event === "overlay")?.decision, deny.recs.find((x) => x.event === "overlay")?.by], ["deny", "auto"]);
  // the guards after the overlay still run: the reviewer's allow does not skip them (here the shell write guard refuses the rm)
  const later = await bash(`${FX.reviewable[0].line}; rm -rf -- "$1"/*`, { r });
  assert.deepEqual([later.outcome, later.dialogs, later.calls], ["allow", 0, 1]);
  assert.ok(later.block?.block, JSON.stringify(later.block));
  assert.match(later.block!.reason!, /shell write into project files refused/);
  // defer: today's dialog
  const defer = await bash(FX.reviewable[0].line, { r, reply: '{"verdict":"defer"}' });
  assert.deepEqual([defer.outcome, defer.dialogs, defer.calls], ["ask-denied", 1, 1]);
  assert.match(defer.block?.reason ?? "", /^Denied by the user\. /);
});

test("r16 foreman_dialogs counts the family auto_review_allow", () => {
  const line = fill(FX.reviewable[0].line);
  const file = path.join(tmp, "trace.jsonl");
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
