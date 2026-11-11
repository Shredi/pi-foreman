// The foreman_script tool on the adapter: the owner's dialog (approve, revise, reject), pending without an answer, the dry run on
// approve, the silent-fix notice, the trace records, and who may call it. The rules themselves are tested in scriptapproval.test.ts
// and scriptrun.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { sha256 } from "../checkpoint.ts";
import { shortHash } from "../scriptapproval.ts";
import { applyVariants } from "../ledgercall.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Result = { details?: Record<string, unknown>; content: { text: string }[]; isError?: boolean };
type Tool = { name: string; execute: (...a: unknown[]) => Promise<Result> };

const KEYS = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_PARENT_INTERCOM", "HERDR_ENV", "HERDR_PANE_ID"];
const SCRIPT = ".workflow/scratch/set-key.sh";
const TEXTS = { description: "Sets one key in the user config.", risk: "A wrong value in the user config.", undo: "Run the script again with the old value." };
const skipWin = { skip: process.platform === "win32" };

interface RigOpts {
  /** The owner's answer to the script dialog; undefined = dismissed. May edit files first. */
  answer?: () => string | undefined;
  note?: string;
  mode?: string;
  hasUI?: boolean;
  /** Opened by a parent session, with a handoff dir (parent-ruling checkpoint mode). */
  parent?: boolean;
  /** "unregistered": the extension loads in a subagent child; "runtime": the session is a subagent child after the tools were registered. */
  child?: "unregistered" | "runtime";
  config?: unknown;
  /** The platform the adapter is told it runs on. */
  platform?: string;
}

