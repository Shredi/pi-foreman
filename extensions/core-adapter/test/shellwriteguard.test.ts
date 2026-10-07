// Shell write guard runner (plan D3). The real-script case passes command STRINGS to
// scripts/shell_write_guard.py; nothing is executed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import type { Spawner } from "../spawn.ts";
import { runShellWriteGuard, SHELL_WRITE_REFUSAL, shellWriteGuardPayload, shellWriteVerdict } from "../shellwriteguard.ts";
import { FAIL_POLICY } from "../translate.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const pc = { sessionId: "s1", cwd: os.tmpdir(), home: os.homedir() };
const ran = (code: number | null, stdout: string) => ({ status: "ran" as const, code, stdout, stderr: "" });

test("payload carries the command, cwd and workspace root; runner spawns <pkg>/scripts/shell_write_guard.py", async () => {
  const p = shellWriteGuardPayload({ command: "echo x > f" }, pc, "/ws");
  assert.equal(p.tool_name, "Bash");
  assert.deepEqual(p.tool_input, { command: "echo x > f" });
  assert.equal(p.workspace, "/ws");
  assert.equal(p.shell, "bash");
  const ps = shellWriteGuardPayload({ command: "Set-Content f x" }, pc, "/ws", "powershell");
  assert.deepEqual([ps.tool_name, ps.shell, (ps.tool_input as { command: string }).command], ["Bash", "powershell", "Set-Content f x"]);
  const calls: string[][] = [];
  const spawner: Spawner = async (cmd, args) => (calls.push([cmd, ...args]), { code: 0, stdout: "", stderr: "", timedOut: false });
  await runShellWriteGuard({ python: "py", pkgRoot: "/pkg", payload: p, env: {}, cwd: "/", spawner });
  assert.deepEqual(calls[0], ["py", "-E", "-s", path.join("/pkg", "scripts", "shell_write_guard.py")]);
  assert.equal(FAIL_POLICY.shell_write_guard, "closed");
});

test("verdict: empty stdout allows; a deny refuses with the script's reason and a slug kind", () => {
  assert.deepEqual(shellWriteVerdict(ran(0, ""), "py"), { decision: "allow" });
  const deny = (kind: unknown) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `pi-foreman: ${SHELL_WRITE_REFUSAL} (redirect: f)` }, kind });
  assert.deepEqual(shellWriteVerdict(ran(0, deny("redirect")), "py"), { decision: "refuse", kind: "redirect", reason: `pi-foreman: ${SHELL_WRITE_REFUSAL} (redirect: f)` });
  // a kind that is not a short slug never reaches the trace
  assert.equal((shellWriteVerdict(ran(0, deny("echo x > src/a.go")), "py") as { kind: string }).kind, "unknown");
});

test("verdict fails closed: no Python, spawn error, timeout, exit 2, garbage", () => {
  const failures = [
    { status: "failed" as const, failure: "no-python" as const, detail: "none" },
    { status: "failed" as const, failure: "spawn" as const, detail: "ENOENT" },
    { status: "failed" as const, failure: "timeout" as const, detail: "slow" },
    { status: "ran" as const, code: 2, stdout: "", stderr: "shell_write_guard: internal error: X" },
    ran(0, "not json"),
  ];
  for (const r of failures) {
    const v = shellWriteVerdict(r, "py");
    assert.equal(v.decision, "failure", JSON.stringify(r));
    assert.match((v as { reason: string }).reason, /shell write guard could not run.*blocked/);
  }
});

test("real script: project write refused, .workflow write allowed", { skip: !py.ok ? "no Python >= 3.9" : false }, async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-swg-")));
  try {
    fs.mkdirSync(path.join(ws, ".workflow"));
    const python = py.ok ? py.info.executable : null;
    const verdict = async (command: string, tool: "bash" | "powershell" = "bash") =>
      shellWriteVerdict(await runShellWriteGuard({ python, pkgRoot: repo, payload: shellWriteGuardPayload({ command }, { ...pc, cwd: ws }, ws, tool), env: { ...process.env } as Record<string, string>, cwd: ws, spawner: defaultSpawner }), python);
    const refused = await verdict("cat > src/a_test.go <<'EOF'\npackage a\nEOF");
    assert.equal(refused.decision, "refuse");
    assert.equal((refused as { kind: string }).kind, "redirect");
    assert.ok((refused as { reason: string }).reason.includes(SHELL_WRITE_REFUSAL));
    assert.deepEqual(await verdict("echo note >> .workflow/notes.md"), { decision: "allow" });
    // the foreman's powershell tool: cmdlet writes refused, `.workflow/` still writable
    const ps = await verdict("Set-Content -Path src/a.go -Value 'package a'", "powershell");
    assert.deepEqual([ps.decision, (ps as { kind: string }).kind], ["refuse", "set-content"]);
    assert.deepEqual(await verdict("'note' | Out-File .workflow/notes.md", "powershell"), { decision: "allow" });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
