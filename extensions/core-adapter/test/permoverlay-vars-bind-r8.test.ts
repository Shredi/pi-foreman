// R8 ledger items 1-2: a nameref without a literal value, an integer-attribute assignment and a `${a:off:len}` substring offset may
// bind a harness-trusted name (HOME, S), so a later `$HOME/..` / `$S/..` is never trusted as a path. Test names are the literal lines.
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
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-varsbind-r8-")));
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
const runAs = (who: "child" | "foreman", line: string): string => (who === "child" ? child(line) : foreman(line));
const untrusted = (kind: string, line: string): void => assert.ok(kind === "deny" || kind === "ask", `${line}: ${kind}`);

const HOME_USE = "cat $HOME/.pi/agent/pi-foreman/x";
const S_USE = "echo y > $S/f";

test("r8 baseline: the unbound uses are trusted", { skip: !posix }, () => {
  assert.equal(foreman(HOME_USE), "pass");
  assert.equal(child(S_USE), "pass");
});

// ------------------------------------------------------------------ item 1: nameref bindings
for (const [line, name, who] of [
  [`for r in $x; do declare -n r; r=/x; done; ${HOME_USE}`, "HOME", "foreman"],
  [`r=$x; declare -n r; r=/x; ${HOME_USE}`, "HOME", "foreman"],
  [`r=$x; typeset -n r; r=/x; ${S_USE}`, "S", "child"],
  [`f() { local -n r; r=/x; }; r=$x; f; ${S_USE}`, "S", "child"],
  [`r=$x; declare -nx r; r=/x; ${HOME_USE}`, "HOME", "foreman"],
  [`read r <f; declare -n r; r=/x; ${S_USE}`, "S", "child"],
  [`declare -n r; for r in $x; do r=/x; done; ${HOME_USE}`, "HOME", "foreman"],
  [`r=HOME; declare -n r; r=/x; ${HOME_USE}`, "HOME", "foreman"],
  [`declare -n r=HOME; r=/x; ${HOME_USE}`, "HOME", "foreman"],
  [`declare -nx r=S; r=/x; ${S_USE}`, "S", "child"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has(name), `boundNames sees ${name}`);
    untrusted(runAs(who, line), line);
  });
}

// ------------------------------------------------------------------ item 2: integer attribute and substring offsets
for (const [line, name, who] of [
  [`declare -i x; x=$y; ${S_USE}`, "S", "child"],
  [`y=$(cat f); declare -i x; x=$y; ${S_USE}`, "S", "child"],
  [`typeset -i x; x=$y; ${HOME_USE}`, "HOME", "foreman"],
  [`f() { local -i x; x=$1; }; f "$y"; ${S_USE}`, "S", "child"],
  [`declare -ix x; x=$y; ${S_USE}`, "S", "child"],
  [`declare -ai a; a[0]=$y; ${S_USE}`, "S", "child"],
  [`declare -i x; x+=$y; ${S_USE}`, "S", "child"],
  [`declare -i x=$y; ${S_USE}`, "S", "child"],
  [`declare -i x; x=y; ${S_USE}`, "S", "child"],
  [`declare -i x; x="$y"; ${HOME_USE}`, "HOME", "foreman"],
  [`declare -i x; read x <f; ${S_USE}`, "S", "child"],
  [`declare -i x; for x in $y; do :; done; ${S_USE}`, "S", "child"],
  [`echo \${a:$off}; ${S_USE}`, "S", "child"],
  [`echo \${a:off}; ${S_USE}`, "S", "child"],
  [`echo \${a:1:$len}; ${HOME_USE}`, "HOME", "foreman"],
  [`echo \${a:1:len}; ${S_USE}`, "S", "child"],
  [`echo \${a: -x}; ${S_USE}`, "S", "child"],
  [`echo \${a:S=1}; ${S_USE}`, "S", "child"],
  [`echo \${@:$off}; ${S_USE}`, "S", "child"],
  [`echo \${a[0]:$off}; ${S_USE}`, "S", "child"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has(name), `boundNames sees ${name}`);
    untrusted(runAs(who, line), line);
  });
}