async function rig(t: import("node:test").TestContext, o: RigOpts = {}) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(mkTestTmp("pf-scripttool-"));
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    try { await shutdown?.(); } catch { /* best effort */ }
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const handoff = path.join(root, "handoff");
  const scratch = path.join(project, ".workflow", "scratch");
  for (const d of [scratch, path.join(project, ".git"), agentDir, handoff]) fs.mkdirSync(d, { recursive: true });
  const mark = path.join(root, "ran.txt");
  const file = path.join(project, SCRIPT);
  const text = `# honours --dry-run\necho "mode:\${1:-real}" >> '${mark}'\necho "would set the key ($1)"\n`;
  fs.writeFileSync(file, text);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  for (const k of ["PI_SUBAGENT_CHILD", "PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_PARENT_INTERCOM", "HERDR_PANE_ID"]) delete process.env[k];
  process.env.HERDR_ENV = "1";
  if (o.parent) {
    process.env.PI_FOREMAN_HANDOFF_DIR = handoff;
    process.env.PI_FOREMAN_PARENT_INTERCOM = "parent-1";
  }
  if (o.child === "unregistered") process.env.PI_SUBAGENT_CHILD = "1";
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify(o.config ?? { trace: { enabled: true } }));
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const blocked: { active: boolean; label?: string }[] = [];
  const pi = {
    events: { on: () => undefined, emit: (ch: string, d: unknown) => void (ch === "herdr:blocked" && blocked.push(d as { active: boolean; label?: string })) },
    on: (n: string, h: Handler) => {
      const prev = handlers.get(n);
      // tool_call: the first block wins; any other event runs every handler
      handlers.set(n, !prev ? h : n === "tool_call" ? async (e, c) => (await prev(e, c)) ?? (await h(e, c)) : async (e, c) => { const r = await prev(e, c); const r2 = await h(e, c); return r ?? r2; });
    },
    registerCommand: () => undefined,
    registerTool: (x: Tool) => void tools.set(x.name, x),
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }, { name: "subagent" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    getThinkingLevel: () => "high",
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never, o.platform ? { platform: o.platform } : {});
  if (o.child === "runtime") process.env.PI_SUBAGENT_CHILD = "1";
  const seen = { titles: [] as string[], choices: [] as string[][], notices: [] as string[], inputs: 0, blockedAtSelect: [] as boolean[] };
  const ctx = {
    sessionManager: { getSessionId: () => "script-session", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    cwd: project,
    model: { provider: "fake", id: "foreman" },
    mode: o.mode ?? "tui",
    hasUI: o.hasUI ?? true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: {
      notify: (m: string) => void seen.notices.push(m),
      confirm: async () => false,
      // only the script dialog is answered; every other dialog (a gate ask) is dismissed
      select: async (title: string, choices: string[]) => {
        if (!title.startsWith("Run the owner script")) return undefined;
        seen.titles.push(title);
        seen.choices.push(choices);
        seen.blockedAtSelect.push(blocked.at(-1)?.active === true);
        return o.answer?.();
      },
      input: async () => (seen.inputs++, o.note),
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const raw = tools.get("foreman_script");
  const call = (params: Record<string, unknown>, signal?: AbortSignal): Promise<Result> => raw!.execute("c1", params, signal, undefined, ctx);
  const trace = (event: string): Record<string, unknown>[] => {
    const dir = path.join(agentDir, "pi-foreman", "state");
    const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.startsWith("trace-") && n.endsWith(".jsonl")) : undefined;
    const all = f ? fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
    return all.filter((r) => r.event === event);
  };
  return {
    registered: !!raw,
    description: String((raw as { description?: unknown } | undefined)?.description ?? ""),
    call,
    propose: () => call({ action: "propose", path: SCRIPT, ...TEXTS }),
    seen,
    blocked,
    trace,
    file,
    text,
    handoff,
    agentDir,
    root,
    /** Lines the script wrote, one per run; [] when it never ran. */
    runs: (): string[] => (fs.existsSync(mark) ? fs.readFileSync(mark, "utf8").split("\n").filter(Boolean) : []),
    logs: (): string[] => fs.readdirSync(scratch).filter((n) => n.endsWith(".log")),
    toolCall: (toolName: string, input: Record<string, unknown>) => handlers.get("tool_call")!({ toolName, toolCallId: "g1", input }, ctx),
    dialogs: async (): Promise<Record<string, { count: number }> & { total: number }> => JSON.parse((await tools.get("foreman_dialogs")!.execute("d1", {}, undefined, undefined, ctx)).content[0].text),
  };
}

const textOf = (r: Result): string => r.content[0]?.text ?? "";

test("foreman_script: approve runs the dry run at once and returns its output; the dialog shows summary, path and hash, not the body", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  const out = await r.propose();
  assert.equal(out.details?.decision, "approve", textOf(out));
  assert.equal(out.details?.by, "user");
  assert.equal(out.details?.status, "dry_ok");
  assert.equal(out.details?.exit, 0);
  assert.match(textOf(out), /would set the key \(--dry-run\)/);
  assert.match(textOf(out), /stop and propose again with a corrected description/);
  assert.deepEqual(r.runs(), ["mode:--dry-run"]);
  const short = shortHash(sha256(Buffer.from(r.text)));
  assert.deepEqual(r.seen.choices, [["approve", "revise", "reject"]], "approve first (owner decision 2026-11-11)");
  assert.equal(r.seen.titles.length, 1);
  assert.ok(r.seen.titles[0].includes("set-key.sh") && r.seen.titles[0].includes(short), r.seen.titles[0]);
  const notice = r.seen.notices.find((n) => n.startsWith("Description: "));
  assert.ok(notice, "the summary notice was sent");
  assert.deepEqual(notice.split("\n"), [`Description: ${TEXTS.description}`, `Risk: ${TEXTS.risk}`, `Undo: ${TEXTS.undo}`, `Path: ${SCRIPT}`, "Lines: 3", `sha256: ${short}`, "Undo through the tool: no (the script has no undo marker line)"]);
  assert.ok(!r.seen.notices.some((n) => n.includes("would set the key")), "the script body is not shown");
});

test("foreman_script: the real run follows the dry run, consumes the approval, and the trace keeps its records", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  await r.propose();
  const run = await r.call({ action: "run" });
  assert.equal(run.details?.decision, "run", textOf(run));
  assert.equal(run.details?.status, "consumed");
  assert.deepEqual(r.runs(), ["mode:--dry-run", "mode:real"]);
  const again = await r.call({ action: "run" });
  assert.equal(again.details?.code, "script_consumed");
  assert.deepEqual(r.runs(), ["mode:--dry-run", "mode:real"]);
  const status = JSON.parse(textOf(await r.call({ action: "status" }))) as { status: string; logs: string[] };
  assert.equal(status.status, "consumed");
  assert.equal(status.logs.length, 2);
  const short = shortHash(sha256(Buffer.from(r.text)));
  assert.deepEqual(r.trace("script").map((x) => [x.decision, x.by, x.hash]), [["approve", "user", short]]);
  const runs = r.trace("script_run");
  assert.deepEqual(runs.map((x) => [x.kind, x.hash, x.exit]), [["dry", short, 0], ["run", short, 0]]);
  assert.ok(runs.every((x) => typeof x.seconds === "number"), "seconds survives the trace writer");
  const stateDir = path.join(r.agentDir, "pi-foreman", "state");
  const stateFiles = fs.readdirSync(stateDir, { recursive: true, encoding: "utf8" }).filter((n) => !/^trace-[^/\\]*\.jsonl$/.test(n) && fs.statSync(path.join(stateDir, n)).isFile());
  for (const n of stateFiles) assert.ok(!fs.readFileSync(path.join(stateDir, n), "utf8").includes("set-key.sh"), `${n}: nothing about the approval is written to the state directory`);
});

