// D3b item 15: (a) the danger-inline-code reason says "the code is in the command" only when the -c/-e word, the here-string word or the heredoc body is literal;
// (b) $FOREMAN_OUT / $FOREMAN_SCRATCH inside a nested -c string under an env-clearing wrapper do not resolve to the harness path (the inner shell sees them empty).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-d3b-ci-"));
const wt = path.join(base, "wt");
const scratch = path.join(base, "scratch");
const out = path.join(base, "out");
for (const d of [wt, scratch, out]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (role: string) => (): GateRoots => ({ worktree: wt, scratch: [scratch, out], out, tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role, tmpAccess: false });
const gate = (command: string, role = "builder") => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true, scratch: [scratch, out], out }), roots: roots(role) });
const reason = (c: string): string | undefined => (gate(c) as { danger?: { name: string; reason: string } }).danger?.reason;
const IN_COMMAND = /the code is in the command/;
const UNREADABLE = "runs code the harness cannot read";

test("(a) a literal -c word, here-string word or heredoc body: the code is in the command", { skip: posixOnly }, () => {
  for (const c of ["python3 -c 'print(1)'", "node -e 1", "python3 - <<< 'print(1)'", "python3 - <<'EOF'\nprint($(cat f))\nEOF", "python3 - <<EOF\nprint(1)\nEOF", "python3 - <<EOF\nprint(\\$X)\nEOF", "python3 -c 'print(1)' \"$A\""]) {
    assert.match(reason(c) ?? "", IN_COMMAND, c);
  }
});

test("(a) an expansion in the -c/-e word, the here-string word or an unquoted heredoc body keeps `runs code the harness cannot read`", { skip: posixOnly }, () => {
  for (const c of ['node -e "$CODE"', 'python3 -c "$(cat f)"', 'python3 - <<<"$(cat f)"', "python3 - <<EOF\n$(cat f)\nEOF", "python3 - <<EOF\nprint($X)\nEOF", 'python3 -c "print($((1+2)))"', 'node --eval="$CODE"']) {
    assert.equal(reason(c), UNREADABLE, c);
  }
});

const wrapped = (n: string): string[] => [
  `env -i sh -c 'rm -rf $${n}/x'`,
  `env - sh -c 'rm -rf $${n}/x'`,
  `env -i -- bash -c 'rm -rf $${n}/x'`,
  `exec -c bash -c 'rm -rf $${n}/x'`,
  `env -u ${n} sh -c 'rm -rf $${n}/x'`,
  `env --ignore-environment sh -c 'rm -rf \${${n}}/x'`,
];

test("(b) under an env-clearing wrapper the nested string gets no fixed-path binding: judge-first for a builder, no allow verdict for a reviewer", { skip: posixOnly }, () => {
  for (const n of ["FOREMAN_OUT", "FOREMAN_SCRATCH"]) {
    for (const c of wrapped(n)) {
      for (const role of ["builder", "reviewer"]) {
        const o = gate(c, role);
        assert.notEqual((o.result as { allow?: boolean } | undefined)?.allow, true, `${role}: ${c}`);
        assert.notEqual(o.danger, null, `${role}: ${c}`);
      }
    }
  }
});

test("(b) controls: no clearing wrapper, or one that keeps the name, still resolves to the harness folder", { skip: posixOnly }, () => {
  for (const n of ["FOREMAN_OUT", "FOREMAN_SCRATCH"]) {
    for (const c of [`sh -c 'echo > $${n}/f'`, `env FOO=1 sh -c 'echo > $${n}/f'`, `env -u OTHER sh -c 'echo > $${n}/f'`, `env -i cp a $${n}/b`, `rm -rf $${n}/x`]) {
      const o = gate(c);
      assert.equal(o.danger, null, c);
    }
  }
  assert.equal(gate(`env -u FOREMAN_SCRATCH sh -c 'echo > $FOREMAN_OUT/f'`).danger, null);
});
