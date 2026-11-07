import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childRoleIds, roleLaunchBlock } from "../roles.ts";
import { foremanModelSpec, formatList, runSessionCommand, sessionForemanModel, sessionModelOf } from "../session.ts";
import type { SessionDeps } from "../session.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-session-foreman-")));
const ranks = [{ match: "claude-fable-*", tier: 0 }, { match: "claude-opus-*", tier: 1 }, { match: "claude-sonnet-*", tier: 2 }];
const config = {
  providers: {
    "claude-bridge": { ranks, roles: { "session-foreman": { model: "claude-bridge/claude-opus-5-5" } } },
    other: { fallback: { provider: "claude-bridge" } },
  },
};

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

test("session-foreman: not a launchable role", () => {
  const roles = { foreman: {}, "session-foreman": {}, builder: {} };
  assert.deepEqual(childRoleIds(roles), ["builder"]);
  const msg = roleLaunchBlock({ agent: "session-foreman" }, childRoleIds(roles));
  assert.match(msg ?? "", /session-foreman is the model of sessions opened by `foreman session open`, not a launchable role/);
});

test("session-foreman: model choice reads the own provider map, then its fallback", () => {
  assert.equal(sessionForemanModel(config, "claude-bridge/claude-sonnet-5-5"), "claude-bridge/claude-opus-5-5");
  assert.equal(sessionForemanModel(config, "other/x"), "claude-bridge/claude-opus-5-5");
  assert.equal(sessionForemanModel(config, "nowhere/x"), undefined);
  assert.equal(sessionForemanModel(undefined, "claude-bridge/x"), undefined);
});

test("session open: model is --model, else the mapping, else the own model; dry-run prints it", async () => {
  const own = "claude-bridge/claude-opus-5-5";
  let d = deps({ model: own, config });
  let r = await runSessionCommand(d, "open demo b.md --dry-run");
  assert.equal(r.ok, true);
  assert.match(r.text, /^session model: claude-bridge\/claude-opus-5-5\n/);
  assert.equal(r.text.includes("handoff: x"), true);
  assert.deepEqual(d.spawned[0].slice(-3), ["--model", own, "--dry-run"]);

  d = deps({ model: own, config: { providers: { "claude-bridge": { ranks } } } });
  r = await runSessionCommand(d, "open demo b.md --dry-run");
  assert.match(r.text, /^session model: claude-bridge\/claude-opus-5-5\n/);

  d = deps({ model: "claude-bridge/claude-sonnet-5-5", config });
  r = await runSessionCommand(d, "open demo b.md --model claude-bridge/claude-sonnet-5-5 --dry-run");
  assert.match(r.text, /^session model: claude-bridge\/claude-sonnet-5-5\n/);
});

test("session list: shows label, model, status, handoff dir and child id", () => {
  const text = formatList({ version: 1, sessions: [{ label: "demo", child: "fm-demo-abc123", status: "open", handoff: "/h/x", model: "p/m" }, { label: "old", child: "fm-old-000000", status: "closed", handoff: "/h/y" }] });
  const lines = text.split("\n");
  assert.match(lines[0], /label, model, status, handoff dir, child id/);
  assert.equal(lines[1], "demo  p/m  open  /h/x  fm-demo-abc123");
  assert.equal(lines[2], "old  -  closed  /h/y  fm-old-000000");
});

test("session model: the env var wins over the mapped foreman role model; unset keeps it", () => {
  assert.equal(sessionModelOf({ PI_FOREMAN_SESSION_MODEL: " claude-bridge/claude-sonnet-5-5 " }), "claude-bridge/claude-sonnet-5-5");
  assert.equal(sessionModelOf({}), undefined);
  assert.equal(sessionModelOf({ PI_FOREMAN_SESSION_MODEL: "  " }), undefined);
  assert.equal(foremanModelSpec("claude-bridge/claude-opus-5-5", "claude-bridge/claude-sonnet-5-5"), null);
  assert.equal(foremanModelSpec("claude-bridge/claude-opus-5-5", undefined), "claude-bridge/claude-opus-5-5");
});

test("session open: does not repeat the model line and passes no --own-model", async () => {
  const own = "claude-bridge/claude-opus-5-5";
  const child = "claude-bridge/claude-sonnet-5-5";
  const d = deps({ model: own, config, spawner: async () => ({ code: 0, stdout: `handoff: x\nsession model: ${child}`, stderr: "", timedOut: false }) });
  const r = await runSessionCommand(d, `open demo b.md --model ${child} --dry-run`);
  assert.equal(r.ok, true);
  assert.equal(r.text.match(/session model:/g)?.length, 1);
  const d2 = deps({ model: own, config, confirm: async () => true });
  await runSessionCommand(d2, `open demo b.md --model ${child}`);
  assert.equal(d2.spawned[0].includes("--own-model"), false);
});
