// A fixed table of posix lines: shellast.ts's `boundNames` once had to answer "HOME bound" wherever the old overlay's `boundNames` did. The overlay is gone;
// what stays is the table size and the literal answers of `boundNames` for the lines the overlay was compared on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundNames } from "../shellast.ts";

const U = "cat $HOME/.ssh/k.pub";
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const deep = (n: number, inner: string): string => (n === 0 ? inner : `bash -c ${q(deep(n - 1, inner))}`);

const LINES: string[] = [
  // wait / select / coproc
  `sleep 1 & wait -p HOME; ${U}`,
  `wait -p HOME -n; ${U}`,
  `wait -fp HOME; ${U}`,
  `command wait -p HOME; ${U}`,
  `select HOME in /x; do break; done; ${U}`,
  `select x in HOME; do break; done; ${U}`,
  `coproc HOME { :; }; ${U}`,
  `coproc cat; ${U}`,
  // arithmetic
  `a[HOME=1]=1; ${U}`,
  `echo $(( a[HOME=1] )); ${U}`,
  `: $((x=y)); ${U}`,
  `echo $((x=y)); ${U}`,
  `echo $((HOME=3)); ${U}`,
  `(( HOME=3 )); ${U}`,
  `(( HOME++ )); ${U}`,
  `(( --HOME )); ${U}`,
  `echo $(( 1 + 2 )); ${U}`,
  `echo $(( x )); ${U}`,
  `y='HOME=1'; echo $(( y )); ${U}`,
  `y='HOME=1'; (( $y )); ${U}`,
  `declare -i n; n=HOME=1; ${U}`,
  `declare -i n=HOME=1; ${U}`,
  `let HOME=1; ${U}`,
  `let "HOME=1"; ${U}`,
  `echo \${a[HOME=1]}; ${U}`,
  `echo \${a[HOME++]}; ${U}`,
  `x=(1 2); echo \${x[HOME=1]}; ${U}`,
  `a=(); a[HOME=1]=1; ${U}`,
  `[[ HOME=1 -eq 1 ]]; ${U}`,
  `echo \${x:HOME=1}; ${U}`,
  `echo \${x:0:HOME=1}; ${U}`,
  `i=1; echo $((i+1)); ${U}`,
  // plain assignments and builtins
  `HOME=/x; ${U}`,
  `HOME=/x ${U}`,
  `HOME+=/x; ${U}`,
  `HOME[0]=/x; ${U}`,
  `export HOME=/x; ${U}`,
  `export HOME; ${U}`,
  `declare HOME=/x; ${U}`,
  `local HOME=/x; ${U}`,
  `readonly HOME=/x; ${U}`,
  `unset HOME; ${U}`,
  `read HOME; ${U}`,
  `read -r HOME <f; ${U}`,
  `mapfile -t HOME <f; ${U}`,
  `getopts o HOME; ${U}`,
  `printf -v HOME %s /x; ${U}`,
  `: \${HOME=/x}; ${U}`,
  `: \${HOME:=/x}; ${U}`,
  `for HOME in /x; do ${U}; done; ${U}`,
  `for ((HOME=1;;)); do break; done; ${U}`,
  // namerefs
  `declare -n r=HOME; r=/x; ${U}`,
  `typeset -n r=HOME; r=/x; ${U}`,
  `declare -n r; r=HOME; r=/x; ${U}`,
  `local -n r=HOME; r=/x; ${U}`,
  // env forms
  `env HOME=/x ${U}`,
  `env -u PATH HOME=/x ${U}`,
  `env -u X -u Y HOME=/x ${U}`,
  `env -i HOME=/x ${U}`,
  `env -- HOME=/x ${U}`,
  `env -C /tmp HOME=/x ${U}`,
  `env -u PATH HOME=/x bash -c ${q(U)}`,
  `env HOME=/x bash -c ${q(U)}`,
  `env -S 'HOME=/x cat f'; ${U}`,
  // nested -c
  `bash -c ${q(`HOME=/x; ${U}`)}`,
  `bash -c -e ${q(`HOME=/x; ${U}`)}`,
  `bash -e -c ${q(`HOME=/x; ${U}`)}`,
  `bash -ec ${q(`HOME=/x; ${U}`)}`,
  `sh -c ${q(`HOME=/x; ${U}`)}`,
  `flock f -c ${q(`HOME=/x; ${U}`)}`,
  `bash -c ${q(`read HOME; ${U}`)}`,
  ...[1, 2, 3, 4, 5, 6].map((n) => deep(n, `HOME=/x; ${U}`)),
  ...[1, 3, 5, 6].map((n) => deep(n, `read HOME; ${U}`)),
  // eval / source behind wrappers
  `eval x; ${U}`,
  `eval "$c"; ${U}`,
  `command eval x; ${U}`,
  `builtin eval x; ${U}`,
  `time eval x; ${U}`,
  `source ./f; ${U}`,
  `. ./f; ${U}`,
  `command . ./f; ${U}`,
  `true && . ./f; ${U}`,
  `{ source ./f; }; ${U}`,
  `( . ./f ); ${U}`,
  `if true; then source ./f; fi; ${U}`,
  `bash -c ${q(`source ./f; ${U}`)}`,
  `x=$(. ./f); ${U}`,
  // here-documents
  `cat <<EOF\nHOME=/x\nEOF\n${U}`,
  `HOME=/x cat <<EOF\nx\nEOF\n${U}`,
  `bash <<EOF\nHOME=/x\nEOF\n${U}`,
  `cat <<EOF\n$((HOME=3))\nEOF\n${U}`,
  `cat <<EOF\n\${HOME:=/x}\nEOF\n${U}`,
  // functions
  `f() { HOME=/x; }; f; ${U}`,
  `f() { read HOME; }; f; ${U}`,
  `function f { HOME=/x; }; f; ${U}`,
  `f() { local HOME=/x; ${U}; }; f`,
  // exec {fd}, trap, misc
  `exec {HOME}>f; ${U}`,
  `exec {fd}>f; ${U}`,
  `trap 'HOME=/x' EXIT; ${U}`,
  `trap "$c" DEBUG; ${U}`,
  `BASH_ENV=./f bash -c ${q(U)}`,
  `$x ./f; ${U}`,
  `HO""ME=/x; ${U}`,
  `{HOME,X}=/x; ${U}`,
  `echo \${!n:=3}; ${U}`,
  `echo \${x@P}; ${U}`,
  `echo ok; ${U}`,
  `ls | grep x; ${U}`,
  `echo "unterminated; ${U}`,
  `if then fi ( ; ${U}`,
];

