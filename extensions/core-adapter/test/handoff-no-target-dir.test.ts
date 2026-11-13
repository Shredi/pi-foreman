// `cp -T` / `mv -T` (--no-target-directory) write the destination dir itself, not `dest/<name>`: a handoff dir or its work/ is no writable name, so the
// forms stay refused as without the into-a-dir inference (subagent child: child-write-outside; session-level child and parent: danger-write-outside).
// The plain into-dir forms still work.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-hntd-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
const O = path.join(base, "agent", "handoffs", "opened");
for (const d of [wt, scr, path.join(H, "work"), O]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "a"), "a");
fs.writeFileSync(path.join(wt, "plan.md"), "p");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const mk = (o: Partial<GateRoots>): GateRoots => ({ worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "builder", tmpAccess: false, ...o });
const KINDS: Record<string, GateRoots> = {
  sub: mk({ scratch: [scr], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), child: true, childHandoff: H }),
  own: mk({ ownHandoff: H }),
  parent: mk({ openedHandoffs: [O] }),
};
const seen = (kind: string, command: string): string => {
  const r = KINDS[kind];
  const out = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: r.child }), roots: () => r });
  const res = out.result as { allow?: boolean; block?: boolean; rule?: string } | undefined;
  return res?.block ? `block:${res.rule}` : out.danger?.name ?? (res?.allow ? `allow:${res.rule}` : "none");
};
const REFUSED: Record<string, string> = { sub: "block:child-write-outside", own: "danger-write-outside", parent: "danger-write-outside" };
const dirOf = (kind: string): string => (kind === "parent" ? O : H);
const FORMS: Array<[string, string]> = [
  ["cp -T", "cp -T"], ["cp -rT", "cp -rT"], ["cp -fT", "cp -fT"], ["cp --no-target-directory", "cp --no-target-directory"], ["cp --no-t", "cp --no-t"],
  ["mv -T", "mv -T"], ["mv -fT", "mv -fT"], ["mv --no-target-directory", "mv --no-target-directory"],
];

test("-T and --no-target-directory onto the handoff dir itself: refused as without the inference", { skip: !posix }, () => {
  for (const kind of Object.keys(KINDS)) {
    for (const [name, prog] of FORMS) {
      const src = prog.startsWith("mv") ? `${wt}/a` : `${wt}/plan.md`;
      assert.equal(seen(kind, `${prog} ${src} ${dirOf(kind)}`), REFUSED[kind], `${kind}: ${name}`);
      fs.writeFileSync(path.join(wt, "a"), "a");
    }
  }
});

test("-T onto work/ of a handoff dir: refused for the child kinds", { skip: !posix }, () => {
  for (const kind of ["sub", "own"]) {
    for (const [name, prog] of FORMS) assert.equal(seen(kind, `${prog} ${wt}/a ${H}/work`), REFUSED[kind], `${kind}: ${name}`);
  }
});

test("the plain into-dir forms still work for a subagent child", { skip: !posix }, () => {
  assert.equal(seen("sub", `mv ${wt}/a ${H}/work`), "allow:default-write-in");
  fs.writeFileSync(path.join(wt, "a"), "a");
  assert.equal(seen("sub", `mv -f ${wt}/a ${H}/work`), "allow:default-write-in");
  fs.writeFileSync(path.join(wt, "a"), "a");
  assert.equal(seen("sub", `cp ${wt}/a ${H}/result.md`), "allow:default-write-in");
});

test("the plain into-the-handoff-dir form stays refused for the child kinds (a non-listed name)", { skip: !posix }, () => {
  assert.equal(seen("sub", `cp ${wt}/a ${H}`), REFUSED.sub);
  assert.equal(seen("own", `cp ${wt}/a ${H}`), REFUSED.own);
});
