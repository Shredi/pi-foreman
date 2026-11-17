// The names a line binds, from shellast.ts's own parse (round 2, step 1): the posix rows of permoverlay-vars-bind.test.ts and
// permoverlay-vars-bind-r8.test.ts, with the same inputs, asked of `boundNames` alone. "any" counts as bound. Test names are the literal lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundNames } from "../shellast.ts";

const bound = (line: string, name: string): boolean => {
  const b = boundNames(line);
  return b.any || b.names.has(name);
};

const HOME_USE = "cat $HOME/.pi/agent/pi-foreman/x";
const S_USE = "echo x > $S/f";
const S_USE_Y = "echo y > $S/f";

// ------------------------------------------------------------------ posix HOME
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
  `HOME=/x; ${HOME_USE}`,
  `HOME=/x ${HOME_USE}`,
  `HOME=/x; cat ~/.pi/agent/pi-foreman/x`,
]) {
  test(line, () => assert.ok(bound(line, "HOME")));
}

// ------------------------------------------------------------------ posix S / FOREMAN_SCRATCH
for (const line of [
  `mapfile -t S<f; ${S_USE}`,
  `read S<$FOREMAN_SCRATCH/p; ${S_USE}`,
  `read S<<<x; ${S_USE}`,
  `read S<f; ${S_USE}`,
  `eval x; ${S_USE}`,
  `source ./f; ${S_USE}`,
  `. ./f; ${S_USE}`,
]) {
  test(line, () => assert.ok(bound(line, "S")));
}
for (const line of [`read FOREMAN_SCRATCH<f; echo x > $FOREMAN_SCRATCH/f`, `eval x; echo x > $FOREMAN_SCRATCH/f`]) {
  test(line, () => assert.ok(bound(line, "FOREMAN_SCRATCH")));
}

// ------------------------------------------------------------------ negatives: HOME is not bound
for (const line of ["HOMEDIR=/x; cat $HOME/f", "echo $HOME_OLD; cat $HOME/f", "cat $HOME/f"]) {
  test(line, () => assert.ok(!bound(line, "HOME")));
}

// ------------------------------------------------------------------ the name given by a quoted, escaped or computed word
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
  `n=HO; declare "\${n}ME=/x"; cat $HOME/f`,
  `n=HO; printf -v "\${n}ME" /x; cat $HOME/f`,
  `n=home; export "\${n^^}=/x"; cat $HOME/f`,
  `export {HOME,X}=/x; cat $HOME/f`,
  `n=HO; (( \${n}ME=1 )); cat $HOME/f`,
]) {
  test(line, () => assert.ok(bound(line, "HOME")));
}
test("read {S,} <f; echo x > $S/f", () => assert.ok(bound("read {S,} <f; echo x > $S/f", "S")));

// ------------------------------------------------------------------ lead characters and attached options
for (const [line, name] of [
  [`read \\S <f; echo x > $S/f`, "S"],
  [`printf -vS %s /x; echo x > $S/f`, "S"],
  [`printf -vHOME %s /x; cat $HOME/f`, "HOME"],
  [`read -aHOME <<<x; cat $HOME/f`, "HOME"],
  [`exec {S}>/dev/null; echo x > $S/f`, "S"],
  [`exec {HOME}>/dev/null; cat $HOME/f`, "HOME"],
  [`(( ++S )); echo x > $S/f`, "S"],
  [`: \${S[0]:=/x}; echo x > $S/f`, "S"],
] as const) {
  test(line, () => assert.ok(bound(line, name)));
}

// ------------------------------------------------------------------ eval-like command words
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
  `read HOME <f; cat <~/x`,
  `for HOME in /x; do cat {~/x,y}; done`,
]) {
  test(line, () => assert.ok(bound(line, "HOME")));
}