// Kept disagreements: the overlay reads a here-document body as code; it is data for `cat` and a child shell's script for `bash`, neither binds in this shell.
const KEPT = new Set([`cat <<EOF\nHOME=/x\nEOF\n${U}`, `bash <<EOF\nHOME=/x\nEOF\n${U}`]);

test("the differential table holds at least 80 lines", () => {
  assert.ok(LINES.length >= 80, String(LINES.length));
});

for (const line of KEPT) {
  test(`a here-document body binds nothing in this shell (the lines the overlay read as code): ${JSON.stringify(line)}`, () => {
    const b = boundNames(line);
    assert.equal(b.any || b.names.has("HOME"), false);
  });
}

const LINES2: string[] = [
  `test -v 'a[HOME=1]'; ${U}`,
  `[ -v 'a[HOME=1]' ]; ${U}`,
  `[[ -v a[HOME=1] ]]; ${U}`,
  `compgen -V HOME -W x; ${U}`,
  `declare 'a[HOME=1]=x'; ${U}`,
  `typeset 'a[HOME=1]=x'; ${U}`,
  `declare "a[HOME=1]"=x; ${U}`,
];

// The literal answer of `boundNames` for each line of LINES and LINES2, by index: "+" = `any` (every name may be bound), "-" = not, then the sorted bound names.
// Wherever the old overlay said HOME is bound (all but the two KEPT lines), HOME is bound here too: `any` is set or HOME is in the list.
const ANSWERS: string[] = [
  "-HOME,p", "-HOME,n,p", "-HOME,fp,p", "-HOME,p", "+", "+", "+", "+", "+a", "+",
  "+x", "+x", "+HOME", "+HOME", "+", "+", "-", "-", "+y", "+y",
  "+i,n", "+i,n", "+", "+", "+", "+", "+x", "+a", "+", "+",
  "+", "-i", "+HOME", "+HOME", "+HOME", "+HOME", "+HOME", "+HOME", "+HOME", "+HOME",
  "+HOME", "+HOME", "+HOME", "+HOME,r", "+HOME,t", "+HOME,o", "+HOME,v", "+HOME", "+HOME", "+",
  "+HOME", "+n,r", "+n,r", "+n,r", "+n,r", "+HOME,cat", "+HOME,PATH,cat,u", "+HOME,X,Y,cat,u", "+HOME,cat,i", "+HOME,cat",
  "+C,HOME,cat", "+HOME,PATH,bash,c,u", "+HOME,bash,c", "+HOME,S", "+HOME,c", "+HOME,c,e", "+HOME,c,e", "+HOME,c,ec", "+HOME,c", "+HOME,c,f",
  "+HOME,c", "+HOME,c", "+HOME,c", "+HOME,c", "+HOME,c", "+c", "+c", "+HOME,c", "+HOME,c", "+c",
  "+c", "+x", "+", "+x", "+x", "+x", "+", "+", "+", "+",
  "+", "+", "+", "+c", "+x", "-", "+HOME", "-", "+HOME", "+HOME",
  "+HOME", "+HOME", "+HOME", "+HOME", "+HOME", "-fd", "+EXIT", "+DEBUG", "+BASH_ENV,c", "+",
  "+HOME", "+", "+", "+", "-ok", "-x", "+", "+",
  // LINES2
  "+v", "+v", "+", "-HOME,V,W,x", "+", "+", "+",
];

