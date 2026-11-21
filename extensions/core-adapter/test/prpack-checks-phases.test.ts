// `pr_checks` through the pack: the answer is tagged by tools.prPhases (prphases.ts tagChecks) for GitHub and GitLab shaped results; the repo comes from the call, else the checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import type { PhaseRule } from "../prphases.ts";
import { PrWatches } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: { result?: Record<string, unknown> } }> };
type Entry = Record<string, unknown>;

const RULES: PhaseRule[] = [{ repos: ["acme/*"], gate: ["ci/gate"], ignore: ["review-assign"], mergeLabel: "" }];
const GITHUB = { action: "pr_checks", pending: [{ name: "deploy", state: "IN_PROGRESS", link: "https://x/1" }], failed: [{ name: "review-assign", state: "FAILURE", link: "https://x/2" }, { name: "ci/gate", state: "FAILURE", link: "https://x/3" }], passed: [{ name: "build", state: "SUCCESS", link: "https://x/4" }], summary: "1 passed, 2 failed (review-assign, ci/gate), 1 pending", required: false };
const GITLAB = { action: "pr_checks", pending: [], failed: [{ name: "ci/gate", state: "failed", link: "https://gl/1" }], passed: [{ name: "build", state: "success", link: "https://gl/2" }, { name: "review-assign", state: "success", link: "https://gl/3" }], summary: "2 passed, 1 failed (ci/gate), 0 pending", required: false };

function setup(result: Record<string, unknown>, opts: { repoFor?: boolean; phases?: PhaseRule[] } = {}) {
  const tools = new Map<string, Tool>();
  const spawner: Spawner = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, ...result }) + "\n", stderr: "", timedOut: false });
  const watches = new PrWatches({ storeEntry: async () => ({ kind: "down" }), reviewedHeads: () => [], send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0 });
  const session: PrPackSession = {
    python: "/py", isChild: false, packOn: true, config: { baseBranch: "x", prHost: "auto" }, gateOn: false, reviewed: async () => [], watches, trace: () => {}, githubHosts: () => ({ hosts: ["github.com"] }),
    tracker: { hostAllowed: async () => true, ...(opts.repoFor === false ? {} : { repoFor: async () => ({ host: "github.com", repo: "acme/app" }) }) },
    phases: () => opts.phases ?? RULES,
  };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  return async (params: Record<string, unknown>) => (await tools.get("pr_checks")!.execute("id", params, undefined, undefined, { cwd: "/ws" })).details.result as Record<string, Entry[] | string>;
}

const phaseOf = (res: Record<string, Entry[] | string>, k: string, name: string) => (res[k] as Entry[]).find((e) => e.name === name)?.phase;

test("pr_checks GitHub shape: repo from the checkout, gate and not-counted tagged, summary counts phase 1", async () => {
  const res = await setup(GITHUB)({ number: 3 });
  assert.equal(phaseOf(res, "failed", "ci/gate"), "gate");
  assert.equal(phaseOf(res, "failed", "review-assign"), "not counted");
  assert.equal(phaseOf(res, "pending", "deploy"), undefined);
  assert.equal(res.summary, "1 passed, 0 failed, 1 pending");
});

test("pr_checks GitLab shape: repo from the call, tagged the same way", async () => {
  const res = await setup(GITLAB, { repoFor: false })({ number: 3, repo: "acme/api" });
  assert.equal(phaseOf(res, "failed", "ci/gate"), "gate");
  assert.equal(phaseOf(res, "passed", "review-assign"), "not counted");
  assert.equal(res.summary, "1 passed, 0 failed, 0 pending");
});

test("pr_checks: the call's repo wins over the checkout; a repository without a rule is untouched", async () => {
  const res = await setup(GITHUB)({ number: 3, repo: "other/app" });
  assert.equal(phaseOf(res, "failed", "ci/gate"), undefined);
  assert.equal(res.summary, GITHUB.summary);
  assert.equal(res.phases, undefined);
});

test("pr_checks: no repository known adds the repository unknown line and leaves the checks alone", async () => {
  const res = await setup(GITHUB, { repoFor: false })({ number: 3 });
  assert.equal(res.phases, "repository unknown");
  assert.equal(phaseOf(res, "failed", "ci/gate"), undefined);
  assert.equal(res.summary, GITHUB.summary);
});

test("pr_checks: without rules the answer is as the host gave it", async () => {
  const res = await setup(GITHUB, { phases: [] })({ number: 3 });
  assert.equal(res.phases, undefined);
  assert.equal(res.summary, GITHUB.summary);
});
