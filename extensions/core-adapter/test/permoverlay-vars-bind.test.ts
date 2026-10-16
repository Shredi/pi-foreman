// Every binding form of a harness-trusted name (HOME, S, FOREMAN_SCRATCH, USERPROFILE) makes boundNames see it, so a later
// `$HOME/..` / `$S/..` / `$env:HOME\..` is never trusted as a path (ledger items 1-3). Test names are the literal lines.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { boundNames, buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { ownedRoots } from "../owned.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-varsbind-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const home = path.join(base, "home");
const agentDir = path.join(home, ".pi", "agent");
const main = path.join(base, "repo");
const scratch = path.join(base, "tmp", "pi-foreman-scratch", "child1");
for (const d of [path.join(main, ".workflow"), agentDir, scratch]) fs.mkdirSync(d, { recursive: true });
const owned = ownedRoots({ agentDir, workspaceRoot: main, tmpRoot: path.join(base, "tmp"), npmRoot: null });
const rules = buildOverlayRules(baseline, {}, {}, agentDir, pkgRoot, undefined, false, owned);

const foreman = (command: string, tool = "bash"): string => checkToolCall(rules, tool, { command }, { cwd: main, home, platform: process.platform, role: "main", owned })?.kind ?? "pass";
const child = (command: string): string => {
  const ctx: MatchCtx = { cwd: main, home, platform: process.platform, role: "child", scratch, owned };
  return checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";
};

// the uses: trusted while unbound (pass), so a binding that boundNames misses would let them through
const HOME_USE = "cat $HOME/.pi/agent/pi-foreman/x";
const S_USE = "echo x > $S/f";
const PS_USE = "Get-Content $env:HOME/.pi/agent/pi-foreman/x";
const PS_USE_UP = "Get-Content $env:USERPROFILE/.pi/agent/pi-foreman/x";

test("baseline: the unbound uses are trusted", { skip: !posix }, () => {
  assert.equal(foreman(HOME_USE), "pass");
  assert.equal(child(S_USE), "pass");
  assert.equal(foreman(PS_USE, "powershell"), "pass");
  assert.equal(foreman(PS_USE_UP, "powershell"), "pass");
});

const untrusted = (kind: string, line: string): void => assert.ok(kind === "deny" || kind === "ask", `${line}: ${kind}`);

// ------------------------------------------------------------------ posix HOME (foreman)
for (const line of [
  `read HOME<f; ${HOME_USE}`,
  `read HOME<<<x; ${HOME_USE}`,
  `read -r HOME <f; ${HOME_USE}`,
  `read HOME; ${HOME_USE}`,
  `readarray -t HOME<f; ${HOME_USE}`,
  `mapfile -t HOME<f; ${HOME_USE}`,
  `HOME+=/x; ${HOME_USE}`,
  `HOME[0]=/x; ${HOME_USE}`,
  `export HOME=/x; ${HOME_USE}`,
  `export HOME; ${HOME_USE}`,
  `declare HOME=/x; ${HOME_USE}`,
  `typeset HOME=/x; ${HOME_USE}`,
  `local HOME=/x; ${HOME_USE}`,
  `readonly HOME=/x; ${HOME_USE}`,
  `for HOME in /x; do ${HOME_USE}; done`,
  `printf -v HOME %s /x; ${HOME_USE}`,
  `getopts o HOME; ${HOME_USE}`,
  `: \${HOME=/x}; ${HOME_USE}`,
  `: \${HOME:=/x}; ${HOME_USE}`,
  `eval x; ${HOME_USE}`,
  `source ./f; ${HOME_USE}`,
  `. ./f; ${HOME_USE}`,
  `true && . ./f; ${HOME_USE}`,
  `\`read HOME<f\`; ${HOME_USE}`,
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has("HOME"), "boundNames sees HOME");
    untrusted(foreman(line), line);
  });
}

test("R5 B1: HOME=/x; cat $HOME/… same-line prefix", { skip: !posix }, () => {
  for (const line of [`HOME=/x; ${HOME_USE}`, `HOME=/x ${HOME_USE}`, `HOME=/x; cat ~/.pi/agent/pi-foreman/x`]) {
    assert.ok(boundNames(line).has("HOME"), line);
    untrusted(foreman(line), line);
  }
});

// ------------------------------------------------------------------ posix S / FOREMAN_SCRATCH (child)
for (const line of [
  `mapfile -t S<f; ${S_USE}`,
  `read S<$FOREMAN_SCRATCH/p; ${S_USE}`,
  `read S<<<x; ${S_USE}`,
  `read S<f; ${S_USE}`,
  `eval x; ${S_USE}`,
  `source ./f; ${S_USE}`,
  `. ./f; ${S_USE}`,
  `read FOREMAN_SCRATCH<f; echo x > $FOREMAN_SCRATCH/f`,
  `eval x; echo x > $FOREMAN_SCRATCH/f`,
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has(line.includes("$S/") ? "S" : "FOREMAN_SCRATCH"));
    untrusted(child(line), line);
  });
}

test("R5 B2: bound $S resolution reaches tmpTargets", { skip: !posix }, () => {
  for (const line of [`S=/tmp; ${S_USE}`, "S=/tmp; echo x | tee $S/x", `read S<f; echo x | tee $S/x`]) untrusted(child(line), line);
  // the grammar's own resolution of the scratch dir still passes
  assert.equal(child(`S=$FOREMAN_SCRATCH; ${S_USE}`), "pass");
});

// ------------------------------------------------------------------ negatives: HOME is not bound
for (const line of ["HOMEDIR=/x; cat $HOME/f", "echo $HOME_OLD; cat $HOME/f"]) {
  test(line, { skip: !posix }, () => {
    assert.ok(!boundNames(line).has("HOME"));
    assert.equal(foreman(line), foreman("cat $HOME/f"));
    assert.equal(foreman(line.replace("$HOME/f", HOME_USE.slice(4))), "pass");
  });
}

// ------------------------------------------------------------------ PowerShell env forms (foreman, shell "powershell")
for (const [line, name] of [
  [`Set-Item env:HOME /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path env:HOME -Value /x; ${PS_USE}`, "HOME"],
  [`Set-Item Env:\\USERPROFILE /x; ${PS_USE_UP}`, "USERPROFILE"],
  [`si env:HOME /x; ${PS_USE}`, "HOME"],
  [`New-Item env:HOME -Value /x; ${PS_USE}`, "HOME"],
  [`ni -Path Env:\\HOME -Value /x; ${PS_USE}`, "HOME"],
  [`\${env:HOME}='/x'; ${PS_USE}`, "HOME"],
  [`\${env:HOME} = '/x'; Get-Content \${env:HOME}/.pi/agent/pi-foreman/x`, "HOME"],
  [`$env:HOME = '/x'; ${PS_USE}`, "HOME"],
  [`$Env:home = '/x'; ${PS_USE}`, "HOME"],
  [`$env:USERPROFILE='/x'; ${PS_USE_UP}`, "USERPROFILE"],
  [`[Environment]::SetEnvironmentVariable('HOME', '/x'); ${PS_USE}`, "HOME"],
  [`[System.Environment]::SetEnvironmentVariable("USERPROFILE", "/x"); ${PS_USE_UP}`, "USERPROFILE"],
  [`[environment]::SetEnvironmentVariable($n, '/x'); ${PS_USE}`, "HOME"],
  [`set-item ENV:home /x; ${PS_USE}`, "HOME"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line, "powershell").has(name), `boundNames sees ${name}`);
    untrusted(foreman(line, "powershell"), line);
  });
}