const encode = (line: string): string => {
  const b = boundNames(line);
  return (b.any ? "+" : "-") + [...b.names].sort().join(",");
};

test("the answer table covers every line of LINES and LINES2", () => {
  assert.equal(ANSWERS.length, LINES.length + LINES2.length);
});

[...LINES, ...LINES2].forEach((line, i) => {
  test(`boundNames gives the literal answer ${JSON.stringify(ANSWERS[i])} for ${JSON.stringify(line)}`, () => {
    assert.equal(encode(line), ANSWERS[i]);
  });
});

// Revision 3: for these lines HOME is bound.
const LINES3: string[] = [
  `test -v 'a[$(cat f)]'; ${U}`,
  "test -v 'a[`cat f`]'; " + U,
  `test -v 'a[$(<f)]'; ${U}`,
  "test -v 'a[`printf HOME\\x3d1`]'; " + U,
  `test -v 'a[$1]'; ${U}`,
  `x='HOME=1'; test -v 'a[x]'; ${U}`,
  `x='HOME=1'; declare 'a[x]=1'; ${U}`,
  `x=HOME=1 test -v 'a[x]'; ${U}`,
  `echo \${x:=HOME=1}; test -v 'a[x]'; ${U}`,
  `x=HOME; wait -p $x; ${U}`,
  `declare x=HOME; wait -p "$x"; ${U}`,
  `x='a[HOME=1]'; test -v "$x"; ${U}`,
  `x='a[HOME=1]'; [[ -v $x ]]; ${U}`,
];

for (const line of LINES3) {
  test(`boundNames says HOME is bound (revision 3): ${JSON.stringify(line)}`, () => {
    const b = boundNames(line);
    assert.ok(b.any || b.names.has("HOME"), "the new function says HOME is not bound");
  });
}