// ------------------------------------------------------------------ expansions, nested shells, callbacks and arithmetic
for (const [line, name] of [
  ["x=; declare -n r=${x}S; r=/x; echo y > $S/f", "S"],
  ["x=HO; local -n r=${x}ME; r=/x; cat $HOME/f", "HOME"],
  ["declare -n r=$'\\x53'; read r <f; echo y > $S/f", "S"],
  ["bash -c 'printf -v \"$1\" %s /x; echo y > $S/f' _ $'\\x53'", "S"],
  ["bash -c '. ./f; echo y > $S/f'", "S"],
  ["x=$'\\x53'; trap 'printf -v \"$x\" %s /x' DEBUG; echo y > $S/f", "S"],
  ["trap '. ./f' DEBUG; cat $HOME/f", "HOME"],
  ["mapfile -C 'printf -v S %s' -c 1 a <f; echo y > $S/f", "S"],
  ["readarray -C 'printf -v S %s' -c 1 a <f; echo y > $S/f", "S"],
  ["x=$'\\x53=1'; (( x )); echo y > $S/f", "S"],
  ["echo ${a[S++]}; echo y > $S/f", "S"],
  ["x=S; : ${!x:=/x}; echo y > $S/f", "S"],
  ["x=S; : ${!x=/x}; echo y > $S/f", "S"],
  ["echo ${x@P}; echo y > $S/f", "S"],
] as const) {
  test(line, () => assert.ok(bound(line, name)));
}

// ------------------------------------------------------------------ r8 item 1: nameref bindings
for (const [line, name] of [
  [`for r in $x; do declare -n r; r=/x; done; ${HOME_USE}`, "HOME"],
  [`r=$x; declare -n r; r=/x; ${HOME_USE}`, "HOME"],
  [`r=$x; typeset -n r; r=/x; ${S_USE_Y}`, "S"],
  [`f() { local -n r; r=/x; }; r=$x; f; ${S_USE_Y}`, "S"],
  [`r=$x; declare -nx r; r=/x; ${HOME_USE}`, "HOME"],
  [`read r <f; declare -n r; r=/x; ${S_USE_Y}`, "S"],
  [`declare -n r; for r in $x; do r=/x; done; ${HOME_USE}`, "HOME"],
  [`r=HOME; declare -n r; r=/x; ${HOME_USE}`, "HOME"],
  [`declare -n r=HOME; r=/x; ${HOME_USE}`, "HOME"],
  [`declare -nx r=S; r=/x; ${S_USE_Y}`, "S"],
] as const) {
  test(line, () => assert.ok(bound(line, name)));
}

// ------------------------------------------------------------------ r8 items 2, 2b: integer reads, an expansion in an arithmetic body
for (const [line, name] of [
  [`declare -i x; read x <f; ${S_USE_Y}`, "S"],
  [`declare -i x; for x in $y; do :; done; ${S_USE_Y}`, "S"],
  [`y=$(cat f); (( $y )); ${S_USE_Y}`, "S"],
  [`y=$(cat f); let "$y"; ${HOME_USE}`, "HOME"],
  [`y=$(cat f); let $y; ${S_USE_Y}`, "S"],
  [`y=$(cat f); (( \${y} )); ${S_USE_Y}`, "S"],
  [`read y <f; (( $y )); ${S_USE_Y}`, "S"],
  [`for y in $z; do (( $y )); done; ${HOME_USE}`, "HOME"],
  [`f() { (( $1 )); }; f "$y"; ${S_USE_Y}`, "S"],
  [`read OPTIND <f; ${S_USE_Y}`, "S"],
  [`read y <f; a=([$y]=1); ${S_USE_Y}`, "S"],
] as const) {
  test(line, () => assert.ok(bound(line, name)));
}

