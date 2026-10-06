// Review flow (plan D2, D3, D5, D6, D10): revision rounds, triage gate, model map checks and
// the reviewer's read-only-with-shell tool pin. Temp dirs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { escalate, initialCeremony, userOverride } from "../ceremony.ts";
import { afterBuilderLaunch, checkBuilderLaunch, completedAgents, initialRounds, onReviewDone, revisionLimit, verdictOf } from "../rounds.ts";
import { foremanTriage, isTriaged, triageGateBlock } from "../triage.ts";
import { familyWarnings, modelFamily, modelGaps } from "../modelcheck.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("completion notices: completed agents and the review verdict", () => {
  assert.deepEqual(completedAgents("Background task completed: **reviewer**\n\nreviewer:\n1. FAIL x"), ["reviewer"]);
  assert.deepEqual(completedAgents("Background task failed: **reviewer**\n\nboom"), []);
  assert.deepEqual(completedAgents("Background tasks completed (2): **builder**, **reviewer** (1/2)\n"), ["builder", "reviewer"]);
  assert.deepEqual(completedAgents("reviewer said Background task completed: **reviewer**"), []);
  assert.equal(verdictOf("1. PASS a\n3. Overall verdict: FAIL"), "fail");
  assert.equal(verdictOf("**Overall verdict:** PASS"), "pass");
  assert.equal(verdictOf("1. Verdict: BLOCK"), "fail");
  assert.equal(verdictOf("Verdict: APPROVE"), "pass");
  assert.equal(verdictOf("Overall verdict: PASS\nOverall verdict: FAIL"), "fail");
  assert.equal(verdictOf("1. PASS everything"), null);
});

test("revision rounds: limits per tier, PASS opens none, a review before any build opens none", () => {
  assert.deepEqual([revisionLimit(undefined, "trivial"), revisionLimit(undefined, "standard"), revisionLimit({ heavy: 5 }, "heavy"), revisionLimit({ standard: -1 }, "standard")], [0, 1, 5, 1]);
  let r = onReviewDone(initialRounds(), "fail");
  assert.equal(checkBuilderLaunch(r, "standard", undefined).revision, false, "plan review before the first build");
  r = afterBuilderLaunch(r, false);
  assert.equal(checkBuilderLaunch(onReviewDone(r, "pass"), "standard", undefined).revision, false);
  r = onReviewDone(r, null);
  assert.deepEqual(checkBuilderLaunch(r, "standard", undefined), { revision: true });
  r = onReviewDone(afterBuilderLaunch(r, true), "fail");
  const second = checkBuilderLaunch(r, "standard", undefined);
  assert.match(second.block ?? "", /revision limit for standard reached \(1\).*Report the open findings to the owner.*\/ceremony/s);
  assert.deepEqual(checkBuilderLaunch(r, "heavy", { heavy: 2 }), { revision: true });
  assert.ok(checkBuilderLaunch(onReviewDone(afterBuilderLaunch(initialRounds(), false), "fail"), "trivial", undefined).block);
});

test("foreman_triage records a tier and never lowers a recorded or escalated one", () => {
  const d = initialCeremony("standard");
  assert.equal(isTriaged(d), false);
  const t = foremanTriage(d, "trivial", "typo");
  assert.ok("state" in t && t.state.tier === "trivial" && t.state.source === "foreman" && isTriaged(t.state));
  const heavy = escalate(d, "heavy", "auto", "signal");
  assert.equal(isTriaged(heavy), false, "an escalation by a signal is no triage");
  const low = foremanTriage(heavy, "standard", "x");
  assert.ok("error" in low && /never lowers a recorded or escalated tier/.test(low.error));
  assert.ok("error" in foremanTriage(userOverride(d, "standard"), "trivial", "x"));
  const up = foremanTriage(heavy, "heavy", "agreed");
  assert.ok("state" in up && isTriaged(up.state));
  // a later escalation keeps the triage
  if ("state" in t) assert.equal(isTriaged(escalate(t.state, "standard", "auto", "second child launch")), true);
});

