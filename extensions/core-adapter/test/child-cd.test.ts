// Child cd confinement in the permission overlay (delegation D4): a child may cd only inside the workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, "/nonexistent/agent", "/nonexistent/pkg");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-cd-")));
const cwd = path.join(root, "ws");
const outside = path.join(root, "elsewhere");
fs.mkdirSync(path.join(cwd, "sub", "deep"), { recursive: true });
fs.mkdirSync(outside);
const verdict = (command: string, role: "main" | "child" = "child"): string =>
  checkToolCall(rules, "bash", { command }, { cwd, home: path.join(root, "home"), platform: process.platform, role })?.kind ?? "pass";

test("child cd: inside the workspace passes, also cumulatively and with pushd/popd", () => {
  for (const c of ["cd sub && cargo test", `cd ${path.join(cwd, "sub")} && ls`, "cd sub/deep && cd .. && ls", "cd . && ls", "pushd sub && popd && ls", "ls"]) assert.equal(verdict(c), "pass", c);
});

test("child cd: outside, escapes and non-literal targets deny", () => {
  const cases = [`cd ${outside} && cargo test`, "cd ../.. && ls", "cd sub && cd ../.. && ls", "cd ..", "cd", "cd -", "cd ~", "cd $HOME", "cd $(pwd)/..", "cd `echo /`", "cd su*", "pushd ..", "popd", "ls && cd sub; cd /", "bash -c 'cd /'"];
  for (const c of cases) {
    const d = checkToolCall(rules, "bash", { command: c }, { cwd, home: path.join(root, "home"), platform: process.platform, role: "child" });
    assert.equal(d?.kind, "deny", c);
    assert.match(d!.reason, /children may cd only inside the workspace/, c);
  }
});

test("child cd: the foreman is not confined by the overlay", () => {
  assert.equal(verdict(`cd ${outside} && ls`, "main"), "pass");
});

test("child cd: a symlink that leaves the workspace denies", (t) => {
  try {
    fs.symlinkSync(outside, path.join(cwd, "link"), "dir");
  } catch {
    t.skip("symlinks unavailable");
    return;
  }
  assert.equal(verdict("cd link && ls"), "deny");
  assert.equal(verdict("cd link/new && ls"), "deny");
});
