// Spawns the real core destructive_guard.py. Core location: <repo>/core, or
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
const coreDir = [process.env.PI_FOREMAN_TEST_CORE, path.join(repo, "core")].find((d) => d && fs.existsSync(path.join(d, "scripts", "destructive_guard.py")));
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !coreDir ? "no core checkout" : !py.ok ? "no Python >= 3.9" : false;

async function decide(command: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pf-int-"));
  const python = py.ok ? py.info.executable : null;
  const env = buildGuardEnv({ base: process.env, coreDir: coreDir!, sessionId: "int-test", guard: "destructive_guard", markerDir: cwd });
  const run = await runGuard({ python, coreDir: coreDir!, guard: "destructive_guard", payload: preToolPayload("bash", { command }, { sessionId: "int-test", cwd, home: os.homedir() }), env, cwd, spawner: defaultSpawner });
  const input = { command };
  return translateToolCall({ guard: "destructive_guard", outcome: evaluateRun("destructive_guard", run, python), piTool: "bash", input, ask: { isChild: false, mode: "print", hasUI: false } });
}

test("real destructive guard denies a variable recursive rm and allows ls", { skip }, async () => {
  // The command text is only analysed by the guard, never executed.
  const denied = await decide('rm -rf -- "$1"/*');
  assert.equal(denied.result?.block, true);
  assert.match(denied.result!.reason, /^DESTRUCTIVE GUARD:/);
  const allowed = await decide("ls -la");
  assert.equal(allowed.result, undefined);
});