// ------------------------------------------------------------------ negatives: HOME stays unbound
for (const line of [
  "declare -i n; n=5; cat $HOME/f",
  "echo ${a:2}; cat $HOME/f",
  "echo ${a:2:3}; cat $HOME/f",
  "echo ${a: -1}; cat $HOME/f",
  "echo ${a:-x}; cat $HOME/f",
  "echo ${a:=x}; cat $HOME/f",
  "echo ${a:+x}; cat $HOME/f",
  "echo ${a:?x}; cat $HOME/f",
  "HOMEDIR=/x; cat $HOME/f",
  "echo $HOME_OLD; cat $HOME/f",
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(!boundNames(line).has("HOME"));
    assert.equal(foreman(line), foreman("cat $HOME/f"));
    assert.equal(foreman(line.replace("$HOME/f", HOME_USE.slice(4))), "pass");
  });
}

// ------------------------------------------------------------------ item 2b: an expansion inside an arithmetic body
// `(( $y ))`, `$(( $y ))`, `let "$y"`: the expanded text is evaluated as arithmetic, so `y='S=1'` assigns S
for (const [line, name, who] of [
  [`y=$(cat f); (( $y )); ${S_USE}`, "S", "child"],
  [`y=$(cat f); echo $(( $y )); ${S_USE}`, "S", "child"],
  [`y=$(cat f); let "$y"; ${HOME_USE}`, "HOME", "foreman"],
  [`y=$(cat f); let $y; ${S_USE}`, "S", "child"],
  [`y=$(cat f); (( \${y} )); ${S_USE}`, "S", "child"],
  [`read y <f; (( $y )); ${S_USE}`, "S", "child"],
  [`for y in $z; do (( $y )); done; ${HOME_USE}`, "HOME", "foreman"],
  [`f() { (( $1 )); }; f "$y"; ${S_USE}`, "S", "child"],
  [`y=$(cat f); echo $(( 1 + $y )); ${S_USE}`, "S", "child"],
  [`y=$(cat f); [[ $y -eq 1 ]]; ${S_USE}`, "S", "child"],
  [`y=$(cat f); echo \${a[$y]}; ${S_USE}`, "S", "child"],
  [`y=$(cat f); echo $[ $y ]; ${S_USE}`, "S", "child"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has(name), `boundNames sees ${name}`);
    untrusted(runAs(who, line), line);
  });
}

// item 2b negatives: a literal-valued or unset name in arithmetic leaves HOME trusted
for (const line of [
  "n=5; echo $(( $n + 1 )); cat $HOME/f",
  "echo $(( $n + 1 )); cat $HOME/f",
  "(( 1 + 2 )); cat $HOME/f",
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(!boundNames(line).has("HOME"));
    assert.equal(foreman(line.replace("$HOME/f", HOME_USE.slice(4))), "pass");
  });
}

// ------------------------------------------------------------------ item 3: PowerShell colon parameters, splatting, ScriptBlocks
const PS_USE = "Get-Content $env:HOME/.pi/agent/pi-foreman/x";
const PS_USE_UP = "Get-Content $env:USERPROFILE/.pi/agent/pi-foreman/x";
const PS_VAR_USE = "Get-Content $HOME/.pi/agent/pi-foreman/x";

test("r8 baseline: the unbound PowerShell uses are trusted", { skip: !posix }, () => {
  for (const use of [PS_USE, PS_USE_UP, PS_VAR_USE]) assert.equal(foreman(use, "powershell"), "pass", use);
});

