// Round 2, step 1, revision 4: an argument word that expands to an unknown name (an unset name joined to a literal, a brace expansion, `${!y}`), an option
// with its name attached (`wait -pHOME`), and an expansion inside single quotes (no expansion at all). The first table is also run against the overlay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundNames } from "../shellast.ts";
import { boundNames as overlayBoundNames } from "../permoverlay.ts";

const U = "cat $HOME/.ssh/k.pub";
const bound = (line: string, name = "HOME"): boolean => {
  const b = boundNames(line);
  return b.any || b.names.has(name);
};

const G = [
  `wait -p $NOPE'HOME'; ${U}`,
  `wait -p "$NOPE"HOME; ${U}`,
  `wait -p {HOME,}; ${U}`,
  `wait -p{HOME,}; ${U}`,
  `compgen -V {HOME,} -W x; ${U}`,
  `x=HOME; y=x; wait -p \${!y}; ${U}`,
];
for (const line of G) {
  test(`${line} [revision 4]`, () => {
    assert.ok(bound(line));
  });
  test(`${line} [revision 4, overlay agrees]`, () => {
    assert.ok(overlayBoundNames(line).has("HOME"));
    assert.ok(bound(line));
  });
}

for (const line of [`wait -p \${x:-HOME}; ${U}`, `wait -p {a..b}; ${U}`, `wait -p $x'HOME'; ${U}`, `echo {a,b}; ${U}`]) {
  test(`${line} [revision 4, more shapes]`, () => {
    assert.ok(bound(line));
  });
}

for (const line of [`wait -pHOME; ${U}`, `wait -npHOME; ${U}`, `wait -fpHOME; ${U}`, `compgen -VHOME -W x; ${U}`, `compgen -W x -VHOME; ${U}`]) {
  test(`${line} [attached option name]`, () => {
    assert.ok(bound(line));
  });
}

for (const line of [
  `echo 'cost $5'; ${U}`,
  `echo '$(date)'; ${U}`,
  "echo 'a `b`'; " + U,
  `echo '{a,b}'; ${U}`,
  `echo "{a,b}"; ${U}`,
  `echo \\$x; ${U}`,
  `echo "$HOME"/f; ${U}`,
  `wait -pfoo; ${U}`,
  `ls -la; ${U}`,
]) {
  test(`${line} [no expansion, binds nothing]`, () => {
    assert.equal(bound(line), false);
  });
}