// r8 negatives: HOME stays unbound
for (const line of [
  "declare -i n; n=5; cat $HOME/f",
  "echo ${a:2}; cat $HOME/f",
  "echo ${a:2:3}; cat $HOME/f",
  "echo ${a: -1}; cat $HOME/f",
  "echo ${a:-x}; cat $HOME/f",
  "echo ${a:=x}; cat $HOME/f",
  "echo ${a:+x}; cat $HOME/f",
  "echo ${a:?x}; cat $HOME/f",
  "n=5; echo $(( $n + 1 )); cat $HOME/f",
  "echo $(( $n + 1 )); cat $HOME/f",
  "(( 1 + 2 )); cat $HOME/f",
  "echo ${#x}; cat $HOME/f",
  "echo ${!x}; cat $HOME/f",
  "echo ${x:-y}; cat $HOME/f",
  "echo ${#:-0}; cat $HOME/f",
  "echo ${$:2}; cat $HOME/f",
  'declare -i n; n="5"; cat $HOME/f',
  "OPTIND=1; cat $HOME/f",
  "[[ $n -eq 1 ]]; cat $HOME/f",
  "[[ a[0] -eq 1 ]]; cat $HOME/f",
  "declare -i n; : ${n:=5}; cat $HOME/f",
  "a=([0]=1 [1]=2); cat $HOME/f",
  "shift $((OPTIND-1)); cat $HOME/f",
  "echo $RANDOM $SECONDS; cat $HOME/f",
]) {
  test(line, () => assert.ok(!bound(line, "HOME")));
}