for (const [line, name] of [
  // (a) the colon form `-Path:value` parses like `-Path value`
  [`Set-Item -Path:$p /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path: $p /x; ${PS_USE}`, "HOME"],
  [`Set-Item -PATH:$p /x; ${PS_USE_UP}`, "USERPROFILE"],
  [`Set-Item -path:$p /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path:'env:HOME' /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path:env:HOME /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path: env:HOME /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path:Env:\\USERPROFILE /x; ${PS_USE_UP}`, "USERPROFILE"],
  [`Set-Item -LiteralPath:$p /x; ${PS_USE}`, "HOME"],
  [`Set-Item -LiteralPath:env:USERPROFILE /x; ${PS_USE_UP}`, "USERPROFILE"],
  [`New-Item -Path:"env:HOME" -Value /x; ${PS_USE}`, "HOME"],
  [`New-Item -Path:$p -Value /x; ${PS_USE}`, "HOME"],
  [`si -Path:$p /x; ${PS_USE}`, "HOME"],
  [`Set-Variable -Name:$n -Value /x; ${PS_VAR_USE}`, "HOME"],
  [`Set-Variable -Name:HOME -Value /x; ${PS_VAR_USE}`, "HOME"],
  [`Set-Variable -name: HOME -Value /x; ${PS_VAR_USE}`, "HOME"],
  [`sv -Name:$n /x; ${PS_VAR_USE}`, "HOME"],
  [`Remove-Item -Path:env:HOME; ${PS_USE}`, "HOME"],
  [`Remove-Item -Path:$p; ${PS_USE}`, "HOME"],
  [`Clear-Variable -Name:$n; ${PS_VAR_USE}`, "HOME"],
  [`Rename-Item env:X -NewName:HOME; ${PS_USE}`, "HOME"],
  [`Set-Item -Path:('en'+'v:HOME') /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path:"env:$n" /x; ${PS_USE}`, "HOME"],
  [`Set-Item @($p) /x; ${PS_USE}`, "HOME"],
  // (b) a splat on a binder cmdlet, or passed to Invoke-Command / icm / &
  [`Set-Item @p; ${PS_USE}`, "HOME"],
  [`Set-Item @p -Value /x; ${PS_USE}`, "HOME"],
  [`si @p; ${PS_USE}`, "HOME"],
  [`Set-Variable @p; ${PS_VAR_USE}`, "HOME"],
  [`sv @p; ${PS_VAR_USE}`, "HOME"],
  [`New-Variable @p; ${PS_VAR_USE}`, "HOME"],
  [`nv @p; ${PS_VAR_USE}`, "HOME"],
  [`New-Item @p; ${PS_USE}`, "HOME"],
  [`ni @p; ${PS_USE_UP}`, "USERPROFILE"],
  [`Set-Content @p; ${PS_USE}`, "HOME"],
  [`sc @p; ${PS_USE}`, "HOME"],
  [`Clear-Variable @p; ${PS_VAR_USE}`, "HOME"],
  [`Remove-Item @p; ${PS_USE}`, "HOME"],
  [`Remove-Variable @p; ${PS_VAR_USE}`, "HOME"],
  [`$null = Set-Item @p; ${PS_USE}`, "HOME"],
  [`Set-Item @{Path=$n; Value='/x'}; ${PS_USE}`, "HOME"],
  [`Set-Item @{Path=$n}; ${PS_USE}`, "HOME"],
  [`Invoke-Command @p; ${PS_USE}`, "HOME"],
  [`icm @p; ${PS_USE}`, "HOME"],
  [`& @p; ${PS_USE}`, "HOME"],
  // (c) ScriptBlock forms run code this check never sees
  [`$ExecutionContext.InvokeCommand.NewScriptBlock($c).InvokeReturnAsIs(); ${PS_USE}`, "HOME"],
  [`$sb = $ExecutionContext.InvokeCommand.NewScriptBlock($c); $sb.InvokeReturnAsIs(); ${PS_USE}`, "HOME"],
  [`$sb.InvokeReturnAsIs(); ${PS_USE}`, "HOME"],
  [`$sb.InvokeWithContext($null, $null); ${PS_USE_UP}`, "USERPROFILE"],
  [`$x.NewScriptBlock($c); ${PS_USE}`, "HOME"],
  [`[ScriptBlock]::Create($c).InvokeReturnAsIs(); ${PS_USE}`, "HOME"],
  [`$ExecutionContext.InvokeCommand.InvokeScript($c); ${PS_USE}`, "HOME"],
  [`$null = $ExecutionContext.InvokeCommand.ExpandString($c); ${PS_USE}`, "HOME"],
  [`$ic = $ExecutionContext.InvokeCommand; ${PS_USE}`, "HOME"],
  [`Invoke-Expression $c; ${PS_USE}`, "HOME"],
  [`iex $c; ${PS_USE}`, "HOME"],
  [`& $sb; ${PS_USE}`, "HOME"],
  [`. $sb; ${PS_USE}`, "HOME"],
  [`$sb.Invoke(); ${PS_USE}`, "HOME"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line, "powershell").has(name), `boundNames sees ${name}`);
    untrusted(foreman(line, "powershell"), line);
  });
}

