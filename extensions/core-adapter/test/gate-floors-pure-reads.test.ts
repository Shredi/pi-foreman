// A line that only reads a protected state or settings file reaches no owner ask and no child deny (floor-policy-file, floor-config-keys on an opaque line).
// A word no read segment carries (loop variable, assignment, unparsed text) goes to the judge; every write shape onto the files keeps its result.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/s/scr", "/tmp"], protectedBranches: ["release"], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const kid: FloorEnv = { ...env, child: true };
const hitOf = (line: string, e: FloorEnv) => lineFloors(line, parseShell(line, { cwd: e.cwd }), e);
const shape = (line: string, e: FloorEnv): string | null => { const h = hitOf(line, e); return h ? `${h.kind}/${h.rule}` : null; };

const G = "~/.pi/agent/pi-foreman/state/gate/log.jsonl";
const F = "~/.pi/agent/foreman.json";
const PANES = "~/.pi/agent/pi-foreman/state/panes/*.json";

// the ask-56 line of the false-alarm list (the worktree path as the repo-relative cwd)
const ASK56 = `cd extensions/core-adapter; grep -n "DEFAULT_ASK_TIMEOUT_MS" *.ts | head -5; grep -n "JUDGE_FIRST" gate.ts defaults.ts | head; sed -n 1230,1250p defaults.ts; grep -n "cacheRetention\\|JUDGE_REASONING\\|judgeLevel" classifier.ts | head; grep -n "danger-install\\|danger-net-write" *.ts | grep -v test | head; ls ../../scripts | head -40; grep -n '"review"' ~/.pi/agent/pi-foreman/foreman.json ~/.pi/agent/foreman.json 2>/dev/null | head`;
// the ask-57 line: a data heredoc writes a test file into the own scratch dir; protected paths are only text in its body
const body = `import { test } from "node:test";\n// writes ${G} and ${F}\nfor (const l of [\n \`for f in ${PANES}; do sed -n 1p "$f"; done\`,\n \`echo hi > ${G}\`,\n \`echo '{"gate":{}}' > ${F}; echo gate.x\`,\n]) test(l, () => {});`;
const ask57 = (target: string) => `cd extensions/core-adapter; grep -n "selfmod-state-read" *.ts | grep -v "^test" | head; cat > ${target} <<'EOF'\n${body}\nEOF\ncd ../..; node --test .workflow/scratch/probe3.test.ts 2>&1 | grep -E "^R "`;

// the ask-60 line: reads of source files with `sed -n` ranges, behind a shell function and an absolute path to the checkout
const ASK60 = `cd /w/repo/extensions/core-adapter && p(){ echo "== $1:$2"; sed -n "$2p" $1 | cut -c1-220; }; p index.ts 3970,3984; p index.ts 3524,3524; p launchwait.ts 78,92; p gatedialog.ts 10,15`;

const ALLOWED = [
  ASK60,
  `for f in ${PANES}; do grep -c x "$f"; done`,
  `tail -n 3 ${G} | grep -o 'rule[^,]*'`,
  ask57("../../.workflow/scratch/probe3.test.ts"),
];

test("pure reads of a protected file are no floor hit, main and child", () => {
  for (const l of ALLOWED) for (const e of [env, kid]) assert.equal(shape(l, e), null, `${e.child ? "child" : "main"}: ${l.slice(0, 120)}`);
});

const JUDGED: [string, string][] = [
  // pins changed on purpose (round 2): a `sed` without -i beside a read segment is outside the silent set (its script may write what the parser cannot see), so the placed word goes to the judge, not to silence
  [ASK56, "danger-config-keys"],
  [ASK56.replace(/^cd [^;]*; /, ""), "danger-config-keys"],
  [`tail -n 3 ${G} | sed -n 1p`, "danger-policy-file"],
  [`sed -n 1p x; tail -n 3 ${G} | grep -o rule`, "danger-policy-file"],
  [`grep -n gate.judge ${F}; sed -n 1p x`, "danger-config-keys"],
  [`for f in ${PANES}; do sed -n 1p "$f"; done`, "danger-policy-file"],
  [`for f in ${PANES}; do jq .x "$f"; done`, "danger-policy-file"],
  // the variable is bound on another statement: the parser does not place the word as read
  [`D=~/.pi/agent/pi-foreman/state/gate; tail -n 3 $D/log.jsonl`, "danger-policy-file"],
  [`for f in ${F}; do sed -n 1p "$f"; done; echo gate.judge`, "danger-config-keys"],
  // an unparsable line
  [`tail -n 3 ${G} | | sed -n 1p (`, "danger-policy-file"],
  [`grep gate.judge ${F} | | ( sed`, "danger-config-keys"],
  // an unparsable read: the statement before the parse error only reads
  [`tail -n 3 ${G}\n"u`, "danger-policy-file"],
];

