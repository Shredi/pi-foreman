// D23: the receipt of a [pre-pr] reviewer launch says a [high-stakes] review is still necessary when a trigger fired; classification, model and gates stay as they are.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { tick, world } from "./_r46world.ts";

process.env.PI_OFFLINE = "1";

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;

const MODEL = "fake/hs";
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const LEDGER = "# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [x] V. fresh-eyes verification passed\n";

const commit = (project: string) => {
  fs.mkdirSync(path.join(project, "src/a"), { recursive: true });
  fs.writeFileSync(path.join(project, "src/a/big.ts"), "x\n".repeat(100));
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "work");
};

async function setup(t: Parameters<typeof world>[0]) {
  const w = world(t, { ceremony: { default: "standard", highStakes: { model: MODEL } } });
  fs.rmSync(path.join(w.project, ".git"), { recursive: true });
  git(w.project, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(w.project, ".gitignore"), ".workflow/\n");
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", "seed");
  const cfgFile = path.join(w.project, "..", "agent", "foreman.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
  cfg.safety = { ops: { baseBranch: "main" } };
  cfg.presence = { enabled: false };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  git(w.project, "checkout", "-q", "-b", "feature");
  const a = await w.adapter("startup");
  await a.command("ceremony", "standard");
  await a.writeLedger(LEDGER);
  commit(w.project);
  return a;
}

/** Launches `input` and returns its receipt texts and the input as the launch left it. */
async function launch(a: Rig, input: Record<string, unknown>): Promise<{ texts: string[]; input: Record<string, unknown>; id: string }> {
  const id = `d${Math.random().toString(36).slice(2, 8)}`;
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const call = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  assert.ok(!call?.block, String(call?.reason));
  const res = (await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false })) as { content?: { text: string }[] } | undefined;
  await tick(50);
  return { texts: (res?.content ?? []).map((c) => c.text), input, id };
}

const NECESSARY = "a [high-stakes] review is due (";

test("a [pre-pr] launch with a fired high-stakes trigger names pre-pr and that a [high-stakes] review is necessary; the normal model runs", async (t) => {
  const a = await setup(t);
  await launch(a, { agent: "builder", task: "build the widget", size: { files: ["src/a/big.ts"] }, risk: ["design"] });
  const r = await launch(a, { agent: "reviewer", task: "[pre-pr] review the branch" });
  const line = r.texts.find((x) => x.startsWith("occasion: pre-pr"));
  assert.ok(line, JSON.stringify(r.texts));
  assert.ok(line.includes(NECESSARY), line);
  assert.notEqual(String(r.input.model).split(":")[0], MODEL, "the high-stakes model does not apply to a [pre-pr] review");
});

test("an item review launch while a high-stakes review is due carries the reminder as its own line; without a due review it carries none; a second-opinion review carries none", async (t) => {
  const a = await setup(t);
  const plain = await launch(a, { agent: "reviewer", task: "review item 1" });
  assert.ok(!plain.texts.some((x) => x.includes(NECESSARY)), JSON.stringify(plain.texts));
  await launch(a, { agent: "builder", task: "build the widget", size: { files: ["src/a/big.ts"] }, risk: ["design"] });
  const r = await launch(a, { agent: "reviewer", task: "review item 1" });
  assert.ok(r.texts.includes("a [high-stakes] review is due (risk tag design); launch it if the change warrants it"), JSON.stringify(r.texts));
  const second = await launch(a, { agent: "reviewer", task: "[second-opinion] look" });
  assert.ok(!second.texts.some((x) => x.includes(NECESSARY)), JSON.stringify(second.texts));
});

test("a [pre-pr] launch without a fired trigger keeps the plain pre-pr line", async (t) => {
  const a = await setup(t);
  const r = await launch(a, { agent: "reviewer", task: "[pre-pr] review the branch" });
  assert.ok(r.texts.includes("occasion: pre-pr (counts for items and the PR gate)"), JSON.stringify(r.texts));
  assert.ok(!r.texts.some((x) => x.includes(NECESSARY)), JSON.stringify(r.texts));
});

test("a [high-stakes] launch gets its occasion line and the high-stakes model", async (t) => {
  const a = await setup(t);
  const b = await launch(a, { agent: "builder", task: "build the widget", size: { files: ["src/a/big.ts"] }, risk: ["design"] });
  a.endRunAs(b.id, "builder", "done");
  await tick(150);
  const p = await launch(a, { agent: "reviewer", task: "[pre-pr] review the branch" });
  a.endRunAs(p.id, "reviewer", "Overall verdict: PASS");
  await tick(150);
  const r = await launch(a, { agent: "reviewer", task: "[high-stakes] review the whole change" });
  assert.ok(r.texts.includes("occasion: high-stakes (the whole change on the high-stakes model: marks no items, opens no gate)"), JSON.stringify(r.texts));
  assert.equal(String(r.input.model).split(":")[0], MODEL);
});
