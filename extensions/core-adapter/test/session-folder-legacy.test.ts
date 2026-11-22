// A session that started on code before the dirty-base entry and already ran a builder keeps working in its own checkout: no session folder is made mid-session.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { world } from "./_r46world.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;

async function launch(a: Rig, input: Record<string, unknown>) {
  const id = `f${Math.random().toString(36).slice(2, 8)}`;
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  if (res?.block) return { blocked: res.reason ?? "blocked", input };
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  return { blocked: null as string | null, input };
}
const worktrees = (dir: string) => git(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));

/** A session whose first builder ran at trivial in the primary checkout; `legacy` strips the entries only new code writes, as a session of the old code lacks them. */
async function setup(t: Parameters<typeof world>[0], legacy: boolean) {
  const w = world(t, { ceremony: { default: "trivial" }, headless: false });
  fs.rmSync(path.join(w.project, ".git"), { recursive: true });
  git(w.project, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(w.project, ".gitignore"), ".workflow/\n");
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", "seed");
  const a = await w.adapter("startup");
  await a.command("ceremony", "trivial");
  await a.writeLedger("# Ledger: x\nTier: trivial\n\n- [ ] 1. item\n");
  const first = await launch(a, { agent: "builder", task: "build" });
  assert.equal(first.blocked, null, String(first.blocked));
  await a.command("ceremony", "standard");
  await a.down();
  // the work counter is saved at an owner input or a settle, which the rig does not run: the old session's entry says its builder ran
  const ceremony = [...w.entries].reverse().find((e) => e.customType === "pi-foreman-ceremony-state");
  assert.ok(ceremony, "a ceremony-state entry exists");
  (ceremony.data as Record<string, unknown>).pause = { work: { builders: 1, edits: 0 }, atPrompt: { builders: 0, edits: 0 }, refusals: null };
  const drop = legacy ? ["pi-foreman-dirty-base", "pi-foreman-session-folder"] : ["pi-foreman-session-folder"];
  const kept = w.entries.filter((e) => !drop.includes(String(e.customType)));
  w.entries.splice(0, w.entries.length, ...kept);
  return { w, b: await w.adapter("resume") };
}

test("a legacy session with prior builder work keeps its checkout: no cwd, no worktree, a primary entry, and it holds after a reload", async (t) => {
  const { w, b } = await setup(t, true);
  const next = await launch(b, { agent: "builder", task: "more" });
  assert.equal(next.blocked, null, String(next.blocked));
  assert.equal(next.input.cwd, undefined, "no folder is injected");
  assert.equal(worktrees(w.project).length, 1);
  assert.ok(w.entries.some((e) => e.customType === "pi-foreman-session-folder" && (e.data as { primary?: boolean }).primary === true), "the decision is recorded");
  await b.down();
  const c = await w.adapter("resume");
  const after = await launch(c, { agent: "builder", task: "again" });
  assert.equal(after.input.cwd, undefined, "the decision survives a reload");
  assert.equal(worktrees(w.project).length, 1);
});

test("a session of the current code with prior builder work and no folder entry still gets its folder", async (t) => {
  const { w, b } = await setup(t, false);
  const next = await launch(b, { agent: "builder", task: "more" });
  assert.equal(next.blocked, null, String(next.blocked));
  assert.equal(typeof next.input.cwd, "string", "a folder is injected");
  assert.equal(worktrees(w.project).length, 2);
});