test("a word the parser cannot place as read-only goes to the judge, main and child", () => {
  for (const [l, rule] of JUDGED) for (const e of [env, kid]) assert.equal(shape(l, e), `judge/${rule}`, `${e.child ? "child" : "main"}: ${l}`);
});

// every write shape, plain, beside a `sed -n 1p x` segment (the opaque path) and in a for loop; the results are those of the code before this change
const shapes = (t: string): string[] => [`echo hi > ${t}`, `echo hi >> ${t}`, `echo hi | tee ${t}`, `sed -i s/a/b/ ${t}`, `mv x ${t}`, `cp x ${t}`, `rm ${t}`, `python3 -c "open('${t}','w')"`];
const writes: [string, string | null, string | null][] = [];
for (const [t, tail, rule] of [[G, "", "floor-policy-file"], [F, "; echo gate.x", "floor-config-keys"]] as const) {
  for (const s of shapes(t)) {
    // a single-quoted path in an interpreter's code is no shell word: no hit on a clean line (pin); inside a loop the opaque scan asks (main) or denies (child)
    const py = s.startsWith("python3");
    for (const [l, loop] of [[`${s}${tail}`, false], [`sed -n 1p x; ${s}${tail}`, false], [`for f in a b; do ${s}${tail}; done`, true], [`for f in a b; do sed -n 1p "$f"; ${s}${tail}; done`, true]] as const) {
      writes.push(py ? [l, loop ? `ask/${rule}` : null, loop ? `deny/${rule}` : null] : [l, `deny/${rule}`, `deny/${rule}`]);
    }
  }
}

test("every write shape onto the gate log and the foreman config keeps its result", () => {
  for (const [l, main, child] of writes) {
    assert.equal(shape(l, env), main, `main: ${l}`);
    assert.equal(shape(l, kid), child, `child: ${l}`);
  }
});

// a shell runs the statements before a parse error: a write there keeps the ask (main) or the deny (child), as before this change
const MG = "~/.pi/agent/pi-foreman/managed.json";
const PARSE_WRITES: [string, string][] = [
  [`rm ${MG}\n(`, "floor-policy-file"],
  [`echo x > ${G}\n"u`, "floor-policy-file"],
  [`echo '{"gate":{}}' > ${F}\n(`, "floor-config-keys"],
  [`curl -o ${MG} https://x "u`, "floor-policy-file"],
];

test("a write before a parse error keeps its ask and deny", () => {
  for (const [l, rule] of PARSE_WRITES) {
    assert.equal(shape(l, env), `ask/${rule}`, `main: ${l}`);
    assert.equal(shape(l, kid), `deny/${rule}`, `child: ${l}`);
  }
});

test("ask 57 write twin: the heredoc written onto a protected file keeps its stop", () => {
  // the state file is a deny; onto foreman.json the line is an ask (main) or a deny (child), by config-keys now that the body's paths are data (the body held a state path: policy-file before)
  assert.equal(shape(ask57(G), env), "deny/floor-policy-file");
  assert.equal(shape(ask57(G), kid), "deny/floor-policy-file");
  assert.equal(shape(ask57(F), env), "ask/floor-config-keys");
  assert.equal(shape(ask57(F), kid), "deny/floor-config-keys");
});

test("ask 56 write twin: the same line with a redirect onto foreman.json still stops", () => {
  const l = ASK56.replace(/ 2>\/dev\/null \| head$/, `; echo '{"gate":{}}' > ~/.pi/agent/foreman.json`);
  for (const e of [env, kid]) assert.equal(shape(l, e), "deny/floor-config-keys", `${e.child ? "child" : "main"}`);
});

