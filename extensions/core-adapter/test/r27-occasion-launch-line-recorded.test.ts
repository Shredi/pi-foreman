// D23: the receipt names the occasion the run was recorded with (classified from the raw task at launch), not one re-read from the task after the ledger block went in.
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
const LEDGER = '# Ledger: x\nTier: standard\n\n- [ ] 1. the receipt says "a [high-stakes] review is due" when so\n';

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
  fs.mkdirSync(path.join(w.project, "src/a"), { recursive: true });
  fs.writeFileSync(path.join(w.project, "src/a/big.ts"), "x\n".repeat(100));
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", "work");
  return a;
}

async function launch(a: Rig, input: Record<string, unknown>): Promise<{ texts: string[]; input: Record<string, unknown> }> {
  const id = `d${Math.random().toString(36).slice(2, 8)}`;
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const call = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  assert.ok(!call?.block, String(call?.reason));
  const res = (await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false })) as { content?: { text: string }[] } | undefined;
  await tick(50);
  return { texts: (res?.content ?? []).map((c) => c.text), input };
}

test("a [pre-pr] launch citing a ledger item that names [high-stakes] in plain text still says occasion: pre-pr", async (t) => {
  const a = await setup(t);
  await launch(a, { agent: "builder", task: "build the widget", size: { files: ["src/a/big.ts"] }, risk: ["design"] });
  const r = await launch(a, { agent: "reviewer", task: "[pre-pr] review items 1" });
  assert.ok(JSON.stringify(r.input.task).includes("[high-stakes]"), "the rewritten task carries the tag text from the ledger item");
  assert.ok(r.texts.some((x) => x.startsWith("occasion: pre-pr") && x.includes("a [high-stakes] review is due (")), JSON.stringify(r.texts));
  assert.ok(!r.texts.some((x) => x.startsWith("occasion: high-stakes")), JSON.stringify(r.texts));
});

test("a [high-stakes] launch still says occasion: high-stakes", async (t) => {
  const a = await setup(t);
  const id = `d${Math.random().toString(36).slice(2, 8)}`;
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: { agent: "builder", task: "build the widget" } }] } });
  await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input: { agent: "builder", task: "build the widget", size: { files: ["src/a/big.ts"] }, risk: ["design"] } });
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input: { agent: "builder", task: "build the widget" }, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  a.endRunAs(id, "builder", "done");
  await tick(150);
  const p = `d${Math.random().toString(36).slice(2, 8)}`;
  const pin = { agent: "reviewer", task: "[pre-pr] review the branch" };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id: p, name: "subagent", arguments: pin }] } });
  await a.fire("tool_call", { toolName: "subagent", toolCallId: p, input: pin });
  await a.fire("tool_result", { toolName: "subagent", toolCallId: p, input: pin, details: { runId: `run-${p}` }, content: [{ type: "text", text: "started" }], isError: false });
  a.endRunAs(p, "reviewer", "Overall verdict: PASS");
  await tick(150);
  const r = await launch(a, { agent: "reviewer", task: "[high-stakes] review the whole change" });
  assert.ok(r.texts.some((x) => x.startsWith("occasion: high-stakes")), JSON.stringify(r.texts));
});