// item 3 negatives: a literal colon target binds that name only; a reader binds nothing; `$HOMEDIR` is not HOME
test(`Set-Item -Path:env:FOO /x; ${PS_USE}`, { skip: !posix }, () => {
  const line = `Set-Item -Path:env:FOO /x; ${PS_USE}`;
  const names = boundNames(line, "powershell");
  assert.ok(names.has("FOO"), "binds FOO");
  assert.ok(!names.has("HOME"), "not HOME");
  assert.equal(foreman(line, "powershell"), "pass");
});

for (const line of [
  `Set-Item -Path:'env:FOO' -Value:/x; ${PS_USE}`,
  `Set-Variable -Name:FOO -Value /x; ${PS_USE}`,
  `$HOMEDIR = 1; ${PS_USE}`,
  `Get-Item -Path:$p; ${PS_USE}`,
  `Get-Item -Path:env:FOO; ${PS_USE}`,
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(!boundNames(line, "powershell").has("HOME"), "not HOME");
    assert.equal(foreman(line, "powershell"), "pass");
  });
}

// ------------------------------------------------------------------ revision 1, item 2: quoted integer RHS, special-parameter offsets
for (const [line, name, who] of [
  [`declare -i x; x=" $y"; ${S_USE}`, "S", "child"],
  [`declare -i x=" $y"; ${S_USE}`, "S", "child"],
  [`declare -i x; x=1" $y"; ${HOME_USE}`, "HOME", "foreman"],
  [`declare -i x; x="1 + $y"; ${S_USE}`, "S", "child"],
  [`declare -i x; x=' y'; ${S_USE}`, "S", "child"],
  [`declare -i x; x+=" $y"; ${S_USE}`, "S", "child"],
  [`typeset -i x; x=" \`cat f\`"; ${HOME_USE}`, "HOME", "foreman"],
  [`echo \${$:$off}; ${S_USE}`, "S", "child"],
  [`echo \${?:$off}; ${S_USE}`, "S", "child"],
  [`echo \${-:$off}; ${S_USE}`, "S", "child"],
  [`echo \${#:$off}; ${HOME_USE}`, "HOME", "foreman"],
  [`echo \${!:$off}; ${S_USE}`, "S", "child"],
  [`echo \${$:1:$len}; ${S_USE}`, "S", "child"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has(name), `boundNames sees ${name}`);
    untrusted(runAs(who, line), line);
  });
}

// revision 1, item 2 negatives: lengths, indirection, defaults and quoted numeric literals leave HOME trusted
for (const line of [
  "echo ${#x}; cat $HOME/f",
  "echo ${!x}; cat $HOME/f",
  "echo ${x:-y}; cat $HOME/f",
  "echo ${#:-0}; cat $HOME/f",
  "echo ${?:-0}; cat $HOME/f",
  "echo ${$:2}; cat $HOME/f",
  'declare -i n; n="5"; cat $HOME/f',
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(!boundNames(line).has("HOME"));
    assert.equal(foreman(line.replace("$HOME/f", HOME_USE.slice(4))), "pass");
  });
}

