import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHILD_REFUSAL, PLAN_MODE_UNAVAILABLE, SESSION_USAGE, parseSessionArgs, runSessionCommand, runSessionOpenTool } from "../session.ts";
import type { SessionDeps } from "../session.ts";

const savedChild = process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_CHILD;
after(() => {
  if (savedChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = savedChild;
});

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-session-first-")));

function deps(over: Partial<SessionDeps> = {}): SessionDeps & { spawned: string[][] } {
  const spawned: string[][] = [];
  return {
    isChild: false,
    env: {},
    agentDir: path.join(root, "agent"),
    cwd: root,
    piSessionId: "sess-1",
    pkgRoot: "/pkg",
    python: "/usr/bin/python3",
    spawner: async (_c, args) => (spawned.push(args), { code: 0, stdout: "handoff: x", stderr: "", timedOut: false }),
    send: async () => "sent",
    spawned,
    ...over,
  };
}

test("session open: --first-command and --plan-mode parse; absent flags add no fields", () => {
  assert.deepEqual(parseSessionArgs("open demo b.md --first-command /plan --first-command /x --plan-mode"), { sub: "open", label: "demo", brief: "b.md", planFirst: false, focus: false, dryRun: false, planMode: true, firstCommands: ["/plan", "/x"] });
  assert.ok(!("planMode" in parseSessionArgs("open demo b.md")));
  const bad = parseSessionArgs("open demo b.md --first-command");
  assert.ok("error" in bad);
  assert.match(SESSION_USAGE, /--plan-mode/);
  assert.match(SESSION_USAGE, /--first-command/);
});

test("session open: the flags are forwarded to the CLI in order", async () => {
  const d = deps({ commands: ["plan"] });
  const r = await runSessionCommand(d, "open demo b.md --first-command /a --plan-mode --first-command /b");
  assert.equal(r.ok, true);
  const a = d.spawned[0];
  assert.ok(a.includes("--plan-mode"));
  const firsts = a.flatMap((x, i) => (x === "--first-command" ? [a[i + 1]] : []));
  assert.deepEqual(firsts, ["/a", "/b"]);
  const plain = deps();
  await runSessionCommand(plain, "open demo b.md");
  assert.ok(!plain.spawned[0].includes("--plan-mode") && !plain.spawned[0].includes("--first-command"));
});

test("foreman_session_open: refused in subagent children, nothing spawned", async () => {
  for (const over of [{ isChild: true }, { env: { PI_SUBAGENT_CHILD: "1" } }]) {
    const d = deps(over);
    assert.deepEqual(await runSessionOpenTool(d, { label: "demo", brief: "b.md" }), { text: CHILD_REFUSAL, ok: false });
    assert.equal(d.spawned.length, 0);
  }
});

test("foreman_session_open: runs the same open, forwards its params", async () => {
  const d = deps({ commands: ["plan"] });
  const r = await runSessionOpenTool(d, { label: "demo", brief: "b.md", planMode: true, firstCommand: ["/x"], planFirst: true, dryRun: true });
  assert.equal(r.ok, true);
  const a = d.spawned[0];
  for (const f of ["--plan-mode", "--plan-first", "--dry-run"]) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf("--first-command") + 1], "/x");
  assert.equal((await runSessionOpenTool(deps(), { brief: "b.md" })).ok, false);
});

test("foreman_session_open: the rank rule refuses a higher-ranked model", async () => {
  const config = { providers: { "claude-bridge": { ranks: [{ match: "claude-opus-*", tier: 1 }, { match: "claude-sonnet-*", tier: 2 }] } } };
  const d = deps({ model: "claude-bridge/claude-sonnet-4-5", config });
  const r = await runSessionOpenTool(d, { label: "demo", brief: "b.md", model: "claude-bridge/claude-opus-4-1" });
  assert.equal(r.ok, false);
  assert.equal(d.spawned.length, 0);
});

test("plan_mode_unavailable: refused without a plan command, passes with one (command and tool)", async () => {
  for (const commands of [undefined, [], ["foreman", "mcp"]]) {
    const d = deps({ commands });
    for (const r of [await runSessionCommand(d, "open demo b.md --plan-mode"), await runSessionOpenTool(d, { label: "demo", brief: "b.md", planMode: true })]) {
      assert.deepEqual(r, { text: PLAN_MODE_UNAVAILABLE, ok: false });
    }
    assert.equal(d.spawned.length, 0);
  }
  assert.match(PLAN_MODE_UNAVAILABLE, /^session open refused \[plan_mode_unavailable\]: /);
  for (const commands of [["plan"], ["plan:2"]]) {
    const d = deps({ commands });
    assert.equal((await runSessionOpenTool(d, { label: "demo", brief: "b.md", planMode: true })).ok, true);
    assert.equal(d.spawned.length, 1);
  }
});