test("foreman_script: the tool description and the rules text tell the foreman to stop on an unexpected dry run", async (t) => {
  const r = await rig(t);
  for (const want of ["POSIX sh", "LF line endings", "$0", "--dry-run", "DRY_RUN", "Read the dry-run output before run", "unexpected state or a different change than described, stop and propose again with a corrected description"]) assert.ok(r.description.includes(want), want);
  const rules = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "instructions", "foreman.md"), "utf8");
  const on = applyVariants(rules, { ownerScript: "on" });
  assert.match(on, /^### Owner scripts$/m);
  for (const want of ["foreman_script", "Read that output before `run`", "unexpected state or a different change than you described, stop", "Never run an owner script through the shell", "stays pending"]) assert.ok(on.includes(want), want);
  assert.ok(!applyVariants(rules, {}).includes("foreman_script"), "the rules are one tagged block");
});

test("foreman_script: reject spawns nothing", async (t) => {
  const r = await rig(t, { answer: () => "reject" });
  const out = await r.propose();
  assert.equal(out.details?.decision, "reject");
  assert.equal((await r.call({ action: "dry" })).details?.code, "script_pending");
  assert.equal((await r.call({ action: "run" })).details?.code, "script_pending");
  assert.deepEqual(r.runs(), []);
  assert.deepEqual(r.logs(), []);
});

test("foreman_script: revise returns the owner's note and spawns nothing", async (t) => {
  const r = await rig(t, { answer: () => "revise", note: "use the other key" });
  const out = await r.propose();
  assert.equal(out.details?.decision, "revise");
  assert.match(textOf(out), /use the other key/);
  assert.equal(r.seen.inputs, 1);
  assert.equal((await r.call({ action: "run" })).details?.code, "script_pending");
  assert.deepEqual(r.runs(), []);
});

for (const [name, o] of [
  ["no UI", { hasUI: false }],
  ["print mode", { mode: "print" }],
  ["json mode", { mode: "json" }],
] as [string, RigOpts][]) {
  test(`foreman_script: ${name} stays pending, opens no dialog and spawns nothing`, async (t) => {
    const r = await rig(t, { ...o, answer: () => "approve" });
    const out = await r.propose();
    assert.equal(out.details?.decision, "pending", textOf(out));
    assert.match(textOf(out), /stays pending/);
    assert.equal(r.seen.titles.length, 0);
    assert.equal((await r.call({ action: "dry" })).details?.code, "script_pending");
    assert.equal((await r.call({ action: "run" })).details?.code, "script_pending");
    assert.deepEqual(r.runs(), []);
    assert.deepEqual(r.logs(), []);
  });
}

test("foreman_script: a dismissed dialog stays pending and spawns nothing", async (t) => {
  const r = await rig(t, { answer: () => undefined });
  const out = await r.propose();
  assert.equal(out.details?.decision, "pending");
  assert.equal(r.seen.titles.length, 1);
  assert.equal((await r.call({ action: "run" })).details?.code, "script_pending");
  assert.deepEqual(r.runs(), []);
});

test("foreman_script: a script edited while the dialog is open stays pending", async (t) => {
  let file = "";
  const r = await rig(t, { answer: () => (fs.appendFileSync(file, "echo more\n"), "approve") });
  file = r.file;
  const out = await r.propose();
  assert.equal(out.details?.decision, "pending", textOf(out));
  assert.match(textOf(out), /changed while the dialog was open/);
  assert.equal((await r.call({ action: "dry" })).details?.code, "script_pending");
  assert.deepEqual(r.runs(), []);
});

test("foreman_script: the dialog runs inside the shared blocked helper", async (t) => {
  const r = await rig(t, { answer: () => "reject" });
  await r.propose();
  assert.deepEqual(r.seen.blockedAtSelect, [true], "blocked while the select is open");
  assert.equal(r.blocked.length, 2);
  assert.equal(r.blocked[0].active, true);
  assert.ok(r.blocked[0].label?.includes("set-key.sh"), r.blocked[0].label);
  assert.deepEqual(r.blocked[1], { active: false });
});

test("foreman_script: not registered in a subagent child", async (t) => {
  const r = await rig(t, { child: "unregistered" });
  assert.equal(r.registered, false);
});

