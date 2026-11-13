// Invariants of the handoff write rule, pinned: `..`, empty segments and a bare `work` are never child-written names (given and real spelling; tool and
// shell, session-level child); a subagent child's literal write outside its checkout is blocked whatever allow rule applies (child deny before allow);
// the two reports that did not reproduce (a plain redirect outside, `git pull --ff-only` in the worktree) are pinned.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateDecide, gateEvaluate, type GateResult } from "../gate.ts";
import { childHandoffWrite, pathDecide, type GateRoots } from "../pathrules.ts";
import { parseRule } from "../rules.ts";
import type { RuleSets } from "../rules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-hinv-"));
const wt = path.join(base, "wt");
const out = path.join(base, "elsewhere");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
for (const d of [wt, out, scr, path.join(H, "work")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "a"), "a");
after(() => fs.rmSync(base, { recursive: true, force: true }));

// The paths are resolved before they are judged: `work//x` and `work/../result.md` name the same file as `work/x` and `result.md` and follow their verdict;
// a `..` that leaves the root or lands on a parent-owned name is refused, so is the bare `work` entry and the dir itself.
test("childHandoffWrite: .., bare work, work/ and the dir itself are refused in the given and the real spelling", () => {
  const root = "/h/handoffs/h1";
  const real = (p: string): string | null => p;
  const ok = (abs: string, ra = abs): boolean => childHandoffWrite(root, abs, ra, "linux", real);
  for (const rel of ["work/../x", "work", "work/", "work/..", "../x", "", ".", "plan.md/../ruling.md", "work/a/../../ruling.md"]) assert.equal(ok(`${root}/${rel}`), false, rel);
  // only the real spelling shows the bad name
  assert.equal(ok(`${root}/work/x`, `${root}/work/../ruling.md`), false);
  assert.equal(ok(`${root}/work/x`, `${root}/work`), false);
  assert.equal(ok(`${root}/work/x`, `${root}/../x`), false);
  // an empty segment or a resolved `..` that lands on a listed name is that name
  assert.equal(ok(`${root}/work//x`), true);
  assert.equal(ok(`${root}/work/../result.md`), true);
  assert.equal(ok(`${root}/work/x`), true);
});

test("childHandoffWrite win32: .., an empty segment and bare work (also with trailing dots) are refused", () => {
  const root = "C:\\h\\handoffs\\h1";
  const real = (p: string): string | null => p;
  const ok = (rel: string): boolean => childHandoffWrite(root, `${root}\\${rel}`, `${root}\\${rel}`, "win32", real);
  for (const rel of ["work\\..\\x", "work", "work\\", "work.", "WORK \\", "work\\..", "..\\x"]) assert.equal(ok(rel), false, rel);
  assert.equal(ok("work\\\\x"), true);
  assert.equal(ok("work\\x"), true);
});

const ownRoots = (): GateRoots => ({ worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false, ownHandoff: H });
const subRoots = (): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false, childHandoff: H });
const SPELLINGS = ["work", "work/", "work/..", "work/../ruling.md", "../h1/ruling.md", "work/../.git/HEAD"];

test("session-level child, write tool: .., bare work and work/ are no allow", () => {
  for (const n of SPELLINGS) assert.equal(pathDecide("write", { path: `${H}/${n}` }, wt, ownRoots()), undefined, n);
});

test("session-level child, shell: .., bare work and work/ are write-outside, never an allow", { skip: !posix }, () => {
  const r = ownRoots();
  for (const n of SPELLINGS) {
    // cp and mv onto the existing dir `work` put the file below it, a name of its own: only the redirect form is judged for the bare entry
    const bare = n === "work" || n === "work/";
    for (const l of [`echo x > ${H}/${n}`, ...(bare ? [] : [`cp ${wt}/a ${H}/${n}`, `mv ${wt}/a ${H}/${n}`])]) {
      const o = gateEvaluate("bash", { command: l }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: false }), roots: () => r });
      const res = o.result as { allow?: boolean } | undefined;
      assert.notEqual(res?.allow, true, l);
      assert.equal(o.danger?.name, "danger-write-outside", l);
    }
  }
});

const rule = (t: string) => {
  const r = parseRule(t);
  if (!r.ok) throw new Error(t);
  return r.rule;
};
const allowAll: RuleSets = { allow: ["Bash(*)", "Write", "Edit"].map(rule), ask: [], deny: [] };
const sub = (tool: string, input: Record<string, unknown>, cwd = wt, sets: RuleSets | undefined = allowAll): GateResult =>
  gateDecide(tool, input, cwd, {
    env: (c) => baseFloorEnv(c, { child: true }),
    roots: () => subRoots(),
    ...(sets ? { rules: { sets, env: { cwd, home: path.join(base, "home"), platform: process.platform, checkout: wt } } } : {}),
  });
const tag = (r: GateResult): string => (r ? ("ask" in r ? `ask:${r.rule}` : "block" in r ? `block:${r.rule}` : `allow:${r.rule}`) : "pass");

test("subagent: a literal write outside the checkout stays blocked with an allow-everything rule set (child deny before allow)", { skip: !posix }, () => {
  for (const [tool, input] of [["bash", { command: `echo x > ${out}/f` }], ["bash", { command: `cp ${wt}/a ${out}/f` }], ["bash", { command: `mv ${wt}/a ${out}/f` }], ["write", { path: `${out}/f`, content: "x" }]] as const) {
    assert.equal(tag(sub(tool, { ...input })), "block:child-write-outside", JSON.stringify(input));
    assert.equal(tag(sub(tool, { ...input }, wt, undefined)), "block:child-write-outside", `${JSON.stringify(input)} without rules`);
  }
});

test("pin: a plain redirect outside the checkout from a subagent is blocked (not reproducible as refused-by-mistake; refused by design)", { skip: !posix }, () => {
  assert.equal(tag(sub("bash", { command: `echo x > ${out}/f` })), "block:child-write-outside");
  assert.equal(tag(sub("bash", { command: `D=${out}; echo x > $D/f` })), "block:child-write-outside");
});

test("pin: git pull --ff-only in the worktree is not blocked by the child floor", { skip: !posix }, () => {
  assert.notEqual(tag(sub("bash", { command: "git pull --ff-only" }, wt, undefined)).split(":")[0], "block");
});
