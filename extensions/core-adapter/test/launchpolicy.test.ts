import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTION_TABLE, classifyAction, isManagementCall, recordLaunch, subagentActionCheck } from "../actions.ts";
import type { ActionContext, RunRegistry } from "../actions.ts";
import { buildGuardEnv } from "../env.ts";
import { dropDeadPathRewrite, expandGuardDir, guardPayloadBlock } from "../guardgaps.ts";
import { roleLaunchBlock } from "../roles.ts";
import { SupervisorWindow, roleToolsFrom } from "../supervisor.ts";
import type { HookDecision } from "../translate.ts";

// pi-subagents 0.75.0 src/shared/types.js SUBAGENT_ACTIONS, verbatim.
const UPSTREAM = ["list", "get", "models", "children.list", "guide", "validate", "create", "update", "delete", "eject", "disable", "enable", "reset", "mission.create", "mission.list", "mission.show", "mission.update", "mission.resolve-decision", "mission.attach-run", "mission.close", "worktree.discard", "worktree.cleanup", "lane.status", "lane.recordMerge", "lane.recordSupersession", "refine", "refine.show", "refine.rollback", "inspector.open", "inspector.command", "inspector.status", "inspector.close", "project.open", "project.status", "project.close", "status", "debug.run", "grant-spawn-budget", "interrupt", "resume", "steer", "stop", "command.status", "command.yield", "command.cancel", "dismiss", "doctor", "watchdog.status", "watchdog.check", "watchdog.configure", "watchdog.recommend-model", "schedule.create", "schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.resume", "schedule.run", "schedule.run-due", "schedule.delete"];

const ROLES = { explorer: { model: "p1/small", thinking: "low", tools: ["read", "ls", "grep", "find", "bash", "codemode"] }, builder: { model: "p1/big", tools: ["read", "bash", "edit", "write"] } };
const ALLOWED = ["explorer", "builder", "reviewer", "senior-reviewer", "finalizer"];

function ctx(runs: RunRegistry, over: Partial<ActionContext> = {}): ActionContext {
  return { allowWorkflow: false, runs, allowed: ALLOWED, resolution: { provider: "p1", roles: ROLES, source: "cli" }, maxThinking: "high", ...over };
}

test("every upstream action is classified, and the table has nothing else", () => {
  assert.deepEqual(Object.keys(ACTION_TABLE).sort(), [...UPSTREAM].sort());
  const launching = ["create", "update", "delete", "eject", "disable", "enable", "reset", "refine", "refine.rollback", "worktree.discard", "inspector.open", "project.open", "watchdog.configure"];
  for (const a of launching) assert.equal(classifyAction(a), "block", a);
  for (const a of UPSTREAM.filter((x) => x.startsWith("schedule."))) assert.equal(classifyAction(a), "workflow", a);
  assert.equal(classifyAction("resume"), "resume");
  assert.equal(classifyAction("append-step"), "block");
  assert.equal(classifyAction("schedule.future"), "workflow");
  assert.equal(classifyAction("Status"), "block");
});

