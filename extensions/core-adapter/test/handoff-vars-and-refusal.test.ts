// Same-line variables in a parent's ruling write (`D=<dir>; echo x > "$D/ruling.md"`), and the text of a child's write-effect refusal.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-hvr-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const O = path.join(base, "agent", "handoffs", "opened");
const MINE = path.join(base, "agent", "handoffs", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
for (const d of [wt, scr, O, MINE, path.join(H, "work")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "f"), "f");
fs.writeFileSync(path.join(wt, "a"), "a");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const parent = (o: Partial<GateRoots> = {}): GateRoots => ({ worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], openedHandoffs: [O], child: false, role: "foreman", tmpAccess: false, ...o });
const run = (command: string, r: GateRoots): { allow?: string; block?: string; danger: string | null; reason?: string } => {
  const out = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: r.child }), roots: () => r });
  const res = out.result as { allow?: boolean; block?: boolean; rule?: string; reason?: string } | undefined;
  return { ...(res?.allow ? { allow: res.rule } : {}), ...(res?.block ? { block: res.rule, reason: res.reason } : {}), danger: out.danger?.name ?? null };
};

test("a same-line variable that resolves to an opened dir: the ruling write is an allow", { skip: !posix }, () => {
  for (const l of [`D=${O}; echo x > "$D/ruling.md"`, `D=${O} && cp ${wt}/f "$D/ruling.md"`]) {
    const s = run(l, parent());
    assert.ok(s.allow?.endsWith("default-write-handoff-ruling"), l);
    assert.equal(s.danger, null, l);
  }
});

test("a same-line variable that resolves to the session's own child dir (also opened-and-child): no allow, danger mark kept", { skip: !posix }, () => {
  const cases: Array<Partial<GateRoots>> = [{ openedHandoffs: [O], ownHandoff: MINE }, { openedHandoffs: [O, MINE], childHandoffs: [MINE], ownHandoff: MINE }];
  for (const o of cases) {
    for (const l of [`D=${MINE}; echo x > "$D/ruling.md"`, `D=${MINE} && cp ${wt}/f "$D/ruling.md"`]) {
      const s = run(l, parent(o));
      assert.equal(s.allow, undefined, l);
      assert.equal(s.danger, "danger-write-outside", l);
    }
  }
});

test("a refused subagent cp names the destination, not the worktree root", { skip: !posix }, () => {
  const r: GateRoots = { worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false, childHandoff: H };
  const dest = `${H}/ruling.md`;
  const s = run(`cp ${wt}/a ${dest}`, r);
  assert.equal(s.block, "child-write-outside");
  assert.ok(s.reason?.includes(`Refused: ${dest},`), s.reason);
  // a cp into an existing dir refused by the write-effect check names the destination dir too
  const t = run(`cp ${wt}/a ${H}/work`, r);
  assert.equal(t.block, "child-write-outside");
  assert.ok(t.reason?.includes(`Refused: ${H}/work,`), t.reason);
  assert.ok(!t.reason?.includes(`Refused: ${wt},`), t.reason);
});