test("triage gate: workspace paths only, .workflow open, symlinks and move/copy covered", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-triage-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, "ws");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".workflow"));
  fs.mkdirSync(path.join(ws, "src"));
  fs.mkdirSync(outside);
  const opts = { cwd: ws, home: root, platform: process.platform };
  const untriaged = initialCeremony("standard");
  const trivial = userOverride(untriaged, "trivial");
  const standard = userOverride(untriaged, "standard");
  assert.match(triageGateBlock("edit", { path: "src/a.ts" }, untriaged, opts) ?? "", /no tier recorded yet.*Call foreman_triage/);
  assert.match(triageGateBlock("write", { path: "src/a.ts" }, standard, opts) ?? "", /tier is standard.*Launch a builder/);
  assert.equal(triageGateBlock("write", { path: "src/a.ts" }, trivial, opts), undefined);
  assert.equal(triageGateBlock("write", { path: ".workflow/LEDGER-x.md" }, untriaged, opts), undefined);
  assert.equal(triageGateBlock("write", { path: path.join(outside, "x") }, standard, opts), undefined);
  assert.equal(triageGateBlock("read", { path: "src/a.ts" }, standard, opts), undefined);
  assert.ok(triageGateBlock("foreman_move", { src: "src/a.ts", dst: ".workflow/a.ts" }, standard, opts), "moving a workspace file out is a change");
  assert.ok(triageGateBlock("foreman_copy", { src: ".workflow/n.md", dst: "src/n.md" }, standard, opts));
  assert.equal(triageGateBlock("foreman_copy", { src: "src/a.ts", dst: ".workflow/a.ts" }, standard, opts), undefined);
  assert.ok(triageGateBlock("foreman_move", { src: ".workflow", dst: path.join(outside, "w") }, standard, opts), "the .workflow folder itself is not exempt");
  if (process.platform !== "win32") {
    fs.symlinkSync(path.join(ws, "src"), path.join(ws, ".workflow", "into-src"));
    assert.ok(triageGateBlock("write", { path: ".workflow/into-src/a.ts" }, standard, opts), "a link inside .workflow cannot carry a write out of it");
    fs.symlinkSync(path.join(ws, "src"), path.join(outside, "link"));
    assert.ok(triageGateBlock("write", { path: path.join(outside, "link", "a.ts") }, standard, opts), "a link outside cannot carry a write into the workspace");
  }
});

test("model map checks: registry gaps, auth gaps and the reviewer family warning", () => {
  assert.deepEqual(["anthropic/claude-sonnet-4-5:high", "openai/gpt-5", "o3-mini", "gemini-2.5-pro", "vendor/acme-large"].map(modelFamily), ["claude", "gpt", "gpt", "gemini", "acme"]);
  const config = { providers: { p: { fallback: { provider: "q" }, roles: { builder: { model: "p/claude-a", strong: { model: "p/claude-b" } }, reviewer: { model: "p/claude-c" } } }, q: { roles: { finalizer: { model: "q/x" } } } } };
  const known = new Set(["p/claude-a", "p/claude-c"]);
  const registry = { find: (p: string, id: string) => (known.has(`${p}/${id}`) ? {} : undefined), getProviderAuthStatus: (p: string) => ({ configured: p === "p" }), getAvailable: () => [{ provider: "p", id: "claude-a" }, { provider: "p", id: "gpt-5" }, { provider: "z", id: "gemini" }] };
  const gaps = modelGaps(config, "p", registry);
  assert.deepEqual(gaps, ["model p/claude-b (providers.p.roles.builder.strong) is not in the model registry", "model q/x (providers.q.roles.finalizer) is not in the model registry", "no auth for provider q, which the map for p uses"]);
  const roles = { builder: { model: "p/claude-a", strong: { model: "p/claude-b" } }, reviewer: { model: "p/claude-c" }, "senior-reviewer": { model: "p/gpt-5" } };
  const w = familyWarnings(roles, "p", registry);
  assert.equal(w.length, 1);
  assert.match(w[0], /the reviewer \(p\/claude-c\) and the builder share the model family claude on p.*for example p\/gpt-5/);
  assert.deepEqual(familyWarnings(roles, "p", { ...registry, getAvailable: () => [{ provider: "p", id: "claude-z" }] }), [], "no other family on offer: no warning");
});

test("H4 pin: the reviewer roles are read-only with a shell", () => {
  const want = ["read", "ls", "grep", "find", "bash"];
  const defaults = JSON.parse(fs.readFileSync(path.join(PKG, "config", "foreman.defaults.json"), "utf8"));
  for (const role of ["reviewer", "senior-reviewer"]) {
    assert.deepEqual(defaults.roles[role].tools, want, role);
    const front = fs.readFileSync(path.join(PKG, "agents", `${role}.md`), "utf8").split(/^---$/m)[1];
    assert.deepEqual(/^tools:\s*(.*)$/m.exec(front)?.[1].split(/,\s*/), want, role);
  }
});
