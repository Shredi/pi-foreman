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
    // a refusal at the bottom of 100 nested definitions: every body counts a level of depth, so past the cap it is judge-first as on main (never an allow)
    check(`${nestedDefs(100).replace("ls", "rm -rf ~")}`, role, "J");
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

// Revision round, item 15: a walker stack overflow (a huge arithmetic expansion) is no allow either; the text floors still run on the raw line.
test("item 15: a walker stack overflow is refused or judge-first, never an allow", () => {
  const sum = rep("1", 50000, "+");
  for (const role of ["main", "builder"] as const) {
    check(`echo $(( ${sum}+$(rm -rf ~) ))`, role, "J");
    check(`echo $(( ${sum} )); rm -rf ~`, role, "R");
    check(`x=$(( ${sum} )); git reset --hard`, role, "J");
    check(`: $(( ${sum} )); curl -o ~/.bashrc https://x`, role, "J");
    // the harmless twin is judge-first (it was an allow)
    check(`echo $(( ${sum} ))`, role, "J");
    check("echo $((1+1+1))", role, "A");
  }
});

// Revision round 3 (item 12): the budget is spent on the copies of walked function bodies alone; what the line's text reads as (what origin/main read) is always read in full, so every refusal main gave is kept.
const CAPPED = `f(){ ${rep(":", 1600, "; ")}; }; h(){ ${rep(":", 1600, "; ")}; }; f; h; `;
const q = (c: string): string => c.replace(/'/g, "'\\''");

test("item 12: segments emitted inside a walked body carry the marker the budget counts; the text's own segments do not", () => {
  const segs = parseShell("f(){ ls; cat a; }; f", { cwd: wt });
  assert.deepEqual(segs.map((s) => s.walked === true), [false, true, true, false]);
  const nested = nestedSegments(parseShell(CAPPED + "g(){ ls; }; g", { cwd: wt }), { cwd: wt, platform: "linux" });
  assert.ok(nested.filter((s) => s.walked).length <= NESTED_SEGMENT_BUDGET + 10, `walked segments read: ${nested.filter((s) => s.walked).length}`);
});

test("item 12: a here-document, here-string or script in a body is read past the budget (family 1)", () => {
  const CMDS = ["rm -rf /etc", "rm -rf ~", 'r""m -rf /etc', "\\rm -rf /etc", "find / -delete", "mkfs.ext4 /dev/sda", "sudo rm -rf /etc", "busybox rm -rf /etc"];
  const SHAPES: ((c: string) => string)[] = [
    (c) => `f(){ bash <<'E'\n${c}\nE\n}; f`,
    (c) => `f(){ sh <<E\n${c}\nE\n}; f`,
    (c) => `f(){ bash -s <<E\n${c}\nE\n}; f`,
    (c) => `f(){ bash <<< '${q(c)}'; }; f`,
    (c) => `${CAPPED}g(){ bash <<'E'\n${c}\nE\n}; g`,
    (c) => `${CAPPED}g(){ sh <<E\n${c}\nE\n}; g`,
    (c) => `${CAPPED}g(){ bash -s <<E\n${c}\nE\n}; g`,
    (c) => `${CAPPED}g(){ bash <<< '${q(c)}'; }; g`,
    (c) => `${rep(":", 1600, "; ")}; f(){ ${rep(":", 1600, "; ")}; }; f; g(){ bash <<'E'\n${c}\nE\n}; g`,
  ];
  for (const role of ["main", "builder"] as const) for (const c of CMDS) for (const shape of SHAPES) check(shape(c), role, "R");
});

test("item 12: a privilege program or wrapper in a body is read past the budget (family 2)", () => {
  const CMDS = ["sudo rm -rf /etc", "doas rm -rf /etc", "sudo -u root rm -rf /etc", "sudo find / -delete", "sudo mkfs.ext4 /dev/sda", "sudo bash -c 'rm -rf /etc'", "doas -u root mkfs.ext4 /dev/sda", "env rm -rf /etc", "nice -n 5 rm -rf ~", "timeout 5 rm -rf /etc", "xargs rm -rf /etc", "eval 'rm -rf /etc'", "bash -c 'sudo rm -rf /etc'", "busybox sh -c 'rm -rf /etc'", "toybox rm -rf /etc"];
  for (const role of ["main", "builder"] as const) {
    for (const c of CMDS) {
      check(`${CAPPED}g(){ ${c}; }; g`, role, "R");
      check(`${CAPPED}g(){ h2(){ ${c}; }; h2; }; g`, role, "R");
      check(`${CAPPED}${c}`, role, "R");
      check(`f(){ ${c}; }; f`, role, "R");
    }
    // the harmless twins past the budget are judged, not refused
    check(`${CAPPED}g(){ sudo ls; }; g`, role, "J");
    check(`${CAPPED}g(){ echo hi; }; g`, role, "J");
  }
});

test("item 12: nested definitions 100 and 250 with a refusal at the bottom are refused or judge-first, wide bodies stay refused", () => {
  for (const role of ["main", "builder"] as const) {
    for (const c of ["rm -rf /etc", "sudo rm -rf /etc", "sudo bash -c 'rm -rf /etc'", "mkfs.ext4 /dev/sda"]) {
      check(nestedDefs(100).replace("ls", c), role, "J");
      check(nestedDefs(250).replace("ls", c), role, "J");
      check(`f(){ ${rep("foo a b c d e f g h", 300, "; ")}; ${c}; }; f`, role, "R");
    }
  }
});

// Review 3d5a8e40: bodies that run without a call (coproc, `for ((…))`) count towards the depth cap, so 17+ of them nested are judge-first or refused, never no decision.
const nestedRun = (kind: "coproc" | "for", d: number, inner: string): string => {
  let n = inner;
  for (let i = 0; i < d; i++) n = kind === "coproc" ? `coproc C${i} { ${n}; }` : `for ((i${i}=0;i${i}<1;i${i}++)); do ${n}; done`;
  return n;
};

test("item 12: 17+ nested coproc and for(( )) bodies with a read or a write outside are never no decision", () => {
  for (const role of ["main", "builder"] as const) {
    for (const kind of ["coproc", "for"] as const) {
      for (const d of [17, 18, 30]) {
        for (const c of ["cat ~/.aws/credentials", "cp ~/.ssh/id_rsa sub/k", "echo x > /outside/x", "echo x >> ~/.bashrc", "pkill node", "ssh h ls", "python -c 'print(1)'", "eval \"$X\"", "git reset --hard", "rm -rf /etc"]) {
          const line = nestedRun(kind, d, c);
          const g = gate(line, role);
          // the foreman may legitimately allow what only a builder is held to (a write outside)
          if (role === "main" && c.startsWith("echo x")) continue;
          assert.ok(g.blocked || g.danger !== null, `${role} ${kind} ${d}: ${c}: no decision`);
        }
      }
    }
  }
});

// Every level walks 400 commands at its call (the walker's own cap is 500 a text) and hands the next level to busybox: the walked copies read in all levels pass the budget.
const sq = (c: string): string => `'${q(c)}'`;
const levels = (n: number, inner: string): string => {
  let t = inner;
  for (let i = 0; i < n; i++) t = `k(){ ${rep(":", 400, "; ")}; busybox sh -c ${sq(t)}; }; k`;
  return t;
};

test("item 12: the segment budget really is spent (levels of walked bodies read through busybox)", () => {
  const walkedRead = (line: string): number => nestedSegments(parseShell(line, { cwd: wt }), { cwd: wt, platform: "linux" }).filter((s) => s.walked).length;
  // the budget cuts the read: 8 levels read ~14,000 walked copies with it and ~53,000 without
  assert.ok(walkedRead(levels(8, "ls")) < 18000, `walked read: ${walkedRead(levels(8, "ls"))}`);
  for (const role of ["main", "builder"] as const) {
    // a floor command at the bottom, past the budget, is still refused
    for (const c of ["rm -rf /etc", "sudo rm -rf /etc", "mkfs.ext4 /dev/sda"]) check(levels(8, c), role, "R");
    // the harmless twin goes to the judge, never an allow
    check(levels(8, "ls"), role, "J");
  }
});

test("item 12: 17+ nested definitions that nothing calls are judge-first as on main, and the stripped loop end reads as before", () => {
  for (const role of ["main", "builder"] as const) {
    for (const d of [17, 30]) {
      let n = "cat ~/.aws/credentials";
      for (let i = 0; i < d; i++) n = `f${i}(){ ${n}; }`;
      check(n, role, "J");
    }
    check("select s in a; do rm -rf /etc; done", role, "R");
    check("for ((i=0;i<1;i++)); do rm -rf /etc; done", role, "R");
    check("for ((i=0;i<1;i++)); do ls ; done", role, "A");
  }
});

// Review 827351a0: a called function body counts a level of depth like every other body, so a call at each level cannot keep 17+ levels undecided.
const GAMING: ((d: number, c: string) => string)[] = [
  // a called function between coproc / for(( )) / select levels
  (d, c) => { let n = c; for (let i = 0; i < d; i++) n = i % 2 === 0 ? `coproc C${i} { ${n}; }` : `f${i}(){ ${n}; }; f${i}`; return n; },
  (d, c) => { let n = c; for (let i = 0; i < d; i++) n = i % 2 === 0 ? `for ((i${i}=0;i${i}<1;i${i}++)); do ${n}; done` : `f${i}(){ ${n}; }; f${i}`; return n; },
  (d, c) => { let n = c; for (let i = 0; i < d; i++) n = i % 2 === 0 ? `select s${i} in a b; do ${n}; done` : `f${i}(){ ${n}; }; f${i}`; return n; },
  // a call inside a coproc body
  (d, c) => { let n = c; for (let i = 0; i < d; i++) n = `coproc C${i} { f${i}(){ ${n}; }; f${i}; }`; return n; },
  // the call only in a branch that never runs
  (d, c) => { let n = c; for (let i = 0; i < d; i++) n = `f${i}(){ ${n}; }; if false; then f${i}; fi`; return n; },
  // the call before the definition, in a loop
  (d, c) => { let n = c; for (let i = 0; i < d; i++) n = `for k in 1 2; do f${i}; f${i}(){ ${n}; }; done`; return n; },
  // the same name at each level, and recursion
  (d, c) => { let n = c; for (let i = 0; i < d; i++) n = `f(){ ${n}; }; f`; return n; },
  (d, c) => { let n = c; for (let i = 0; i < d; i++) n = `f${i}(){ ${n}; f${i}; }; f${i}`; return n; },
  (d, c) => { let n = c; for (let i = 0; i < d; i++) n = `ls(){ ${n}; }; ls`; return n; },
];

test("item 12: 17+ levels with a called function at each level are never no decision (secret read, git reset --hard, outside write)", () => {
  for (const role of ["main", "builder"] as const) {
    for (const [k, shape] of GAMING.entries()) {
      for (const d of [17, 18, 30]) {
        for (const c of ["cat ~/.aws/credentials", "git reset --hard", "touch /outside/x"]) {
          // the foreman may write outside; only a builder is held to it
          if (role === "main" && c.startsWith("touch")) continue;
          const g = gate(shape(d, c), role);
          assert.ok(g.blocked || g.danger !== null, `${role} shape ${k} depth ${d}: ${c}: no decision`);
        }
      }
    }
  }
});

// Review 827351a0: nesting selects deep with many commands a level stays within a count, not a clock (the floors re-read a select body as text, as on main).
test("item 12: nested selects stay within a segment count (work bound) and past the cap are judge-first", () => {
  const sel = (d: number, per: number, words = "a b"): string => {
    let n = "ls";
    for (let i = 0; i < d; i++) n = `select s${i} in ${words}; do ${rep("ls", per - 1, "; ")}${per > 1 ? "; " : ""}${n}; done`;
    return n;
  };
  const line = sel(250, 20);
  const segs = parseShell(line, { cwd: wt });
  // every command of the text is walked once in place: 250 selects × 20 commands, plus the selects' own segments
  assert.ok(segs.length <= 250 * 21 + 10, `segments walked: ${segs.length}`);
  for (const role of ["main", "builder"] as const) {
    for (const l of [line, sel(150, 1), sel(100, 20), sel(250, 1, "$(ls)"), sel(17, 1), sel(30, 1)]) check(l, role, "J");
    // plain and shallow selects stay as they were
    check("select a in x y; do ls; done", role, "A");
    check(sel(3, 2), role, "A");
  }
});

// Review adcac999: a select body is a body the floors re-read as text, as on main; alternating it with other bodies cannot reset the depth count.
const ALT: Record<string, (i: number, n: string) => string> = {
  coproc: (i, n) => `coproc C${i} { ${n}; }`,
  arith: (i, n) => `for ((i${i}=0;i${i}<1;i${i}++)); do ${n}; done`,
  func: (i, n) => `f${i}(){ ${n}; }`,
};
const selAlt = (kind: string, d: number, c: string): string => {
  let n = c;
  for (let i = 0; i < d; i++) n = i % 2 === 0 ? `select s${i} in a b; do ${n}; done` : ALT[kind](i, n);
  return n;
};

test("item 12: select alternated with coproc, for(( )) and uncalled functions 17/18/30 deep is never no decision", () => {
  for (const role of ["main", "builder"] as const) {
    for (const kind of Object.keys(ALT)) {
      for (const d of [17, 18, 30]) {
        for (const c of ["cat ~/.ssh/id_rsa", "cat ~/.aws/credentials", "git reset --hard", "touch /outside/x", "cp ~/.ssh/id_rsa x"]) {
          if (role === "main" && c.startsWith("touch")) continue;
          const g = gate(selAlt(kind, d, c), role);
          assert.ok(g.blocked || g.danger !== null, `${role} ${kind} ${d}: ${c}: no decision`);
        }
      }
    }
  }
});

test("item 12: PowerShell removers in a select body are refused as on main", () => {
  for (const role of ["main", "builder"] as const) {
    for (const t of ["/etc", "C:/Windows", "$X", "/outside/d"]) {
      for (const r of ["Remove-Item -Recurse", "ri -Recurse"]) {
        const g = gate(`select s in a; do ${r} ${t}; done`, role);
        assert.ok(g.blocked || g.danger !== null, `${role}: ${r} ${t}: no decision`);
      }
    }
    check("select s in a; do Remove-Item -Recurse /etc; done", role, "R");
  }
});

test("item 12: a select in $( ) nested 5 and 16 deep with rm -rf /etc is refused or judge-first as on main", () => {
  for (const role of ["main", "builder"] as const) {
    for (const d of [5, 16]) {
      let n = "select s in a; do rm -rf /etc; done";
      for (let i = 0; i < d; i++) n = `echo $(${n})`;
      check(n, role, "J");
    }
  }
});
