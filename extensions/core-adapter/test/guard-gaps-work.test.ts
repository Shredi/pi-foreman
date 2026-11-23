// Guard gaps, performance round (ledger items 12 and 13): the work of one gate call is bounded by counts, not by the clock, and a bound that is hit goes to the judge, never to an allow.
// Item 13: a function body read at its call decides as the inline line; `eval '(( x = $(...) ))'` is judge-first. Gate level for the foreman and a builder (a child).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { nestedSegments, NESTED_SEGMENT_BUDGET } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

process.env.PI_OFFLINE = "1";

const base = fs.realpathSync(mkTestTmp("pf-gg-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "tmp", "pi-foreman-out", "mine");
const handoff = path.join(base, "handoffs", "h1");
for (const d of [path.join(wt, "sub"), scr, out, handoff]) fs.mkdirSync(d, { recursive: true });
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

type X = "J" | "R" | "A";
const check = (line: string, role: Role, want: X): void => {
  const l = line.replaceAll("$WT", wt);
  const g = gate(l, role);
  const got = g.blocked ? "R" : g.danger ? "J" : "A";
  const ok = want === "J" ? got !== "A" : got === want;
  assert.ok(ok, `${role}: ${l}: want ${want}, got ${got} (${g.danger ?? "no danger"})`);
};

const rep = (s: string, n: number, j = " "): string => Array(n).fill(s).join(j);
const nestedDefs = (d: number): string => {
  let n = "ls";
  for (let i = 0; i < d; i++) n = `f${i}(){ ${n}; f${i}; }; f${i}`;
  return n;
};
const BEHIND_BUDGET = 1000;

test("item 13: a function body decides at the call as the inline line", () => {
  const CASES: [string, X, X][] = [
    ["f(){ cat ~/.ssh/id_rsa; }; f", "J", "J"],
    ["cat ~/.ssh/id_rsa", "J", "J"],
    ["f(){ cat README.md; }; f", "A", "A"],
    ["f(){ touch /outside/x; }; f", "A", "R"],
    ["touch /outside/x", "A", "R"],
    ["f(){ touch sub/x; }; f", "A", "A"],
    ["f(){ cat ~/.ssh/id_rsa; }; g(){ f; }; g", "J", "J"],
    ["(( x = $(rm -rf $HOME/y) ))", "J", "J"],
    ["eval '(( x = $(rm -rf $HOME/y) ))'", "J", "J"],
    ["eval '(( x = $(ls) ))'", "J", "J"],
    ["(( x = $(ls) ))", "J", "J"],
    ["eval '(( x = 1 ))'", "A", "A"],
    ["eval '(( x = 1 + 2 ))'", "A", "A"],
  ];
  for (const [line, fm, ch] of CASES) {
    check(line, "main", fm);
    check(line, "builder", ch);
  }
});

test("item 12: calls of a big function body walk a bounded number of commands, and the line is judged", () => {
  const line = `f(){ ${rep("foo a b c d e f g h", 300, "; ")}; }; ${rep("f", 64, "; ")}`;
  const segs = parseShell(line, { cwd: wt });
  assert.ok(segs.length < 2000, `segments: ${segs.length}`);
  assert.ok(segs.some((s) => s.programUnknown === true));
  for (const role of ["main", "builder"] as const) check(line, role, "J");
});

test("item 12: look-behind starts per line are bounded, and the line past the bound is judged", () => {
  const starts = (line: string): number => parseShell(line, { cwd: wt }).reduce((a, s) => a + (s.behind?.length ?? 0), 0);
  const many = rep("foo " + rep("a", 32), 200, "; ");
  assert.ok(starts(many) <= BEHIND_BUDGET, `starts: ${starts(many)}`);
  for (const role of ["main", "builder"] as const) check(many, role, "J");
  // under the bound the walk is as before, and the twin stays allowed
  const few = rep("foo " + rep("a", 32), 20, "; ");
  assert.equal(starts(few), 640);
  for (const role of ["main", "builder"] as const) check(few, role, "A");
});

test("item 12: bodies defined inside bodies are read once per place, not once per path to them", () => {
  const line = nestedDefs(30);
  const segs = parseShell(line, { cwd: wt });
  assert.ok(segs.length < 100, `segments: ${segs.length}`);
  assert.ok(nestedSegments(segs, { cwd: wt, platform: "linux" }).length < 6000);
  for (const role of ["main", "builder"] as const) check(line, role, "J");
});

test("item 12: deeply nested definitions stop at the segment budget and go to the judge", () => {
  for (const d of [150, 250]) {
    const line = nestedDefs(d);
    const nested = nestedSegments(parseShell(line, { cwd: wt }), { cwd: wt, platform: "linux" });
    assert.ok(nested.length <= NESTED_SEGMENT_BUDGET * 2, `depth ${d}: ${nested.length}`);
    assert.ok(nested.some((s) => s.programUnknown === true), `depth ${d}: no judge-first marker`);
    for (const role of ["main", "builder"] as const) check(line, role, "J");
  }
});

test("item 12: look-behind inside function bodies stays bounded", () => {
  const line = `f(){ ${rep("u " + rep("f", 30), 20, "; ")}; }; ${rep("u " + rep("f", 30), 20, "; ")}`;
  const segs = parseShell(line, { cwd: wt });
  assert.ok(segs.reduce((a, s) => a + (s.behind?.length ?? 0), 0) <= BEHIND_BUDGET);
  assert.ok(segs.length < 2000);
  for (const role of ["main", "builder"] as const) check(line, role, "J");
});

test("item 12: one large body called once is cut during the walk and judged; a body at the budget decides as inline", () => {
  const MAX_BODY_CMDS = 500;
  const big = `f(){ ${rep("ls", 8000, "; ")}; }; f`;
  const segs = parseShell(big, { cwd: wt });
  assert.ok(segs.length < MAX_BODY_CMDS + 50, `segments: ${segs.length}`);
  assert.ok(segs.some((s) => s.programUnknown === true));
  const bigFoo = `f(){ ${rep("foo a b c d e f g h", 4000, "; ")}; }; f`;
  assert.ok(parseShell(bigFoo, { cwd: wt }).length < MAX_BODY_CMDS + 50);
  for (const role of ["main", "builder"] as const) {
    check(big, role, "J");
    check(bigFoo, role, "J");
    const atBudget = `f(){ ${rep("ls", MAX_BODY_CMDS, "; ")}; }; f`;
    assert.ok(!parseShell(atBudget, { cwd: wt }).some((s) => s.programUnknown === true));
    check(atBudget, role, "A");
  }
});

// Revision round: a refusal in a body read after the segment budget is spent stays a refusal; the budget only moves what is not a refusal to the judge.
test("item 12: a refusal in a body read after the budget is spent stays a refusal", () => {
  const spent = `f(){ ${rep(":", 1600, "; ")}; }; f; `;
  const REFUSED = ["rm -rf ~", "rm -fr /etc", "find / -delete", "mkfs.ext4 /dev/sda", "chmod -R 777 /"];
  for (const cmd of REFUSED) {
    for (const role of ["main", "builder"] as const) {
      check(`${spent}g(){ ${cmd}; }; g`, role, "R");
      // the same body below another body, past the budget at depth
      check(`${spent}g(){ h(){ ${cmd}; }; h; }; g`, role, "R");
      // the harmless twin is judged, not allowed and not refused
      check(`${spent}g(){ ls; }; g`, role, "J");
    }
  }
  for (const role of ["main", "builder"] as const) {
    check(`${spent}g(){ Remove-Item -Recurse /etc; }; g`, role, "R");
    // a refusal at the bottom of 100 nested definitions, after the budget went at the top
    check(`${nestedDefs(100).replace("ls", "rm -rf ~")}`, role, "R");
  }
});

// Revision round, item 15: nesting past the parser's limit is no syntax error, so the line is not an allow.
test("item 15: nesting the parser rejects is refused or judge-first, never an allow", () => {
  const nestIf = (n: number, c: string) => rep("if true; then", n) + ` ${c}; ` + rep("fi", n, "; ");
  const nestParen = (n: number, c: string) => rep("(", n) + ` ${c} ` + rep(")", n);
  const nestDef = (n: number, c: string) => {
    let b = c;
    for (let i = 0; i < n; i++) b = `f${i}(){ ${b}; }`;
    return `${b}; f${n - 1}`;
  };
  for (const role of ["main", "builder"] as const) {
    for (const c of ["rm -rf ~", "rm -fr /etc"]) {
      check(nestIf(300, c), role, "J");
      check(nestParen(300, c), role, "J");
      check(nestDef(260, c), role, "J");
    }
    // the harmless deep twin is judge-first (main allowed it); lines that parse are as before
    check(nestIf(300, "echo hi"), role, "J");
    check(nestParen(300, "echo hi"), role, "J");
    check(nestDef(260, "echo hi"), role, "J");
    check(nestIf(5, "echo hi"), role, "A");
    check("echo hi", role, "A");
    check(nestIf(200, "rm -rf ~"), role, "R");
  }
});
