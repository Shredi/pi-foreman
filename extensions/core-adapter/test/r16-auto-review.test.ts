// r79 item 11: the review is the classifier now and only a call of the dangerous class reaches it. A line that no rule decides and that is not
// dangerous runs in mode auto (`allowed:mode:no-rule`, no model call); a selfmod rule hit asks the owner (`dialog:selfmod:comment`); the closed
// verdict is allow/deny citing a whitelist entry, or escalate, and anything else escalates (`dialog:danger:comment`).
// R41 (item 23): the r16 fixture lines (test/fixtures/r16-auto-review.json) through the gate. The old auto reviewer (overlayAutoReview, the
// rules file, `kind: auto` reviews, auto_review_allow) is retired; the same lines now run through the real adapter (test/_r11rig.ts):
// tool_call -> the gate (floors, path rules, defaults, review with a closed verdict, dialog) -> the later guards. The outcome is read from
// the gate's trace records ({event: "guard", guard: "gate", decision, rule} and {event: "dialog", guard: "gate", cause, decision, rule}),
// the dialogs from a counted ctx.ui.select, the review calls from a stubbed model registry.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";
import { SHELL_WRITE_REFUSAL } from "../shellwriteguard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
type Case = { name: string; line: string; gate?: string; note?: string };
type ToolCase = { name: string; tool: string; input: Record<string, unknown>; gate?: string };
type VerdictCase = { name: string; reply: string; gate: string };
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "r16-auto-review.json"), "utf8")) as { friction: Case[]; hardDeny: Case[]; selfMod: Case[]; cdRelativeGaps: Case[]; selfModTool: ToolCase[]; reviewable: Case[]; verdicts: VerdictCase[] };
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const verdict = (v: string, entry: string): string => JSON.stringify({ verdict: v, entry, reason: `because ${entry}` });
const ALLOW = verdict("allow", "A1");

// the stubbed reviewer: `answer` is set per call; every model call is counted and its prompt kept
type Reply = { content?: unknown; stopReason?: string };
const text = (t: string) => async (): Promise<Reply> => ({ content: [{ type: "text", text: t }], stopReason: "stop" });
let answer: () => Promise<Reply> = text(ALLOW);
let found = true;
let calls = 0;
const sent: { system: string; text: string }[] = [];
const modelRegistry = {
  find: () => (found ? { id: "m" } : undefined),
  getProviderAuthStatus: () => ({ configured: false }),
  complete: (_m: unknown, context: unknown) => {
    calls++;
    const c = context as { systemPrompt: string; messages: { content: string }[] };
    sent.push({ system: c.systemPrompt, text: c.messages[0].content });
    return answer();
  },
};
// the human: every dialog is counted and denied
let dialogs = 0;
const ui = { notify: () => undefined, confirm: async () => false, select: async () => (dialogs++, "deny with comment"), input: async () => "", setStatus: () => undefined, setWidget: () => undefined };
const config = (extra: Record<string, unknown> = {}) => ({ gate: { reviewTimeoutMs: 50 }, presence: { enabled: false }, providers: { fake: { roles: { review: { model: "m" }, ...Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } } }, ...extra });
/** The whitelist the classifier reads: A1 allows, D1 denies. */
const seedPerms = (r: { agentDir: string }): void => {
  fs.mkdirSync(path.join(r.agentDir, "pi-foreman"), { recursive: true });
  fs.writeFileSync(path.join(r.agentDir, "pi-foreman", "permissions.json"), JSON.stringify({ classifier: { allow: ["Read-only inspection"], deny: ["Never read secrets"] } }));
};