test("foreman_script: a subagent child session is refused at runtime with script_child, whatever the action", async (t) => {
  const r = await rig(t, { child: "runtime", answer: () => "approve" });
  assert.equal(r.registered, true);
  for (const action of ["propose", "dry", "run", "status"]) {
    const out = await r.call({ action, ...(action === "propose" ? { path: SCRIPT, ...TEXTS } : {}) });
    assert.equal(out.details?.code, "script_child", action);
    assert.equal(out.isError, true);
  }
  assert.equal(r.seen.titles.length, 0);
  assert.deepEqual(r.runs(), []);
});

test("foreman_script: dry, run and status with a path refuse", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  await r.propose();
  for (const action of ["dry", "run", "status"]) {
    const out = await r.call({ action, path: SCRIPT });
    assert.equal(out.details?.code, "script_path", action);
    assert.match(textOf(out), /takes no path/);
  }
  assert.deepEqual(r.runs(), ["mode:--dry-run"], "only the dry run of the approve ran");
});

test("foreman_script: a second propose drops the first approval", skipWin, async (t) => {
  let answer: string | undefined = "approve";
  const r = await rig(t, { answer: () => answer });
  assert.equal((await r.propose()).details?.status, "dry_ok");
  answer = undefined;
  assert.equal((await r.propose()).details?.decision, "pending");
  assert.equal((await r.call({ action: "run" })).details?.code, "script_pending");
  assert.deepEqual(r.runs(), ["mode:--dry-run"]);
});

test("foreman_script: a ruling file in the handoff dir does not approve; without a UI the proposal stays pending", async (t) => {
  const r = await rig(t, { parent: true, hasUI: false, answer: () => "approve" });
  for (const f of ["ruling-plan.md", "ruling.md", "ruling-script.md"]) fs.writeFileSync(path.join(r.handoff, f), "APPROVED\n");
  const out = await r.propose();
  assert.equal(out.details?.decision, "pending", textOf(out));
  assert.equal((await r.call({ action: "run" })).details?.code, "script_pending");
  assert.deepEqual(r.runs(), []);
});

test("foreman_script: a session in parent-ruling mode still gets the dialog in its own window, and a REJECT there holds against an APPROVED file", async (t) => {
  const r = await rig(t, { parent: true, answer: () => "reject" });
  for (const f of ["ruling-plan.md", "ruling.md"]) fs.writeFileSync(path.join(r.handoff, f), "APPROVED\n");
  const out = await r.propose();
  assert.equal(r.seen.titles.length, 1);
  assert.equal(out.details?.decision, "reject");
  assert.deepEqual(r.runs(), []);
});

test("foreman_script: a small fix after approval reruns with a notice whose first line has the name and both short hashes", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  await r.propose();
  const fixed = r.text.replace("would set the key", "will set the key");
  fs.writeFileSync(r.file, fixed);
  const before = r.seen.notices.length;
  const run = await r.call({ action: "run" });
  assert.equal(run.details?.code, "script_dry_required", "a fixed script needs a new dry run");
  const from = shortHash(sha256(Buffer.from(r.text)));
  const to = shortHash(sha256(Buffer.from(fixed)));
  const notice = r.seen.notices.slice(before).find((n) => n.includes("changed after approval"));
  assert.ok(notice, "the notice is sent, also when the call is refused");
  const first = notice.split("\n")[0];
  assert.ok(first.includes("set-key.sh") && first.includes(from) && first.includes(to), first);
  assert.deepEqual(r.trace("script_fix").map((x) => [x.from, x.to, x.added, x.removed]), [[from, to, 1, 1]]);
  const dry = await r.call({ action: "dry" });
  assert.equal(dry.details?.status, "dry_ok", textOf(dry));
  assert.match(textOf(dry), /will set the key/);
  assert.equal(r.seen.titles.length, 1, "no second dialog");
});

test("foreman_script: safety.scripts.silentFixLines 0 turns the silent fix off; a larger change always needs a new dialog", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve", config: { trace: { enabled: true }, safety: { scripts: { silentFixLines: 0 } } } });
  await r.propose();
  fs.writeFileSync(r.file, r.text.replace("would set", "will set"));
  const out = await r.call({ action: "dry" });
  assert.equal(out.details?.code, "script_changed", textOf(out));
  assert.deepEqual(r.runs(), ["mode:--dry-run"]);
});

test("foreman_script: the dialogs counter counts surface script", async (t) => {
  const r = await rig(t, { answer: () => "reject" });
  await r.propose();
  const rep = await r.dialogs();
  assert.equal(rep.script.count, 1);
  assert.equal(rep.total, 1);
  assert.deepEqual(r.trace("dialog").map((x) => x.surface), ["script"]);
});

