import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVars } from "../shellvars.ts";

test("resolveVars returns changed copies and leaves the parsed words alone", () => {
  const pipes = [[["A=/p/q"]], [["ls", "$A/x", "${A}", "$B"]]];
  const r = resolveVars(pipes, [";", "end"], {});
  assert.deepEqual(r.get(pipes[1][0]), ["ls", "/p/q/x", "/p/q", "$B"]);
  assert.deepEqual(pipes[1][0], ["ls", "$A/x", "${A}", "$B"]);
  assert.equal(r.size, 1);
  assert.equal(resolveVars([[["ls", "$FOREMAN_X"]]], ["end"], {}).size, 0);
  const env = [[["ls", "$FOREMAN_SCRATCH/y"]]];
  assert.deepEqual(resolveVars(env, ["end"], { FOREMAN_SCRATCH: "/e" }).get(env[0][0]), ["ls", "/e/y"]);
  // a relative value depends on a cd the line may hold
  const rel = [[["A=p/q"]], [["ls", "$A"]]];
  assert.equal(resolveVars(rel, [";", "end"], {}).size, 0);
});