// ------------------------------------------------------------------ bash evaluating text as arithmetic (r8 items 2, 2b, revisions 1-3)
// integer attributes, substring offsets, subscripts, `$(( ))`, `[[ -eq ]]`, array keys and the integer specials: a non-literal word there answers "any"
for (const [line, name] of [
  // integer attribute: an assigned value, a default / assign operand
  [`declare -i x; x=$y; ${S_USE_Y}`, "S"],
  [`y=$(cat f); declare -i x; x=$y; ${S_USE_Y}`, "S"],
  [`typeset -i x; x=$y; ${HOME_USE}`, "HOME"],
  [`f() { local -i x; x=$1; }; f "$y"; ${S_USE_Y}`, "S"],
  [`declare -ix x; x=$y; ${S_USE_Y}`, "S"],
  [`declare -ai a; a[0]=$y; ${S_USE_Y}`, "S"],
  [`declare -i x; x+=$y; ${S_USE_Y}`, "S"],
  [`declare -i x=$y; ${S_USE_Y}`, "S"],
  [`declare -i x; x=y; ${S_USE_Y}`, "S"],
  [`declare -i x; x="$y"; ${HOME_USE}`, "HOME"],
  [`declare -i x; x=" $y"; ${S_USE_Y}`, "S"],
  [`declare -i x=" $y"; ${S_USE_Y}`, "S"],
  [`declare -i x; x=1" $y"; ${HOME_USE}`, "HOME"],
  [`declare -i x; x="1 + $y"; ${S_USE_Y}`, "S"],
  [`declare -i x; x=' y'; ${S_USE_Y}`, "S"],
  [`declare -i x; x+=" $y"; ${S_USE_Y}`, "S"],
  [`typeset -i x; x=" \`cat f\`"; ${HOME_USE}`, "HOME"],
  [`typeset -i k; k=$y; ${HOME_USE}`, "HOME"],
  [`declare -i k; k="$y"; ${HOME_USE}`, "HOME"],
  [`declare -i k; k=1" $y"; ${HOME_USE}`, "HOME"],
  [`typeset -i k; k=" \`cat f\`"; ${HOME_USE}`, "HOME"],
  [`declare -i x; : \${x:=$y}; ${S_USE_Y}`, "S"],
  [`declare -i x; : \${x:+$y}; ${S_USE_Y}`, "S"],
  [`declare -i n; : \${n+$y}; ${HOME_USE}`, "HOME"],
  [`declare -i x; : \${x:-$y}; ${S_USE_Y}`, "S"],
  [`declare -i x; : \${x-$y}; ${S_USE_Y}`, "S"],
  [`declare -i x; : \${x:?$y}; ${S_USE_Y}`, "S"],
  [`declare -ai a; : \${a[0]:=$y}; ${S_USE_Y}`, "S"],
  [`typeset -i n; echo "\${n:=$y}"; ${HOME_USE}`, "HOME"],
  // substring offsets and lengths
  [`echo \${a:$off}; ${S_USE_Y}`, "S"],
  [`echo \${a:off}; ${S_USE_Y}`, "S"],
  [`echo \${a:1:$len}; ${HOME_USE}`, "HOME"],
  [`echo \${a:1:len}; ${S_USE_Y}`, "S"],
  [`echo \${a: -x}; ${S_USE_Y}`, "S"],
  [`echo \${a:S=1}; ${S_USE_Y}`, "S"],
  [`echo \${@:$off}; ${S_USE_Y}`, "S"],
  [`echo \${a[0]:$off}; ${S_USE_Y}`, "S"],
  [`echo \${$:$off}; ${S_USE_Y}`, "S"],
  [`echo \${?:$off}; ${S_USE_Y}`, "S"],
  [`echo \${-:$off}; ${S_USE_Y}`, "S"],
  [`echo \${#:$off}; ${HOME_USE}`, "HOME"],
  [`echo \${!:$off}; ${S_USE_Y}`, "S"],
  [`echo \${$:1:$len}; ${S_USE_Y}`, "S"],
  // bash's integer specials
  [`OPTIND=$y; ${S_USE_Y}`, "S"],
  [`OPTERR=$y; ${S_USE_Y}`, "S"],
  [`SECONDS=$y; ${HOME_USE}`, "HOME"],
  [`RANDOM=$y; ${S_USE_Y}`, "S"],
  [`LINENO=$y; ${S_USE_Y}`, "S"],
  [`HISTCMD=$y; ${S_USE_Y}`, "S"],
  [`OPTIND="$y"; ${S_USE_Y}`, "S"],
  [`OPTIND+=$y; ${S_USE_Y}`, "S"],
  [`export OPTIND=$y; ${S_USE_Y}`, "S"],
  [`: \${OPTIND:=$y}; ${S_USE_Y}`, "S"],
  // an expansion of a name assigned a non-literal value, in `$(( ))`, `$[ ]`, a subscript, `[[ -eq ]]` or an array key
  [`y=$(cat f); echo $(( $y )); ${S_USE_Y}`, "S"],
  [`y=$(cat f); echo $(( 1 + $y )); ${S_USE_Y}`, "S"],
  [`y=$(cat f); [[ $y -eq 1 ]]; ${S_USE_Y}`, "S"],
  [`y=$(cat f); echo \${a[$y]}; ${S_USE_Y}`, "S"],
  [`y=$(cat f); echo $[ $y ]; ${S_USE_Y}`, "S"],
  [`y=$(cat f); a=([$y]=1); ${S_USE_Y}`, "S"],
  [`y=$(cat f); declare -a a=([$y]=1); ${S_USE_Y}`, "S"],
  [`y=$(cat f); a+=([$y]=1); ${HOME_USE}`, "HOME"],
  [`y=$(cat f); a=(x [$y]=1); ${S_USE_Y}`, "S"],
  [`y=$(cat f); [[ a[0] -eq $y ]]; ${S_USE_Y}`, "S"],
  [`y=$(cat f); [[ a[0] -ne $y ]]; ${S_USE_Y}`, "S"],
  [`y=$(cat f); [[ a[0] -lt $y ]]; ${HOME_USE}`, "HOME"],
  [`y=$(cat f); [[ a[0] -le $y ]]; ${S_USE_Y}`, "S"],
  [`y=$(cat f); [[ a[0] -gt $y ]]; ${S_USE_Y}`, "S"],
  [`y=$(cat f); [[ a[0] -ge $y ]]; ${S_USE_Y}`, "S"],
  [`y=$(cat f); [[ $y -lt a[0] ]]; ${S_USE_Y}`, "S"],
  [`y=$(cat f); [[ a[0] -eq y ]]; ${S_USE_Y}`, "S"],
  [`y=$(cat f); [[ \${a[0]} -eq $y ]]; ${S_USE_Y}`, "S"],
  [`y=$(cat f); [[ a[b[0]] -eq $y ]]; ${S_USE_Y}`, "S"],
] as const) {
  test(`${line} [arith]`, () => {
    assert.ok(bound(line, name));
    assert.ok(boundNames(line).any, "answers any");
  });
}