test("foreman_script: an open approval does not open the shell: a global install through bash is still stopped", skipWin, async (t) => {
  // presence off: an owner dialog of the gate awaits the presence probe otherwise (as _r11rig.ts)
  const r = await rig(t, { answer: () => "approve", config: { trace: { enabled: true }, presence: { enabled: false } } });
  const line = "npm install -g left-pad";
  const before = (await r.toolCall("bash", { command: line })) as { block?: boolean } | undefined;
  assert.equal(before?.block, true, "stopped before any approval");
  assert.equal(((await r.toolCall("bash", { command: "ls" })) as { block?: boolean } | undefined)?.block, undefined, "the rig's gate lets a harmless line through");
  assert.equal((await r.propose()).details?.status, "dry_ok");
  const during = (await r.toolCall("bash", { command: line })) as { block?: boolean } | undefined;
  assert.equal(during?.block, true, "stopped while the approval is open");
  await r.call({ action: "run" });
  const after = (await r.toolCall("bash", { command: line })) as { block?: boolean } | undefined;
  assert.equal(after?.block, true, "stopped after the approved run");
  // a shell call of the approved script is no way around the harness run either: the mark shows only the two harness runs
  assert.deepEqual(r.runs(), ["mode:--dry-run", "mode:real"]);
});

/** A rig told it runs on Windows, with Pi's shellPath setting in the agent dir; `shell` sets it again. */
async function winRig(t: import("node:test").TestContext) {
  const saved = { PI_BG_SHELL: process.env.PI_BG_SHELL, PI_BG_SHELL_PATH: process.env.PI_BG_SHELL_PATH };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const r = await rig(t, { answer: () => "approve", platform: "win32" });
  const shell = (p: string): void => fs.writeFileSync(path.join(r.agentDir, "settings.json"), JSON.stringify({ shellPath: p }));
  return { ...r, shell };
}

test("foreman_script: Pi's shellPath setting reaches the runner's shell resolution on Windows", skipWin, async (t) => {
  const r = await winRig(t);
  // an existing shell that is neither bash nor sh: only the setting can make the resolution refuse here
  r.shell("/bin/zsh");
  const refused = await r.propose();
  assert.equal(refused.details?.code, "no_posix_shell", textOf(refused));
  assert.match(textOf(refused), /set Pi's shellPath/);
  assert.deepEqual(r.runs(), []);
  assert.deepEqual(r.logs(), []);
  r.shell("/bin/sh");
  const dry = await r.call({ action: "dry" });
  assert.equal(dry.details?.status, "dry_ok", textOf(dry));
  assert.deepEqual(r.runs(), ["mode:--dry-run"]);
});

test("foreman_script: a real run refused with no_posix_shell is not one of the three attempts", skipWin, async (t) => {
  const r = await winRig(t);
  const status = async () => JSON.parse(textOf(await r.call({ action: "status" }))) as { status: string; attempts: number; attemptsLeft: number };
  r.shell("/bin/sh");
  assert.equal((await r.propose()).details?.status, "dry_ok");
  r.shell("/bin/zsh");
  for (let i = 0; i < 4; i++) assert.equal((await r.call({ action: "run" })).details?.code, "no_posix_shell", `refusal ${i + 1}`);
  const st = await status();
  assert.deepEqual([st.status, st.attempts, st.attemptsLeft], ["dry_ok", 0, 3]);
  assert.deepEqual(r.runs(), ["mode:--dry-run"]);
  r.shell("/bin/sh");
  const run = await r.call({ action: "run" });
  assert.equal(run.details?.status, "consumed", textOf(run));
  assert.equal((await status()).attempts, 1);
  assert.deepEqual(r.runs(), ["mode:--dry-run", "mode:real"]);
});

// ---- undo, status after a run, log names

const UNDO_MARKER = "# foreman-undo: supported";
type Rig = Awaited<ReturnType<typeof rig>>;

/** A script that logs `<$1 or real>:<DRY_RUN or none>` per run; with the marker unless `marker` is false; its undo exits 1 while `<root>/fail` exists. */
function undoScript(r: Rig, marker = true): string {
  const mark = path.join(r.root, "ran.txt");
  const text = `# honours --dry-run\n${marker ? `${UNDO_MARKER}\n` : ""}echo "\${1:-real}:\${DRY_RUN:-none}" >> '${mark}'\n[ "$1" = undo ] && [ -f '${path.join(r.root, "fail")}' ] && exit 1\nexit 0\n`;
  fs.writeFileSync(r.file, text);
  return text;
}

const statusOf = async (r: Rig) => JSON.parse(textOf(await r.call({ action: "status" }))) as Record<string, any>;

test("foreman_script: the dialog payload lists approve, revise, reject, and the notice with the undo line last comes before it, unshortened", skipWin, async (t) => {
  let before: string[] = [];
  let r: Rig | undefined;
  r = await rig(t, { answer: () => ((before = [...r!.seen.notices]), "reject") });
  undoScript(r);
  await r.propose();
  assert.deepEqual(r.seen.choices, [["approve", "revise", "reject"]]);
  assert.ok(before.some((n) => n.startsWith(`Description: ${TEXTS.description}\nRisk: ${TEXTS.risk}\nUndo: ${TEXTS.undo}\n`)), "summary notice before the select");
  assert.ok(before.some((n) => n.split("\n").at(-1)!.startsWith("Undo through the tool: yes")), "the undo ability is the last line of that notice");
  assert.ok(r.seen.titles[0].startsWith("Run the owner script set-key.sh (sha256 "));
});

test("foreman_script: the undo line says no for a script without the marker", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "reject" });
  undoScript(r, false);
  await r.propose();
  assert.ok(r.seen.notices.some((n) => n.split("\n").at(-1)!.startsWith("Undo through the tool: no")));
});

