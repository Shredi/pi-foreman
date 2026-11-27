// The skip-only PowerShell table (fastallow.ts psSkipOnlyOk): `powershell|pwsh -NoProfile -Command Get-Volume | Get-PSDrive | Get-ChildItem` in the listed forms
// runs with no judge call from the bash tool; every other form gets the normal handling.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateDecide, type GateResult } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import type { GitFacts } from "../defaults.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-psskip-"));
const wt = path.join(base, "wt");
fs.mkdirSync(wt, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots: GateRoots = { worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false };
const facts: GitFacts = { currentBranch: () => "round/x", protectedBranches: () => ["main"], pushConfigured: () => false };
const env: FloorEnv = { cwd: wt, home: path.join(base, "home"), agentDir: path.join(base, "agent"), platform: process.platform, protectedBranches: ["main"], currentBranch: () => "round/x", remoteHead: () => "main", writeRoots: [wt] };
const run = (command: string, r: GateRoots = roots): GateResult => gateDecide("bash", { command }, wt, { env: () => env, roots: () => r, facts });
const allowed = (command: string, r?: GateRoots): boolean => { const v = run(command, r); return !!v && "allow" in v && v.rule.startsWith("default-skip"); };

test("the listed forms run with no judge call, main and child", () => {
  for (const l of [
    "powershell -NoProfile -Command Get-Volume", "pwsh -NoProfile -Command Get-Volume", "powershell.exe -NoProfile -NonInteractive -Command Get-Volume", "pwsh.exe -NonInteractive -NoProfile -Command get-volume",
    'powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem"', "powershell -NoProfile -Command Get-PSDrive",
    'powershell -NoProfile -Command "Get-ChildItem -Path C:\\Users\\me -Recurse -File"', "powershell -NoProfile -Command Get-ChildItem C:/x -Directory -Force", "powershell -NoProfile -Command Get-ChildItem",
    "powershell -NoProfile -Command Get-ChildItem sub\\dir", "powershell -NoProfile -Command Get-Volume | cat",
  ]) for (const r of [roots, { ...roots, child: true, role: "builder" }]) assert.ok(allowed(l, r), `${r.child ? "child" : "main"}: ${l} -> ${JSON.stringify(run(l, r))}`);
});

test("every other form gets the normal handling", () => {
  for (const l of [
    "powershell -Command Get-Volume", "powershell -NonInteractive -Command Get-Volume", "powershell -NoProfile Get-Volume", "powershell -NoProfile -Command Get-Volume -DriveLetter C",
    "powershell -NoProfile -Command Get-ChildItem -Path Env:", "powershell -NoProfile -Command Get-ChildItem Env:", "powershell -NoProfile -Command Get-ChildItem Cert:\\CurrentUser", "powershell -NoProfile -Command Get-ChildItem HKLM:\\Software",
    'powershell -NoProfile -Command "Get-ChildItem C:\\a,C:\\b"', 'powershell -NoProfile -Command "Get-Volume | Remove-Item"', 'powershell -NoProfile -Command "Get-Volume; id"', 'powershell -NoProfile -Command "Get-ChildItem $HOME"',
    "powershell -NoProfile -Command Get-ChildItem //server/share", "powershell -NoProfile -Command Get-ChildItem \\\\\\\\server\\\\share", "powershell -NoProfile -Command Get-ChildItem -Path C:/a:b",
    "powershell -NoProfile -Command Get-ChildItem -Recurse -Recurse", "powershell -NoProfile -Command Get-ChildItem -Include x", "powershell -NoProfile -Command Get-PSDrive -PSProvider Registry",
    "powershell -NoProfile -Command Remove-Item C:/x", "powershell -NoProfile -Command Get-Volume > out.txt", "timeout 5 powershell -NoProfile -Command Get-Volume",
  ]) assert.ok(!allowed(l), `${l} -> ${JSON.stringify(run(l))}`);
});

test("a secret path is no skip-only target", () => {
  for (const p of ["C:/Users/me/.ssh", "C:/Users/me/.aws/credentials", ".ssh", "C:\\\\Users\\\\me\\\\.ssh"]) assert.ok(!allowed(`powershell -NoProfile -Command Get-ChildItem ${p}`), p);
  assert.ok(!allowed("powershell -NoProfile -Command Get-ChildItem -Path C:/Users/me/.gnupg -Recurse"));
});

test("a wildcard in the path value is no skip-only target", () => {
  for (const p of ["~/.ss?", "C:/Users/me/.ss*", "C:/Users/me/.s[s]h", "*"]) {
    assert.ok(!allowed(`powershell -NoProfile -Command Get-ChildItem ${p}`), p);
    assert.ok(!allowed(`powershell -NoProfile -Command Get-ChildItem -Path ${p}`), `-Path ${p}`);
  }
});
