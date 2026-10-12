// R6 review fix: one review launch counts once against ceremony.reviewRuns (launchRoles lists a single-agent call twice).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { subagentAgents } from "../payload.ts";
import { roundSteps } from "../actions.ts";

test("a single-agent launch is listed twice by subagentAgents + roundSteps, so the cap counts subagentAgents only", () => {
  const input = { agent: "reviewer", task: "t" };
  assert.deepEqual(subagentAgents(input), ["reviewer"]);
  assert.equal([...subagentAgents(input), ...roundSteps(input, new Map()).flat()].length, 2);
  const src = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(src, /const reviewCount = subagentAgents\(input\)\.filter\(/);
});
