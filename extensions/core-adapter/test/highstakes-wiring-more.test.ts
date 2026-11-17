// The high-stakes review wired into the adapter, second part: facts block base, the `design` tag, the finish gate against the ledger and
// reviewGate: verdict mode, the child's ledger mark, PR gate scope through the PR gates of reviews.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { prGateRefusal } from "../reviews.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";
import { rmTestTmp } from "./_tmpbase.ts";
import { tick, world } from "./_r46world.ts";

// pi-subagents resolves the global npm root with `npm root -g` on the first skill lookup (no seam); PI_OFFLINE keeps the child rig from starting npm.
process.env.PI_OFFLINE = "1";

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
type World = ReturnType<typeof world>;
type Settle = { entries?: { customType?: string; content?: string }[] } | undefined;

const MODEL = "fake/hs";
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const lines = (n: number) => "x\n".repeat(n);

async function setup(t: Parameters<typeof world>[0], ceremony: Record<string, unknown> = {}, ledger = "# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [x] V. fresh-eyes verification passed\n", seedFiles: Record<string, string> = {}) {
  const w = world(t, { ceremony: { default: "standard", highStakes: { model: MODEL }, ...ceremony } });
  fs.rmSync(path.join(w.project, ".git"), { recursive: true });
  git(w.project, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(w.project, ".gitignore"), ".workflow/\n");
  for (const [f, text] of Object.entries(seedFiles)) {
    fs.mkdirSync(path.dirname(path.join(w.project, f)), { recursive: true });
    fs.writeFileSync(path.join(w.project, f), text);
  }
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", "seed");
  const seed = git(w.project, "rev-parse", "HEAD");
  const cfgFile = path.join(w.project, "..", "agent", "foreman.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
  cfg.safety = { ops: { baseBranch: "main" } };
  cfg.presence = { enabled: false }; // an owner dialog must not depend on the host's idle state
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  git(w.project, "checkout", "-q", "-b", "feature");
  const a = await w.adapter("startup");
  await a.command("ceremony", "standard");
  await a.writeLedger(ledger);
  return { w, a, seed };
}
const work = (w: World, name: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(w.project, name)), { recursive: true });
  fs.writeFileSync(path.join(w.project, name), text);
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", `work ${name}`);
};
async function launch(a: Rig, agent: string, task: string, extra: Record<string, unknown> = {}) {
  const id = `m${Math.random().toString(36).slice(2, 8)}`;
  const input: Record<string, unknown> = { agent, task, ...extra };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  if (res?.block) return { blocked: res.reason ?? "blocked", id, input };
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  return { blocked: null as string | null, id, input };
}
const end = async (a: Rig, s: { id: string }, agent: string, output: string) => {
  a.endRunAs(s.id, agent, output);
  await tick(150);
};
const settle = async (a: Rig): Promise<string> => {
  const r = (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as Settle;
  return (r?.entries ?? []).find((e) => e.customType === "pi-foreman-ceremony-gate")?.content ?? "";
};
const pr = async (a: Rig): Promise<string> => (await a.checkCall("create_pull_request", {}))?.reason ?? "";
/** What the adapter adds to a successful PR tool result: the due-review reminder, "" when none. */
const prNote = async (a: Rig): Promise<string> => {
  const r = (await a.fire("tool_result", { toolName: "create_pull_request", toolCallId: `pn${Math.random()}`, input: {}, details: {}, content: [{ type: "text", text: "created" }], isError: false })) as { content?: { text?: string }[] } | undefined;
  return (r?.content ?? []).map((c) => c.text ?? "").filter((x) => x !== "created").join("\n");
};
const REMINDER = /a \[high-stakes\] review is due \(risk tag design\); launch it if the change warrants it/;
const traces = async (w: World, event: string) => (await w.traceEvents()).filter((e) => e.event === event);
/** A builder tagged `design` fires the review (the size is the sizing field the launch needs when sizing is on). */
const TAGGED = { size: { files: ["src/a/big.ts"] }, risk: ["design"] };
const buildAndPass = async (a: Rig, extra: Record<string, unknown> = {}) => {
  await end(a, await launch(a, "builder", "build the widget", extra), "builder", "done");
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
};

test("item 2: the facts block of a [high-stakes] launch is collected against the whole-change base, the ledger block is present; another occasion's model does not apply; its PASS leaves no FAIL entry", async (t) => {
  const { w, a, seed } = await setup(t, { reviewByOccasion: { "pre-pr": { model: "fake/foreman" } } }, undefined, { "src/a/test/t.test.ts": "a\n" });
  work(w, "src/a/big.ts", lines(100));
  work(w, "src/a/test/t.test.ts", "b\n");
  await buildAndPass(a);
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(s.blocked, null, String(s.blocked));
  const task = String(s.input.task);
  assert.match(task, /## Facts to rule on/);
  assert.match(task, /test file modified: src\/a\/test\/t\.test\.ts/, "a committed change of the branch is in the facts");
  assert.ok(task.includes(`against ${seed.slice(0, 12)}`), "the facts name the merge-base, not HEAD");
  assert.match(task, /\[pi-foreman ledger\]/);
  assert.match(task, /marks no items/);
  assert.equal(String(s.input.model).split(":")[0], MODEL, "the [pre-pr] model override does not apply");
  await end(a, s, "reviewer", "Overall verdict: PASS");
  assert.equal(await settle(a), "");
  assert.equal(await pr(a), "");
  assert.deepEqual((await traces(w, "review_high_stakes")).map((e) => e.verdict), ["pass"]);
});

test("item 3: a builder launch with risk tag design fires the review; without the tag nothing fires, whatever the size", async (t) => {
  const { w, a } = await setup(t);
  work(w, "src/a/one.ts", lines(5));
  await launch(a, "builder", "build it", { size: { files: ["src/a/one.ts"] } });
  assert.deepEqual(await traces(w, "review_stakes"), []);
  assert.match(await pr(a), /\[pr_refused:no_review\]/);
  const b = await launch(a, "builder", "build it", { size: { files: ["src/a/one.ts"] }, risk: ["design"] });
  assert.equal(b.blocked, null, String(b.blocked));
  assert.deepEqual((await traces(w, "review_stakes")).map((e) => e.reasons), ["design"]);
  await end(a, b, "builder", "done");
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
  assert.equal(await pr(a), "", "a due review refuses nothing");
  assert.match(await prNote(a), REMINDER);
  // sticky: a later untagged builder does not unfire it
  await end(a, await launch(a, "builder", "build more"), "builder", "done");
  assert.match(await prNote(a), REMINDER);
});

test("item 4/6: the finish gate does not ask for the pass while a ledger item other than V is open, asks once all are marked (V open does not matter); reviewGate: verdict mode: the FAIL entry holds after a high-stakes FAIL, and ends with the normal PASS after the revision", async (t) => {
  const { w, a } = await setup(t, { reviewGate: "verdict" }, "# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [ ] 2. other\n- [ ] V. fresh-eyes verification passed\n");
  work(w, "src/a/big.ts", lines(100));
  await buildAndPass(a, TAGGED);
  assert.doesNotMatch(await settle(a), /high-stakes/);
  await a.writeLedger("# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [x] 2. other\n- [ ] V. fresh-eyes verification passed\n");
  assert.match(await settle(a), REMINDER, "all items but V marked: the finish is held once with the reminder");
  const h = await launch(a, "reviewer", "[high-stakes] review");
  assert.equal(h.blocked, null, String(h.blocked));
  await end(a, h, "reviewer", "1. FAIL src/a/big.ts:1 broken\nOverall verdict: FAIL");
  assert.match(await settle(a), /revise after the high-stakes FAIL, then pass the normal reviewer/);
  work(w, "src/a/fix.ts", lines(2));
  await end(a, await launch(a, "builder", "fix it"), "builder", "done");
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
  assert.doesNotMatch(await settle(a), /revise after the high-stakes FAIL/);
});

test("item 2: a child with a [high-stakes] launch binding has its ledger V mark refused", async (t) => {
  const saved = process.env[BINDINGS_ENV];
  t.after(() => {
    if (saved === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = saved;
  });
  const call = async (extra: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> => {
    process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "reviewer", launchId: "l1", kind: "first", workspace: "", ...extra } });
    const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
    const r = await r11Rig(t, { ledgerHelper: "tool" }, { child: true, config: { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: { reviewer: { model: "fake/reviewer" } } } } }, piExtra: { registerTool: (d: { name: string; execute: never }) => void tools.set(d.name, d as never), registerCommand: () => undefined } });
    const res = await tools.get("foreman_ledger")!.execute("id", { action: "mark", items: ["V"] }, undefined, undefined, r.ctx);
    return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError };
  };
  const hs = await call({ highStakes: true });
  assert.equal(hs.isError, true);
  assert.match(hs.text, /a \[high-stakes\] review marks no ledger item, item V included/);
});