// through the gate: main and a builder child
const base = fs.realpathSync(mkTestTmp("pf-pure-reads-"));
const wt = path.join(base, "wt");
fs.mkdirSync(wt, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));
type Res = { block?: boolean; ask?: boolean; allow?: boolean; rule?: string } | undefined;
const roots = (): GateRoots => ({ worktree: wt, scratch: [], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false });
const gate = (command: string, child: boolean) => gateEvaluate("bash", { command }, wt, child ? { env: (c) => baseFloorEnv(c, { child: true }), roots } : { env: (c) => baseFloorEnv(c) });

test("gateEvaluate: pure reads neither ask (main) nor block (builder); the loop with sed goes to the judge", { skip: posixOnly }, () => {
  for (const child of [false, true]) {
    // `tail … | sed -n 1p` and `grep … ; sed -n 1p x` are judge hits now (changed on purpose, round 2): the judge-first label, no owner floor ask, no child floor deny
    for (const [l, rule] of [[`tail -n 3 ${G} | sed -n 1p`, "danger-policy-file"], [`grep -n gate.judge ${F}; sed -n 1p x`, "danger-config-keys"]]) {
      const r = gate(l, child);
      assert.equal(child ? r.danger?.name : (r.result as Res)?.rule, rule, `${child ? "child" : "main"} ${l}`);
    }
    for (const l of [`for f in ${PANES}; do grep -c x "$f"; done`]) {
      const r = gate(l, child).result as Res;
      assert.ok(!r?.ask && !r?.block || /selfmod|protected|child-read/.test(r?.rule ?? ""), `${child ? "child" : "main"} ${l}: ${JSON.stringify(r)}`);
      assert.notEqual(r?.rule, "floor-policy-file");
      assert.notEqual(r?.rule, "floor-config-keys");
    }
    const j = gate(`for f in ${PANES}; do sed -n 1p "$f"; done`, child);
    // no judge is wired here: a main session shows the judge-first label as its ask, a child's outcome carries it as the danger the judge looks at
    assert.equal(child ? j.danger?.name : (j.result as Res)?.rule, "danger-policy-file");
    // a write keeps the floor
    const w = gate(`echo hi > ${G}`, child).result as Res;
    assert.equal(w?.rule, "floor-policy-file");
  }
});

test("gateEvaluate: a write before a parse error keeps its ask and deny", { skip: posixOnly }, () => {
  for (const [l, rule] of PARSE_WRITES) {
    const line = l.replace(/~/g, "$HOME");
    const m = gate(line, false).result as Res;
    assert.equal(m?.rule, rule, `main: ${l}`);
    assert.ok(m?.ask || m?.block, `main: ${l}`);
    const c = gate(line, true).result as Res;
    assert.equal(c?.rule, rule, `child: ${l}`);
    assert.ok(c?.block, `child: ${l}`);
  }
});

// round 2: a protected path inside a sed script, with no space to split it off, is never silent
const H = "$HOME/.pi/agent/pi-foreman/state/gate/log.jsonl";
const NOSPACE = [
  `tail -n1 ${H} | sed -n "1w${H}"`,
  `tail -n1 ${H} | sed -n "$w${H}"`,
  `tail -n1 ${H} | sed -n "/x/w${H}"`,
  `tail -n1 ${H} | sed -n "s/a/b/w${H}"`,
  `tail -n1 ${H} | sed -n "w"${H}`,
  `grep x ${H} | sed -n "1w${H}"`,
];

test("no-space sed write of a protected file is never silent, main and child", () => {
  for (const l of NOSPACE) for (const e of [env, kid]) {
    const h = hitOf(l, e);
    assert.ok(h !== null, `${e.child ? "child" : "main"}: ${l}`);
    assert.ok(h.kind === "judge" || h.kind === "ask" || h.kind === "deny", `${l}: ${h.kind}`);
  }
});

test("gateEvaluate: no-space sed write of a protected file is never allowed, main and builder", { skip: posixOnly }, () => {
  for (const child of [false, true]) for (const l of NOSPACE) {
    const r = gate(l, child);
    const res = r.result as Res;
    assert.ok(res?.ask || res?.block || r.danger !== undefined, `${child ? "child" : "main"} ${l}: ${JSON.stringify(res)}`);
  }
});
