// R6 lane 2 (fail closed): a word with white space escapes a catch-all `*` deny only in a pure read or as the value of a known prose option.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { ownedRoots } from "../owned.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-lane2f-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const agentDir = path.join(base, "agent");
const main = path.join(base, "repo");
fs.mkdirSync(main, { recursive: true });
const owned = ownedRoots({ agentDir, workspaceRoot: main, tmpRoot: path.join(base, "tmp"), npmRoot: null });
const star = { paths: { deny: ["*"] } };
const foreman = (command: string): string =>
  checkToolCall(buildOverlayRules(baseline, star, {}, agentDir, pkgRoot, undefined, false, owned), "bash", { command }, { cwd: main, home: base, platform: process.platform, role: "main", owned })?.kind ?? "pass";

test("writer verbs with a quoted space path under a `*` deny are denied", { skip: !posix }, () => {
  const p = path.join(base, "x", "a b");
  for (const cmd of [`mv x "${p}"`, `install -m 644 x "${p}"`, `dd of="${p}"`, `rsync x "${p}"`, `ln -s x "${p}"`, `cp -t "${p}" x`, `python3 -c "open('${p}','w')"`]) {
    assert.equal(foreman(cmd), "deny", cmd);
  }
});

test("prose passes in a pure read and as a known prose option value only", { skip: !posix }, () => {
  assert.equal(foreman('git commit --reason "read index.ts, then fix it"'), "pass");
  assert.equal(foreman('git commit -m "read index.ts, then x"'), "pass");
  assert.equal(foreman('git log --reason "read index.ts, then fix it"'), "pass");
  assert.equal(foreman("cat /etc/hosts"), "deny");
});
