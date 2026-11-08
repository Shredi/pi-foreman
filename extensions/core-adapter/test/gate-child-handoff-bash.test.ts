// Item 3: a child's bash writes into its own handoff dir (roots.childHandoff): allow-list names and work/ pass the write-outside danger rule,
// parent-owned names stay outside.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-hob-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
for (const d of [wt, scr, path.join(H, "work")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "a"), "a");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (withHandoff: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false, ...(withHandoff ? { childHandoff: H } : {}) });
const rule = (command: string, withHandoff = true): string | undefined => {
  const r = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true }), roots: () => roots(withHandoff) }).result as { block?: boolean; rule?: string } | undefined;
  return r?.block ? r.rule : undefined;
};

test("child bash writes of allow-list names and work/ in the own handoff dir pass", { skip: !posix }, () => {
  for (const l of [`echo x > ${H}/result.md`, `cp ${wt}/a ${H}/result.md`, `cp ${wt}/a ${H}/work/n.txt`, `mkdir -p ${H}/work/d`, `echo x >> ${H}/ask-1.md`]) assert.equal(rule(l), undefined, l);
});

test("child bash writes of parent-owned names in the own handoff dir stay outside", { skip: !posix }, () => {
  for (const l of [`echo x > ${H}/ruling.md`, `cp ${wt}/a ${H}/brief.md`, `echo x > ${H}/close.json`]) assert.equal(rule(l), "child-write-outside", l);
});

test("without a childHandoff root the same write stays outside", { skip: !posix }, () => {
  assert.equal(rule(`echo x > ${H}/result.md`, false), "child-write-outside");
});
