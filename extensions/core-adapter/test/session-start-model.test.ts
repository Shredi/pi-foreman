import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { foremanModelSpec, runSessionCommand, sessionModelOf, startModelOf, userCliModelOf } from "../session.ts";
import type { SessionDeps } from "../session.ts";
import { trackedTmp } from "./_tmpbase.ts";

const root = fs.realpathSync.native(trackedTmp("pf-session-start-model-"));
fs.writeFileSync(path.join(root, "b.md"), "brief\n");
const own = "anthropic/claude-sonnet-5-5";

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

test("remote open without a model passes the opener's model as --start-model, not --model", async () => {
  const d = deps({ model: own });
  await runSessionCommand(d, "open demo b.md --cwd C:/w --machine winbox --dry-run");
  const a = d.spawned[0];
  assert.equal(a[a.indexOf("--start-model") + 1], own);
  assert.equal(a.includes("--model"), false);
});

test("local open without a model passes no --start-model", async () => {
  const d = deps({ model: own });
  await runSessionCommand(d, "open demo b.md --dry-run");
  assert.equal(d.spawned[0].includes("--start-model"), false);
});

test("remote open with an explicit model passes --model and no --start-model", async () => {
  const d = deps({ model: own });
  await runSessionCommand(d, "open demo b.md --cwd /w --machine box --model other/m-1 --dry-run");
  const a = d.spawned[0];
  assert.equal(a[a.indexOf("--model") + 1], "other/m-1");
  assert.equal(a.includes("--start-model"), false);
});

test("start model: a CLI --model equal to the start env does not count, a different one does", () => {
  const env = { PI_FOREMAN_START_MODEL: own };
  assert.equal(startModelOf(env), own);
  assert.equal(startModelOf({}), undefined);
  assert.equal(userCliModelOf(["pi", "--model", own], env), undefined);
  assert.equal(userCliModelOf(["pi", "--model", "x/y"], env), "x/y");
  assert.equal(userCliModelOf(["pi", "--model", own], {}), own);
  // the role map then applies for the start provider; an explicit session model still wins
  assert.equal(foremanModelSpec("anthropic/role", sessionModelOf(env), userCliModelOf(["pi", "--model", own], env)), "anthropic/role");
  assert.equal(foremanModelSpec("anthropic/role", "x/y", undefined), null);
});