// ------------------------------------------------------------------ revision 1, item 3: comma arrays in the colon and space forms
for (const [line, name] of [
  [`Set-Item -Path:env:FOO, $p -Value /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path env:FOO ,$p -Value /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path:env:FOO, (gc f) -Value /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path:'env:FOO', $p -Value /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path env:FOO , $p -Value /x; ${PS_USE}`, "HOME"],
  [`Remove-Item -Path:env:FOO, $p; ${PS_USE}`, "HOME"],
  [`Set-Variable -Name:FOO, $n -Value /x; ${PS_VAR_USE}`, "HOME"],
  [`Set-Item -Path:env:FOO,\n$p -Value /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path:env:FOO, env:HOME -Value /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Path env:FOO ,env:HOME -Value /x; ${PS_USE}`, "HOME"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line, "powershell").has(name), `boundNames sees ${name}`);
    untrusted(foreman(line, "powershell"), line);
  });
}

// ------------------------------------------------------------------ revision 1, item 19: pipeline input, positionals, destinations, module names
for (const [line, name] of [
  // pipeline input into an item cmdlet without a literal path / name
  [`Get-Content f | Set-Item -Value /x; ${PS_USE}`, "HOME"],
  [`gc f | si -Value /x; ${PS_USE}`, "HOME"],
  [`gc f | New-Item -Value /x; ${PS_USE}`, "HOME"],
  [`gc f | ni -Value /x; ${PS_USE}`, "HOME"],
  [`gc f | Set-Content -Value x; ${PS_USE}`, "HOME"],
  [`gc f | sc -Value x; ${PS_USE}`, "HOME"],
  [`gc f | Remove-Item; ${PS_USE}`, "HOME"],
  [`gc f | Clear-Item; ${PS_USE}`, "HOME"],
  [`gc f | Rename-Item -NewName FOO; ${PS_USE}`, "HOME"],
  [`gc f | Copy-Item -Destination ./b; ${PS_USE}`, "HOME"],
  [`gc f | Move-Item -Destination ./b; ${PS_USE}`, "HOME"],
  [`gc f | Rename-Item -Path env:X; ${PS_USE}`, "HOME"],
  [`gc f | Set-Variable -Value /x; ${PS_VAR_USE}`, "HOME"],
  [`gc f | sv -Value /x; ${PS_VAR_USE}`, "HOME"],
  [`gc f | New-Variable -Value /x; ${PS_VAR_USE}`, "HOME"],
  [`gc f | nv -Value /x; ${PS_VAR_USE}`, "HOME"],
  [`$null = gc f | Set-Item -Value /x; ${PS_USE}`, "HOME"],
  // a positional path after a named option's value, or behind an abbreviated parameter name
  [`Set-Item -Value /x $p; ${PS_USE}`, "HOME"],
  [`si -Value /x $p; ${PS_USE}`, "HOME"],
  [`Set-Content -Value x $p; ${PS_USE}`, "HOME"],
  [`New-Item -Value /x $p; ${PS_USE}`, "HOME"],
  [`New-Item -ItemType Variable -Value /x $p; ${PS_USE}`, "HOME"],
  [`Set-Variable -Value /x $n; ${PS_VAR_USE}`, "HOME"],
  [`$null = Set-Item -Value /x $p; ${PS_USE}`, "HOME"],
  [`Set-Item -Pa $p -Value /x; ${PS_USE}`, "HOME"],
  [`Set-Item -P $p /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Lit $p /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Pa:$p -Value /x; ${PS_USE}`, "HOME"],
  [`Set-Variable -N $n -Value /x; ${PS_VAR_USE}`, "HOME"],
  [`Set-Item -Force $p /x; ${PS_USE}`, "HOME"],
  [`Set-Item -Val /x $p; ${PS_USE}`, "HOME"],
  [`Set-Item env:FOO /x $p; ${PS_USE}`, "HOME"],
  // a non-literal destination
  [`Rename-Item env:X -NewName $n; ${PS_USE}`, "HOME"],
  [`Rename-Item env:X -NewName:$n; ${PS_USE}`, "HOME"],
  [`Rename-Item env:X $n; ${PS_USE}`, "HOME"],
  [`ren env:X $n; ${PS_USE}`, "HOME"],
  [`rni env:X $n; ${PS_USE}`, "HOME"],
  [`Copy-Item env:X -Destination $d; ${PS_USE}`, "HOME"],
  [`Copy-Item env:X -Destination:$d; ${PS_USE}`, "HOME"],
  [`copy env:X $d; ${PS_USE}`, "HOME"],
  [`cp env:X $d; ${PS_USE}`, "HOME"],
  [`cpi env:X $d; ${PS_USE}`, "HOME"],
  [`Move-Item env:X -Destination $d; ${PS_USE}`, "HOME"],
  [`move env:X $d; ${PS_USE}`, "HOME"],
  [`mv env:X $d; ${PS_USE}`, "HOME"],
  [`mi env:X $d; ${PS_USE}`, "HOME"],
  [`Copy-Item -Destination $d env:X; ${PS_USE}`, "HOME"],
  // a literal destination binds that name
  [`Copy-Item env:X -Destination env:HOME; ${PS_USE}`, "HOME"],
  [`Move-Item env:X variable:HOME; ${PS_VAR_USE}`, "HOME"],
  // module-qualified cmdlet names
  [`Microsoft.PowerShell.Management\\Set-Item -Path $p -Value /x; ${PS_USE}`, "HOME"],
  [`microsoft.powershell.management\\set-item $p /x; ${PS_USE}`, "HOME"],
  [`Microsoft.PowerShell.Management\\Set-Item -Value /x $p; ${PS_USE}`, "HOME"],
  [`Microsoft.PowerShell.Utility\\Set-Variable -Name $n -Value /x; ${PS_VAR_USE}`, "HOME"],
  [`MICROSOFT.POWERSHELL.UTILITY\\SET-VARIABLE $n /x; ${PS_VAR_USE}`, "HOME"],
  [`Foo\\Set-Item @p; ${PS_USE}`, "HOME"],
  [`$null = Microsoft.PowerShell.Management\\New-Item -Path $p; ${PS_USE}`, "HOME"],
  [`gc f | Microsoft.PowerShell.Management\\Set-Item -Value /x; ${PS_USE}`, "HOME"],
  [`Microsoft.PowerShell.Utility\\Invoke-Expression $c; ${PS_USE}`, "HOME"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line, "powershell").has(name), `boundNames sees ${name}`);
    untrusted(foreman(line, "powershell"), line);
  });
}

