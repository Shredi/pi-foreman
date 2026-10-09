// Security review cycle 1 fixes in the permission overlay (S1/S2, S3/S6, S10-S15, S17, S27,
// foreman_move/foreman_copy, Windows paths). Table-driven: [tool, input, main, child].
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, codeLiterals, expandBraces, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-harden-")));
const cwd = path.join(root, "proj");
const home = path.join(root, "home");
const agentDir = path.join(home, ".pi", "agent");
const pkgRoot = path.join(root, "pkg");
for (const d of [path.join(cwd, ".git", "hooks"), path.join(cwd, ".github"), path.join(home, ".ssh"), agentDir, pkgRoot]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(cwd, ".env"), "TOKEN=x\n");
fs.writeFileSync(path.join(cwd, ".gitignore"), "x\n");
fs.writeFileSync(path.join(cwd, ".git", "config"), "[core]\n");
fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "k\n");

const r = buildOverlayRules(baseline, {}, {}, agentDir, pkgRoot);
const ctx = (role: "main" | "child"): MatchCtx => ({ cwd, home, platform: process.platform, role });
const kind = (tool: string, input: Record<string, unknown>, role: "main" | "child"): string => checkToolCall(r, tool, input, ctx(role))?.kind ?? "pass";
const sh = (command: string): [string, Record<string, unknown>] => ["bash", { command }];
const at = (...p: string[]): string => path.join(...p);

type Row = [[string, Record<string, unknown>], string, string];

function run(rows: Row[]): void {
  for (const [[tool, input], main, child] of rows) {
    assert.equal(kind(tool, input, "main"), main, `main: ${tool} ${JSON.stringify(input)}`);
    assert.equal(kind(tool, input, "child"), child, `child: ${tool} ${JSON.stringify(input)}`);
  }
}

test("S1/S2: .git is write-protected in every session, git commands and .gitignore/.github pass", () => {
  run([
    [["write", { path: ".git/hooks/pre-commit", content: "x" }], "deny", "deny"],
    [["edit", { path: at(cwd, ".git", "config") }], "deny", "deny"],
    [sh("echo '[core] fsmonitor=x' >> .git/config"), "deny", "deny"],
    [sh("cp x .git/hooks/pre-commit"), "deny", "deny"],
    [sh("echo 'gitdir: /x' > .git"), "deny", "deny"],
    [sh("cat .g*/config"), "deny", "deny"],
    [sh("git status"), "pass", "pass"],
    [sh("git diff --stat"), "pass", "pass"],
    [sh("git add .gitignore"), "pass", "pass"],
    [sh("cat .gitignore"), "pass", "pass"],
    [sh("ls .github"), "pass", "pass"],
    [["write", { path: ".gitignore", content: "y" }], "pass", "pass"],
    [["read", { path: ".git/config" }], "pass", "pass"],
  ]);
  if (process.platform === "darwin" || process.platform === "win32") run([[["write", { path: ".GIT/config", content: "x" }], "deny", "deny"]]);
});

