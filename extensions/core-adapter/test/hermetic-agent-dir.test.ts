// The hermetic preload points the agent dir at a temp folder, so a real session a test opens cannot write the real ~/.pi/agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { piAgentDir } from "../env.ts";

test("under the hermetic preload the agent dir is a temp folder, not the real home", { skip: process.env.PI_FOREMAN_NO_PRELOAD === "1" }, () => {
  const dir = piAgentDir(process.env, os.homedir());
  const real = path.join(os.homedir(), ".pi", "agent");
  assert.notEqual(path.resolve(dir), path.resolve(real));
  assert.ok(path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(dir)).startsWith("..") === false, `agent dir ${dir} is not under the temp root`);
  assert.ok(path.basename(dir).startsWith("pf-agent-dir-"));
});
