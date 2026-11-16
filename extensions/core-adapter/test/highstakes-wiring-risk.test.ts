// The high-stakes review fires from risk: a tag with sizing off, tier heavy, the fast-forward into the base branch after the pass, the migration of an
// old per-checkout entry, the doctor line for the retired size bounds.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { retiredHighStakesLines } from "../doctorcache.ts";
import { tick, world } from "./_r46world.ts";

process.env.PI_OFFLINE = "1";

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;
type World = ReturnType<typeof world>;
type Settle = { entries?: { customType?: string; content?: string }[] } | undefined;

const MODEL = "fake/hs";
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const LEDGER = "# Ledger: x\nTier: standard\n\n- [x] 1. item\n- [x] V. fresh-eyes verification passed\n";

async function setup(t: Parameters<typeof world>[0], ceremony: Record<string, unknown> = {}, tier = "standard", extraCfg: Record<string, unknown> = {}) {
  const w = world(t, { ceremony: { default: tier, highStakes: { model: MODEL }, ...ceremony } });
  fs.rmSync(path.join(w.project, ".git"), { recursive: true });
  git(w.project, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(w.project, ".gitignore"), ".workflow/\n");
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", "seed");
  const cfgFile = path.join(w.project, "..", "agent", "foreman.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
  cfg.safety = { ops: { baseBranch: "main" } };
  cfg.presence = { enabled: false };
  Object.assign(cfg, extraCfg);
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  git(w.project, "checkout", "-q", "-b", "feature");
  const a = await w.adapter("startup");
  await a.command("ceremony", tier);
  await a.writeLedger(LEDGER.replace("standard", tier));
  return { w, a };
}
const work = (w: World, name: string) => {
  fs.mkdirSync(path.dirname(path.join(w.project, name)), { recursive: true });
  fs.writeFileSync(path.join(w.project, name), "x\n");
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", `work ${name}`);
};
async function launch(a: Rig, agent: string, task: string, extra: Record<string, unknown> = {}) {
  const id = `k${Math.random().toString(36).slice(2, 8)}`;
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
const build = async (a: Rig, extra: Record<string, unknown> = {}) => {
  await end(a, await launch(a, "builder", "build the widget", extra), "builder", "done");
  await end(a, await launch(a, "reviewer", "[pre-pr] review the branch"), "reviewer", "Overall verdict: PASS");
};
const hsPass = async (a: Rig) => {
  const s = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(s.blocked, null, String(s.blocked));
  await end(a, s, "reviewer", "Overall verdict: PASS");
};

test("a risk tag fires the review with sizing off (no size field needed)", async (t) => {
  const { w, a } = await setup(t, { default: "standard" }, "standard", { ladder: { sizing: { enabled: false } } });
  work(w, "src/a/x.ts");
  await build(a, { risk: ["security"] });
  assert.match(await pr(a), /\[pr_refused:high_stakes_required\]/);
  assert.match(await pr(a), /risk tag security/);
});

test("tier heavy that built something fires the review; an untagged standard build does not", async (t) => {
  // a heavy builder launch needs an approved plan; the tier is raised after the build (the gates read it)
  const heavy = await setup(t);
  work(heavy.w, "src/a/x.ts");
  await build(heavy.a);
  assert.equal(await pr(heavy.a), "");
  await heavy.a.command("ceremony", "heavy");
  assert.match(await pr(heavy.a), /\[pr_refused:high_stakes_required\]/);
  assert.match(await pr(heavy.a), /the task is heavy/);
  const std = await setup(t);
  work(std.w, "src/a/x.ts");
  await build(std.a);
  assert.equal(await pr(std.a), "");
});

test("the pass in the feature checkout stays valid after a fast-forward into the base branch: no second review", async (t) => {
  const { w, a } = await setup(t);
  work(w, "src/a/x.ts");
  await build(a, { size: { files: ["src/a/x.ts"] }, risk: ["design"] });
  await hsPass(a);
  git(w.project, "checkout", "-q", "main");
  git(w.project, "merge", "-q", "--ff-only", "feature");
  assert.doesNotMatch(await pr(a), /high_stakes/, "main holds the reviewed head");
  assert.doesNotMatch(await settle(a), /high-stakes review must run/);
});

test("an old per-checkout array entry loads at session start: reasons migrated, retired ones dropped", async (t) => {
  const { w, a } = await setup(t);
  work(w, "src/a/x.ts");
  await build(a, { size: { files: ["src/a/x.ts"] }, risk: ["design"] });
  const stop = Date.now() + 8000;
  const entryOf = () => w.ceremonyEntries().at(-1)?.data as { highStakes?: unknown; reviews?: unknown[] } | undefined;
  // the newest entry holds the PASS and the fired tag: an earlier one (only the noted base) would reload without the PASS
  while (Date.now() < stop && !((entryOf()?.reviews?.length ?? 0) > 0 && JSON.stringify(entryOf()?.highStakes ?? null).includes('"design"'))) await tick(50);
  const e = entryOf()!;
  assert.ok(e.highStakes !== undefined);
  e.highStakes = [{ cwd: w.project, fired: { reasons: ["lines", "design"], files: 1, lines: 100, modules: 1 }, runs: [], runIds: [], seenHead: "abc" }];
  const b = await w.adapter("reload");
  const refusal = await pr(b);
  assert.match(refusal, /\[pr_refused:high_stakes_required\]/);
  assert.match(refusal, /risk tag design/);
  assert.doesNotMatch(refusal, /lines/);
});

test("retiredHighStakesLines: one WARN when lines or modules is set, none otherwise", () => {
  assert.equal(retiredHighStakesLines({ ceremony: { highStakes: { model: null, lines: 50 } } }).length, 1);
  assert.equal(retiredHighStakesLines({ ceremony: { highStakes: { modules: 0 } } }).length, 1);
  assert.deepEqual(retiredHighStakesLines({ ceremony: { highStakes: { model: "x/y" } } }), []);
  assert.deepEqual(retiredHighStakesLines({}), []);
});
