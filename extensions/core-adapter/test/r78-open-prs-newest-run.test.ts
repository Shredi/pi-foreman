import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CHECKS, parseSearch } from "../openprs.ts";
import { readFileSync } from "node:fs";

const T1 = "2026-01-01T00:00:00Z", T2 = "2026-01-01T01:00:00Z", T3 = "2026-01-01T02:00:00Z";
const run = (name: string, conclusion: string | null, startedAt: string | null, extra: Record<string, unknown> = {}) =>
  ({ __typename: "CheckRun", name, status: conclusion ? "COMPLETED" : "QUEUED", conclusion, startedAt, completedAt: null, ...extra });
const wf = (name: string) => ({ checkSuite: { app: { slug: "github-actions" }, workflowRun: { workflow: { name } } } });
const sc = (context: string, state: string, createdAt: string) => ({ __typename: "StatusContext", context, state, createdAt });
const states = (nodes: unknown[]) => {
  const n = { number: 1, title: "t", url: "https://example.test/acme/widgets/pull/1", isDraft: false, repository: { nameWithOwner: "acme/widgets" }, author: { login: "o" },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { nodes } } } }] } };
  return parseSearch(JSON.stringify({ data: { search: { nodes: [n] } } }))[0].checks.map((c) => `${c.n}:${c.state}`);
};

test("older failure + newer success of one check is ok only", () => {
  assert.deepEqual(states([run("p", "FAILURE", T1), run("p", "SUCCESS", T2), run("p", "SUCCESS", T3)]), ["p:ok"]);
  assert.deepEqual(states([run("p", "SUCCESS", T3), run("p", "FAILURE", T1)]), ["p:ok"]);
});

test("older success + newer failure is fail", () => {
  assert.deepEqual(states([run("p", "SUCCESS", T1), run("p", "FAILURE", T2)]), ["p:fail"]);
});

test("a newer queued run without startedAt is newest (run)", () => {
  assert.deepEqual(states([run("p", "SUCCESS", T1), run("p", null, null)]), ["p:run"]);
});

test("same name in two workflows stays two checks", () => {
  assert.deepEqual(states([run("b", "FAILURE", T1, wf("A")), run("b", "SUCCESS", T2, wf("B"))]), ["b:fail", "b:ok"]);
});

test("status contexts reduce by createdAt", () => {
  assert.deepEqual(states([sc("ci", "FAILURE", T1), sc("ci", "SUCCESS", T2)]), ["ci:ok"]);
  assert.deepEqual(states([sc("ci", "SUCCESS", T1), sc("ci", "ERROR", T2)]), ["ci:fail"]);
});

test("tie on startedAt goes to the later completedAt", () => {
  assert.deepEqual(states([run("p", "FAILURE", T1, { completedAt: T2 }), run("p", "SUCCESS", T1, { completedAt: T3 })]), ["p:ok"]);
});

test("duplicates do not use up the check cap", () => {
  const dup = Array.from({ length: MAX_CHECKS + 5 }, (_, i) => run("p", i % 2 ? "FAILURE" : "SUCCESS", T1));
  assert.equal(states([...dup, run("q", "SUCCESS", T1)]).length, 2);
});

test("the query asks for the fields identity and order need", () => {
  const src = readFileSync(new URL("../openprs.ts", import.meta.url), "utf8");
  for (const f of ["startedAt", "completedAt", "workflowRun{workflow{name}}", "createdAt"]) assert.ok(src.includes(f), f);
});
