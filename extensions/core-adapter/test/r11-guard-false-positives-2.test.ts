// R11 P3 fix round 1 (ledger items 7, 9): a commit message the shell expands is still scanned; a python -c body is left out only for its own unit.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, "/nonexistent/agent", "/nonexistent/pkg");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r11b-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const cwd = path.join(root, "ws");
const home = path.join(root, "home");
for (const d of [path.join(cwd, "sub"), home]) fs.mkdirSync(d, { recursive: true });

const child = (command: string): { kind: string; reason?: string } => {
  const d = checkToolCall(rules, "bash", { command }, { cwd, home, platform: process.platform, role: "child" });
  return { kind: d?.kind ?? "pass", reason: (d as { reason?: string } | null)?.reason };
};
const CD = /children may cd only inside the workspace/;
const BIND = /the line binds HOME and uses it/;

// ---- item 7: a double-quoted or bare message with an assignment expansion binds the variable in the shell
test("cd_guard_commit_message_assignment_expansion_still_refused", () => {
  for (const c of [
    'git commit -m "${CDPATH:=/tmp}" && cd sub',
    'git commit -m "${CDPATH=/tmp}" && cd sub',
    'git commit -m "subject" -m "body ${CDPATH:=/}" && cd sub',
    'git commit -m"${CDPATH=/}" && cd sub',
    'git commit --message="${CDPATH:=/}"; cd sub',
    'git commit --message "${CDPATH=/}"; cd sub',
    "git commit -m ${CDPATH:=/} && cd sub",
    'git commit -am "x `true` ${CDPATH=/}" && cd sub',
  ]) {
    const d = child(c);
    assert.equal(d.kind, "deny", c);
    assert.match(d.reason!, CD, c);
  }
});

test("cd_guard_commit_message_single_quoted_mention_allowed", () => {
  for (const c of [
    "git commit -m 'about ${CDPATH:=/tmp} as text' && cd sub",
    "git commit -m 'about ${CDPATH=/} and `x`'",
    "git commit -m 'subject' -m 'body: CDPATH=${CDPATH:=x}'",
    'git commit -m "plain CDPATH mention" -m \'${CDPATH:=/}\'',
    'git commit -m "escaped \\${CDPATH:=/} is literal"',
  ]) assert.doesNotMatch(child(c).reason ?? "", CD, c);
});

// ---- item 9: only the python/node unit's own code word is left out
const b = "HOME=/x; cat ~/y";
test("home_binding_second_unit_bash_c_same_body_still_refused", () => {
  for (const c of [
    `python3 -c "${b}"; bash -c "${b}"`,
    `bash -c "${b}"; python3 -c "${b}"`,
    `python3 -c '${b}' && bash -c '${b}'`,
    `node -e "${b}" | sh -c "${b}"`,
    `python3 -c "${b}"; zsh -lc "${b}"`,
  ]) {
    const d = child(c);
    assert.equal(d.kind, "deny", c);
    assert.match(d.reason!, BIND, c);
  }
});

test("home_binding_bash_c_body_still_refused", () => {
  for (const c of [`bash -c "${b}"`, `sh -c '${b}'`, `zsh -c "${b}"`, `bash -lc "${b}"`, `/bin/bash -c "${b}"`]) {
    const d = child(c);
    assert.equal(d.kind, "deny", c);
    assert.match(d.reason!, BIND, c);
  }
});

test("home_binding_python_c_body_alone_still_ignored", () => {
  for (const c of [`python3 -c "x=1; d={'HOME': 2}; print('~')"`, `/usr/bin/python3 -c 'HOME=1; print(HOME)'`, `node -e "const HOME=1; console.log('~')"`]) {
    assert.doesNotMatch(child(c).reason ?? "", BIND, c);
  }
});
