// Same-line variables in the shell write guard (ledger item 12, friction 97/30): the real script, command strings only.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { runShellWriteGuard, shellWriteGuardPayload, shellWriteVerdict } from "../shellwriteguard.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const pc = { sessionId: "s1", cwd: os.tmpdir(), home: os.homedir() };

test("H=<handoff dir>; cp <plan> \"$H/plan.md\" is allowed for an allowed dir; the prefix form stays refused", { skip: !py.ok ? "no Python >= 3.9" : false }, async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-swg-vars-")));
  try {
    const handoff = path.join(ws, "handoffs", "s1");
    fs.mkdirSync(handoff, { recursive: true });
    fs.mkdirSync(path.join(ws, "src"));
    const python = py.ok ? py.info.executable : null;
    const verdict = async (command: string) =>
      shellWriteVerdict(await runShellWriteGuard({ python, pkgRoot: repo, payload: shellWriteGuardPayload({ command }, { ...pc, cwd: ws }, ws, "bash", [".workflow"], [handoff]), env: { ...process.env } as Record<string, string>, cwd: ws, spawner: defaultSpawner }), python);
    assert.deepEqual(await verdict(`cp plan.md ${handoff}/plan.md`), { decision: "allow" });
    assert.deepEqual(await verdict(`H=${handoff}; cp plan.md "$H/plan.md"`), { decision: "allow" });
    assert.equal((await verdict(`H=${handoff} cp plan.md "$H/plan.md"`)).decision, "refuse", "prefix assignment");
    assert.equal((await verdict(`cp plan.md "$H/plan.md"`)).decision, "refuse", "unknown $H");
    assert.equal((await verdict(`H=${ws}/src; cp plan.md "$H/plan.md"`)).decision, "refuse", "resolved outside the allowed dir");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