// ------------------------------------------------------------------ round 2, revision: cases the first cut answered "not bound"
const deep = (n: number, inner: string): string => (n === 0 ? inner : `bash -c '${deep(n - 1, inner).replace(/'/g, `'\\''`)}'`);
for (const line of [
  `sleep 1 & wait -p HOME; ${HOME_USE}`,
  `wait -n -p HOME; ${HOME_USE}`,
  `select HOME in /x; do break; done; ${HOME_USE}`,
  `coproc HOME { :; }; ${HOME_USE}`,
  `a[HOME=1]=1; ${HOME_USE}`,
  `echo $(( a[HOME=1] )); ${HOME_USE}`,
  `: $((x=y)); ${HOME_USE}`,
  `echo $((x=y)); ${HOME_USE}`,
  `bash -c -e 'HOME=/x; ${HOME_USE}'`,
  `env -u PATH HOME=/x bash -c '${HOME_USE}'`,
  `env -u PATH HOME=/x ${HOME_USE}`,
  `env -S 'HOME=/x cat f'; ${HOME_USE}`,
  deep(5, `HOME=/x; ${HOME_USE}`),
  deep(6, `HOME=/x; ${HOME_USE}`),
]) {
  test(`${line} [revision]`, () => {
    assert.ok(bound(line, "HOME"));
  });
}

test("env -u X NAME=v binds NAME", () => {
  assert.ok(boundNames("env -u X HOME=/x cat f").names.has("HOME"));
});

test("a nested script deeper than MAX_DEPTH answers any", () => {
  assert.equal(boundNames(deep(6, "true")).any, true);
});

// ------------------------------------------------------------------ round 2, revision 2: a variable name given as a word, a subscript that assigns
for (const line of [
  `test -v 'a[HOME=1]'; ${HOME_USE}`,
  `[ -v 'a[HOME=1]' ]; ${HOME_USE}`,
  `[[ -v a[HOME=1] ]]; ${HOME_USE}`,
  `compgen -V HOME; ${HOME_USE}`,
  `compgen -V HOME -W x; ${HOME_USE}`,
  `declare 'a[HOME=1]=x'; ${HOME_USE}`,
  `typeset 'a[HOME=1]=x'; ${HOME_USE}`,
  `declare "a[HOME=1]"=x; ${HOME_USE}`,
]) {
  test(`${line} [revision 2]`, () => {
    assert.ok(bound(line, "HOME"));
  });
}

// ------------------------------------------------------------------ round 2, revision 3: an expansion in a subscript, a name the line assigns that feeds a subscript or a name argument
for (const line of [
  `test -v 'a[$(cat f)]'; ${HOME_USE}`,
  "test -v 'a[`cat f`]'; " + HOME_USE,
  `test -v 'a[$(<f)]'; ${HOME_USE}`,
  "test -v 'a[`printf HOME\\x3d1`]'; " + HOME_USE,
  `test -v 'a[$1]'; ${HOME_USE}`,
  `[ -v 'a[$(cat f)]' ]; ${HOME_USE}`,
  "declare 'a[`cat f`]=1'; " + HOME_USE,
  `x='HOME=1'; test -v 'a[x]'; ${HOME_USE}`,
  `x='HOME=1'; declare 'a[x]=1'; ${HOME_USE}`,
  `x=HOME=1 test -v 'a[x]'; ${HOME_USE}`,
  `echo \${x:=HOME=1}; test -v 'a[x]'; ${HOME_USE}`,
  `x=HOME; wait -p $x; ${HOME_USE}`,
  `declare x=HOME; wait -p "$x"; ${HOME_USE}`,
  `x='a[HOME=1]'; test -v "$x"; ${HOME_USE}`,
  `x='a[HOME=1]'; [[ -v $x ]]; ${HOME_USE}`,
  `x=HOME; wait -p "\${x}"; ${HOME_USE}`,
  `wait -p $1; ${HOME_USE}`,
  `wait -p $(echo HOME); ${HOME_USE}`,
  "wait -p `echo HOME`; " + HOME_USE,
  `wait -p \${a:=HOME}; ${HOME_USE}`,
]) {
  test(`${line} [revision 3]`, () => {
    assert.ok(bound(line, "HOME"));
  });
}
