import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { builderLaunchRefusal, changedPlans, currentPlanHash, isPlanPath, launchRefusalText, planSnapshot, planSummary, readPlan, sha256 } from "../checkpoint.ts";
import type { PlanRecord } from "../checkpoint.ts";

const PLAN = "# Add the widget\n\n## Goal\nShip the widget.\nKeep it small.\n\n## Approach\nx\n\n## Risks\ny\n";

function workspace(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-ckpt-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, "ws");
  for (const d of [".git", ".workflow/scratch", "src"]) fs.mkdirSync(path.join(ws, d), { recursive: true });
  fs.writeFileSync(path.join(ws, ".workflow/scratch/plan-widget.md"), PLAN);
  return { root, ws, scratch: path.join(ws, ".workflow/scratch"), opts: { cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch" } };
}

const err = (r: ReturnType<typeof readPlan>): string => ("error" in r ? r.error : "");

test("checkpoint: a valid plan reads with its topic, relative path and sha256 of the bytes", (t) => {
  const { opts } = workspace(t);
  const r = readPlan(".workflow/scratch/plan-widget.md", opts);
  assert.ok("plan" in r, err(r));
  assert.equal(r.plan.topic, "widget");
  assert.equal(r.plan.rel, ".workflow/scratch/plan-widget.md");
  assert.equal(r.plan.hash, sha256(Buffer.from(PLAN)));
});

test("checkpoint: path rules refuse outside, wrong dir or name, symlink, hard link, too large", (t) => {
  const { root, ws, scratch, opts } = workspace(t);
  fs.writeFileSync(path.join(root, "plan-out.md"), PLAN);
  assert.match(err(readPlan(path.join(root, "plan-out.md"), opts)), /foreman_checkpoint refused: the path is outside the workspace/);
  fs.writeFileSync(path.join(ws, "src/plan-x.md"), PLAN);
  assert.match(err(readPlan("src/plan-x.md", opts)), /directly in \.workflow\/scratch/);
  fs.mkdirSync(path.join(scratch, "sub"));
  fs.writeFileSync(path.join(scratch, "sub/plan-x.md"), PLAN);
  assert.match(err(readPlan(".workflow/scratch/sub/plan-x.md", opts)), /directly in/);
  for (const bad of ["notes.md", "plan-.md", "plan-a b.md", `plan-${"a".repeat(65)}.md`, "plan-x.txt"]) {
    fs.writeFileSync(path.join(scratch, bad), PLAN);
    assert.match(err(readPlan(`.workflow/scratch/${bad}`, opts)), /plan-<topic>\.md/, bad);
  }
  assert.ok("plan" in readPlan(`.workflow/scratch/plan-${"a".repeat(64)}.md`, (fs.writeFileSync(path.join(scratch, `plan-${"a".repeat(64)}.md`), PLAN), opts)));
  assert.match(err(readPlan(".workflow/scratch/plan-missing.md", opts)), /does not exist/);
  assert.match(err(readPlan("", opts)), /non-empty/);
  fs.mkdirSync(path.join(scratch, "plan-dir.md"));
  assert.match(err(readPlan(".workflow/scratch/plan-dir.md", opts)), /not a regular file/);
  fs.writeFileSync(path.join(scratch, "plan-big.md"), "x".repeat(256 * 1024 + 1));
  assert.match(err(readPlan(".workflow/scratch/plan-big.md", opts)), /larger than 256 KiB/);
  fs.linkSync(path.join(scratch, "plan-widget.md"), path.join(root, "other-name.md"));
  assert.match(err(readPlan(".workflow/scratch/plan-widget.md", opts)), /hard link/);
  fs.rmSync(path.join(root, "other-name.md"));
  // a symlinked plan file, and a path through a symlinked directory
  fs.writeFileSync(path.join(root, "real.md"), PLAN);
  try {
    fs.symlinkSync(path.join(root, "real.md"), path.join(scratch, "plan-link.md"));
    fs.symlinkSync(scratch, path.join(ws, "alias"), "dir");
  } catch {
    t.skip("no symlinks here");
    return;
  }
  assert.match(err(readPlan(".workflow/scratch/plan-link.md", opts)), /symlink/);
  assert.match(err(readPlan("alias/plan-widget.md", opts)), /symlink/);
});

test("checkpoint: same bytes after delete and re-create keep the hash; an edit or a symlink swap changes it", (t) => {
  const { root, scratch, opts } = workspace(t);
  const r = readPlan(".workflow/scratch/plan-widget.md", opts);
  assert.ok("plan" in r);
  const rec: PlanRecord = { topic: "widget", path: r.plan.path, hash: r.plan.hash, status: "approved", approvedAt: "t", by: "user" };
  fs.rmSync(path.join(scratch, "plan-widget.md"));
  assert.equal(currentPlanHash(rec, opts), null, "gone");
  fs.writeFileSync(path.join(scratch, "plan-widget.md"), PLAN);
  assert.equal(currentPlanHash(rec, opts), rec.hash);
  fs.appendFileSync(path.join(scratch, "plan-widget.md"), "more\n");
  assert.notEqual(currentPlanHash(rec, opts), rec.hash);
  fs.rmSync(path.join(scratch, "plan-widget.md"));
  fs.writeFileSync(path.join(root, "same.md"), PLAN);
  try {
    fs.symlinkSync(path.join(root, "same.md"), path.join(scratch, "plan-widget.md"));
  } catch {
    return;
  }
  assert.equal(currentPlanHash(rec, opts), null, "a symlink with the same bytes is not the approved file");
});

test("checkpoint: launch decision by record status and hash; only at heavy", () => {
  const rec = (status: PlanRecord["status"]): PlanRecord => ({ topic: "t", path: "/p", hash: "h", status, approvedAt: null, by: null });
  assert.equal(builderLaunchRefusal(null, "standard", null), null);
  assert.equal(builderLaunchRefusal(null, "heavy", null), "plan_required");
  assert.equal(builderLaunchRefusal(rec("rejected"), "heavy", "h"), "plan_required");
  assert.equal(builderLaunchRefusal(rec("pending"), "heavy", "h"), "checkpoint_pending");
  assert.equal(builderLaunchRefusal(rec("revise"), "heavy", "h"), "checkpoint_pending");
  assert.equal(builderLaunchRefusal(rec("approved"), "heavy", "h"), null);
  assert.equal(builderLaunchRefusal(rec("approved"), "heavy", "other"), "plan_changed");
  assert.equal(builderLaunchRefusal(rec("approved"), "heavy", null), "plan_changed");
  assert.match(launchRefusalText("plan_required", null, ".workflow/scratch"), /^pi-foreman: builder launch refused \[launch_refused:plan_required\]: .*call foreman_checkpoint/);
  assert.match(launchRefusalText("plan_required", rec("rejected"), "s"), /the owner rejected plan-t\.md/);
  assert.match(launchRefusalText("checkpoint_pending", rec("revise"), "s"), /\[launch_refused:checkpoint_pending\]: .*revised plan/);
  assert.match(launchRefusalText("plan_changed", rec("approved"), "s"), /\[launch_refused:plan_changed\]: plan-t\.md changed or is gone/);
});

test("checkpoint: summary has title, goal lines, headings, path and hash prefix, at most 12 lines, no control characters", () => {
  const s = planSummary(PLAN + "\x1b[31mred\x1b[0m\n", ".workflow/scratch/plan-widget.md", "abcdef0123456789");
  assert.deepEqual(s.split("\n"), ["Plan: Add the widget", "Goal: Ship the widget.", "  Keep it small.", "Sections: Goal · Approach · Risks", "File: .workflow/scratch/plan-widget.md", "sha256: abcdef012345"]);
  const long = planSummary("# T\n## Goal\n" + "line\n".repeat(30), "p", "h");
  assert.ok(long.split("\n").length <= 12);
  assert.doesNotMatch(planSummary("# a\x07b\n", "p", "h"), /[\x00-\x09\x0b-\x1f\x7f]/);
});

test("checkpoint: plan paths and snapshots for plan_written", (t) => {
  const { scratch, opts } = workspace(t);
  assert.equal(isPlanPath(".workflow/scratch/plan-new.md", opts), true);
  assert.equal(isPlanPath(".workflow/scratch/notes.md", opts), false);
  assert.equal(isPlanPath("src/plan-x.md", opts), false);
  const before = planSnapshot(opts);
  assert.deepEqual([...before.keys()], ["plan-widget.md"]);
  fs.writeFileSync(path.join(scratch, "plan-new.md"), "n");
  fs.writeFileSync(path.join(scratch, "notes.md"), "n");
  fs.appendFileSync(path.join(scratch, "plan-widget.md"), "x");
  assert.deepEqual(changedPlans(before, planSnapshot(opts)).sort(), ["plan-new.md", "plan-widget.md"]);
  assert.deepEqual(changedPlans(planSnapshot(opts), planSnapshot(opts)), []);
});

test("checkpoint tool: sequential; a plan changed during the dialog is not approved; refused while a planner run is active", async (t) => {
  const keys = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const { root, ws, scratch } = workspace(t);
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  delete process.env.PI_SUBAGENT_CHILD;
  type Fn = (...a: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Fn>();
  const channels = new Map<string, (d: unknown) => void>();
  const tools = new Map<string, { executionMode?: string; execute: Fn }>();
  const events = { on: (n: string, h: (d: unknown) => void) => void channels.set(n, h), emit: () => undefined };
  const pi = { on: (n: string, h: Fn) => void handlers.set(n, h), events, registerCommand: () => undefined, registerTool: (d: { name: string; executionMode?: string; execute: Fn }) => void tools.set(d.name, d), getActiveTools: () => [] as string[], setActiveTools: () => undefined, setModel: async () => true, setThinkingLevel: () => undefined };
  const { default: coreAdapter } = await import("../index.ts");
  coreAdapter(pi as never);
  let onSelect: () => void = () => undefined;
  const ctx = {
    sessionManager: { getSessionId: () => "ck-tool-1", getSessionFile: () => undefined },
    cwd: ws,
    model: undefined,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: () => undefined, confirm: async () => false, select: async () => (onSelect(), "approve"), setStatus: () => undefined, setWidget: () => undefined },
  };
  await handlers.get("session_start")!({ reason: "startup" }, ctx);
  const tool = tools.get("foreman_checkpoint")!;
  assert.equal(tool.executionMode, "sequential");
  const call = async () => ((await tool.execute("c", { path: ".workflow/scratch/plan-widget.md" }, undefined, undefined, ctx)) as { details: { decision: string }; content: { text: string }[] });
  // a write lands while the owner reviews: the answer approves bytes that are no longer there
  onSelect = () => fs.appendFileSync(path.join(scratch, "plan-widget.md"), "changed during the dialog\n");
  const changed = await call();
  assert.equal(changed.details.decision, "pending");
  assert.match(changed.content[0].text, /changed while the owner was reviewing it/);
  onSelect = () => undefined;
  assert.equal((await call()).details.decision, "approve");
  // a planner run of this session still in flight: refused, the record stays as it was
  await handlers.get("tool_result")!({ toolName: "subagent", toolCallId: "l1", input: { agent: "planner", task: "t" }, details: { runId: "run-p" }, content: [], isError: false }, ctx);
  const busy = await call();
  assert.equal(busy.details.decision, "refused");
  assert.match(busy.content[0].text, /a planner run of this session is still active/);
  channels.get("subagent:async-complete")!({ runId: "run-p", agent: "planner", success: true });
  assert.equal((await call()).details.decision, "approve", "still approved: the refusal changed no record");
  await handlers.get("session_shutdown")!({}, ctx);
});
