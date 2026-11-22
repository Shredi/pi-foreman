// Judge-first-unknown revision round: the plan's remaining judged lines and the assignment-only units, for main, builder and reviewer.
// too), and `$FOREMAN_SCRATCH` / `$FOREMAN_OUT` are the harness folder only up to the first run unit that may rebind them. Gate level for main, builder and reviewer; the five
// examples of the brief also through the real tool_call handler.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { parseShell, harnessRebound } from "../shellast.ts";
import { posixOnly } from "./_platform.ts";

process.env.PI_OFFLINE = "1";

const base = fs.realpathSync(mkTestTmp("pf-jfu2-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "tmp", "pi-foreman-out", "mine");
const handoff = path.join(base, "handoffs", "h1");
for (const d of [path.join(wt, "sub"), scr, out, handoff]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

type T = Parameters<typeof r11Rig>[0];
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


const LINES = [
  // assignment-only units marked programUnknown (arithmetic or a subscript on text)
  "x='a[$(rm -rf ~/Documents)]'; y=$(( x ))",
  "x=a; a[$x]=1",
  "x=t; declare -i i; i=$x",
  "read x < g; y=$(( x ))",
  "(y=$((x)))",
  "{ y=$((x)); }",
  "arr=( $((x)) )",
  // program word and wrapper
  '"$E" -c \'rm -rf ~/x\'',
  "$(echo sh) -c 'rm -rf ~/x'",
  "env --ign rm -rf ~/Documents",
  "env -S 'rm -rf ~/Documents'",
  'env -i -S "rm -rf ~/Documents"',
  "env --unse=PATH rm -rf ~/Documents",
  "T=5; timeout $T rm -rf ~/Documents",
  'exec -a "$N" rm -rf ~/Documents',
  "E=-c; bash $E 'rm -rf ~/x'",
  "builtin exec -c sh -c 'rm -rf ~/Documents'",
  "builtin cd /tmp",
  "env --ignore-env sh -c 'FOREMAN_OUT=~; rm -rf $FOREMAN_OUT/x'",
  "builtin exec -c sh -c 'FOREMAN_OUT=~; rm -rf $FOREMAN_OUT/x'",
  "E=s; ${E}h -c 'rm -rf ~/Documents'",
  "$V/bin/s$X -c 'rm -rf ~/x'",
  "{rm,-rf,~/Documents}",
  "C=rm; find ~/Documents -exec $C -rf {} +",
  "sh -c 'E=sh; $E -c \"rm -rf ~/x\"'",
  "command --x rm -rf ~/x",
  'bash "$E" \'rm -rf ~/x\'',
  // arithmetic and subscripts on text
  ": 'a[$(id)]'; echo $(( $_ ))",
  "read < g; echo $(( REPLY ))",
  'printf -v y %s "$z"; echo $(( y ))',
  "unset 'b[$(id)]'",
  "declare 'd[$(id)]=1'",
  "read 'e[$(id)]' <<< v",
  "bash -c 'echo $(( $0 ))' 'a[$(id)]'",
  "declare -i i; read i < g",
  "declare -i j; for j in $(cat g); do :; done",
  'declare -i k; printf -v k %s "$v"',
  "for OPTIND in $(cat g); do :; done",
  "x=Y; Y='a[$(id)]'; read \"${!x}\" <<< v",
  'x=Y; declare "${!x}=1"',
  '_=5; : \'a[$(id)]\'; echo $(( _ ))',
  "_=Y; : 'a[$(id)]'; read \"$_\" <<< v",
  "REPLY=5; read <<< 'a[$(id)]'; echo $(( REPLY ))",
  "REPLY=Y; read <<< 'a[$(id)]'; read \"$REPLY\" <<< v",
  "OPTARG=Y; getopts a: o -a 'b[$(id)]'; read \"$OPTARG\" <<< v",
  "false && FUNCNAME=5; Y='a[$(id)]'; Y() { : $(( FUNCNAME )); }; Y",
  "N=5; echo $((N+1))",
  'X=HOME; echo "${!X}"',
  'y=0; printf -v y %s "$z"; echo $(( y ))',
  "echo $((COLUMNS-2))",
  "[[ $x -eq 1 ]]",
  "echo ${s:$x:1}",
  "echo ${a[$x]}",
  "[[ -v a[$(id)] ]]",
  "x='a[$(id)]'; read \"$x\" <<< v",
  'x=\'a[$(id)]\'; echo "${!x}"',
  "X=FOREMAN_OU; printf -v ${X}T %s ~; rm -rf $FOREMAN_OUT/Documents",
  "X=FOREMAN_OU; declare ${X}T=~; rm -rf $FOREMAN_OUT/Documents",
  "X=FOREMAN_OU; export ${X}T=~; rm -rf $FOREMAN_OUT/Documents",
  "X=FOREMAN_OU; read ${X}T <<< ~; rm -rf $FOREMAN_OUT/Documents",
  'declare -n r=$X"T"',
  "printf -v FOREMAN_OU{T,} %s ~",
  "declare FOREMAN_OU?=~",
  "start=$(date +%s); sleep 1; echo $(( $(date +%s) - start ))",
  "n=$(wc -l < f); echo $((n/2))",
  "echo $(( $1 + 1 ))",
  "x='a[$(rm -rf ~/x)]'; let x",
  "read x < g; (( x ))",
  "x='a[FOREMAN_SCRATCH=3]'; for ((i=0;i<x;i++)); do :; done",
  ": $(( $(echo FOREMAN_SCRATCH=7) ))",
  "declare -i i; i=$x",
  // other label first or the same label
  "r$X -rf ~/x",
];
// an earlier judge-first label or a refusal may come first for these; the call still never runs unjudged
const EARLIER: Record<string, string> = { "r$X -rf ~/x": "danger-delete-unknown-target" };
for (const role of ROLES) {
  test(`${role}: the plan's judged lines and assignment-only units never run unjudged`, { skip: posixOnly }, () => {
    for (const l of LINES) {
      const g = gate(l, role);
      assert.ok(!g.result?.allow, `${l}: not an allow ${JSON.stringify(g)}`);
      assert.ok(g.danger !== null || g.result?.block, `${l}: judged or refused ${JSON.stringify(g)}`);
      if (EARLIER[l]) assert.equal(g.danger, EARLIER[l], l);
    }
  });
}
// the lines of the review finding carry the new label itself, for every role
const ASSIGN_ONLY = LINES.slice(0, 7);
for (const role of ROLES) {
  test(`${role}: an assignment-only unit with arithmetic on text is danger-unknown-program`, { skip: posixOnly }, () => {
    for (const l of ASSIGN_ONLY) assert.equal(gate(l, role).danger, "danger-unknown-program", l);
  });
}
// the folder is lost after such a unit
test("a write through the folder name after an assignment-only arithmetic unit is judged (builder)", { skip: posixOnly }, () => {
  assert.equal(gate("x=a; y=$(( x )); echo x > $FOREMAN_SCRATCH/f", "builder").danger !== null, true);
});

// the remaining rebind writes of the plan: judged (builder), refused (reviewer)
const REBIND2 = [
  "mapfile -C 'FOREMAN_SCRATCH=/Users/x #' -c 1 a < f; echo x > $FOREMAN_SCRATCH/.zshrc",
  "readarray -C 'FOREMAN_SCRATCH=/Users/x #' -c 1 a < f; echo x > $FOREMAN_SCRATCH/.zshrc",
  "ENV= sh -c 'echo x > $FOREMAN_SCRATCH/.zshrc'",
  "typeset -n R=FOREMAN_SCRATCH; R=$HOME; echo x > $FOREMAN_SCRATCH/.zshrc",
  "f() { local -n R=FOREMAN_SCRATCH; R=$HOME; }; f; echo x > $FOREMAN_SCRATCH/.zshrc",
  'export "FOREMAN_${S}=$HOME"; echo x > $FOREMAN_SCRATCH/.zshrc',
  'declare -n R="FOREMAN_$S"; R=$HOME; echo x > $FOREMAN_SCRATCH/.zshrc',
  "F=-n; declare $F R=FOREMAN_SCRATCH; R=$HOME; echo x > $FOREMAN_SCRATCH/.zshrc",
  "read x < g; let x; echo x > $FOREMAN_SCRATCH/f",
  "for N in FOREMAN_SCRATCH; do compgen -V $N -W ~; done; echo x > $FOREMAN_SCRATCH/f",
  "X=1; x='a[${X#${FOREMAN_SCRATCH:=/Users/x}}]'; : $(( x )); echo x > $FOREMAN_SCRATCH/.zshrc",
  "declare -i i; i='a[${X#${FOREMAN_SCRATCH:=/Users/x}}]'; echo x > $FOREMAN_SCRATCH/.zshrc",
];
test("builder: the remaining rebind writes are judged or refused", { skip: posixOnly }, () => {
  for (const l of REBIND2) {
    const g = gate(l, "builder");
    assert.ok(!g.result?.allow && (g.danger !== null || g.result?.block), `${l}: ${JSON.stringify(g)}`);
  }
});
test("reviewer: the remaining rebind writes are refused or judged", { skip: posixOnly }, () => {
  for (const l of REBIND2) {
    const g = gate(l, "reviewer");
    assert.ok(!g.result?.allow && (g.danger !== null || g.result?.block), `${l}: ${JSON.stringify(g)}`);
  }
});

// outer-line state into nested shells (parent ruling 2026-11-22): each judged or refused for builder and reviewer
const NESTED = [
  "bash -c 'cd ~; IFS=/; rm -rf $FOREMAN_OUT'",
  ". ./x.sh; sh -c 'rm -rf $FOREMAN_OUT/Documents'",
  "export $(cat v); sh -c 'rm -rf $FOREMAN_OUT/Documents'",
  "BASH_ENV=./x.sh bash -c 'rm -rf $FOREMAN_OUT/Documents'",
  "bash -l -c 'rm -rf $FOREMAN_OUT/Documents'",
  ". ./x.sh; sh -c 'echo x > $FOREMAN_OUT/.zshrc'",
];
for (const role of ["builder", "reviewer"] as const) {
  test(`${role}: outer-line state flows into nested shells (judged or refused)`, { skip: posixOnly }, () => {
    const bad = NESTED.filter((l) => {
      const g = gate(l, role);
      return g.result?.allow || (g.danger === null && !g.result?.block);
    });
    assert.deepEqual(bad, []);
  });
}

// the six reproducers carry the folder names as rebound on every segment (IFS, startup files, the outer line's set into a nested -c string)
test("outer-line state reaches the nested segments as harnessRebound", { skip: posixOnly }, () => {
  for (const l of NESTED) {
    const segs = parseShell(l, { cwd: wt, platform: "linux" }).filter((x) => x.program === "rm" || x.program === "echo");
    assert.ok(segs.length > 0, l);
    for (const sg of segs) assert.deepEqual([...(sg.harnessRebound ?? [])].sort(), ["FOREMAN_OUT", "FOREMAN_SCRATCH"], l);
  }
  for (const l of ["IFS=/; echo $FOREMAN_OUT", "declare IFS=/; echo $FOREMAN_OUT", "export IFS=/; echo $FOREMAN_OUT", "f(){ local IFS=/; }; echo $FOREMAN_OUT", "IFS=/ read a; echo $FOREMAN_OUT"]) {
    assert.deepEqual(harnessRebound(l).at(-1)?.slice().sort(), ["FOREMAN_OUT", "FOREMAN_SCRATCH"], l);
  }
  assert.deepEqual(harnessRebound("echo $FOREMAN_OUT; IFS=/; ls")[0], []);
  assert.deepEqual(parseShell("sh -c 'echo $FOREMAN_OUT'", { cwd: wt, platform: "linux" })[0].harnessRebound, []);
});

const ALLOW = JSON.stringify({ verdict: "clear", reason: "stub" });
async function handlerRig(t: T, kind: "main" | "child", role = "builder") {
  const saved = { b: process.env[BINDINGS_ENV], c: process.env.FOREMAN_CHECKOUT };
  t.after(() => {
    if (saved.b === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = saved.b;
    if (saved.c === undefined) delete process.env.FOREMAN_CHECKOUT;
    else process.env.FOREMAN_CHECKOUT = saved.c;
  });
  if (kind === "child") {
    process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role, launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
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

for (const role of ["builder", "reviewer"]) {
  test(`${role}: the nested-shell reproducers reach the judge or are refused through the real handler`, { skip: posixOnly }, async (t: T) => {
    const r = await handlerRig(t, "child", role);
    for (const command of NESTED) {
      const before = r.classifier();
      const res = await r.c.call("bash", { command });
      assert.ok(res?.block || r.classifier() === before + 1, `${command}: judged or refused ${JSON.stringify(res)}`);
    }
  });
}
