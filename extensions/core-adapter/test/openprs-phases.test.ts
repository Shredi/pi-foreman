// openprs.ts parseSearch: search-feed PRs are classified by tools.prPhases (`phase` per check, `gate`, `gated`, `ruled`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearch } from "../openprs.ts";
import type { PhaseRule } from "../prphases.ts";

const ctx = (name: string, state: string) => ({ __typename: "StatusContext", context: name, state });
const node = (n: number, repo: string, contexts: unknown[]) => ({
  number: n, title: `PR ${n}`, url: `https://example.test/${repo}/pull/${n}`, isDraft: false, repository: { nameWithOwner: repo }, author: { login: "octo" },
  commits: { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: { state: "PENDING", contexts: { nodes: contexts } } } }] },
});
const text = (...nodes: unknown[]) => JSON.stringify({ data: { search: { nodes } } });
const RULES: PhaseRule[] = [{ repos: ["acme/*"], gate: ["ci/gate"], ignore: ["review-assign"], mergeLabel: "" }];
const GATE_ONLY: PhaseRule[] = [{ repos: ["acme/*"], gate: [], ignore: ["review-assign"], mergeLabel: "merge" }];

test("search entries: phase per check, gate state, gated and ruled", () => {
  const cases: [string, string, string][] = [["pending", "PENDING", "running"], ["failure", "FAILURE", "failed"], ["success", "SUCCESS", "passed"]];
  for (const [, state, want] of cases) {
    const [p] = parseSearch(text(node(1, "acme/app", [ctx("build", "SUCCESS"), ctx("ci/gate", state), ctx("review-assign", "FAILURE")])), RULES);
    assert.deepEqual(p.checks.map((c) => c.phase), [undefined, 2, "ignore"]);
    assert.deepEqual(p.gate, { state: want });
    assert.equal(p.gated, true);
    assert.equal(p.ruled, true);
  }
});

test("search entries: a merge label alone gates; a repository without a rule is unclassified", () => {
  const [a, b] = parseSearch(text(node(1, "acme/app", [ctx("build", "SUCCESS")]), node(2, "other/app", [ctx("ci/gate", "FAILURE")])), GATE_ONLY);
  assert.equal(a.gated, true);
  assert.equal(a.gate, undefined, "no gate check, no gate state (the feed has no required list, so never waiting)");
  assert.equal(b.gated, undefined);
  assert.equal(b.ruled, undefined);
  assert.equal(b.checks[0].phase, undefined);
});

test("search entries without rules are as before", () => {
  const [p] = parseSearch(text(node(1, "acme/app", [ctx("ci/gate", "FAILURE")])));
  assert.deepEqual(p.checks.map((c) => c.phase), [undefined]);
  assert.equal(p.gate, undefined);
});
