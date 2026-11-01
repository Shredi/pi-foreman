// opencommand.ts: the open bash command file and the long-command patterns.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearOpenCommand, DEFAULT_LONG_COMMANDS, isLongCommand, OPEN_COMMAND_FILE, readOpenCommand, writeOpenCommand } from "../opencommand.ts";

test("write, read and clear (only the matching tool call)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-opencmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readOpenCommand(dir), null);
  writeOpenCommand(dir, { toolCallId: "c1", command: "npm test", startedAt: 5 });
  assert.deepEqual(readOpenCommand(dir), { toolCallId: "c1", command: "npm test", startedAt: 5 });
  clearOpenCommand(dir, "c2");
  assert.ok(readOpenCommand(dir));
  clearOpenCommand(dir, "c1");
  assert.equal(readOpenCommand(dir), null);
  fs.writeFileSync(path.join(dir, OPEN_COMMAND_FILE), "not json");
  assert.equal(readOpenCommand(dir), null);
  writeOpenCommand(path.join(dir, "missing"), { toolCallId: "c", command: "x", startedAt: 1 }); // no throw
});

test("isLongCommand: test runners match, also after cd, env assignments and with flags", () => {
  for (const c of ["npm test", "npm test -- --watch=false", "npm test 2>&1", "cd x && npm test", "CI=1 npm test", "cd 'a b' && FOO=\"x y\" pytest -q", "python -m unittest discover -s tests", "node --test \"a/*.test.ts\"", "go test ./...", "cargo test"])
    assert.ok(isLongCommand(c, DEFAULT_LONG_COMMANDS), c);
  assert.equal(isLongCommand("cd x && npm test", ["npm test"]), "npm test");
});

test("isLongCommand: the runner must be the whole command (no chaining, pipes or substitution after it)", () => {
  for (const c of ["npm test; sleep 9999", "npm test & sleep 9999", "npm test || sleep 9999", "npm test$(sleep 999)", "npm test 2>&1 | tail -20", "npm test\nsleep 9999", "npm test `sleep 9`"])
    assert.equal(isLongCommand(c, DEFAULT_LONG_COMMANDS), null, c);
});

test("isLongCommand: watch modes do not match", () => {
  for (const c of ["yarn test:watch", "npx jest --watch", "npx jest --watchAll", "npm run test:watch", "npm test -- --watch=true"])
    assert.equal(isLongCommand(c, DEFAULT_LONG_COMMANDS), null, c);
});

test("isLongCommand: a runner with flags and file arguments matches", () => {
  assert.equal(isLongCommand("cd a && npm test -- --grep x", DEFAULT_LONG_COMMANDS), "npm test");
  assert.equal(isLongCommand("pytest tests/ -q", DEFAULT_LONG_COMMANDS), "pytest");
  assert.equal(isLongCommand("x=1 cargo test", DEFAULT_LONG_COMMANDS), "cargo test");
});

test("isLongCommand: other commands do not match", () => {
  for (const c of ["", "npm run build", "grep -rn test src", "cat npm test.txt", "echo npm test", "npm testing", "cd x", "ls && npm test", "npm install"])
    assert.equal(isLongCommand(c, DEFAULT_LONG_COMMANDS), null, c);
  assert.equal(isLongCommand("npm test", ["("]), null); // an invalid pattern matches nothing
});
