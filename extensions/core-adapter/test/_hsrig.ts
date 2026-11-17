// Shared rig of the high-stakes risk wiring tests: a standard-tier world over a real git repo (`main` seeded, optionally with a bare local origin), the launch and
// run-end helpers of a foreman session, worktree and commit helpers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tick, world } from "./_r46world.ts";

process.env.PI_OFFLINE = "1";

export type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
export type World = ReturnType<typeof world>;
type Settle = { entries?: { customType?: string; content?: string }[] } | undefined;

export const MODEL = "fake/hs";
export const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const ledger = (tier: string) => `# Ledger: x\nTier: ${tier}\n\n- [x] 1. item\n- [x] V. fresh-eyes verification passed\n`;

export interface SetupOpts {
  ceremony?: Record<string, unknown>;
  tier?: string;
  cfg?: Record<string, unknown>;
  /** A bare local repository as `origin` (main pushed). */
  remote?: boolean;
  /** The session starts on `main` instead of a `feature` branch. */
  onMain?: boolean;
  /** No `/ceremony` command and no ledger: the tier comes from `ceremony.default` alone (source default). */
  noOwner?: boolean;
  /** More options of the world (e.g. a handoff dir and a parent: a session opened by another session). */
  world?: Record<string, unknown>;
}

export async function setup(t: Parameters<typeof world>[0], o: SetupOpts = {}) {
  const tier = o.tier ?? "standard";
  const w = world(t, { ...o.world, ceremony: { default: tier, highStakes: { model: MODEL }, ...o.ceremony } });
  fs.rmSync(path.join(w.project, ".git"), { recursive: true });
  git(w.project, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(w.project, ".gitignore"), ".workflow/\n");
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", "seed");
  const root = fs.realpathSync.native(path.join(w.project, ".."));
  if (o.remote) {
    const origin = path.join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    git(w.project, "remote", "add", "origin", origin);
    // the harness sets url.invalid-push:.pushInsteadOf for every URL; the fixture's own origin keeps its path
    git(w.project, "-c", `url.${origin}.pushInsteadOf=${origin}`, "push", "-q", "origin", "main");
  }
  const cfgFile = path.join(root, "agent", "foreman.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
  cfg.safety = { ops: { baseBranch: "main" } };
  cfg.presence = { enabled: false };
  Object.assign(cfg, o.cfg);
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  if (!o.onMain) git(w.project, "checkout", "-q", "-b", "feature");
  const a = await w.adapter("startup");
  if (!o.noOwner) {
    await a.command("ceremony", tier);
    await a.writeLedger(ledger(tier));
  }
  if (tier === "heavy") {
    // the plan passes its review and the owner approves it: a builder may launch
    assert.equal(await a.review("PASS"), null);
    assert.equal((await a.checkpoint()).decision, "approve");
  }
  return { w, a, root, seed: git(w.project, "rev-parse", "HEAD") };
}

/** A worktree of the repo of `w` on a new branch off HEAD. */
export function worktree(w: World, name: string): string {
  const dir = path.join(fs.realpathSync.native(path.join(w.project, "..")), name);
  git(w.project, "worktree", "add", "-q", "-b", name, dir);
  return dir;
}

export const commitIn = (dir: string, name: string, text = "x\n") => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `work ${name}`);
};

export async function launch(a: Rig, agent: string, task: string, extra: Record<string, unknown> = {}) {
  const id = `k${Math.random().toString(36).slice(2, 8)}`;
  const input: Record<string, unknown> = { agent, task, ...extra };
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  if (res?.block) return { blocked: res.reason ?? "blocked", id, input };
  await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
  return { blocked: null as string | null, id, input };
}
export const end = async (a: Rig, s: { id: string }, agent: string, output: string, cwd?: string) => {
  a.endRunAs(s.id, agent, output, cwd);
  await tick(150);
};
export const settle = async (a: Rig): Promise<string> => {
  const r = (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as Settle;
  return (r?.entries ?? []).find((e) => e.customType === "pi-foreman-ceremony-gate")?.content ?? "";
};
export const pr = async (a: Rig, input: Record<string, unknown> = {}): Promise<string> => (await a.checkCall("create_pull_request", input))?.reason ?? "";
export const traces = async (w: World, event: string) => (await w.traceEvents()).filter((e) => e.event === event);
export const stakes = async (w: World) => (await traces(w, "review_stakes")).map((e) => e.reasons);

/** A builder launch and its end, then a normal `[pre-pr]` PASS, in `cwd` (the own checkout by default). */
export const build = async (a: Rig, extra: Record<string, unknown> = {}, cwd?: string) => {
  const c = cwd ? { cwd } : {};
  const b = await launch(a, "builder", "build the widget", { ...c, ...extra });
  assert.equal(b.blocked, null, String(b.blocked));
  await end(a, b, "builder", "done", cwd);
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch", c), "reviewer", "Overall verdict: PASS", cwd);
};
export const hsRun = async (a: Rig, verdict: "PASS" | "FAIL", cwd?: string) => {
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change", cwd ? { cwd } : {});
  assert.equal(s.blocked, null, String(s.blocked));
  await end(a, s, "reviewer", verdict === "PASS" ? "Overall verdict: PASS" : "1. FAIL src/x.ts:1 broken\nOverall verdict: FAIL", cwd);
  return s;
};
export const hsPass = (a: Rig, cwd?: string) => hsRun(a, "PASS", cwd);

/** Waits until the newest ceremony-state entry satisfies `ok(highStakes, wholeEntry)`. */
export async function persisted(w: World, ok: (hs: any, entry: { highStakes?: unknown; reviews?: unknown[] } | undefined) => boolean): Promise<void> {
  const stop = Date.now() + 8000;
  const entry = () => w.ceremonyEntries().at(-1)?.data as { highStakes?: unknown; reviews?: unknown[] } | undefined;
  const good = () => ok(entry()?.highStakes, entry());
  while (Date.now() < stop && !good()) await tick(50);
  assert.ok(good(), "the high-stakes state was persisted");
}
export { tick };