test("protect matches path arguments only: patterns, scripts and echo text are not paths (item 4)", () => {
  for (const d of ["internal/api", "internal/db"]) fs.mkdirSync(at(cwd, d), { recursive: true });
  fs.writeFileSync(at(cwd, "internal", "api", "hub.go"), "package api\n");
  fs.writeFileSync(at(cwd, "internal", "db", "exchange_status.go"), "package db\n");
  run([
    // two real bench commands that were denied: `\` read as a separator, `*` listing .git
    [sh(`cd ${cwd} && grep -rn "broadcastServerUpdate\\|func (h \\*\\|clientsMu\\|register\\b" internal/api/*.go | grep -v _test | head -50`), "pass", "pass"],
    [sh(`grep -n "LogCleanup\\b\\|Transport \\*\\|ExchangeStatus struct" internal/db/exchange_status.go`), "pass", "pass"],
    [sh("grep -rn '.git/config' internal"), "pass", "pass"],
    [sh("rg -e .git/HEAD internal"), "pass", "pass"],
    [sh("sed -n '/.git\\//p' internal/api/hub.go"), "pass", "pass"],
    [sh("find . -name .git -prune -o -name '*.go' -print"), "pass", "pass"],
    [sh("echo .git/hooks"), "pass", "pass"],
    [sh("cat */hub.go"), "pass", "pass"],
    // real .git paths stay denied, also as redirect targets and with dotglob
    [sh("cat .git/config"), "deny", "deny"],
    [sh("grep x .git/config"), "deny", "deny"],
    [sh("grep -e x .git/config"), "deny", "deny"],
    [sh("grep -f .git/config internal"), "deny", "deny"],
    [sh("rg foo .git"), "deny", "deny"],
    [sh("echo x > .git/HEAD"), "deny", "deny"],
    [sh("printf x >> .git/config"), "deny", "deny"],
    [sh("cp a .g*/hooks/"), "deny", "deny"],
    [sh("shopt -s dotglob; cat */config"), "deny", "deny"],
    // a pattern that can become a path, or a script that writes, is checked as before
    [sh("echo .git/HEAD | xargs touch"), "deny", "deny"],
    [sh("touch $(echo .git/HEAD)"), "deny", "deny"],
    [sh("find . -path '*/.git/*' -delete"), "deny", "deny"],
    [sh("sed -n 'w .git/HEAD' internal/api/hub.go"), "deny", "deny"],
    [sh("sed 's/a/b/w .git/HEAD' internal/api/hub.go"), "deny", "deny"],
    [sh("awk '{print > \".git/HEAD\"}' internal/api/hub.go"), "deny", "deny"],
  ]);
});

test("S3/S6/S17/S27: agent and harness configuration is asked in the foreman, denied in children", () => {
  run([
    [["write", { path: ".pi/agents/builder.md", content: "x" }], "ask", "deny"],
    [["write", { path: ".pi/settings.json", content: "{}" }], "ask", "deny"],
    [["write", { path: ".pi/foreman.json", content: "{}" }], "ask", "deny"],
    [["edit", { path: ".agents/skills/x/SKILL.md" }], "ask", "deny"],
    [sh("echo x > .pi/foreman.json"), "ask", "deny"],
    [["write", { path: at(root, "other", ".pi", "agents", "builder.md"), content: "x" }], "pass", "deny"],
    [["write", { path: at(agentDir, "foreman.json"), content: "{}" }], "ask", "deny"],
    [["edit", { path: at(agentDir, "settings.json") }], "ask", "deny"],
    [sh(`echo x > ${at(agentDir, "npm", "x.js")}`), "ask", "deny"],
    [["write", { path: at(agentDir, "extensions", "evil", "index.ts"), content: "x" }], "ask", "deny"],
    [["write", { path: at(agentDir, "agents", "builder.md"), content: "x" }], "ask", "deny"],
    [["write", { path: at(pkgRoot, "scripts", "git_guard.py"), content: "x" }], "ask", "deny"],
    [sh(`python3 ${at(pkgRoot, "scripts", "x.py")}`), "pass", "deny"], // T11: children may not name the package root in a shell
    [["read", { path: ".pi/foreman.json" }], "pass", "pass"],
    [["write", { path: "src/a.ts", content: "x" }], "pass", "pass"],
  ]);
});

test("foreman_move/foreman_copy paths go through the deny paths and the write protection", () => {
  run([
    [["foreman_copy", { src: ".env", dst: "x" }], "deny", "deny"],
    [["foreman_move", { src: "x", dst: ".git/hooks/pre-commit" }], "deny", "deny"],
    [["foreman_move", { src: ".git/config", dst: "x" }], "deny", "deny"],
    [["foreman_move", { src: "x", dst: ".pi/agents/b.md" }], "ask", "deny"],
    [["foreman_copy", { src: ".git/config", dst: "x" }], "pass", "pass"],
    [["foreman_copy", { src: "a", dst: "b" }], "pass", "pass"],
  ]);
});

