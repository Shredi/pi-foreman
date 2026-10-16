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

// ================================================================== full-grammar reviewer findings (ledger item 4)
// Each literal line binds (or may bind) the trusted name it then uses; the use must not be trusted.

// A. quote removal inside a name token (bash may not even treat some as assignments; bound anyway, fail closed)
for (const line of [
  `HO""ME=/x; cat $HOME/f`,
  `H\\OME=/x; cat $HOME/f`,
  `H''OME=/x; cat $HOME/f`,
  `"HO"ME=/x; cat $HOME/f`,
  `export HO""ME=/x; cat $HOME/.pi/agent/pi-foreman/x`,
  `env "HO"ME=/x bash -c 'cat $HOME/.pi/agent/pi-foreman/x'`,
  `declare H\\OME=/x; cat $HOME/f`,
  `read "HO"ME <f; cat $HOME/f`,
  `export $'HO''ME'=/x; cat $HOME/f`,
  `declare -n r=HO""ME; r=/x; cat $HOME/f`,
  `unset -v HO""ME; cat $HOME/f`,
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has("HOME"), "boundNames sees HOME");
    untrusted(foreman(line), line);
  });
}

// B. indirection in a name position: every trusted name is bound (eval-like)
for (const line of [
  `n=HO; declare "\${n}ME=/x"; cat $HOME/f`,
  `n=HO; printf -v "\${n}ME" /x; cat $HOME/f`,
  `n=home; export "\${n^^}=/x"; cat $HOME/f`,
  `export {HOME,X}=/x; cat $HOME/f`,
  `n=HO; (( \${n}ME=1 )); cat $HOME/f`,
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has("HOME"), "boundNames sees HOME");
    untrusted(foreman(line), line);
  });
}
test("read {S,} <f; echo x > $S/f", { skip: !posix }, () => {
  const line = "read {S,} <f; echo x > $S/f";
  assert.ok(boundNames(line).has("S"));
  untrusted(child(line), line);
});

// C. lead characters and attached options
for (const [line, name, who] of [
  [`read \\S <f; echo x > $S/f`, "S", "child"],
  [`printf -vS %s /x; echo x > $S/f`, "S", "child"],
  [`printf -vHOME %s /x; cat $HOME/f`, "HOME", "foreman"],
  [`read -aHOME <<<x; cat $HOME/f`, "HOME", "foreman"],
  [`exec {S}>/dev/null; echo x > $S/f`, "S", "child"],
  [`exec {HOME}>/dev/null; cat $HOME/f`, "HOME", "foreman"],
  [`(( ++S )); echo x > $S/f`, "S", "child"],
  [`: \${S[0]:=/x}; echo x > $S/f`, "S", "child"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has(name), `boundNames sees ${name}`);
    untrusted(who === "child" ? child(line) : foreman(line), line);
  });
}

// D. eval-like command words found from the parsed command word
for (const line of [
  `if . ./f; then cat $HOME/f; fi`,
  `while . ./f; do cat $HOME/f; done`,
  `until . ./f; do cat $HOME/f; done`,
  `if false; then :; elif . ./f; then cat $HOME/f; fi`,
  `case x in x) . ./f;; esac; cat $HOME/f`,
  `2>/dev/null . ./f; cat $HOME/f`,
  `\\source ./f; cat $HOME/f`,
  `"." ./f; cat $HOME/f`,
  `x=source; $x ./f; cat $HOME/f`,
  `BASH_ENV=./f bash -c 'cat $HOME/f'`,
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has("HOME"), "boundNames sees HOME");
    untrusted(foreman(line), line);
  });
}

// E. tilde: `~` behind the bound check; `~-`, `~+`, `~user` never resolve against the cwd
for (const line of [
  `read HOME <f; echo y >~/f`,
  `read HOME <f; cat <~/.pi/agent/pi-foreman/x`,
  `for HOME in /x; do cat {~/.pi/agent/pi-foreman/x,y}; done`,
  `OLDPWD=/x; echo y > ~-/f`,
  `PWD=/x; echo y > ~+/f`,
  `echo y > ~root/f`,
]) {
  test(line, { skip: !posix }, () => untrusted(foreman(line), line));
}

