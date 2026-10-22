// R27 item 2: a child's in-place interpreter edits and inline write code are denied with the heredoc reason; reads with the same interpreters are not.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const r = buildOverlayRules(baseline, {}, {}, "/nonexistent/agent", pkgRoot, undefined, false);
const child = (command: string) => checkToolCall(r, "bash", { command }, { cwd: pkgRoot, home: "/nonexistent", platform: process.platform, role: "child" });

test("in-place interpreter edits and inline write code are denied for a child with the reason", { skip: !posix }, () => {
  for (const cmd of [
    "perl -pi -e 's/a/b/' file.ts",
    "perl -i.bak -pe 's/a/b/' file.ts",
    "ruby -pi -e 'gsub(/a/, \"b\")' file.rb",
    "awk -i inplace '{print}' file.txt",
    "python3 -c \"open('x.txt', 'w').write('1')\"",
    "node -e \"require('fs').writeFileSync('x','1')\"",
  ]) {
    const d = child(cmd);
    assert.equal(d?.kind, "deny", cmd);
    assert.ok(d!.reason.includes("use the write or edit tool"), d!.reason);
  }
});

test("reads with the same interpreters are not this deny", { skip: !posix }, () => {
  for (const cmd of [
    "perl -ne 'print if /x/' package.json",
    "python3 -c \"print(open('package.json').read())\"",
    "ruby -e 'puts 1'",
    "awk '{print $1}' package.json",
  ]) {
    const d = child(cmd);
    assert.ok(!d || !d.reason.includes("never heredoc or stdin-script file writes"), cmd);
  }
});

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r27-inplace-")));
after(() => rmTestTmp(base));
const scratch = path.join(base, "scratch");
fs.mkdirSync(scratch, { recursive: true });

test("an in-place edit whose file lies in the child's own scratch dir passes from the scratch cwd", { skip: !posix }, () => {
  const d = checkToolCall(r, "bash", { command: `perl -pi -e s/x/y/ ${scratch}/f` }, { cwd: scratch, home: "/nonexistent", platform: process.platform, role: "child", scratch });
  assert.notEqual(d?.kind, "deny", JSON.stringify(d));
});

test("an in-place edit of a relative workspace file is denied with the write or edit reason", { skip: !posix }, () => {
  const d = checkToolCall(r, "bash", { command: "perl -pi -e s/x/y/ f" }, { cwd: pkgRoot, home: "/nonexistent", platform: process.platform, role: "child", scratch });
  assert.equal(d?.kind, "deny");
  assert.ok(d!.reason.includes("use the write or edit tool"), d!.reason);
});

test("inline write code is denied for a child even when its file argument lies in the scratch dir", { skip: !posix }, () => {
  const d = checkToolCall(r, "bash", { command: `python3 -c "import os; os.remove('/ws/x')" ${scratch}/f` }, { cwd: scratch, home: "/nonexistent", platform: process.platform, role: "child", scratch });
  assert.equal(d?.kind, "deny");
  assert.ok(d!.reason.includes("use the write or edit tool"), d!.reason);
});

test("an in-place perl edit whose -e code calls system() passes from scratch (system( is not a write pattern)", { skip: !posix }, () => {
  const d = checkToolCall(r, "bash", { command: `perl -pi -e 'system("rm x")' ${scratch}/f` }, { cwd: scratch, home: "/nonexistent", platform: process.platform, role: "child", scratch });
  assert.notEqual(d?.kind, "deny", JSON.stringify(d));
});

test("an awk in-place edit of a scratch file passes from the scratch cwd (the program operand is not a path)", { skip: !posix }, () => {
  const d = checkToolCall(r, "bash", { command: `awk -i inplace '{print}' ${scratch}/f` }, { cwd: scratch, home: "/nonexistent", platform: process.platform, role: "child", scratch });
  assert.notEqual(d?.kind, "deny", JSON.stringify(d));
});
