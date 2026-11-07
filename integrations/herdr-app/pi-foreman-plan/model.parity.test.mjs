import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as mine from "./model.js";
import * as agents from "../pi-foreman/model.js";

// The loader refuses a cross-mod import, so plan/model.js carries copies of these functions; they must stay equal.
for (const name of ["isSafeHttpsUrl", "openerArgv", "buildTree", "allSessions", "joinAgents", "joinPath", "fmtSince"]) {
  test(`${name} is the same source as in the Agents mod`, () => {
    assert.equal(String(mine[name]), String(agents[name]));
  });
}

test("the copies agree on a radar sample", () => {
  const doc = agents.parseRadarDoc(readFileSync(new URL("../pi-foreman/radar-sample.json", import.meta.url), "utf8"));
  assert.ok(doc.nodes.length > 0);
  assert.equal(JSON.stringify(mine.buildTree(doc.nodes)), JSON.stringify(agents.buildTree(doc.nodes)));
  const agentList = [{ address: "t1", pid: 1 }, { address: "t2" }];
  const a = agents.joinAgents(agentList, agents.buildTree(doc.nodes));
  const b = mine.joinAgents(agentList, mine.buildTree(doc.nodes));
  assert.deepEqual([...a].map(([k, n]) => [k, n.key]), [...b].map(([k, n]) => [k, n.key]));
});
