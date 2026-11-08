// Item 3: a refusal caused only by a parent-owned name in the own handoff dir carries handoffOnly (index.ts then skips the tier
// escalation); a refusal with any other target, an unresolved one included, does not. Runs the real script.
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
const pyRes = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const py = pyRes.ok ? pyRes.info.executable : null;
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-esc-ho-")));
const ws = path.join(base, "ws");
const handoff = path.join(base, "agent", "handoffs", "h1");
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(path.join(handoff, "work"), { recursive: true });
const pc = { sessionId: "s1", cwd: ws, home: os.homedir() };

async function verdict(command: string) {
  const payload = shellWriteGuardPayload({ command }, pc, ws, "bash", [".workflow"], [], { handoffDir: handoff });
  const run = await runShellWriteGuard({ python: py, pkgRoot: repo, payload, env: { ...process.env } as Record<string, string>, cwd: ws, spawner: defaultSpawner });
  return shellWriteVerdict(run, py);
}

test("a handoff-only refusal is marked handoffOnly (no escalation)", { skip: !py }, async () => {
  const v = await verdict(`echo x > ${handoff}/brief.md`);
  assert.equal(v.decision, "refuse");
  assert.equal((v as { handoffOnly?: boolean }).handoffOnly, true);
});

test("a refusal with a project target is no handoff-only refusal (still escalates)", { skip: !py }, async () => {
  const v = await verdict(`echo x > ${handoff}/brief.md; echo y > ${ws}/a.py`);
  assert.equal(v.decision, "refuse");
  assert.equal((v as { handoffOnly?: boolean }).handoffOnly, undefined);
});

test("an unresolved target next to a handoff refusal still escalates", { skip: !py }, async () => {
  const v = await verdict(`echo x > ${handoff}/brief.md; echo y > "$NOPE/a.py"`);
  assert.equal(v.decision, "refuse");
  assert.equal((v as { handoffOnly?: boolean }).handoffOnly, undefined);
});

test("a project-only refusal is not handoff-only", { skip: !py }, async () => {
  const v = await verdict(`echo y > ${ws}/a.py`);
  assert.equal(v.decision, "refuse");
  assert.equal((v as { handoffOnly?: boolean }).handoffOnly, undefined);
});

test("allow-list names are allowed, so nothing to escalate", { skip: !py }, async () => {
  assert.equal((await verdict(`echo x > ${handoff}/result.md`)).decision, "allow");
});
