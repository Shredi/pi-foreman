// NOTE: this file imports the overlay (permoverlay.ts) and is deleted together with it in round 2, step 6.
// A fixed table of posix lines: shellast.ts's `boundNames` must never answer "HOME not bound" where the overlay's `boundNames` says HOME is bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundNames } from "../shellast.ts";
import { boundNames as overlayBoundNames } from "../permoverlay.ts";

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

for (const line of LINES) {
  test(`new boundNames is never looser for HOME than the overlay's: ${JSON.stringify(line)}`, () => {
    const old = overlayBoundNames(line).has("HOME");
    const b = boundNames(line);
    if (KEPT.has(line)) {
      assert.ok(old);
      assert.equal(b.any || b.names.has("HOME"), false);
    } else if (old) assert.ok(b.any || b.names.has("HOME"), "the overlay says HOME is bound, the new function says it is not");
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

for (const line of LINES2) {
  test(`new boundNames is never looser for HOME than the overlay's (revision 2): ${JSON.stringify(line)}`, () => {
    const old = overlayBoundNames(line).has("HOME");
    const b = boundNames(line);
    if (old) assert.ok(b.any || b.names.has("HOME"), "the overlay says HOME is bound, the new function says it is not");
  });
}

// Revision 3: for these lines the overlay must say bound too, so the table cannot pass by the overlay saying nothing.
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
  test(`the overlay and the new boundNames both say HOME is bound (revision 3): ${JSON.stringify(line)}`, () => {
    assert.ok(overlayBoundNames(line).has("HOME"), "the overlay says HOME is not bound");
    const b = boundNames(line);
    assert.ok(b.any || b.names.has("HOME"), "the new function says HOME is not bound");
  });
}
