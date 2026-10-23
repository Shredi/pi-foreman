// R29 item 7: the write protection of a child's shell line applies to write effects only. A read-only unit (a reader verb or a read-only
// git subcommand) that names a protected file (`{pkgRoot}/*` writeAsk) passes; any write form on the same file stays denied.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { ownedRoots } from "../owned.ts";
import { childSurface } from "../roundsurface.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r29-protread-")));
after(() => rmTestTmp(base));

const agentDir = path.join(base, "agent");
const main = path.join(base, "repo");
const scratch = path.join(base, "tmp", "pi-foreman-scratch", "child1");
for (const d of [scratch, path.join(agentDir, "pi-foreman"), main]) fs.mkdirSync(d, { recursive: true });
const owned = ownedRoots({ agentDir, workspaceRoot: main, tmpRoot: path.join(base, "tmp"), npmRoot: null });
const rules = buildOverlayRules(baseline, {}, {}, agentDir, pkgRoot, undefined, false, owned);

// a child of the package checkout: `package.json` there is a writeAsk path (`{pkgRoot}/*`)
const child = (command: string): string => {
  const s = childSurface([pkgRoot], pkgRoot, "builder", process.platform);
  const ctx: MatchCtx = { cwd: pkgRoot, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read };
  return checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";
};

test("a child's read of a protected file passes: git diff, grep, cat", { skip: !posix }, () => {
  assert.equal(child("git diff HEAD~1..HEAD -- package.json"), "pass");
  assert.equal(child("git diff -- package.json"), "pass");
  assert.equal(child("git -C . diff -- package.json"), "pass");
  assert.equal(child("git log -p -- package.json"), "pass");
  assert.equal(child("git show HEAD:README.md | grep -n x"), "pass");
  assert.equal(child("grep x package.json"), "pass");
  assert.equal(child("cat package.json"), "pass");
  assert.equal(child("cat package.json | head -2"), "pass");
});

test("a child's write to a protected file is denied: redirect, sed -i, tee, git checkout, git apply", { skip: !posix }, () => {
  assert.equal(child("echo x > package.json"), "deny");
  assert.equal(child("sed -i 's/a/b/' package.json"), "deny");
  assert.equal(child("tee package.json"), "deny");
  assert.equal(child("git checkout -- package.json"), "deny");
  assert.equal(child("git apply package.json"), "deny");
});

test("a git read that writes its output to a protected file is denied", { skip: !posix }, () => {
  assert.equal(child("git diff --output=package.json"), "deny");
  assert.equal(child("git log --output package.json"), "deny");
  assert.equal(child("git diff -- package.json > package.json"), "deny");
  assert.equal(child("git diff -- package.json | tee package.json"), "deny");
});

test("a chain mixing a read and a write to a protected file is denied", { skip: !posix }, () => {
  assert.equal(child("git diff -- package.json && echo x > package.json"), "deny");
  assert.equal(child("cat package.json; tee package.json < /dev/null"), "deny");
  assert.equal(child("grep x package.json && sed -i 's/a/b/' package.json"), "deny");
});
