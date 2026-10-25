// R41 Ruling: every fresh subagent task gets the [pi-foreman roots] block; a builder task also gets the absolute plan and ledger paths of this session's .workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRootsBlock, rootsBlock } from "../childbrief.ts";

const roots = { installRoot: "/opt/pi/coding-agent", npmRoot: "/opt/npm/lib/node_modules", pkgRoot: "/opt/pf" };
const files = { plan: "/w/.workflow/scratch/plan-x.md", ledger: "/w/.workflow/LEDGER-x.md" };

test("single, tasks, chain and parallel steps all get the block; only a builder gets the plan and ledger paths", () => {
  const input: Record<string, unknown> = {
    tasks: [
      { agent: "builder", task: "build" },
      { agent: "explorer", task: "look" },
    ],
    chain: [{ agent: "reviewer", task: "review" }, { parallel: [{ agent: "builder", task: "second" }] }],
  };
  const recs = applyRootsBlock(input, roots, files);
  assert.equal(recs.length, 4);
  const all = [...(input.tasks as { agent: string; task: string }[]), (input.chain as { agent: string; task: string }[])[0], ((input.chain as { parallel: { agent: string; task: string }[] }[])[1]).parallel[0]];
  for (const e of all) {
    assert.ok(e.task.includes("[pi-foreman roots]") && e.task.includes("`/opt/pi/coding-agent`") && e.task.includes("`/opt/npm/lib/node_modules`") && /always denied/.test(e.task), e.agent);
    assert.equal(e.task.includes(files.plan) && e.task.includes(files.ledger), e.agent === "builder", e.agent);
  }
});

test("a single agent call is covered; a management action and a missing path stay as they are", () => {
  const one: Record<string, unknown> = { agent: "builder", task: "do it" };
  assert.equal(applyRootsBlock(one, roots, { plan: null, ledger: null }).length, 1);
  assert.ok(String(one.task).startsWith("do it\n\n[pi-foreman roots]"));
  assert.ok(!String(one.task).includes("Plan file"), "no plan path without an approved plan");
  const action: Record<string, unknown> = { action: "status", agent: "builder", task: "x" };
  assert.deepEqual(applyRootsBlock(action, roots, files), []);
  assert.equal(action.task, "x");
  assert.ok(rootsBlock(roots).endsWith("[end of roots]\n"));
});
