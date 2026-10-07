// Child cd confinement in the permission overlay (delegation D4): a child may cd only inside the workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { stripChildCdEnv } from "../childenv.ts";
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
  for (const c of ["cd sub && cargo test", `cd "${path.join(cwd, "sub")}" && ls`, "cd sub/deep && cd .. && ls", "cd . && ls", "pushd sub && popd && ls", "ls"]) assert.equal(verdict(c), "pass", c);
});

test("child cd: outside, escapes and non-literal targets deny", () => {
  const cases = [`cd ${outside} && cargo test`, "cd ../.. && ls", "cd sub && cd ../.. && ls", "cd ..", "cd", "cd -", "cd ~", "cd $HOME", "cd $(pwd)/..", "cd `echo /`", "cd su*", "pushd ..", "popd", "ls && cd sub; cd /", "bash -c 'cd /'"];
  for (const c of cases) {
    const d = checkToolCall(rules, "bash", { command: c }, { cwd, home: path.join(root, "home"), platform: process.platform, role: "child" });
    assert.equal(d?.kind, "deny", c);
    assert.match(d!.reason, /children may cd only inside the workspace/, c);
  }
});

test("child cd: a `~` inside a word is literal (Windows short names), a leading `~` denies", () => {
  // emulated win32 workspace below an 8.3 short name, as on the Windows CI runner
  const w = path.win32;
  const ws = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\pf-cd-x\\ws";
  const dirs = new Set([ws, `${ws}\\sub`].map((d) => d.toLowerCase()));
  const isDir = (x: string): boolean => dirs.has(w.normalize(x).toLowerCase());
  const ctx = { cwd: ws, home: "C:\\Users\\RUNNER~1", platform: "win32" as const, role: "child" as const, realpath: (x: string) => x, exists: isDir, isDir, list: () => [] };
  const v = (command: string): string => checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";
  for (const c of [`cd "${ws}\\sub" && ls`, `cd '${ws}\\sub' && ls`, `cd ${ws.replace(/\\/g, "/")}/sub && ls`, "cd sub && ls"]) assert.equal(v(c), "pass", c);
  for (const c of ["cd ~ && ls", "cd ~/x", 'cd "~"', "cd C:/Users/RUNNER~1 && ls", `cd "${ws}\\..\\elsewhere"`, `cd ${ws}\\sub && ls`, "cd D: && ls", "cd C:x"]) assert.equal(v(c), "deny", c);
  fs.mkdirSync(path.join(cwd, "a~1"), { recursive: true });
  assert.equal(verdict("cd a~1 && ls"), "pass");
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

test("child cd: keywords and grouping in front of cd do not hide it (review D-B1)", () => {
  for (const c of ['{ cd "$D"; ls; }', "! cd; git log", 'if true; then cd "$D"; fi; ls', 'while read d; do cd "$d"; git log; done < .workflow/dirs', "time cd ..", "! FOO=1 command cd ..", "while true; do cd sub/deep; cd ..; done"]) assert.equal(verdict(c), "deny", c);
  assert.equal(verdict("if true; then cd sub; fi; ls"), "pass");
});

test("child cd: CDPATH denies and is removed from the child env (review D-B2)", () => {
  for (const c of ["CDPATH=/ cd etc && cat passwd", "export CDPATH=/; cd tmp", "echo $CDPATH", "bash -c 'CDPATH=/ cd etc'"]) assert.equal(verdict(c), "deny", c);
  const env: Record<string, string> = { PATH: "/usr/bin", CDPATH: "/" };
  stripChildCdEnv(env);
  assert.deepEqual(env, { PATH: "/usr/bin" });
});

test("child cd: a cd that may fail keeps the old cwd as a candidate (review D-B3)", () => {
  for (const c of ["cd nonexist/deeper; cd ../.. && ls", "cd nonexist/deeper || true; cd ../.. && git log", "pushd nonexist && pushd sub && popd && cd ..", "mkdir -p build && cd build && ls; cd .."]) assert.equal(verdict(c), "deny", c);
  for (const c of ["mkdir -p build && cd build && cargo test", "cd nonexist/deeper; cd sub && ls", "mkdir -p build && cd build && cd .. && ls"]) assert.equal(verdict(c), "pass", c);
});
