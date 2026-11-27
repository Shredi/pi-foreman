// D200 (ledger 19): the judge's cleared-call cache keys on the exact text, cwd, role and task; a refusal is never cached. D196b (ledger 18): read-only gh
// commands are `default-gh-read` for every role; a write form is not.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Classifier } from "../classifier.ts";
import type { ClassifierCtx, JudgeCall } from "../classifier.ts";
import { gateDecide, type GateResult } from "../gate.ts";
import type { GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import { mkTestTmp } from "./_tmpbase.ts";

function fakeRegistry(replies: string[]) {
  let n = 0;
  const registry = {
    find: () => ({ id: "m" }),
    complete: async () => ({ content: [{ type: "text", text: replies[Math.min(n++, replies.length - 1)] }], stopReason: "stop", usage: { input: 1, output: 1 } }),
  };
  return { registry, count: () => n };
}
const V = (verdict: string): string => JSON.stringify({ verdict, reason: "because" });
const CALL: JudgeCall = { tool: "bash", payload: "hc send --keys a", reason: "danger-unknown-program: x", kind: "child", role: "foreman", cwd: "/w", worktree: "/w", defaultBranch: "main", ownerMessage: "T1" };
const cfg = { providers: { fake: { roles: { review: { model: "fake/m" } } } } };
const mk = (replies: string[]) => {
  const reg = fakeRegistry(replies);
  const c: ClassifierCtx = { registry: reg.registry as never, config: cfg, provider: "fake", timeoutMs: 200 };
  return { c, reg };
};

test("a cleared call is cached for the exact text, cwd, role and task; any change is a new judge call", async () => {
  const k = new Classifier();
  const { c, reg } = mk([V("clear")]);
  await k.judge(CALL, c);
  await k.judge(CALL, c);
  assert.equal(reg.count(), 1, "the same call twice");
  await k.judge({ ...CALL, payload: "hc send --keys b" }, c);
  assert.equal(reg.count(), 2, "one changed character");
  await k.judge({ ...CALL, cwd: "/other" }, c);
  assert.equal(reg.count(), 3, "another cwd");
  await k.judge({ ...CALL, role: "builder" }, c);
  assert.equal(reg.count(), 4, "another role");
  await k.judge({ ...CALL, ownerMessage: "T2" }, c);
  assert.equal(reg.count(), 5, "another task");
  await k.judge(CALL, c);
  assert.equal(reg.count(), 5, "the first call is still cached");
});

test("a refusal is never cached: the same call is judged again", async () => {
  const k = new Classifier();
  const { c, reg } = mk([V("refuse"), V("refuse"), V("clear")]);
  assert.equal((await k.judge(CALL, c)).clear, false);
  assert.equal((await k.judge(CALL, c)).clear, false);
  assert.equal(reg.count(), 2);
  assert.equal((await k.judge(CALL, c)).clear, true);
  assert.equal(reg.count(), 3);
});

// ---- ledger 18: gh reads
const base = fs.realpathSync(mkTestTmp("pf-d196b-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));
const roots = (o: Partial<GateRoots> = {}): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false, ...o });
const facts: GitFacts = { currentBranch: () => "round/x", protectedBranches: () => ["main"], pushConfigured: () => false };
const env: FloorEnv = { cwd: wt, home: "/pf/home", agentDir: "/pf/agent", platform: process.platform, protectedBranches: ["main"], currentBranch: () => "round/x", remoteHead: () => "main", writeRoots: [wt, scr] };
const g = (command: string, r: Partial<GateRoots> = {}): GateResult => gateDecide("bash", { command }, wt, { env: () => env, roots: () => roots(r), facts });
const rule = (r: GateResult): string | null => (r && "allow" in r ? r.rule : null);
const ROLES: [string, Partial<GateRoots>][] = [["foreman", {}], ["builder", { child: true, role: "builder", builder: true }], ["reviewer", { child: true, role: "reviewer", roundReadOnly: true }], ["explorer", { child: true, role: "explorer", roundReadOnly: true }]];

test("gh reads are default-gh-read for every role", () => {
  const reads = ["gh pr view 12", "gh pr list", "gh pr checks", "gh run view 1", "gh run list", "gh api repos/x/y/pulls", "gh api -X GET repos/x/y/pulls -f state=open", "gh api graphql -f query='query { viewer { login } }'"];
  for (const [name, r] of ROLES) for (const c of reads) assert.equal(rule(g(c, r)), "default-gh-read", `${name}: ${c}`);
});

test("gh writes are not default-gh-read: -X POST, an implied POST with -f, a merge", () => {
  for (const [name, r] of ROLES) {
    for (const c of ["gh api -X POST repos/x/y/issues", "gh api repos/x/y/issues -f title=t", "gh pr merge 12", "gh pr create --fill"]) assert.notEqual(rule(g(c, r)), "default-gh-read", `${name}: ${c}`);
  }
});
