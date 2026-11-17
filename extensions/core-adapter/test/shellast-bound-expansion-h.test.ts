// Round 2, step 1, revision 5 (defect H): a quoted default inside `${..}`, an attached option argument that holds an expansion, `$!` and a `${..//..}` replacement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundNames } from "../shellast.ts";

const U = "cat $HOME/.ssh/k.pub";
const bound = (line: string): boolean => {
  const b = boundNames(line);
  return b.any || b.names.has("HOME");
};

for (const line of [
  `wait -p \${x-'HOME'}; ${U}`,
  `wait -p \${x-"HOME"}; ${U}`,
  `wait -p \${x:-'HOME'}; ${U}`,
  `wait -p \${x-HO'ME'}; ${U}`,
  `wait -p \${x-HO\\ME}; ${U}`,
  `command wait -p \${x-'HOME'}; ${U}`,
  `time wait -p \${x-'HOME'} || true; ${U}`,
  `compgen -V \${x-'HOME'} -W x; ${U}`,
  `wait -p$NOPE'HOME'; ${U}`,
  `wait -p"$NOPE"HOME; ${U}`,
  `wait -p$NOPE\\HOME; ${U}`,
  `wait -p\${NOPE}"HOME"; ${U}`,
  `wait -p"\${NOPE}"'HOME'; ${U}`,
  `wait -p"$x""HOME"; ${U}`,
  `wait -p\${x-'HOME'}; ${U}`,
  `wait -np$NOPE'HOME'; ${U}`,
  `wait -fp$NOPE'HOME'; ${U}`,
  `compgen -V$NOPE'HOME' -W x; ${U}`,
  `compgen -W x -V"$NOPE"HOME; ${U}`,
  `x=HOME; wait -p \${PATH/*/HOME}; ${U}`,
  `x=HOME; wait -p $!HOME; ${U}`,
]) {
  test(`${line} [defect H]`, () => {
    assert.ok(bound(line));
  });
}
