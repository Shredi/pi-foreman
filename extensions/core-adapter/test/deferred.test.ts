// Deferred tool declarations (ledger items 2, 4): the pure hidden-set functions of deferred.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFERRED_ENTRY, DEFERRED_FLOOR, deferredDoctorLines, deferredHint, hiddenSet, latestDeferredLoaded, matchesPattern, mergeDeferredLayers, unmatchedPatterns } from "../deferred.ts";

const DEFAULTS = ["fusion_*", "bg_delegate", "bg_run_pi_attested", "bg_result", "bg_kill", "foreman_session_open", "foreman_dialogs", "foreman_worktree_remove", "foreman_move", "foreman_copy", "pr_comments", "pr_track", "pr_untrack", "plan_mode_question", "plan_mode_complete"];
const DECLARED = ["read", "bash", "bg_run", "bg_wait", "bg_logs", "bg_status", "bg_result", "bg_kill", "bg_delegate", "bg_run_pi_attested", "fusion_validate", "fusion_reason", "subagent", "subagent_supervisor", "foreman_ledger", "foreman_move", "pr_comments", "pr_status", "plan_mode_question", "plan_mode_complete", "tool_search", "codemode"];

test("a name pattern is exact and a glob stands for any run of characters", () => {
  assert.equal(matchesPattern("bg_kill", "bg_kill"), true);
  assert.equal(matchesPattern("bg_kill", "bg_kill2"), false);
  assert.equal(matchesPattern("fusion_*", "fusion_validate"), true);
  assert.equal(matchesPattern("fusion_*", "fusion"), false);
  assert.equal(matchesPattern("a.b*", "a.bc"), true);
  assert.equal(matchesPattern("a.b*", "axbc"), false); // the dot is literal
});

test("the default list hides the rare tools and keeps the frequent ones declared", () => {
  const hidden = hiddenSet({ patterns: DEFAULTS, declared: DECLARED, loaded: [], planMode: false });
  assert.deepEqual(hidden, ["bg_result", "bg_kill", "bg_delegate", "bg_run_pi_attested", "fusion_validate", "fusion_reason", "foreman_move", "pr_comments", "plan_mode_question", "plan_mode_complete"]);
  for (const kept of ["bg_run", "bg_wait", "bg_logs", "bg_status", "subagent", "subagent_supervisor"]) assert.equal(hidden.includes(kept), false, kept);
});

test("the floor is never hidden, even when a pattern names it", () => {
  const hidden = hiddenSet({ patterns: ["*"], declared: [...DECLARED, "contact_supervisor", "foreman_triage", "ask_user_question"], loaded: [], planMode: false });
  for (const name of DEFERRED_FLOOR) assert.equal(hidden.includes(name), false, name);
  assert.ok(hidden.includes("bg_run"));
});

test("a plan-mode session declares the two plan-mode tools; a normal session does not", () => {
  const on = hiddenSet({ patterns: DEFAULTS, declared: DECLARED, loaded: [], planMode: true });
  assert.equal(on.includes("plan_mode_question"), false);
  assert.equal(on.includes("plan_mode_complete"), false);
  assert.ok(on.includes("bg_kill"));
  assert.ok(hiddenSet({ patterns: DEFAULTS, declared: DECLARED, loaded: [], planMode: false }).includes("plan_mode_question"));
});

test("names loaded earlier in the session are not hidden", () => {
  const hidden = hiddenSet({ patterns: DEFAULTS, declared: DECLARED, loaded: ["bg_result", "fusion_reason"], planMode: false });
  assert.equal(hidden.includes("bg_result"), false);
  assert.equal(hidden.includes("fusion_reason"), false);
  assert.ok(hidden.includes("fusion_validate"));
});

test("an empty list hides nothing", () => {
  assert.deepEqual(hiddenSet({ patterns: [], declared: DECLARED, loaded: [], planMode: false }), []);
});

test("layer merge: the project may add names; a removal, an empty list over a non-empty base and a non-list are dropped with a warning", () => {
  const added = mergeDeferredLayers(["a", "b"], [{ who: "project", value: ["b", "c"] }]);
  assert.deepEqual(added.list, ["a", "b", "c"]);
  assert.deepEqual(added.warnings, []);
  const removal = mergeDeferredLayers(["a", "b"], [{ who: "project", value: [] }]);
  assert.deepEqual(removal.list, ["a", "b"]);
  assert.match(removal.warnings[0], /project tools\.deferred ignored: the project may only add names/);
  const bad = mergeDeferredLayers(["a"], [{ who: "session", value: "a" }]);
  assert.deepEqual(bad.list, ["a"]);
  assert.match(bad.warnings[0], /session tools\.deferred ignored: not a list/);
  assert.deepEqual(mergeDeferredLayers(["a"], [{ who: "project", value: undefined }]), { list: ["a"], warnings: [] });
  assert.deepEqual(mergeDeferredLayers([], [{ who: "project", value: [] }]).warnings, []); // nothing to remove
  assert.deepEqual(mergeDeferredLayers(undefined, []).list, []);
});

test("the hint names the hidden tools only, with the codemode call only when codemode is active", () => {
  const withCodemode = deferredHint(["bg_kill", "bg_result"], true);
  assert.match(withCodemode, /tool_search/);
  assert.match(withCodemode, /tools\.<name>\(\)/);
  assert.ok(withCodemode.endsWith(": bg_kill, bg_result"));
  assert.doesNotMatch(deferredHint(["bg_kill"], false), /codemode/);
  assert.ok(deferredHint(DEFAULTS.slice(1, 5), true).length / 3.6 < 100, "about 60 tokens");
});

test("patterns that match no registered tool are listed", () => {
  assert.deepEqual(unmatchedPatterns(["fusion_*", "bg_kill", "typo_tool", "nothing_*"], ["fusion_reason", "bg_kill"]), ["typo_tool", "nothing_*"]);
});

test("doctor: a WARN per unmatched pattern and the PI_BG_FEATURES=process line when the add-on's optional tools are registered", () => {
  const lines = deferredDoctorLines(["fusion_*", "typo_tool"], ["fusion_reason", "bg_run"]);
  assert.equal(lines.filter((l) => l.startsWith("WARN") && l.includes("\"typo_tool\"")).length, 1);
  assert.equal(lines.some((l) => l.includes("\"fusion_*\"")), false);
  assert.ok(lines.some((l) => l.startsWith("WARN") && l.includes("fusion_reason") && l.includes("PI_BG_FEATURES=process")));
  for (const only of ["bg_delegate", "bg_run_pi_attested"]) assert.ok(deferredDoctorLines([], [only]).some((l) => l.includes("PI_BG_FEATURES=process")), only);
  assert.deepEqual(deferredDoctorLines(DEFAULTS.slice(3, 5), ["bg_result", "bg_kill", "bg_run"]), []);
});

test("resume read-back: the latest deferred-loaded entry of the branch decides", () => {
  const branch = [
    { type: "custom", customType: DEFERRED_ENTRY, data: { names: ["a"], planMode: false } },
    { type: "custom", customType: "other", data: {} },
    { type: "custom", customType: DEFERRED_ENTRY, data: { names: ["a", "b", 3], planMode: true } },
  ];
  assert.deepEqual(latestDeferredLoaded(branch), { names: ["a", "b"], planMode: true });
  assert.equal(latestDeferredLoaded([]), null);
  assert.equal(latestDeferredLoaded([{ type: "message" }]), null);
});