test("allowlisted actions pass; blocked, unknown, append-step and workflow calls are refused", () => {
  const runs: RunRegistry = new Map();
  for (const a of ["status", " list ", "interrupt", "stop", "steer", "doctor"]) assert.deepEqual(subagentActionCheck({ action: a }, ctx(runs)), {}, a);
  assert.match(subagentActionCheck({ action: "create", config: {} }, ctx(runs)).block ?? "", /'create' is not allowed \(writes an agent definition/);
  assert.match(subagentActionCheck({ action: "frobnicate" }, ctx(runs)).block ?? "", /unknown to pi-foreman/);
  assert.match(subagentActionCheck({ action: "append-step" }, ctx(runs)).block ?? "", /'append-step' is refused/);
  assert.match(subagentActionCheck({ workflow: true }, ctx(runs)).block ?? "", /workflow scripts can launch any agent/);
  assert.match(subagentActionCheck({ action: "validate", workflow: "./w.js" }, ctx(runs)).block ?? "", /workflow scripts/);
  assert.match(subagentActionCheck({ action: "schedule.create", agent: "worker", at: "+1m" }, ctx(runs)).block ?? "", /'schedule.create' is blocked/);
  // allowWorkflow lets workflow and schedule.* through, flagged as unchecked; other blocks stay.
  assert.deepEqual(subagentActionCheck({ workflow: true }, ctx(runs, { allowWorkflow: true })), { unchecked: "workflow" });
  assert.deepEqual(subagentActionCheck({ action: "schedule.run" }, ctx(runs, { allowWorkflow: true })), { unchecked: "schedule.run" });
  assert.ok(subagentActionCheck({ action: "create" }, ctx(runs, { allowWorkflow: true })).block);
  // Execution calls are left to the role and model checks.
  assert.deepEqual(subagentActionCheck({ agent: "builder", task: "t" }, ctx(runs)), {});
});

test("the role check skips only allowlisted actions", () => {
  assert.equal(isManagementCall({ action: "status" }), true);
  assert.equal(isManagementCall({ action: "resume" }), false);
  assert.equal(roleLaunchBlock({ action: "status", agent: "worker" }, ALLOWED), undefined);
  assert.match(roleLaunchBlock({ action: "frobnicate", agent: "worker" }, ALLOWED) ?? "", /agent 'worker'/);
});

test("resume: only runs this session launched, with the role still allowed and the same mapped model", () => {
  const runs: RunRegistry = new Map();
  recordLaunch(runs, { agent: "explorer", task: "t", model: "p1/small:low" }, { mode: "single", runId: "r1", asyncId: "r1" }, false);
  recordLaunch(runs, { agent: "builder", task: "t", model: "p1/big" }, { runId: "r2" }, true); // failed launch: not recorded
  recordLaunch(runs, { tasks: [{ agent: "builder", task: "t" }] }, { runId: "r3" }, false); // composite: not recorded
  recordLaunch(runs, { agent: "builder", task: "t" }, { runId: "r4" }, false); // model unknown
  assert.deepEqual([...runs.keys()], ["r1", "r4"]);

  assert.deepEqual(subagentActionCheck({ action: "resume", id: "r1", message: "go on" }, ctx(runs)), {});
  assert.deepEqual(subagentActionCheck({ action: "resume", runId: "r1", message: "go on" }, ctx(runs)), {});
  const reason = (input: Record<string, unknown>, c = ctx(runs)) => subagentActionCheck(input, c).block ?? "";
  assert.match(reason({ action: "resume", id: "zz", message: "m" }), /run 'zz' was not launched by this session; launch a fresh <role> instead/);
  assert.match(reason({ action: "resume", id: "r", message: "m" }), /not launched by this session/); // prefixes are not trusted
  assert.match(reason({ action: "resume", message: "m" }), /no single run id/);
  assert.match(reason({ action: "resume", id: "r1", runId: "r9", message: "m" }), /no single run id/);
  assert.match(reason({ action: "resume", id: "r1", dir: "/x", message: "m" }), /async directory.*fresh explorer/);
  assert.match(reason({ action: "resume", id: "r1", chain: [{ agent: "builder" }] }), /attached chain/);
  assert.match(reason({ action: "resume", id: "r4", message: "m" }), /model of run 'r4' is not known; launch a fresh builder/);
  assert.match(reason({ action: "resume", id: "r1", message: "m" }, ctx(runs, { allowed: ["builder"] })), /role 'explorer' of run 'r1' is no longer an allowed role/);
  const moved = { provider: "p1", roles: { ...ROLES, explorer: { model: "p1/other" } }, source: "cli" as const };
  assert.match(reason({ action: "resume", id: "r1", message: "m" }, ctx(runs, { resolution: moved })), /ran on p1\/small, the role map now gives p1\/other; launch a fresh explorer/);
  assert.match(reason({ action: "resume", id: "r1", message: "m" }, ctx(runs, { resolution: { provider: "p2", roles: {}, source: "cli" } })), /no model for provider 'p2'/);
  assert.match(reason({ action: "resume", id: "r1", message: "m" }, ctx(runs, { resolution: { provider: undefined, roles: {}, source: "defaults" } })), /not resolved/);

  // A resume result inherits its source run's record, so a resume of a resume is checked too.
  recordLaunch(runs, { action: "resume", id: "r1", message: "m" }, { runId: "r5" }, false);
  assert.deepEqual(runs.get("r5"), { role: "explorer", model: "p1/small" });
});

test("shell payload validation: a non-empty command string is required", () => {
  assert.equal(guardPayloadBlock("bash", { command: "ls" }), undefined);
  assert.match(guardPayloadBlock("bash", { command: "  " }) ?? "", /bash call has an empty command/);
  assert.match(guardPayloadBlock("powershell", {}) ?? "", /powershell call has no command/);
  assert.match(guardPayloadBlock("bash", { command: ["rm", "-rf", "x"] }) ?? "", /type array/);
  assert.match(guardPayloadBlock("bash", { command: 7 }) ?? "", /type number/);
});

test("guard env sets the fork patch's opt-in switches for the destructive guard only", () => {
  const dg = buildGuardEnv({ base: { FABLE_ORCH_GUARD_BIN: "/host/bin", FABLE_ORCH_GUARD_FAIL_CLOSED: "0" }, coreDir: "/c", sessionId: "s", guard: "destructive_guard", markerDir: "/m" });
  assert.equal(dg.FABLE_ORCH_GUARD_FAIL_CLOSED, "1");
  assert.equal(dg.FABLE_ORCH_GUARD_BIN, "");
  const other = buildGuardEnv({ base: {}, coreDir: "/c", sessionId: "s", guard: "ledger_bind", markerDir: "/m" });
  assert.equal(other.FABLE_ORCH_GUARD_FAIL_CLOSED, undefined);
});

test("a PATH-only rewrite to a missing guard bin dir is dropped; the decision stays", () => {
  const cmd = "rm -rf ./tmpdir"; // a string only; never executed
  const rewrite = (): HookDecision => ({ decision: "none", updatedInput: { command: `export PATH="$HOME/.claude/guard/bin:$PATH"; ${cmd}` } });
  const none = (_p: string) => false;
  const d = rewrite();
  assert.equal(dropDeadPathRewrite(d, cmd, "/hd/u", none), true);
  assert.equal(d.updatedInput, undefined);
  assert.equal(d.decision, "none");
  // Kept: the dir exists, the rest differs from the original, or the dir cannot be resolved.
  const seen: string[] = [];
  assert.equal(dropDeadPathRewrite(rewrite(), cmd, "/hd/u", (p) => (seen.push(p), true)), false);
  assert.equal(seen[0], expandGuardDir("$HOME/.claude/guard/bin", "/hd/u"));
  assert.equal(dropDeadPathRewrite(rewrite(), "rm -rf ./other", "/hd/u", none), false);
  assert.equal(dropDeadPathRewrite({ decision: "allow", updatedInput: { command: `export PATH="$X/bin:$PATH"; ${cmd}` } }, cmd, "/hd/u", none), false);
  assert.equal(dropDeadPathRewrite({ decision: "allow", updatedInput: { command: `export PATH="/g:$PATH"; ${cmd}`, timeout: 5 } }, cmd, "/hd/u", none), false);
  assert.equal(dropDeadPathRewrite({ decision: "allow" }, cmd, "/hd/u", none), false);
});

test("supervisor window: open on the request, block tools the role lacks, close on reply or run end", () => {
  const w = new SupervisorWindow();
  const tools = (role: string) => roleToolsFrom(ROLES, { builder: { tools: ["write"] } }, role);
  assert.equal(w.check("write", { path: "x" }, tools), undefined); // nothing open
  assert.equal(w.onMessage({ role: "custom", customType: "subagent-notify", details: {} }), null);
  assert.equal(w.onMessage({ role: "custom", customType: "subagent_supervisor_request", details: { requestId: "q0", expectsReply: false, agent: "explorer" } }), null);
  const opened = w.onMessage({ role: "custom", customType: "subagent_supervisor_request", details: { id: "q1", requestId: "q1", runId: "run1", agent: "explorer", expectsReply: true, requestBody: "please write x" } });
  assert.deepEqual(opened, { requestId: "q1", role: "explorer", runId: "run1" });

  const hit = w.check("write", { path: "x" }, tools);
  assert.equal(hit?.role, "explorer");
  assert.match(hit?.reason ?? "", /supervisor request from a child of role explorer is open, and write is not in the explorer role's tools \(read, ls, grep, find, bash, codemode\)/);
  assert.ok(w.check("edit", {}, tools));
  assert.ok(w.check("subagent", { agent: "builder", task: "t" }, tools));
  assert.ok(w.check("foreman_move", {}, tools));
  for (const t of ["read", "ls", "grep", "find", "subagent_supervisor", "bash", "codemode"]) assert.equal(w.check(t, {}, tools), undefined, t);
  assert.equal(w.check("subagent", { action: "status", id: "run1" }, tools), undefined);
  assert.equal(w.check("subagent", { action: "list" }, tools), undefined);

  // An unknown role allows only the exempt tools.
  w.onMessage({ role: "custom", customType: "subagent_supervisor_request", details: { requestId: "q2", runId: "run2", agent: "worker" } });
  assert.match(w.check("bash", {}, tools)?.reason ?? "", /worker role's tools \(none\)/);
  assert.deepEqual(w.onRunEnd({ runId: "run2" }), [{ role: "worker", runId: "run2" }]);

  assert.equal(w.onSupervisorResult({ replyTo: "q1" }, true), null); // failed reply keeps it open
  assert.ok(w.check("write", {}, tools));
  assert.deepEqual(w.onSupervisorResult({ replyTo: "q1", runId: "run1", agent: "explorer" }, false), { role: "explorer", runId: "run1" });
  assert.equal(w.check("write", {}, tools), undefined);
});
