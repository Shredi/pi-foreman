import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ownedRoots } from "../owned.ts";
import { buildOverlayRules, readBaseline } from "../permoverlay.ts";
import { checkWaitPath, parseStart } from "../wait.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-waitown-")));
const ws = path.join(root, "work", "repo");
const agentDir = path.join(root, "agent");
const handoff = path.join(agentDir, "pi-foreman", "handoffs", "h1");
const artifacts = path.join(agentDir, "sessions", "s1", "subagent-artifacts");
const wtDir = path.join(root, "work", "repo.worktrees");
const outside = path.join(root, "outside");
for (const d of [ws, handoff, artifacts, path.join(wtDir, "b1"), outside, path.join(agentDir, "pi-foreman", "state")]) fs.mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q", ws]);
fs.symlinkSync(outside, path.join(handoff, "escape"), "dir");
const overlay = buildOverlayRules(readBaseline(PKG)!, {}, {}, agentDir);
const base = { cwd: ws, home: root, agentDir, platform: process.platform, overlay };
const owned = ownedRoots({ agentDir, workspaceRoot: ws, tmpRoot: os.tmpdir() }).readWrite;

test("wait: owned dirs are refused by default and accepted with `owned`", () => {
  const targets = [path.join(handoff, "ruling.md"), path.join(artifacts, "run-1", "result.json"), path.join(wtDir, "b1", "done.flag")];
  for (const t of targets) {
    const refused = checkWaitPath(t, base);
    assert.ok("error" in refused, t);
    assert.deepEqual(checkWaitPath(t, { ...base, owned }), { path: t });
  }
  assert.ok("path" in parseStart({ kind: "file", path: targets[0] }, { batchWindowSeconds: 0, maxSeconds: 60, maxActive: 2, ci: true }, { ...base, owned }));
});

test("wait: owned roots do not open siblings, escapes or the state dir", () => {
  for (const t of [path.join(agentDir, "pi-foreman", "handoffs-x", "a"), path.join(agentDir, "sessions", "s1", "other", "a"), path.join(agentDir, "pi-foreman", "state", "marker.json"), path.join(handoff, "escape", "x"), path.join(root, "work", "repo.worktrees-x", "a"), path.join(outside, "x")]) {
    const r = checkWaitPath(t, { ...base, owned });
    assert.ok("error" in r, t);
  }
});
