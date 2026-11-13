// A subagent child's `tee` with a literal path operand outside the worktree, the scratch dir and the handoff names is `child-write-outside`.
// The null device and the standard sinks are exempt; `tee` inside the worktree and forms that cannot be resolved keep today's result (mode step).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-tee-"));
const wt = path.join(base, "wt");
const out = path.join(base, "elsewhere");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
for (const d of [wt, out, scr, path.join(H, "work")]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child = true): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: false, ...(child ? { childHandoff: H } : {}) });
const seen = (command: string, child = true, cwd = wt): string => {
  const o = gateEvaluate("bash", { command }, cwd, { env: (c) => baseFloorEnv(c, { child }), roots: () => roots(child) });
  const r = o.result as { block?: boolean; allow?: boolean; rule?: string } | undefined;
  return r?.block ? `block:${r.rule}` : r?.allow ? `allow:${r.rule}` : `none:${o.danger?.name ?? "-"}`;
};

test("tee to a literal path outside is child-write-outside, also behind a pipe, with options and in a chain", { skip: !posix }, () => {
  for (const l of [`echo x | tee ${out}/f`, `echo x | tee -a ${out}/f`, `echo x | tee ${wt}/ok ${out}/f`, `ls && echo x | tee ${out}/f`, `echo x | tee ../elsewhere/f`, `echo x | tee ${H}/ruling.md`, `echo x | tee ${H}/work/.git/x`, `echo x | tee ${H}/some-other.md`]) assert.equal(seen(l), "block:child-write-outside", l);
});

test("tee to the null device and the standard sinks is exempt", { skip: !posix }, () => {
  for (const l of [`echo x | tee /dev/null`, `echo x | tee /dev/stdout`, `echo x | tee /dev/stderr`, `echo x | tee -a /dev/null`]) assert.notEqual(seen(l), "block:child-write-outside", l);
});

test("tee inside the worktree, the scratch dir or onto a handoff name keeps today's result (mode step, opaque)", { skip: !posix }, () => {
  for (const l of [`echo x | tee ${wt}/f`, `echo x | tee ${scr}/f`, `echo x | tee ${H}/result.md`, `echo x | tee ${H}/work/n.txt`, `echo x | tee out.txt`]) assert.equal(seen(l), "none:danger-opaque", l);
});

test("forms that cannot be resolved stay at the mode step (left open)", { skip: !posix }, () => {
  for (const l of [`echo x | tee $HOME/f`, `echo x | tee $D/f`, `echo x | tee "$(pwd)/f"`]) assert.equal(seen(l), "none:danger-opaque", l);
});

test("a session that is no subagent child keeps today's result", { skip: !posix }, () => {
  assert.notEqual(seen(`echo x | tee ${out}/f`, false), "block:child-write-outside");
});
