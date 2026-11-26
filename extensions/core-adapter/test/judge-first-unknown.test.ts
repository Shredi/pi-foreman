// Judge-first-unknown round: a segment whose program the shell parse cannot state goes to the judge first (danger-unknown-program), for every role (a read-only reviewer
// too), and `$FOREMAN_SCRATCH` / `$FOREMAN_OUT` are the harness folder only up to the first run unit that may rebind them. Gate level for main, builder and reviewer; the five
// examples of the brief also through the real tool_call handler.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { boundNames, boundNamesDetail, carryFacts, harnessRebound, parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";
import { r11Rig } from "./_r11rig.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

process.env.PI_OFFLINE = "1";

type T = Parameters<typeof r11Rig>[0];
const base = fs.realpathSync(mkTestTmp("pf-jfu-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "tmp", "pi-foreman-out", "mine");
const handoff = path.join(base, "handoffs", "h1");
for (const d of [path.join(wt, "sub"), scr, out, handoff]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

type Role = "main" | "builder" | "reviewer";
const ROLES: Role[] = ["main", "builder", "reviewer"];
const roots = (role: Role): GateRoots => ({
  worktree: wt, scratch: [scr, out], out, tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], childHandoff: handoff,
  child: role !== "main", role: role === "main" ? "foreman" : role, tmpAccess: false, ...(role === "reviewer" ? { roundReadOnly: true } : {}),
});
type Res = { allow?: boolean; block?: boolean; ask?: boolean; rule?: string } | undefined;
const gate = (command: string, role: Role): { result: Res; danger: string | null } => {
  const o = gateEvaluate("bash", { command }, wt, { env: (c) => baseFloorEnv(c, role === "main" ? {} : { child: true, scratch: [scr, out], out }), roots: () => roots(role) });
  return { result: o.result as Res, danger: o.danger?.name ?? null };
};

// every line is judge-first as danger-unknown-program, whatever the role
const UNKNOWN = [
  "E=sh; $E -c 'echo hi'",
  "env --ign ls",
  "env -S 'ls -l'",
  "builtin exec -c ls",
  "$(echo ls) -la",
  '"$P" -n foo src/a.ts',
  "${E}h -c x",
  "{ls,-l}",
  "command --x ls",
  "timeout $T ls",
  "find . -exec $C {} +",
  "echo $((a+1))",
  'echo "wall $(( $(date +%s) - start ))s"; ls',
  "let x=y+1",
  "(( x + $(id) ))",
  "read x < g; : $(( x ))",
  "declare -i i; read i",
  "x='a[$(id)]'; unset \"$x\"",
  "for x in a; do : $(( x )); done",
  "echo $(( $_ + 1 ))",
  "f() { E=sh; $E -c 'echo hi'; }; f",
];
for (const role of ROLES) {
  test(`${role}: a segment whose program is not stated is judge-first (danger-unknown-program)`, { skip: posixOnly }, () => {
    for (const l of UNKNOWN) {
      const g = gate(l, role);
      // a reviewer's find with an action in its worktree is refused before the judge (child-readonly-write)
      if (role === "reviewer" && g.result?.rule === "child-readonly-write" && l.startsWith("find ")) continue;
      assert.equal(g.danger, "danger-unknown-program", `${l}: ${JSON.stringify(g)}`);
      assert.ok(!g.result?.allow, `${l}: not an allow`);
    }
  });
}

// a rebind-free earlier label wins: the delete judge keeps its name
test("an earlier judge-first label wins over danger-unknown-program", { skip: posixOnly }, () => {
  for (const role of ROLES) assert.equal(gate("E=env; $E -i rm -rf ~/Documents", role).danger, "danger-delete-unknown-target", role);
});

// these keep running: no danger-unknown-program, and no refusal for any role
// guard gaps (item 9): the foreman's `cd $FOREMAN_SCRATCH && ... node t.mjs` is judge-first now (its `$FOREMAN_SCRATCH` names no folder), and a child's function body that writes
// relative to that folder is walked at the call and refused like the same write outside a function; both are pinned in guard-gaps.test.ts
const KEEP = [
  "echo x > $FOREMAN_SCRATCH/f",
  'cp a "${FOREMAN_OUT}/f"',
  "cd $FOREMAN_SCRATCH && cp a b",
  "echo $FOREMAN_SCRATCH",
  "env FOO=1 node x.js",
  "env -u PATH ls",
  "timeout 900 node --test x",
  "command -v git",
  "exec node x.js",
  "nice -n 5 npm test",
  "xargs -n1 echo < f",
  "bash --version | head -1",
  "sh f.sh --dry-run",
  "bash $FOREMAN_SCRATCH/x.sh",
  'sh "$FOREMAN_SCRATCH/run.sh"',
  "$V/bin/pip list",
  "~/bin/tool x",
  "for f in a b; do grep x $f; done > $FOREMAN_SCRATCH/out",
  "git diff --name-only | while read f; do echo $f; done > $FOREMAN_SCRATCH/list",
  "export TMPDIR=$FOREMAN_SCRATCH; npm test",
  'echo "FOREMAN_SCRATCH=$FOREMAN_SCRATCH" > $FOREMAN_SCRATCH/e',
  "echo x > $FOREMAN_SCRATCH/a; eval true",
  "S=$FOREMAN_SCRATCH; echo x > $S/f",
  "S=$FOREMAN_SCRATCH; echo $S; echo x > $S/f",
  "for ((i=0;i<2;i++)); do echo $i > $FOREMAN_SCRATCH/f; done",
  "n=0; n=$((n+1)); echo $n > $FOREMAN_SCRATCH/c",
  "while read f; do cat $f; done < l > $FOREMAN_SCRATCH/out",
  "n=0; let n=n+1",
  "echo $(( $? + 1 ))",
  "echo $((RANDOM%10))",
  "[[ $? -eq 0 ]] && echo ok",
  "make; [[ $? -eq 0 ]] && echo ok > $FOREMAN_SCRATCH/s",
  "declare -i n=5; n=n+1",
  "s=abcdef; echo ${s:0:3}",
  'x=HOME; echo "${!x}"',
  "for ((i=0;i<3;i++)); do echo $i; done",
  "for i in 1 2; do echo $i; done; echo x > $FOREMAN_SCRATCH/f",
  "x=$(git rev-parse HEAD); echo $x",
  'for f in a b; do grep -n x "$f"; done',
  'grep -n "$PAT" src/a.ts',
  "touch $FOREMAN_SCRATCH/{a,b}",
];
for (const role of ROLES) {
  test(`${role}: lines that name their program and keep the folder run with no unknown-program judge and no refusal`, { skip: posixOnly }, () => {
    for (const l of KEEP) {
      const g = gate(l, role);
      assert.notEqual(g.danger, "danger-unknown-program", `${l}: ${JSON.stringify(g)}`);
      assert.ok(!g.result?.block, `${l}: ${JSON.stringify(g.result)}`);
    }
  });
}
// PATH chooses which program a name runs (plan D2: a steering name stays marked), so `env -i PATH=/usr/bin ls` is a judge look, not a silent run (pin moved out of the list above)
for (const role of ROLES) {
  test(`${role}: a PATH assignment steers which program runs, so the line goes to the judge`, { skip: posixOnly }, () => {
    assert.equal(gate("env -i PATH=/usr/bin ls", role).danger, "danger-unknown-program");
  });
}
test("a delete floor and the controls keep their verdicts", { skip: posixOnly }, () => {
  for (const role of ROLES) for (const l of ["rm -rf ~/Documents", "env -u PATH rm -rf ~/Documents"]) assert.equal(gate(l, role).result?.rule, "floor-delete-outside", `${role}: ${l}`);
});

// writes through a harness name the line may have rebound
const REBIND = [
  "FOREMAN_SCRATCH=$HOME; echo x > $FOREMAN_SCRATCH/.zshrc",
  "FOREMAN_SCRATCH=/tmp/q; echo x > $FOREMAN_SCRATCH/f",
  "export FOREMAN_SCRATCH=/tmp/q; cp a $FOREMAN_SCRATCH/x",
  ": ${FOREMAN_SCRATCH:=$HOME}; echo x > $FOREMAN_SCRATCH/.zshrc",
  ". ./x.sh; echo x > $FOREMAN_SCRATCH/.zshrc",
  'eval "$S"; echo x > $FOREMAN_SCRATCH/f',
  'f(){ declare -g "FOREMAN_$1=$HOME"; }; f SCRATCH; echo x > $FOREMAN_SCRATCH/.zshrc',
  'S=SCRATCH; declare -g "FOREMAN_$S=$HOME"; echo x > $FOREMAN_SCRATCH/.zshrc',
  'S=SCRATCH; printf -v "FOREMAN_$S" %s ~; echo x > $FOREMAN_SCRATCH/.zshrc',
  "declare -n R=FOREMAN_SCRATCH; R=$HOME; echo x > $FOREMAN_SCRATCH/.zshrc",
  'S=SCRATCH; unset "FOREMAN_$S"; echo x > $FOREMAN_SCRATCH/Users/x/.zshrc',
  "for FOREMAN_SCRATCH in ~; do :; done; echo x > $FOREMAN_SCRATCH/.zshrc",
  "BASH_ENV=./x.sh bash -c 'echo x > $FOREMAN_SCRATCH/.zshrc'",
  "readarray -t FOREMAN_SCRATCH < f; echo x > $FOREMAN_SCRATCH/.zshrc",
  "compgen -V FOREMAN_SCRATCH; echo x > $FOREMAN_SCRATCH/.zshrc",
  "export {FOREMAN_SCRATCH,X}=$HOME; echo x > $FOREMAN_SCRATCH/.zshrc",
  "grep -rn FOREMAN_SCRATCH src > $FOREMAN_SCRATCH/h",
  "git diff -- $(comm -23 a b) > $FOREMAN_SCRATCH/d",
  "N=FOREMAN_SCRATCH; wait -p $N; echo x > $FOREMAN_SCRATCH/f",
  "V='declare FOREMAN_SCRATCH=/Users/x Y='; $V/bin/pip; echo x > $FOREMAN_SCRATCH/f",
  "coproc FOREMAN_SCRATCH { cat; }; echo x > $FOREMAN_SCRATCH/f",
  "read x < g; : $(( x )); echo x > $FOREMAN_SCRATCH/f",
  "for x in a; do : $(( x )); done; echo x > $FOREMAN_SCRATCH/f",
  "x=$(git rev-parse HEAD); git show $x > $FOREMAN_SCRATCH/s",
  "FOREMAN_OUT=$HOME; echo x > $FOREMAN_OUT/.zshrc",
  'S=OUT; declare -g "FOREMAN_$S=$HOME"; rm -rf $FOREMAN_OUT/x',
];
test("builder: a write through a rebound harness name is danger-write-outside", { skip: posixOnly }, () => {
  for (const l of REBIND) {
    const g = gate(l, "builder");
    assert.ok(g.danger !== null || g.result?.block, `${l}: ${JSON.stringify(g)}`);
    assert.ok(!g.result?.allow, l);
  }
  assert.equal(gate("FOREMAN_SCRATCH=$HOME; echo x > $FOREMAN_SCRATCH/.zshrc", "builder").danger, "danger-write-outside");
  assert.equal(gate("FOREMAN_OUT=$HOME; echo x > $FOREMAN_OUT/.zshrc", "builder").danger, "danger-write-outside");
});
test("reviewer: a write through a rebound harness name is child-readonly-write", { skip: posixOnly }, () => {
  for (const l of REBIND.filter((x) => x.includes("echo x >") || x.includes("cp a"))) {
    const g = gate(l, "reviewer");
    assert.ok(g.result?.block || g.danger !== null, `${l}: ${JSON.stringify(g)}`);
  }
  const g = gate("FOREMAN_SCRATCH=$HOME; echo x > $FOREMAN_SCRATCH/.zshrc", "reviewer");
  assert.equal(g.result?.rule, "child-readonly-write", JSON.stringify(g));
});

// run order: the name is the harness folder up to the first run unit that may rebind it
test("harnessRebound: the folder holds until the first unit that may rebind it", () => {
  assert.deepEqual(harnessRebound("echo x > $FOREMAN_SCRATCH/a; FOREMAN_SCRATCH=/x; ls"), [[], ["FOREMAN_SCRATCH"], ["FOREMAN_SCRATCH"]]);
  assert.deepEqual(harnessRebound("echo $FOREMAN_SCRATCH"), [[]]);
  assert.deepEqual(harnessRebound("echo x > $FOREMAN_SCRATCH/a; eval true"), [[], ["FOREMAN_SCRATCH", "FOREMAN_OUT"]]);
  assert.deepEqual(harnessRebound("n=0; n=$((n+1)); echo $n"), [[], [], []]);
  assert.deepEqual(harnessRebound("echo $((a+1))"), [["FOREMAN_SCRATCH", "FOREMAN_OUT"]]);
  assert.deepEqual(harnessRebound("make; [[ $? -eq 0 ]] && echo ok"), [[], [], []]);
});

// the unit's set rides on each segment, and a run unit after the rebind sees it
test("segments carry harnessRebound by run unit", () => {
  const segs = parseShell("echo x > $FOREMAN_SCRATCH/a; FOREMAN_SCRATCH=/x; echo y > $FOREMAN_SCRATCH/b", { env: { FOREMAN_SCRATCH: "/s" } });
  const echoes = segs.filter((s) => s.program === "echo");
  assert.deepEqual(echoes.map((s) => s.harnessRebound), [[], ["FOREMAN_SCRATCH"]]);
  // the line names the variable on the left of an assignment, so the closed grammar resolves none of the targets; `harnessRebound` says which are still the folder
  assert.equal(echoes[1].redirects[0].target, "$FOREMAN_SCRATCH/b");
});

test("boundNames keeps its answers (the detail is a separate walk)", () => {
  assert.equal(boundNames("for x in a; do :; done").any, true);
  assert.ok(boundNames("wait -p HOME").names.has("HOME"));
  assert.ok(boundNamesDetail("for FOREMAN_SCRATCH in a; do :; done").names.has("FOREMAN_SCRATCH"));
});

test("programUnknown and harnessRebound are not enumerable and survive carryFacts and the body re-parse", { skip: posixOnly }, () => {
  const [seg] = parseShell("env --ign ls");
  assert.equal(seg.programUnknown, true);
  assert.ok(!Object.keys(seg).includes("programUnknown") && !Object.keys(seg).includes("harnessRebound"));
  assert.equal(({ ...seg } as { programUnknown?: boolean }).programUnknown, undefined, "a plain spread drops it");
  const copy = carryFacts({ ...seg, argv: [] }, seg);
  assert.equal(copy.programUnknown, true);
  assert.deepEqual(copy.harnessRebound, seg.harnessRebound);
  const known = parseShell("echo hi")[0];
  assert.equal(known.programUnknown, false);
  assert.deepEqual(known.harnessRebound, []);
  // a function body and a remote string are re-parsed by the floors; the judge still sees the unknown program
  for (const role of ROLES) {
    assert.equal(gate("f() { E=sh; $E -c 'echo hi'; }; f", role).danger, "danger-unknown-program", role);
    assert.equal(gate("ssh host 'E=sh; $E -c ls'", role).danger !== null, true, role);
  }
});

// the brief's examples through the real tool_call handler: the judge is asked first (stub), nothing runs unjudged
const ALLOW = JSON.stringify({ verdict: "clear", reason: "stub" });
async function handlerRig(t: T, kind: "main" | "child") {
  const saved = { b: process.env[BINDINGS_ENV], c: process.env.FOREMAN_CHECKOUT };
  t.after(() => {
    if (saved.b === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = saved.b;
    if (saved.c === undefined) delete process.env.FOREMAN_CHECKOUT;
    else process.env.FOREMAN_CHECKOUT = saved.c;
  });
  if (kind === "child") {
    process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "builder", launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
    delete process.env.FOREMAN_CHECKOUT;
  } else {
    delete process.env[BINDINGS_ENV];
    delete process.env.FOREMAN_CHECKOUT;
  }
  let classifier = 0;
  const modelRegistry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => { classifier++; return { content: [{ type: "text", text: ALLOW }], stopReason: "stop", usage: { input: 1, output: 1 } }; } };
  const ui = { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
  const config = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } } };
  const c = await r11Rig(t, {}, { ctx: { modelRegistry, ui }, config, child: kind === "child" });
  return { c, classifier: () => classifier };
}
for (const kind of ["main", "child"] as const) {
  test(`${kind}: the brief's examples reach the judge through the real handler`, { skip: posixOnly }, async (t: T) => {
    const r = await handlerRig(t, kind);
    let asked = 0;
    for (const command of ["E=sh; $E -c 'echo hi'", "env --ign ls", "env -S 'ls -l'", "builtin exec -c ls"]) {
      const res = await r.c.call("bash", { command });
      // the foreman's own session refuses a shell write it cannot read before the judge (the scratchpad rule); nothing runs unjudged either way
      if (kind === "main" && res?.block) continue;
      assert.equal(r.classifier(), ++asked, `${command}: one judge call ${JSON.stringify(res)}`);
    }
    if (kind === "child") {
      await r.c.call("bash", { command: "FOREMAN_SCRATCH=$HOME; echo x > $FOREMAN_SCRATCH/.zshrc" });
      assert.equal(r.classifier(), ++asked, "FOREMAN_SCRATCH rebind write: one judge call");
    }
    const before = r.classifier();
    await r.c.call("bash", { command: "env -u PATH ls" });
    assert.equal(r.classifier(), before, "a known wrapper runs with no judge call");
  });
}