test("foreman_script: exactly one notice goes out before the select, with description, risk, undo and the undo line", skipWin, async (t) => {
  let atSelect: string[] = [];
  let r: Rig | undefined;
  r = await rig(t, { answer: () => ((atSelect = [...r!.seen.notices]), "reject") });
  undoScript(r);
  const start = r.seen.notices.length;
  await r.propose();
  assert.equal(atSelect.length - start, 1);
  const lines = atSelect[start].split("\n");
  assert.equal(lines.length, 7);
  assert.equal(lines[0], `Description: ${TEXTS.description}`);
  assert.equal(lines[1], `Risk: ${TEXTS.risk}`);
  assert.equal(lines[2], `Undo: ${TEXTS.undo}`);
  assert.ok(lines[6].startsWith("Undo through the tool: yes"));
});

test("foreman_script: undo is refused before any run and after only a dry run", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r);
  const none = await r.call({ action: "undo" });
  assert.equal(none.details?.code, "undo_no_proposal", textOf(none));
  await r.propose();
  const dryOnly = await r.call({ action: "undo" });
  assert.equal(dryOnly.details?.code, "undo_not_run", textOf(dryOnly));
  assert.deepEqual(r.runs(), ["--dry-run:1"]);
  const withPath = await r.call({ action: "undo", path: SCRIPT });
  assert.equal(withPath.details?.code, "script_path");
});

test("foreman_script: undo after a real run runs the stored bytes with the argument undo, whatever the file on disk is now", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r);
  await r.propose();
  await r.call({ action: "run" });
  fs.writeFileSync(r.file, "echo changed-after-the-run >> '" + path.join(r.root, "ran.txt") + "'\n");
  const first = await r.call({ action: "undo" });
  assert.equal(first.details?.exit, 0, textOf(first));
  assert.deepEqual(r.runs(), ["--dry-run:1", "real:none", "undo:none"], "$1 is undo, no DRY_RUN, the stored bytes ran");
  fs.rmSync(r.file);
  const again = await r.call({ action: "undo" });
  assert.equal(again.details?.code, "undo_done", textOf(again));
  assert.equal(r.runs().length, 3, "used once after exit 0");
  const notices = r.seen.notices.filter((n) => n.startsWith("Undo of "));
  assert.equal(notices.length, 1);
  assert.match(notices[0], /attempt 1 of 3/);
  const rec = r.trace("script_run").filter((x) => x.kind === "undo");
  assert.deepEqual(rec.map((x) => [x.exit, x.attempts]), [[0, 1]]);
});

test("foreman_script: undo is refused for a script without the marker, even after a real run", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r, false);
  await r.propose();
  await r.call({ action: "run" });
  const u = await r.call({ action: "undo" });
  assert.equal(u.details?.code, "undo_no_marker", textOf(u));
  assert.deepEqual(r.runs(), ["--dry-run:1", "real:none"]);
});