test("S10-S13, S15: glob segments, ANSI-C, braces, case, inline code, grep/find inputs", () => {
  const rows: Row[] = [
    [sh(`cat ${at(home, ".s*", "id_ed25519")}`), "deny", "deny"],
    [sh(`cat ${at(home, ".ss[h]", "id_ed25519")}`), "deny", "deny"],
    [sh("cat ~/.s?h/id_ed25519"), "deny", "deny"],
    [sh("cat $'\\x2eenv'"), "deny", "deny"],
    [sh("cat $'\\056env'"), "deny", "deny"],
    [sh("cat .{e,x}nv"), "deny", "deny"],
    [sh("cat {.env,x}"), "deny", "deny"],
    [sh("python3 -c 'print(open(\".env\").read())'"), "deny", "deny"],
    [sh("python3 -c 'print(open(\".\"+\"env\").read())'"), "deny", "deny"],
    [sh("node -e \"require('fs').readFileSync('.e'+'nv')\""), "deny", "deny"],
    [sh("perl -e 'open(F, \".env\")'"), "deny", "deny"],
    [sh("ruby -e 'puts File.read(\".env\")'"), "deny", "deny"],
    [sh("python3 -c 'print(1+1)'"), "pass", "pass"],
    [["grep", { pattern: "TOKEN", glob: ".env" }], "deny", "deny"],
    [["grep", { pattern: "x", path: home, glob: ".ssh/*" }], "deny", "deny"],
    [["find", { pattern: ".env*" }], "deny", "deny"],
    [["find", { pattern: "*.ts" }], "pass", "pass"],
    [["grep", { pattern: ".env", path: "src" }], "pass", "pass"],
    [["read", { path: "x", file_path: ".env" }], "deny", "deny"],
  ];
  if (process.platform === "darwin" || process.platform === "win32") {
    rows.push([sh("cat .ENV"), "deny", "deny"], [["read", { path: ".ENV" }], "deny", "deny"], [["ls", { path: at(home, ".SSH") }], "deny", "deny"]);
  }
  run(rows);
  assert.deepEqual(expandBraces("a{b,c{d,e}}f"), ["abf", "acdf", "acef"]);
  assert.deepEqual(expandBraces("x{1..3}"), ["x1", "x2", "x3"]);
  assert.deepEqual(expandBraces("${HOME}"), []);
  assert.ok(codeLiterals(`open("." + "env")`).includes(".env"));
});

test("S14: find -exec/-execdir/-delete are asks in the baseline (PS prompts)", () => {
  for (const p of ["find * -exec*", "find * -execdir*", "find * -delete*"]) assert.ok(baseline.bash.ask.includes(p), p);
});

test("win32: native and MSYS paths in bash commands, case and separators folded", () => {
  const w = buildOverlayRules(baseline, {}, {}, "C:\\Profiles\\u\\.pi\\agent");
  const wctx: MatchCtx = { cwd: "C:\\w\\proj", home: "C:\\Profiles\\u", platform: "win32", exists: () => false, isDir: () => false, realpath: () => null, list: () => [] };
  const k = (command: string): string => checkToolCall(w, "bash", { command }, wctx)?.kind ?? "pass";
  assert.equal(k("head -n1 C:\\Profiles\\u\\.ssh\\id_ed25519"), "deny");
  assert.equal(k("cat /c/Profiles/u/.aws/credentials"), "deny");
  assert.equal(k("cat C:/Profiles/U/.AWS/credentials"), "deny");
  assert.equal(k("echo x > .git\\config"), "deny");
  assert.equal(k("git status"), "pass");
  assert.equal(checkToolCall(w, "write", { path: "C:\\Profiles\\u\\.pi\\agent\\settings.json" }, { ...wctx, role: "child" })?.kind, "deny");
  fs.rmSync(root, { recursive: true, force: true });
});
