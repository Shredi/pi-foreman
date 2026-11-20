// A child never merges a pull or merge request: `child-pr-merge`, built like `child-pr-create`. The main session gets no verdict and no label (C removed danger-forge).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-childmerge-"));
const wt = path.join(base, "wt");
fs.mkdirSync(wt, { recursive: true });
after(() => rmTestTmp(base));

const roots = (role: string, readOnly: boolean): GateRoots => ({ worktree: wt, scratch: [], tmp: [], scratchBase: path.join(base, "scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: role !== "foreman", role, tmpAccess: false, ...(readOnly ? { roundReadOnly: true } : {}) });
const run = (command: string, role: string, readOnly = false) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, role === "foreman" ? {} : { child: true }), roots: () => roots(role, readOnly) });
type Res = { allow?: boolean; block?: boolean; ask?: boolean; rule?: string; layer?: string; reason?: string };
const res = (o: ReturnType<typeof run>): Res => (o.result ?? {}) as Res;

const MERGES = [
  "gh pr merge",
  "gh pr merge 1",
  "gh pr merge --auto 1",
  "gh pr merge --squash 1",
  "gh pr merge --admin 1",
  "gh pr merge https://github.com/o/r/pull/1",
  "glab mr merge 1",
  "gh -R o/r pr merge 1",
  "FOO=1 gh pr merge 1",
  "cd x && gh pr merge 1",
  "/usr/bin/gh pr merge 1",
  "env gh pr merge 1",
  "sh -c \"gh pr merge 1\"",
  "gh api -X PUT repos/o/r/pulls/1/merge",
  "gh api --method PUT repos/o/r/pulls/1/merge",
  "gh api -XPUT repos/o/r/pulls/1/merge",
  "gh api --method=PUT repos/o/r/pulls/1/merge",
  "gh api -X PUT repos/o/r/pulls/1/merge -f merge_method=squash",
  "glab api -X PUT projects/1/merge_requests/2/merge",
];

for (const l of MERGES) {
  test(`child-pr-merge refuses ${JSON.stringify(l)} for builder, reviewer, explorer and the read-only round`, { skip: posixOnly }, () => {
    for (const [role, ro] of [["builder", false], ["builder", true], ["reviewer", false], ["reviewer", true], ["explorer", false], ["explorer", true]] as const) {
      const r = res(run(l, role, ro));
      assert.equal(r.block, true, `${role} ${ro}: ${JSON.stringify(r)}`);
      assert.equal(r.rule, "child-pr-merge", `${role} ${ro}`);
      assert.equal(r.layer, "floor");
      assert.equal(r.reason, "pi-foreman: denied for child sessions (child-pr-merge): Children never merge a pull or merge request; the foreman or the owner does. Report what you need to the foreman and continue with what you can.");
    }
  });

  test(`main has no verdict and no label (danger-forge gone) for ${JSON.stringify(l)}`, { skip: posixOnly }, () => {
    const o = run(l, "foreman");
    assert.deepEqual(res(o), {});
    assert.equal(o.danger, null, "C: danger-forge and danger-opaque are gone, main runs it with no judge");
  });
}

const READS = ["gh pr view 1", "gh pr list", "gh pr checks 1", "gh pr diff 1", "gh api repos/o/r/pulls/1", "gh api repos/o/r/pulls/1/merge", "gh api -X GET repos/o/r/pulls/1/merge"];

for (const l of READS) {
  test(`read form ${JSON.stringify(l)} keeps its allow for builder and main`, { skip: posixOnly }, () => {
    for (const role of ["builder", "foreman"]) {
      const o = run(l, role);
      assert.deepEqual(res(o), { allow: true, rule: "default-gh-read", layer: "default" }, role);
      assert.equal(o.danger, null);
    }
  });
}

test("merge words as data are not refused", { skip: posixOnly }, () => {
  const allowed: Array<[string, Res]> = [
    ["git commit -m \"gh pr merge\"", { allow: true, rule: "default-git-commit", layer: "default" }],
    ["grep -r \"gh pr merge\" docs", { allow: true, rule: "default-read", layer: "default" }],
    ["echo gh pr merge 1", {}],
  ];
  for (const [l, want] of allowed) for (const role of ["builder", "foreman"]) assert.deepEqual(res(run(l, role)), want, `${role}: ${l}`);
});

test("gh pr create stays child-pr-create; a variable program word is not refused by either rule", { skip: posixOnly }, () => {
  assert.equal(res(run("gh pr create --fill", "builder")).rule, "child-pr-create");
  for (const l of ["$X pr merge 1", "$X pr create"]) {
    const o = run(l, "builder");
    assert.deepEqual(res(o), {}, l);
    assert.equal(o.danger, null, l);
  }
});

test("gh pr merge --help is refused for a child like gh pr create --help; main keeps its verdict", { skip: posixOnly }, () => {
  assert.equal(res(run("gh pr merge --help", "builder")).rule, "child-pr-merge");
  assert.equal(res(run("gh pr create --help", "builder")).rule, "child-pr-create");
  const o = run("gh pr merge --help", "foreman");
  assert.deepEqual(res(o), {});
  assert.equal(o.danger, null);
});

test("not covered: a GraphQL merge mutation gets no child-pr-merge", { skip: posixOnly }, () => {
  const o = run("gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", "builder");
  assert.equal(res(o).rule, undefined);
  assert.equal(res(o).block, undefined);
});
