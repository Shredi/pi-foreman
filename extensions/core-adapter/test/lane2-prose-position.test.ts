// R6 lane 2 (security): a path tool's path and a pure command's path arguments are always operands; the prose exemption is by option position only.
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
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-lane2p-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const agentDir = path.join(base, "agent");
const main = path.join(base, "repo");
fs.mkdirSync(main, { recursive: true });
const owned = ownedRoots({ agentDir, workspaceRoot: main, tmpRoot: path.join(base, "tmp"), npmRoot: null });
const rules = buildOverlayRules(baseline, { paths: { deny: ["*"] } }, {}, agentDir, pkgRoot, undefined, false, owned);
const call = (tool: string, input: Record<string, unknown>): string =>
  checkToolCall(rules, tool, input, { cwd: main, home: base, platform: process.platform, role: "main", owned })?.kind ?? "pass";
const space = path.join(base, "x", "a b", "f");

test("read, grep, ls and find on a space path under a `*` deny are denied", { skip: !posix }, () => {
  assert.equal(call("read", { path: space }), "deny");
  assert.equal(call("grep", { pattern: "x", path: space }), "deny");
  assert.equal(call("ls", { path: path.dirname(space) }), "deny");
  assert.equal(call("find", { pattern: "*.ts", path: path.dirname(space) }), "deny");
});

test("a pure bash read of a quoted space path is denied; a commit message is not an operand", { skip: !posix }, () => {
  assert.equal(call("bash", { command: `cat "${space}"` }), "deny");
  assert.equal(call("bash", { command: 'cat "/x/a b/f"' }), "deny"); // the literal form
  assert.equal(call("bash", { command: `git commit -m "${space}" -F "${space}"` }), "deny");
  assert.equal(call("bash", { command: `git commit -m "${space}"` }), "pass");
  assert.equal(call("bash", { command: `git commit --message="${space}"` }), "pass");
  assert.equal(call("bash", { command: 'git log --reason "read index.ts, then fix it"' }), "pass");
});

test("the git commit -m exemption applies to the commit unit only", { skip: !posix }, () => {
  assert.equal(call("bash", { command: `git commit -m "${space}" && cat -m "${space}"` }), "deny");
  assert.equal(call("bash", { command: `git commit -m "${space}" && git log -m "${space}"` }), "deny");
});