// F. PowerShell (shell "powershell")
for (const line of [
  `[Environment]::SetEnvironmentVariable('HO'+'ME','/x'); Get-Content $env:HOME/.pi/agent/pi-foreman/x`,
  `Rename-Item env:X -NewName home; Get-Content $env:HOME/.pi/agent/pi-foreman/x`,
  `Set-Variable -Name home -Value /x -Force; Get-Content $HOME/.pi/agent/pi-foreman/x`,
  `Set-Item variable:HOME /x -Force; Get-Content $HOME/.pi/agent/pi-foreman/x`,
  `iex (Get-Content ./f -Raw); Get-Content $env:HOME/.pi/agent/pi-foreman/x`,
  `Invoke-Expression (Get-Content ./f -Raw); Get-Content $env:HOME/f`,
  `& ./f.ps1; Get-Content $env:HOME/f`,
  `./f.ps1; Get-Content $env:HOME/f`,
  `Import-Module ./m.psm1; Get-Content $env:HOME/f`,
  `$p='env'; Set-Item "\${p}:HOME" /x; Get-Content $env:HOME/f`,
  `$global:HOME = '/x'; Get-Content $HOME/f`,
  `(Get-PSProvider FileSystem).Home = '/x'; Get-Content ~/.pi/agent/pi-foreman/x`,
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line, "powershell").has("HOME"), "boundNames sees HOME");
    untrusted(foreman(line, "powershell"), line);
  });
}

// ================================================================== full-grammar re-review findings (ledger items 1, 2, 4)
// Each literal line may bind the trusted name it then uses (through an expansion, nested shell, callback or arithmetic).
const runAs = (who: "child" | "foreman", line: string): string => (who === "child" ? child(line) : foreman(line));

// U1: nameref value built by expansion or a decoded escape
// U2: nested shell bodies; a quoted `.`
// U3: trap and mapfile/readarray -C callbacks are eval-like
// U6: arithmetic over a variable set from a non-literal, `++`/`--`/`=` in a subscript, `${x@P}`, `${!x:=}`
for (const [line, name, who] of [
  ["x=; declare -n r=${x}S; r=/x; echo y > $S/f", "S", "child"],
  ["x=HO; local -n r=${x}ME; r=/x; cat $HOME/f", "HOME", "foreman"],
  ["declare -n r=$'\\x53'; read r <f; echo y > $S/f", "S", "child"],
  ["bash -c 'printf -v \"$1\" %s /x; echo y > $S/f' _ $'\\x53'", "S", "child"],
  ["bash -c '. ./f; echo y > $S/f'", "S", "child"],
  ["x=$'\\x53'; trap 'printf -v \"$x\" %s /x' DEBUG; echo y > $S/f", "S", "child"],
  ["trap '. ./f' DEBUG; cat $HOME/f", "HOME", "foreman"],
  ["mapfile -C 'printf -v S %s' -c 1 a <f; echo y > $S/f", "S", "child"],
  ["readarray -C 'printf -v S %s' -c 1 a <f; echo y > $S/f", "S", "child"],
  ["x=$'\\x53=1'; (( x )); echo y > $S/f", "S", "child"],
  ["echo ${a[S++]}; echo y > $S/f", "S", "child"],
  ["x=S; : ${!x:=/x}; echo y > $S/f", "S", "child"],
  ["x=S; : ${!x=/x}; echo y > $S/f", "S", "child"],
  ["echo ${x@P}; echo y > $S/f", "S", "child"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has(name), `boundNames sees ${name}`);
    untrusted(runAs(who, line), line);
  });
}

// U4: PowerShell eval / item cmdlets anywhere in the text; PSVariable.Set
// U5: backtick escapes, provider-qualified `Environment::` paths
for (const line of [
  `$c = '$env:HO' + 'ME = ''/x'''; $null = iex $c; Get-Content $env:HOME/.pi/agent/pi-foreman/x`,
  `$null = New-Item -Path ('en'+'v:HOME') -Value /x -Force; Get-Content $env:HOME/.pi/agent/pi-foreman/x`,
  `$null = $ExecutionContext.SessionState.PSVariable.Set('HO'+'ME','/x'); Get-Content $HOME/.pi/agent/pi-foreman/x`,
  `Write-Output (iex $c); Get-Content $env:HOME/f`,
  "${env:HO`ME} = '/x'; Get-Content $env:HOME/.pi/agent/pi-foreman/x",
  `Set-Item Environment::HOME /x; Get-Content $env:HOME/.pi/agent/pi-foreman/x`,
  `Set-Item Microsoft.PowerShell.Core\\Environment::HOME /x; Get-Content $env:HOME/f`,
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line, "powershell").has("HOME"), "boundNames sees HOME");
    untrusted(foreman(line, "powershell"), line);
  });
}

// the unbound PowerShell `$HOME` / `~` uses stay trusted
test("powershell: unbound $HOME / ~ are trusted", { skip: !posix }, () => {
  assert.equal(foreman("Get-Content $HOME/.pi/agent/pi-foreman/x", "powershell"), "pass");
  assert.equal(foreman("Get-Content ~/.pi/agent/pi-foreman/x", "powershell"), "pass");
  assert.equal(foreman("cat ~/.pi/agent/pi-foreman/x"), "pass");
});