test("foreman_script: a failed undo is retried, three attempts in all, then refused", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r);
  await r.propose();
  await r.call({ action: "run" });
  fs.writeFileSync(path.join(r.root, "fail"), "");
  for (let i = 1; i <= 3; i++) {
    const u = await r.call({ action: "undo" });
    assert.equal(u.isError, true);
    assert.equal(u.details?.exit, 1, textOf(u));
    assert.match(textOf(u), new RegExp(`attempt ${i} of 3`));
  }
  const fourth = await r.call({ action: "undo" });
  assert.equal(fourth.details?.code, "undo_attempts", textOf(fourth));
  assert.equal(r.runs().filter((x) => x.startsWith("undo")).length, 3);
  const st = await statusOf(r);
  assert.deepEqual([st.undo.attempts, st.undo.attemptsLeft, st.undo.available], [3, 0, false]);
});

test("foreman_script: a failed undo can be followed by one that succeeds", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r);
  await r.propose();
  await r.call({ action: "run" });
  fs.writeFileSync(path.join(r.root, "fail"), "");
  assert.equal((await r.call({ action: "undo" })).details?.exit, 1);
  fs.rmSync(path.join(r.root, "fail"));
  assert.equal((await r.call({ action: "undo" })).details?.exit, 0);
  assert.equal((await r.call({ action: "undo" })).details?.code, "undo_done");
});

test("foreman_script: undo expires one hour after the real run and the text says a new propose is the way", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r);
  await r.propose();
  await r.call({ action: "run" });
  const real = Date.now();
  t.mock.method(Date, "now", () => real + 60 * 60 * 1000 - 1000);
  const st = await statusOf(r);
  assert.equal(st.undo.available, true);
  t.mock.method(Date, "now", () => real + 60 * 60 * 1000 + 1000);
  assert.equal((await statusOf(r)).undo.available, false);
  const u = await r.call({ action: "undo" });
  assert.equal(u.details?.code, "undo_expired", textOf(u));
  assert.match(textOf(u), /new propose/);
  assert.deepEqual(r.runs(), ["--dry-run:1", "real:none"]);
});

test("foreman_script: a new propose replaces the proposal and the old run cannot be undone", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r);
  await r.propose();
  await r.call({ action: "run" });
  await r.propose();
  const u = await r.call({ action: "undo" });
  assert.equal(u.details?.code, "undo_not_run", textOf(u));
  assert.match(textOf(u), /new propose/);
  assert.deepEqual(r.runs(), ["--dry-run:1", "real:none", "--dry-run:1"]);
});

test("foreman_script: a real run aborted before the script starts does not make undo available", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r);
  await r.propose();
  const ac = new AbortController();
  ac.abort();
  await r.call({ action: "run" }, ac.signal);
  assert.deepEqual(r.runs(), ["--dry-run:1"], "the script never ran");
  const st = await statusOf(r);
  assert.equal(st.ranAt, null);
  assert.equal(st.undo.available, false);
  const u = await r.call({ action: "undo" });
  assert.equal(u.details?.code, "undo_not_run", textOf(u));
});

test("foreman_script: undo is refused for a subagent child", skipWin, async (t) => {
  const r = await rig(t, { child: "runtime" });
  const u = await r.call({ action: "undo" });
  assert.equal(u.details?.code, "script_child", textOf(u));
  assert.deepEqual(r.runs(), []);
});

test("foreman_script: the status after a real run says the approval is used up, with the hash that ran, when, and the undo state", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  const text = undoScript(r);
  await r.propose();
  const before = await statusOf(r);
  assert.deepEqual([before.approvalUsed, before.attemptsLeft, before.ranHash, before.ranAt, before.undo.available], [false, 3, null, null, false]);
  const t0 = Date.now();
  await r.call({ action: "run" });
  const st = await statusOf(r);
  const hash = sha256(Buffer.from(text));
  assert.equal(st.status, "consumed");
  assert.equal(st.approvalUsed, true);
  assert.equal(st.attemptsLeft, 0);
  assert.equal(st.expiresAt, null);
  assert.equal(st.ranHash, hash);
  assert.ok(Math.abs(Date.parse(st.ranAt) - t0) < 60_000 && st.ranAt.endsWith("Z"), st.ranAt);
  assert.equal(st.hash, hash, "hash stays the proposed text's hash");
  assert.deepEqual([st.undo.supported, st.undo.available, st.undo.used, st.undo.attempts, st.undo.attemptsLeft], [true, true, false, 0, 3]);
  assert.equal(Date.parse(st.undo.availableUntil), Date.parse(st.ranAt) + 60 * 60 * 1000);
  await r.call({ action: "undo" });
  const after = await statusOf(r);
  assert.deepEqual([after.undo.available, after.undo.used, after.undo.attempts, after.undo.attemptsLeft], [false, true, 1, 0]);
});

