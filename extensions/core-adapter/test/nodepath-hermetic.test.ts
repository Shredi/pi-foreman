// _hermetic-env.mjs: the agent dir of a test process is an empty temp dir, never the real ~/.pi/agent, so a session_start in a test
// cannot leave the node-path record (nodepath.ts) where a launcher test of another step would find it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodePathFile } from "../nodepath.ts";

test("the agent dir of the test process is a fresh temp dir, not the real one, and holds no node-path record", () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  assert.ok(agentDir, "PI_CODING_AGENT_DIR is seeded by _hermetic-env.mjs");
  assert.ok(path.resolve(agentDir).startsWith(fs.realpathSync(os.tmpdir())), `${agentDir} is under the temp dir`);
  assert.notEqual(path.resolve(agentDir), path.join(os.homedir(), ".pi", "agent"));
  assert.equal(fs.existsSync(nodePathFile(agentDir)), false, "no node-path record at the start of a test file");
});
