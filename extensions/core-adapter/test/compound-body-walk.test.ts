// A body of any compound kind is walked like the plain line: a delete outside the worktree or a secret read inside `for ((;;))`, `coproc`, `(( $(...) ))`, select, a case arm,
// a called function or a here-document fed to bash gets the outcome of the same command on a line of its own. A node kind the walk does not know goes to the judge.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { JUDGE_FIRST } from "../defaults.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

process.env.PI_OFFLINE = "1";

const base = fs.realpathSync(mkTestTmp("pf-cbw-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "tmp", "pi-foreman-out", "mine");
const handoff = path.join(base, "handoffs", "h1");
for (const d of [wt, scr, out, handoff]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

type Role = "main" | "builder";
const roots = (role: Role): GateRoots => ({
  worktree: wt, scratch: [scr, out], out, tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], childHandoff: handoff,
  child: role !== "main", role: role === "main" ? "foreman" : "builder", tmpAccess: false,
});
const gate = (command: string, role: Role) => {
  const o = gateEvaluate("bash", { command }, wt, { env: (c) => baseFloorEnv(c, role === "main" ? {} : { child: true, scratch: [scr, out], out }), roots: () => roots(role) });
  const r = o.result as { block?: boolean } | undefined;
  return { blocked: r?.block === true, danger: o.danger?.name ?? null };
};

const DEL = "rm -rf /some/outside/path";
const READ = "cat ~/.ssh/id_rsa";
const WRAPS: [string, (c: string) => string][] = [
  ["for ((;;))", (c) => `for ((;;)); do ${c}; done`],
  ["for ((i=0;i<1;i++))", (c) => `for ((i=0;i<1;i++)); do ${c}; done`],
  ["coproc simple", (c) => `coproc ${c}`],
  ["coproc named brace", (c) => `coproc C { ${c}; }`],
  ["select", (c) => `select x in a b; do ${c}; done`],
  ["case arm", (c) => `case a in a) ${c};; esac`],
  ["function called", (c) => `f() { ${c}; }; f`],
  ["here-doc fed to bash", (c) => `bash <<'EOF'\n${c}\nEOF`],
];

for (const role of ["main", "builder"] as const) {
  for (const [what, line] of [["delete outside", DEL], ["secret read", READ]] as const) {
    const plain = gate(line, role);
    test(`${role}: the plain ${what} line is refused (the baseline of the wrapped ones)`, () => {
      assert.equal(plain.blocked, true, JSON.stringify(plain));
    });
    for (const [kind, wrap] of WRAPS) {
      test(`${role}: ${what} inside ${kind} gets the outcome of the plain line`, () => {
        const g = gate(wrap(line), role);
        // a here-document fed to a shell is read by the judge (danger-inline-code), never allowed; the others are refused by the floor of the plain line
        if (kind.startsWith("here-doc")) return assert.ok(g.blocked || g.danger !== null, `${wrap(line)}: ${JSON.stringify(g)}`);
        assert.equal(g.blocked, true, `${wrap(line)}: ${JSON.stringify(g)}`);
        assert.equal(g.danger, plain.danger, wrap(line));
      });
    }
  }
}

test("`(( $(rm ...) ))`: the substitution is a segment the floors read, and it is refused like the plain line", () => {
  const line = `(( $(${DEL}) ))`;
  assert.ok(parseShell(line).some((s) => s.program === "rm"));
  for (const role of ["main", "builder"] as const) assert.equal(gate(line, role).blocked, true, role);
});

test("`for ((;;))` and `coproc` bodies are segments of their own, next to the opaque one", () => {
  for (const [, wrap] of WRAPS.slice(0, 4)) {
    const segs = parseShell(wrap(DEL));
    assert.ok(segs.some((s) => s.program === "rm"), wrap(DEL));
  }
});

// an `Elif` as a statement: a kind the traversal knows but the walk never gets as a statement
const elif = (src: string) => ({
  type: "Elif",
  pos: 0,
  end: src.length,
  clause: { type: "CompoundList", commands: [] },
  // eslint-disable-next-line unicorn/no-thenable -- `then` is the real field name of an Elif node of the parser
  then: { type: "CompoundList", commands: [] },
});

test("an unknown node kind is an opaque, programUnknown segment, and the judge-first unknown-program rule hits it", () => {
  const fake = (src: string) => ({ type: "Script", commands: [{ type: "Statement", command: elif(src) }], errors: [] }) as never;
  const segs = parseShell("anything", { parse: fake });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].opaque, "unsupported");
  assert.equal(segs[0].programUnknown, true);
  const rule = JUDGE_FIRST.find((r) => r.name === "danger-unknown-program")!;
  assert.equal(rule.test({ tool: "bash", input: {}, text: "anything", segments: segs } as never, { cwd: wt, roots: roots("main"), platform: process.platform } as never), true);
});

test("a known kind that is fully walked is not marked unknown by the default branch", () => {
  assert.equal(parseShell("for ((;;)); do ls; done").every((s) => s.programUnknown !== true), true);
});

// a `cd` in the body of a loop carries on after the loop, like the `while` form; a coproc body runs in a shell of its own, like a subshell
const CD = "cd /some/outside";
const REL = "rm -rf path";
for (const role of ["main", "builder"] as const) {
  const ref = gate(`while true; do ${CD}; done; ${REL}`, role);
  for (const [what, line] of [
    ["for ((;;))", `for ((i=0;i<1;i++)); do ${CD}; done; ${REL}`],
    ["select", `select x in a b; do ${CD}; done; ${REL}`],
  ] as const) {
    test(`${role}: cd in a ${what} body then a relative delete gets the outcome of the while form`, () => {
      const g = gate(line, role);
      assert.deepEqual(g, ref, `${line}: ${JSON.stringify(g)} vs ${JSON.stringify(ref)}`);
    });
  }
  test(`${role}: cd in a coproc body does not leak, like the subshell form`, () => {
    const sub = gate(`( ${CD} ); ${REL}`, role);
    assert.deepEqual(gate(`coproc { ${CD}; }; ${REL}`, role), sub);
    assert.deepEqual(gate(`coproc ${CD}; ${REL}`, role), sub);
  });
}

// a bare `$(...)` or backtick as a whole header part of `for ((;;))` is the expansion itself: it runs like the plain line
const PARTS: [string, (c: string) => string][] = [
  ["init", (c) => `for (($(${c});;)); do :; done`],
  ["test", (c) => `for ((;$(${c});)); do :; done`],
  ["update", (c) => `for ((;;$(${c}))); do :; done`],
  ["init backtick", (c) => `for ((\`${c}\`;;)); do :; done`],
  ["test backtick", (c) => `for ((;\`${c}\`;)); do :; done`],
  ["update backtick", (c) => `for ((;;\`${c}\`)); do :; done`],
];
for (const role of ["main", "builder"] as const) {
  for (const [what, line] of [["delete outside", DEL], ["git push origin main", "git push origin main"], ["secret read", READ]] as const) {
    const plain = gate(line, role);
    for (const [part, wrap] of PARTS) {
      test(`${role}: ${what} as a bare substitution in the ${part} header part gets the outcome of the plain line`, () => {
        const g = gate(wrap(line), role);
        assert.equal(g.blocked, plain.blocked, `${wrap(line)}: ${JSON.stringify(g)} vs ${JSON.stringify(plain)}`);
        assert.equal(g.danger, plain.danger, wrap(line));
      });
    }
  }
}
