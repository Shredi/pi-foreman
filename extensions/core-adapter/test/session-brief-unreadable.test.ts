// `session open` with a brief that is not a readable regular file is refused before the dry-run return and the confirm.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runSessionCommand, runSessionOpenTool } from "../session.ts";
import type { SessionDeps } from "../session.ts";
import { trackedTmp } from "./_tmpbase.ts";

const root = fs.realpathSync.native(trackedTmp("pf-session-brief-"));
fs.writeFileSync(path.join(root, "ok.md"), "brief\n");
fs.mkdirSync(path.join(root, "dir.md"));

function deps(over: Partial<SessionDeps> = {}): SessionDeps & { spawned: string[][]; asked: number } {
  const spawned: string[][] = [];
  const d = {
    isChild: false,
    env: {},
    agentDir: path.join(root, "agent"),
    cwd: root,
    piSessionId: "sess-1",
    pkgRoot: "/pkg",
    python: "/usr/bin/python3",
    spawner: async (_c: string, args: string[]) => (spawned.push(args), { code: 0, stdout: "handoff: x", stderr: "", timedOut: false }),
    send: async () => "sent",
    confirm: async (): Promise<boolean> => ((d.asked += 1), true),
    spawned,
    asked: 0,
    ...over,
  };
  return d as SessionDeps & { spawned: string[][]; asked: number };
}

test("a missing brief file is refused before the confirm; nothing is spawned", async () => {
  const d = deps();
  const r = await runSessionCommand(d, "open demo missing.md");
  assert.equal(r.ok, false);
  assert.match(r.text, /^session open refused \[brief_unreadable\]: file not found \(missing\.md\); pass the path of a brief file$/);
  assert.equal(d.asked, 0);
  assert.equal(d.spawned.length, 0);
});

test("a dry run is refused too", async () => {
  const d = deps();
  const r = await runSessionCommand(d, "open demo missing.md --dry-run");
  assert.equal(r.ok, false);
  assert.match(r.text, /\[brief_unreadable\]/);
  assert.equal(d.spawned.length, 0);
});

test("a directory is not a brief; the tool refuses it the same way", async () => {
  const d = deps();
  const r = await runSessionOpenTool(d, { label: "demo", brief: "dir.md" });
  assert.equal(r.ok, false);
  assert.match(r.text, /\[brief_unreadable\]: not a regular file/);
  assert.equal(d.asked, 0);
  assert.equal(d.spawned.length, 0);
});

test("a text passed as the brief is echoed capped and without control characters", async () => {
  const d = deps();
  const text = `\u001b[31m${"x".repeat(300)}\nline`;
  const r = await runSessionOpenTool(d, { label: "demo", brief: text });
  assert.equal(r.ok, false);
  assert.match(r.text, /\[brief_unreadable\]/);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(r.text), "no control characters");
  assert.ok(r.text.length < 250, "the echo is capped");
  assert.ok(!r.text.includes(root), "no path of the host in the reason");
  assert.equal(d.asked, 0);
  assert.equal(d.spawned.length, 0);
});

test("a readable brief file still opens", async () => {
  const d = deps();
  const r = await runSessionCommand(d, "open demo ok.md");
  assert.equal(r.ok, true);
  assert.equal(d.asked, 1);
  assert.equal(d.spawned.length, 1);
});
