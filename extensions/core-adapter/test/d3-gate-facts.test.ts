// PR D3: the parser reads $FOREMAN_OUT as a harness constant (also where the text pass gives up), and the danger-inline-code reason says whether the code is in the command.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-d3-facts-"));
const wt = path.join(base, "wt");
const scratch = path.join(base, "scratch");
const out = path.join(base, "out");
const elsewhere = path.join(base, "elsewhere");
for (const d of [wt, scratch, out, elsewhere]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (): GateRoots => ({ worktree: wt, scratch: [scratch, out], out, tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false });
const eval1 = (command: string) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true, scratch: [scratch, out], out }), roots });
const blocked = (command: string): boolean => !!(eval1(command).result as { block?: boolean } | undefined)?.block;
const labels = (command: string): string[] => ((eval1(command) as { dangers?: string[] }).dangers ?? []);

test("$FOREMAN_OUT resolves in the parser like $FOREMAN_SCRATCH: an apostrophe elsewhere on the line, a quoted path, a comment", { skip: posixOnly }, () => {
  for (const c of [`echo "it's" && echo x > $FOREMAN_OUT/f`, `echo x > "$FOREMAN_OUT/f" # it's`, `echo x > "\${FOREMAN_OUT}/f" && echo 'y'`, `cp a $FOREMAN_OUT/b && echo 'z'`]) {
    assert.equal(blocked(c), false, c);
    assert.ok(!labels(c).includes("danger-write-outside"), c);
  }
});

test("$FOREMAN_OUT stays literal in single quotes; a target outside out and scratch is still refused", { skip: posixOnly }, () => {
  assert.ok(labels(`echo x > '$FOREMAN_OUT/f'`).includes("danger-write-outside"));
  assert.equal(blocked(`cd ${elsewhere} && echo x > $FOREMAN_OUT/../f && echo 'a'`), true);
  assert.equal(blocked(`cp a ${elsewhere}/b && echo 'a'`), true);
  const rebound = `env FOREMAN_OUT=/etc sh -c 'echo x > $FOREMAN_OUT/f'`;
  assert.ok(labels(rebound).length > 0 || blocked(rebound), rebound);
});

test("a function body writing $FOREMAN_OUT/x resolves; cd $FOREMAN_SCRATCH && cp stays inside", { skip: posixOnly }, () => {
  assert.equal(blocked(`f() { echo x > $FOREMAN_OUT/y; }; echo 'a'`), false);
  assert.equal(blocked(`cd $FOREMAN_SCRATCH && cp a b`), false);
  assert.ok(!labels(`cd $FOREMAN_SCRATCH && cp a b`).includes("danger-write-outside"));
});

test("parseShell: the FOREMAN_OUT binding is read only without a rebinding mention", { skip: posixOnly }, () => {
  const env = { FOREMAN_SCRATCH: scratch, FOREMAN_OUT: out };
  const seg = (c: string) => parseShell(c, { cwd: wt, env }).find((s) => s.redirects.length)!;
  assert.equal(seg(`echo x > $FOREMAN_OUT/f`).redirects[0].target, `${out}/f`);
  assert.equal(seg(`echo x > '$FOREMAN_OUT/f'`).redirects[0].target, `$FOREMAN_OUT/f`);
  assert.notEqual(seg(`FOREMAN_OUT=/etc; echo x > $FOREMAN_OUT/f`).redirects[0].target, `${out}/f`);
});

test("$O/venv/bin/pip install gets no delete label; rm -rf of an unreadable variable target stays judge-first", { skip: posixOnly }, () => {
  assert.deepEqual(labels(`O=$FOREMAN_OUT; $O/venv/bin/pip install -q -r req`), []);
  assert.deepEqual(labels(`O=$FOREMAN_OUT; $O/venv/bin/pip install -q -r req && $O/venv/bin/ruff check .`), []);
  assert.ok(labels(`rm -rf $S/x`).includes("danger-delete-unknown-target"));
});

test("danger-inline-code: the code is in the command for -c, -e and a heredoc; not for a file, a pipe, a variable script or a foreign shell", { skip: posixOnly }, () => {
  const reason = (c: string): string | undefined => (eval1(c) as { danger?: { name: string; reason: string } }).danger?.reason;
  for (const c of ["python3 - <<EOF\nprint(1)\nEOF", "python3 -c 'print(1)'", "node -e 1", "python3 - <<< 'print(1)'"]) assert.match(reason(c) ?? "", /the code is in the command/, c);
  for (const c of ["bash < f", "cat s.py | python3", "python3 - < f", "script -c x", "zsh -c x", "python3 -c x; bash < f", 'eval "$(echo x)"', 'bash -c "$X"']) {
    assert.equal(reason(c), "runs code the harness cannot read", c);
  }
});
