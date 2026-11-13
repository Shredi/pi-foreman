// The `child-write-outside` refusal names the refused path (or the cwd), the worktree root it was compared with and the sanctioned targets.
// Behaviour is pinned too: the same calls stay blocked, `git pull --ff-only` in the worktree stays allowed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-hcw-"));
const wt = path.join(base, "wt");
const out = path.join(base, "elsewhere");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
for (const d of [wt, out, scr, H]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "a"), "a");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (o: Partial<GateRoots> = {}): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false, childHandoff: H, ...o });
type Res = { block?: boolean; allow?: boolean; rule?: string; reason?: string } | undefined;
const call = (tool: string, input: Record<string, unknown>, cwd = wt, o: Partial<GateRoots> = {}): Res =>
  gateEvaluate(tool, input, cwd, { env: (c) => baseFloorEnv(c, { child: true }), roots: () => roots(o) }).result as Res;

const NAMES = ["plan.md", "result.md", "ask.md", ".seen", "work/"];
function named(r: Res, offender: string): void {
  assert.equal(r?.block, true);
  assert.equal(r?.rule, "child-write-outside");
  const t = r?.reason ?? "";
  assert.ok(t.includes(offender), `offender ${offender} in: ${t}`);
  assert.ok(t.includes(wt), `worktree root in: ${t}`);
  assert.ok(t.includes(scr), `scratch dir in: ${t}`);
  assert.ok(t.includes(H), `handoff dir in: ${t}`);
  for (const n of NAMES) assert.ok(t.includes(n), `${n} in: ${t}`);
}

test("a redirect outside names the target, the worktree root, the scratch dir and the handoff names", { skip: !posix }, () => {
  named(call("bash", { command: `echo x > ${out}/f` }), path.join(out, "f"));
});

test("a cp and an mv outside name their destination", { skip: !posix }, () => {
  named(call("bash", { command: `cp ${wt}/a ${out}/g` }), path.join(out, "g"));
  named(call("bash", { command: `mv ${wt}/a ${out}/h` }), path.join(out, "h"));
});

test("a path tool write outside names the path", () => {
  named(call("write", { path: path.join(out, "w.txt"), content: "x" }), path.join(out, "w.txt"));
  named(call("foreman_copy", { src: path.join(wt, "a"), dst: path.join(out, "c.txt") }), path.join(out, "c.txt"));
});

test("a git write run from a cwd outside the worktree names the cwd and the worktree root", { skip: !posix }, () => {
  const r = call("bash", { command: "git pull --ff-only" }, out);
  named(r, out);
});

test("git pull --ff-only in the worktree stays allowed (pin)", { skip: !posix }, () => {
  const r = call("bash", { command: "git pull --ff-only" }, wt);
  assert.equal(r?.block, undefined);
});

test("without a scratch dir and a handoff dir the text says so", { skip: !posix }, () => {
  const r = call("bash", { command: `echo x > ${out}/f` }, wt, { scratch: [], childHandoff: undefined });
  assert.equal(r?.rule, "child-write-outside");
  assert.ok((r?.reason ?? "").includes("no scratch dir"), r?.reason);
  assert.ok((r?.reason ?? "").includes("no handoff dir"), r?.reason);
});

test("a write inside the worktree, the scratch dir and a handoff name is not refused (pin)", { skip: !posix }, () => {
  for (const l of [`echo x > ${wt}/f`, `echo x > ${scr}/f`, `echo x > ${H}/result.md`]) assert.equal(call("bash", { command: l })?.block, undefined, l);
});