test("foreman_script: log names keep .sh, count per kind (dry-1, dry-2, run-1, undo-1), name the undo kind and never reuse an existing log", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  const text = undoScript(r);
  const h8 = sha256(Buffer.from(text)).slice(0, 8);
  const scratch = path.dirname(r.file);
  const pre = `script-set-key.sh-${h8}`;
  fs.writeFileSync(path.join(scratch, `${pre}-dry-2.log`), "older log\n");
  await r.propose(); // dry-1
  await r.call({ action: "dry" }); // dry-2 exists: dry-3
  await r.call({ action: "run" });
  await r.call({ action: "undo" });
  assert.deepEqual(r.logs().sort(), [`${pre}-dry-1.log`, `${pre}-dry-2.log`, `${pre}-dry-3.log`, `${pre}-run-1.log`, `${pre}-undo-1.log`]);
  assert.equal(fs.readFileSync(path.join(scratch, `${pre}-dry-2.log`), "utf8"), "older log\n");
});

test("foreman_script: a small fix after approval that removes the marker ends undo; the script does not run again and status says so", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  const text = undoScript(r);
  await r.propose();
  fs.writeFileSync(r.file, text.replace(`${UNDO_MARKER}\n`, ""));
  assert.equal((await r.call({ action: "dry" })).details?.status, "dry_ok");
  assert.equal((await r.call({ action: "run" })).details?.exit, 0);
  assert.equal(r.runs().length, 3);
  const st = await statusOf(r);
  assert.deepEqual([st.undo.supported, st.undo.available], [false, false]);
  const u = await r.call({ action: "undo" });
  assert.equal(u.details?.code, "undo_no_marker", textOf(u));
  assert.match(textOf(u), /text of .* that ran does not declare/);
  assert.equal(r.runs().length, 3, "the run count stays: undo did not start the script");
});

test("foreman_script: a small fix that adds the marker to a script proposed without it does not enable undo", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  const text = undoScript(r, false);
  await r.propose();
  fs.writeFileSync(r.file, text.replace("# honours --dry-run\n", `# honours --dry-run\n${UNDO_MARKER}\n`));
  assert.equal((await r.call({ action: "dry" })).details?.status, "dry_ok");
  await r.call({ action: "run" });
  const st = await statusOf(r);
  assert.deepEqual([st.undo.supported, st.undo.available], [false, false]);
  const u = await r.call({ action: "undo" });
  assert.equal(u.details?.code, "undo_no_marker", textOf(u));
  assert.equal(r.runs().length, 3);
});

test("foreman_script: an undo aborted before the script starts does not use an attempt", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r);
  await r.propose();
  await r.call({ action: "run" });
  const ac = new AbortController();
  ac.abort();
  const u = await r.call({ action: "undo" }, ac.signal);
  assert.equal(u.isError, true, textOf(u));
  assert.equal(r.runs().length, 2, "the script did not run for the undo");
  const st = await statusOf(r);
  assert.deepEqual([st.undo.attempts, st.undo.attemptsLeft, st.undo.available], [0, 3, true]);
  assert.equal(r.logs().filter((n) => n.includes("-undo-")).length, 0);
  assert.equal((await r.call({ action: "undo" })).details?.exit, 0);
});

// ---- status undo fields: only when they mean something

test("foreman_script: status after a real run of a script without undo support has no availableUntil and no attemptsLeft", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r, false);
  await r.propose();
  await r.call({ action: "run" });
  const st = await statusOf(r);
  assert.equal(st.undo.supported, false);
  assert.equal("availableUntil" in st.undo, false, JSON.stringify(st.undo));
  assert.equal("attemptsLeft" in st.undo, false, JSON.stringify(st.undo));
});

test("foreman_script: status after a real run with undo support has availableUntil and attemptsLeft", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r);
  await r.propose();
  await r.call({ action: "run" });
  const st = await statusOf(r);
  assert.equal(typeof st.undo.availableUntil, "string", JSON.stringify(st.undo));
  assert.equal(st.undo.attemptsLeft, 3);
});

test("foreman_script: status after a successful undo has no availableUntil and attemptsLeft 0", skipWin, async (t) => {
  const r = await rig(t, { answer: () => "approve" });
  undoScript(r);
  await r.propose();
  await r.call({ action: "run" });
  assert.equal((await r.call({ action: "undo" })).details?.exit, 0);
  const st = await statusOf(r);
  assert.equal(st.undo.used, true);
  assert.equal("availableUntil" in st.undo, false, JSON.stringify(st.undo));
  assert.equal(st.undo.attemptsLeft, 0);
});
