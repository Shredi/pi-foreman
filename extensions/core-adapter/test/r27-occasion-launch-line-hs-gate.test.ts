// D23: the reviewer receipt's "a [high-stakes] review is necessary" suffix is computed as the PR gate computes it:
// no high-stakes model, no suffix; a heavy reason only the gate refresh records, the suffix.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { tick, world } from "./_r46world.ts";

process.env.PI_OFFLINE = "1";

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const LEDGER = "# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [x] V. fresh-eyes verification passed\n";
const NECESSARY = "a [high-stakes] review is necessary after this PASS";

async function setup(t: Parameters<typeof world>[0], highStakes: Record<string, unknown>) {
  const w = world(t, { ceremony: { default: "standard", highStakes } });
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

async function launch(a: Rig, input: Record<string, unknown>): Promise<string[] & { id?: string }> {
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const call = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  assert.ok(!call?.block, String(call?.reason));
  const res = (await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false })) as { content?: { text: string }[] } | undefined;
  await tick(50);
  return Object.assign((res?.content ?? []).map((c) => c.text), { id });
}

test("with no high-stakes model a fired trigger gives no suffix, as the PR gate asks for none", async (t) => {
  const a = await setup(t, {});
  await launch(a, { agent: "builder", task: "build the widget", size: { files: ["src/a/big.ts"] }, risk: ["design"] });
  const texts = await launch(a, { agent: "reviewer", task: "[pre-pr] review the branch" });
  assert.ok(!texts.some((x) => x.includes(NECESSARY)), JSON.stringify(texts));
});

test("a heavy reason only the gate refresh records gives the suffix", async (t) => {
  const a = await setup(t, { model: "fake/hs" });
  const b = await launch(a, { agent: "builder", task: "build the widget" });
  a.endRunAs(b.id!, "builder", "done");
  await tick(150);
  await a.command("ceremony", "heavy");
  const texts = await launch(a, { agent: "reviewer", task: "[pre-pr] review the branch" });
  const line = texts.find((x) => x.startsWith("occasion: pre-pr"));
  assert.ok(line?.includes(NECESSARY), JSON.stringify(texts));
});