type Rig = Awaited<ReturnType<typeof r11Rig>>;
// rig: handoff and agent dir below the test base, outside every gate tmp root on every OS (the review path is exercised);
// withTmpRig: a rig in the OS temp dir for the one case that relies on the tmp class (os.tmpdir() is /tmp on Linux);
// r11Rig sets process.env for its session, so the main rig's env is put back afterwards
const rig = await r11Rig({ after }, {}, { ctx: { modelRegistry, ui }, config: config() });
seedPerms(rig);
async function withTmpRig<T>(fn: (r: Rig) => Promise<T>): Promise<T> {
  const keys = ["PI_CODING_AGENT_DIR", "PI_INTERCOM_SESSION_ID", "PI_SUBAGENT_CHILD"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    const tr = await r11Rig({ after }, {}, { ctx: { modelRegistry, ui }, config: config(), inTmp: true });
    seedPerms(tr);
    return await fn(tr);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
// every top-level await stays above the first test(): node runs the root after hooks (the rig's shutdown) once the registered tests are done

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
  /** `allowed:<rule>` / `blocked:<rule>` from the gate's guard record, `refused` for the self_ruling guard, `dialog:<cause>:<answer>` for the owner dialog, `pass` for no gate record. */
  outcome: string;
  block: { block?: boolean; reason?: string } | undefined;
  dialogs: number;
  calls: number;
  recs: Record<string, unknown>[];
}
async function run(tool: string, input: Record<string, unknown>, o: { reply?: string | (() => Promise<Reply>); rig?: Rig } = {}): Promise<Run> {
  const rg = o.rig ?? rig;
  answer = typeof o.reply === "function" ? o.reply : text(o.reply ?? ALLOW);
  const d0 = dialogs;
  const c0 = calls;
  const n0 = rg.trace().length;
  const block = await rg.call(tool, input);
  const recs = rg.trace().slice(n0);
  const g = recs.filter((x) => x.event === "guard" && x.guard === "gate");
  const dlg = recs.find((x) => x.event === "dialog" && x.guard === "gate");
  const last = g[g.length - 1];
  const outcome = dlg && !(last && last.decision === "allowed")
    ? `dialog:${dlg.cause}:${dlg.decision}`
    : last
      ? `${last.decision}:${last.rule}`
      : recs.some((x) => x.event === "guard" && x.guard === "self_ruling") ? "refused" : "pass";
  return { outcome, block, dialogs: dialogs - d0, calls: calls - c0, recs };
}
const bash = (line: string, o: { reply?: string | (() => Promise<Reply>) } = {}): Promise<Run> => run("bash", { command: fill(line) }, o);
const ASK = verdict("ask", "tool-config-edit");
const OK = "allowed:mode:no-rule";
// a line of the dangerous class (here: a toolchain probe / a write outside the worktree) reaches the classifier, whose stub allows with A1
const CLASSIFIED = "allowed:classifier:A1";
/** [outcome, dialogs, calls, blocked by a later guard]: what the gate decides for a fixture line under the named stub. */
type Expect = [string, number, number, boolean?];

// the allowing stub: friction lines and reviewable lines. A default allow needs no model; the rest is the review's allow. A line that a
// later guard (self_ruling, the shell write guard) still refuses is marked blocked: the gate's allow does not skip those.
const ALLOWING: Record<string, Expect> = {
  own_bg_output_cat: ["allowed:default-read", 0, 0],
  own_async_results_python_read: [CLASSIFIED, 0, 1], // r79 revision (finding C): an interpreter one-liner is danger-opaque, the classifier decides
  handoff_ruling_for_cat: [CLASSIFIED, 0, 1],
  cp_ruling_into_scratch: [OK, 0, 0, true],
  usage_ls_grep_node_version: [OK, 0, 0],
  pi_scratch_read: ["allowed:default-read", 0, 0],
  own_bg_output_chain: [OK, 0, 0],
  r16_f1_ruling_append_and_cp: [OK, 0, 0, true],
  toolchain_probe_pipe: [CLASSIFIED, 0, 1],
  project_settings_read_mention: [OK, 0, 0],
  other_session_state_read: [OK, 0, 0],
};
for (const c of [...FX.friction, ...FX.reviewable, ...FX.cdRelativeGaps.filter((x) => x.name in ALLOWING)]) {
  test(`r16 ${c.name}: ${ALLOWING[c.name]?.[0]} with an allowing stub`, async () => {
    const e = ALLOWING[c.name];
    assert.ok(e, `no expectation for ${c.name}`);
    const r = await bash(c.line);
    assert.deepEqual([r.outcome, r.dialogs, r.calls, r.block?.block === true], [e[0], e[1], e[2], e[3] === true], JSON.stringify(r.block));
  });
}

test("r16 hard_deny auth_json_read: floor-secret-path, no model call", async () => {
  const r = await bash(FX.hardDeny[0].line);
  assert.deepEqual([r.outcome, r.dialogs, r.calls, r.block?.block], ["blocked:floor-secret-path", 0, 0, true]);
});

test("r16 rig: the main rig's handoff and agent dir are outside the literal /tmp (the write root default-write-in uses), the tmp rig's in the OS temp dir", async () => {
  const under = (p: string, root: string): boolean => p === root || p.startsWith(`${root}${path.sep}`);
  assert.deepEqual([under(fs.realpathSync(H), "/tmp"), under(rig.agentDir, "/tmp")], [false, false]);
  await withTmpRig(async (r) => assert.equal(under(r.agentDir, fs.realpathSync(os.tmpdir())), true));
});

test("r16 hard_deny cp_into_child_handoff_ruling: the gate allows (mode auto), the self_ruling guard still refuses", async () => {
  const r = await bash(FX.hardDeny[1].line);
  assert.deepEqual([r.outcome, r.block?.block, r.recs.some((x) => x.event === "guard" && x.guard === "self_ruling")], [CLASSIFIED, true, true], JSON.stringify(r.block));
});

// a call of the dangerous class: the only kind that reaches the classifier
const DANGEROUS = "terraform apply -auto-approve";

// R41: the self-modification writes are a dialog by rule (selfmod.ts, plan 2.5): the owner gets one gate dialog and no model is called,
// whatever the stub answers. tee into the agent extensions is no selfmod rule: the review judges it.
const SM: Expect = ["dialog:selfmod:comment", 1, 0, true];
// ruling-10: a self-modification the foreman's edit mode refuses anyway as a shell write into project files gets the refusal before any dialog or model call
const REFUSED: Expect = ["pass", 0, 0, true];
const ASKING: Record<string, Expect> = {
  agentdir_settings_write: SM,
  other_session_state_write: SM,
  probe_ask_after_protect_hit: SM,
  redirect_into_pi_settings: REFUSED,
  cp_into_agent_settings: SM,
  tee_into_agent_extensions: ["dialog:danger:comment", 1, 1, true],
  rm_pi_settings: REFUSED,
  read_then_write_pi_settings: REFUSED,
  cd_then_redirect_into_pi: REFUSED,
  cd_agentdir_then_cp_settings: SM,
};
for (const c of [...FX.selfMod, ...FX.cdRelativeGaps.filter((x) => !(x.name in ALLOWING))]) {
  test(`r16 selfMod ${c.name}: ${ASKING[c.name]?.[0]} with an asking stub`, async () => {
    const e = ASKING[c.name];
    assert.ok(e, `no expectation for ${c.name}`);
    const r = await bash(c.line, { reply: ASK });
    assert.deepEqual([r.outcome, r.dialogs, r.calls, r.block?.block === true], [e[0], e[1], e[2], e[3] === true], JSON.stringify(r.block));
    if (e === REFUSED) assert.ok(r.block?.reason?.includes(SHELL_WRITE_REFUSAL), String(r.block?.reason));
  });
}

const TOOLS: Record<string, Expect> = {
  write_tool_agent_settings: SM,
  edit_tool_pi_settings: SM,
  copy_tool_into_agent_foreman_json: ["allowed:path-read-worktree", 0, 0],
};
for (const c of FX.selfModTool) {
  test(`r16 selfMod tool ${c.name}: ${TOOLS[c.name]?.[0]}, no model call`, async () => {
    const e = TOOLS[c.name];
    assert.ok(e, `no expectation for ${c.name}`);
    const r = c.name === "copy_tool_into_agent_foreman_json"
      ? await withTmpRig((tr) => run(c.tool, fillInput(c.input, tr), { reply: ASK, rig: tr }))
      : await run(c.tool, fillInput(c.input), { reply: ASK });
    assert.deepEqual([r.outcome, r.dialogs, r.calls, r.block?.block === true], [e[0], e[1], e[2], e[3] === true], JSON.stringify(r.block));
  });
}

// item 6: the closed verdict. Every reply is checked with a line of its own (a deny is cached per session by input).
FX.verdicts.forEach((c, i) => {
  test(`r16 verdict ${c.name}: ${c.gate}`, async () => {
    const r = await bash(`${DANGEROUS} # v${i}`, { reply: c.reply });
    const calls1 = c.gate.startsWith("dialog") ? 1 : 0;
    assert.deepEqual([r.outcome, r.dialogs, r.calls, r.block?.block], [c.gate, calls1, 1, true]);
    if (c.gate.startsWith("blocked:prose:")) assert.match(r.block?.reason ?? "", /^pi-foreman: denied by whitelist rule D1/);
  });
});

test("r16 unreachable review (throw, hang, no model): the owner dialog names the cause", async () => {
  const replies: [string, () => Promise<Reply>][] = [["provider_error", async (): Promise<Reply> => { throw new Error("boom"); }], ["timeout", () => new Promise<Reply>(() => {})]];
  for (const [cause, reply] of replies) {
    const r = await bash(`${DANGEROUS} # u-${cause}`, { reply });
    assert.equal(r.outcome, "dialog:danger:comment", r.outcome);
    assert.deepEqual([r.dialogs, r.calls, r.block?.block], [1, 1, true]);
    assert.equal(r.recs.find((x) => x.event === "review" && x.kind === "gate")?.cause ?? cause, cause);
  }
  found = false;
  try {
    const r = await bash(`${DANGEROUS} # u-none`);
    assert.deepEqual([r.outcome, r.dialogs, r.calls, r.block?.block], ["dialog:danger:comment", 1, 0, true]);
  } finally {
    found = true;
  }
});

test("r16 no UI: an escalate under a headless owner session is a silent deny with the no-pane text, no dialog", async () => {
  const ctx = rig.ctx as { mode: string; hasUI: boolean };
  for (const env of [{ mode: "print", hasUI: false }, { mode: "json", hasUI: false }]) {
    Object.assign(ctx, env);
    try {
      const r = await bash(`${DANGEROUS} # nui-${env.mode}`, { reply: verdict("escalate", null as never) });
      assert.deepEqual([r.dialogs, r.calls, r.block?.block], [0, 1, true]);
      assert.match(r.block?.reason ?? "", /nobody is at this session/);
    } finally {
      Object.assign(ctx, { mode: "tui", hasUI: true });
    }
  }
});
