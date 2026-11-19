// Spawns the real core ledger_guard_spawn.py. Core location: <repo>/core, or
// PI_FOREMAN_TEST_CORE pointing at a core checkout. Skipped without Python or core.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGuardEnv } from "../env.ts";
import { preToolPayload } from "../payload.ts";
import { resolvePython } from "../python.ts";
import { runGuard } from "../runguard.ts";
import { defaultSpawner } from "../spawn.ts";
import { evaluateRun, translateToolCall } from "../translate.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const coreDir = [process.env.PI_FOREMAN_TEST_CORE, path.join(repo, "core")].find((d) => d && fs.existsSync(path.join(d, "scripts", "ledger_guard_spawn.py")));
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !coreDir ? "no core checkout" : !py.ok ? "no Python >= 3.13" : false;

async function decide(prompt: string, threshold: number) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pf-int-"));
  const python = py.ok ? py.info.executable : null;
  const env = buildGuardEnv({ base: process.env, coreDir: coreDir!, sessionId: "int-test", guard: "ledger_guard_spawn", markerDir: cwd, threshold });
  const payload = { ...preToolPayload("subagent", { task: prompt, agent: "builder" }, { sessionId: "int-test", cwd, home: os.homedir() }), permission_mode: "default" };
  const run = await runGuard({ python, coreDir: coreDir!, guard: "ledger_guard_spawn", payload, env, cwd, spawner: defaultSpawner });
  const input = { task: prompt };
  return translateToolCall({ guard: "ledger_guard_spawn", outcome: evaluateRun("ledger_guard_spawn", run, python), piTool: "subagent", input, ask: { isChild: false, mode: "print", hasUI: false } });
}

test("real spawn gate refuses an over-threshold launch without a ledger and passes a short one", { skip }, async () => {
  const denied = await decide("implement the whole multi-phase plan", 0);
  assert.equal(denied.result?.block, true);
  const allowed = await decide("ls", 100000);
  assert.equal(allowed.result, undefined);
});