// ---------------------------------------------------------------- PR gate scope

function repo(prefix: string): { dir: string; g: (...a: string[]) => string; head: () => string } {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  g("init", "-q");
  g("commit", "-q", "--allow-empty", "-m", "a");
  return { dir, g, head: () => g("rev-parse", "HEAD") };
}

test("item 4: prGateRefusal asks the high-stakes gate after the head test: scope null for the session's checkout and for the foreign tool, the sibling's toplevel for pr_create {cwd}, with the heads", async () => {
  const session = repo("pf-hs-s-");
  const sib = repo("pf-hs-x-");
  try {
    const calls: { scope: string | null; heads: readonly string[] }[] = [];
    const hs = async (scope: string | null, heads: readonly string[]) => {
      calls.push({ scope, heads });
      return { reason: "high_stakes_required", message: "held" };
    };
    const own = session.head();
    const r1 = await prGateRefusal({ tool: "create_pull_request", isChild: false, gateOn: true, reviewed: [own], cwd: session.dir, input: {}, highStakes: hs });
    assert.equal(r1?.reason, "high_stakes_required");
    assert.deepEqual(calls.pop(), { scope: null, heads: [own] });
    // the head test refuses first: the high-stakes gate is not asked
    const r2 = await prGateRefusal({ tool: "create_pull_request", isChild: false, gateOn: true, reviewed: [], cwd: session.dir, input: {}, highStakes: hs });
    assert.equal(r2?.reason, "no_review");
    assert.equal(calls.length, 0);
    // gate off and child: not asked
    assert.equal(await prGateRefusal({ tool: "create_pull_request", isChild: false, gateOn: false, reviewed: [], cwd: session.dir, highStakes: hs }), null);
    assert.equal(calls.length, 0);
    // the sibling path
    const sh = sib.head();
    const rec = { role: "reviewer", verdict: "pass" as const, head: sh, cwd: sib.dir };
    const r3 = await prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [], cwd: session.dir, input: {}, checkout: { cwd: sib.dir, records: [rec] }, highStakes: hs });
    assert.equal(r3?.reason, "high_stakes_required");
    assert.deepEqual(calls.pop(), { scope: sib.dir, heads: [sh] });
    // cwd naming the session's own checkout: the session rules, every checkout of the session
    const r4 = await prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [own], cwd: session.dir, input: {}, checkout: { cwd: session.dir, records: [] }, highStakes: hs });
    assert.equal(r4?.reason, "high_stakes_required");
    assert.deepEqual(calls.pop(), { scope: null, heads: [own] });
    // pr_create {head}: the heads the call opens from are the named branch's commit
    session.g("branch", "other");
    const named = await prGateRefusal({ tool: "create_pull_request", isChild: false, gateOn: true, reviewed: [own], cwd: session.dir, input: { head: "other" }, highStakes: hs });
    assert.equal(named?.reason, "high_stakes_required");
    assert.deepEqual(calls.pop()?.heads, [own]);
    // a gate that passes opens it
    assert.equal(await prGateRefusal({ tool: "create_pull_request", isChild: false, gateOn: true, reviewed: [own], cwd: session.dir, input: {}, highStakes: async () => null }), null);
  } finally {
    rmTestTmp(session.dir);
    rmTestTmp(sib.dir);
  }
});