// revision 1 negatives: literal targets, value-only expressions and readers leave HOME trusted
for (const line of [
  `Set-Item -Path:env:FOO, env:BAR -Value /x; ${PS_USE}`,
  `Set-Item -Path env:FOO -Value $v; ${PS_USE}`,
  `Set-Item env:FOO $v; ${PS_USE}`,
  `Set-Item -Value $v -Path env:FOO; ${PS_USE}`,
  `Get-Content f | Out-Null; ${PS_USE}`,
  `gc f | Set-Item -Path env:FOO; ${PS_USE}`,
  `Rename-Item env:X -NewName FOO; ${PS_USE}`,
  `Copy-Item ./a ./b; ${PS_USE}`,
  `Microsoft.PowerShell.Management\\Set-Item -Path env:FOO -Value /x; ${PS_USE}`,
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(!boundNames(line, "powershell").has("HOME"), "not HOME");
    assert.equal(foreman(line, "powershell"), "pass");
  });
}

// ------------------------------------------------------------------ revision 2, item 2: default/assign expansions on an integer name,
// bash's integer specials, compound-array subscripts, `[[ .. ]]` operands holding a subscript
for (const [line, name, who] of [
  [`declare -i x; : \${x:=$y}; ${S_USE}`, "S", "child"],
  [`declare -i x; : \${x:+$y}; ${S_USE}`, "S", "child"],
  [`declare -i n; : \${n+$y}; ${HOME_USE}`, "HOME", "foreman"],
  [`declare -i x; : \${x:-$y}; ${S_USE}`, "S", "child"],
  [`declare -i x; : \${x-$y}; ${S_USE}`, "S", "child"],
  [`declare -i x; : \${x:?$y}; ${S_USE}`, "S", "child"],
  [`declare -ai a; : \${a[0]:=$y}; ${S_USE}`, "S", "child"],
  [`typeset -i n; echo "\${n:=$y}"; ${HOME_USE}`, "HOME", "foreman"],
  [`OPTIND=$y; ${S_USE}`, "S", "child"],
  [`OPTERR=$y; ${S_USE}`, "S", "child"],
  [`SECONDS=$y; ${HOME_USE}`, "HOME", "foreman"],
  [`RANDOM=$y; ${S_USE}`, "S", "child"],
  [`LINENO=$y; ${S_USE}`, "S", "child"],
  [`HISTCMD=$y; ${S_USE}`, "S", "child"],
  [`OPTIND="$y"; ${S_USE}`, "S", "child"],
  [`OPTIND+=$y; ${S_USE}`, "S", "child"],
  [`export OPTIND=$y; ${S_USE}`, "S", "child"],
  [`: \${OPTIND:=$y}; ${S_USE}`, "S", "child"],
  [`read OPTIND <f; ${S_USE}`, "S", "child"],
  [`y=$(cat f); a=([$y]=1); ${S_USE}`, "S", "child"],
  [`y=$(cat f); declare -a a=([$y]=1); ${S_USE}`, "S", "child"],
  [`y=$(cat f); a+=([$y]=1); ${HOME_USE}`, "HOME", "foreman"],
  [`y=$(cat f); a=(x [$y]=1); ${S_USE}`, "S", "child"],
  [`read y <f; a=([$y]=1); ${S_USE}`, "S", "child"],
  [`y=$(cat f); [[ a[0] -eq $y ]]; ${S_USE}`, "S", "child"],
  [`y=$(cat f); [[ a[0] -ne $y ]]; ${S_USE}`, "S", "child"],
  [`y=$(cat f); [[ a[0] -lt $y ]]; ${HOME_USE}`, "HOME", "foreman"],
  [`y=$(cat f); [[ a[0] -le $y ]]; ${S_USE}`, "S", "child"],
  [`y=$(cat f); [[ a[0] -gt $y ]]; ${S_USE}`, "S", "child"],
  [`y=$(cat f); [[ a[0] -ge $y ]]; ${S_USE}`, "S", "child"],
  [`y=$(cat f); [[ $y -lt a[0] ]]; ${S_USE}`, "S", "child"],
  [`y=$(cat f); [[ a[0] -eq y ]]; ${S_USE}`, "S", "child"],
  [`y=$(cat f); [[ \${a[0]} -eq $y ]]; ${S_USE}`, "S", "child"],
  [`y=$(cat f); [[ a[b[0]] -eq $y ]]; ${S_USE}`, "S", "child"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has(name), `boundNames sees ${name}`);
    untrusted(runAs(who, line), line);
  });
}

// revision 2, item 2 negatives: numeric literals, unset operands, reads of the specials leave HOME trusted
for (const line of [
  "OPTIND=1; cat $HOME/f",
  "[[ $n -eq 1 ]]; cat $HOME/f",
  "[[ a[0] -eq 1 ]]; cat $HOME/f",
  "declare -i n; : ${n:=5}; cat $HOME/f",
  "a=([0]=1 [1]=2); cat $HOME/f",
  "shift $((OPTIND-1)); cat $HOME/f",
  "echo $RANDOM $SECONDS; cat $HOME/f",
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(!boundNames(line).has("HOME"));
    assert.equal(foreman(line.replace("$HOME/f", HOME_USE.slice(4))), "pass");
  });
}
