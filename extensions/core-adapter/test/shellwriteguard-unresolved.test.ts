// A refusal caused only by targets the guard cannot resolve carries unresolvedOnly (index.ts then skips the tier escalation, as for
// handoffOnly); a refusal with a project file, a resolved bad path or a parent-owned handoff name does not. Runs the real script.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { shPath } from "./_shpath.ts";
import { runShellWriteGuard, shellWriteGuardPayload, shellWriteVerdict } from "../shellwriteguard.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pyRes = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const py = pyRes.ok ? pyRes.info.executable : null;
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-swg-unres-")));
const ws = path.join(base, "ws");
const handoff = path.join(base, "agent", "handoffs", "h1");
fs.mkdirSync(path.join(ws, ".workflow"), { recursive: true });
fs.mkdirSync(path.join(ws, "src"), { recursive: true });
fs.mkdirSync(path.join(handoff, "work"), { recursive: true });
const pc = { sessionId: "s1", cwd: ws, home: os.homedir() };

async function verdict(line: string) {
  const payload = shellWriteGuardPayload({ command: shPath(line) }, pc, ws, "bash", [".workflow"], [], { handoffDir: handoff });
  const run = await runShellWriteGuard({ python: py, pkgRoot: repo, payload, env: { ...process.env } as Record<string, string>, cwd: ws, spawner: defaultSpawner });
  return shellWriteVerdict(run, py);
}
const flags = (v: Awaited<ReturnType<typeof verdict>>) => v as { decision: string; unresolvedOnly?: boolean; handoffOnly?: boolean; reason: string };

for (const line of ['echo x > ".workflow/$V"', 'echo x > ".workflow/$(echo a)"', 'echo x > "$V/.workflow/x"', 'echo x > "$V"', 'for l in a b; do cp x ".workflow/closed/$l/"; done']) {
  test(`unresolved-only refusal carries unresolvedOnly (no escalation): ${line}`, { skip: !py }, async () => {
    const v = flags(await verdict(line));
    assert.equal(v.decision, "refuse");
    assert.equal(v.unresolvedOnly, true);
    assert.match(v.reason, /\(unresolved\)/);
    assert.match(v.reason, /write the path literally or use the edit\/write tool/);
  });
}

for (const line of [
  "echo x > README.md",
  'echo x > "$V"; echo y > README.md',
  'D=.workflow; echo x > "$D/../README.md"',
  'V=../README.md; echo x > ".workflow/$V"',
  'D=src; echo x > "$D/a.ts"',
]) {
  test(`a refusal with a project file keeps escalating (no unresolvedOnly): ${line}`, { skip: !py }, async () => {
    const v = flags(await verdict(line));
    assert.equal(v.decision, "refuse");
    assert.equal(v.unresolvedOnly, undefined);
  });
}

test("a parent-owned handoff name through a resolved quoted variable is refused as handoffOnly, not unresolvedOnly", { skip: !py || process.platform === "win32" }, async () => {
  const v = flags(await verdict(`H="${handoff}"; echo x > "$H/brief.md"`));
  assert.equal(v.decision, "refuse");
  assert.equal(v.handoffOnly, true);
  assert.equal(v.unresolvedOnly, undefined);
});

test("same-line literal assignments are allowed", { skip: !py || process.platform === "win32" }, async () => {
  assert.equal(flags(await verdict('D=.workflow/closed; cp x "$D/y"')).decision, "allow");
  assert.equal(flags(await verdict(`H="${handoff}"; echo x > "$H/result.md"`)).decision, "allow");
});

// The tier decision itself, through the real adapter hook (index.ts tool_call): an unresolved-only refusal leaves the tier,
// a project-file refusal raises it.
test("an unresolved-only refusal leaves the tier; a project-file refusal raises it", { skip: !py }, async (t) => {
  const a = await r11Rig(t, { default: "trivial" }, { ctx: reviewAllowOpts().ctx, config: reviewAllowOpts().config });
  const unresolved = await a.call("bash", { command: 'echo x > ".workflow/$V"' });
  assert.ok(unresolved?.block, "refused");
  assert.match(unresolved.reason ?? "", /\(unresolved\)/);
  assert.doesNotMatch(unresolved.reason ?? "", /The tier is now standard/);
  assert.deepEqual(a.events("triage_escalated"), []);
  const project = await a.call("bash", { command: "echo x > README.md" });
  assert.ok(project?.block, "refused");
  assert.match(project.reason ?? "", /The tier is now standard/);
  assert.ok(a.events("triage_escalated").some((r) => r.reason === "edit_mode"), JSON.stringify(a.events("triage_escalated")));
});
