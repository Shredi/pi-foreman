// Remote-runner lines (`rt exec --on host-a -- CMD`): a look-behind trial that starts at `exec` fails on the program's option words (`--on`), which are none of the shell builtin's.
// That failure alone is no unknown program: every later literal word starts a trial of its own. Any other unknown reading, and every concrete hit behind the program, still judges the line.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-rrt-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const out = path.join(base, "tmp", "pi-foreman-out", "mine");
const handoff = path.join(base, "handoffs", "h1");
for (const d of [wt, scr, out, handoff]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({
  worktree: wt, scratch: [scr, out], out, tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], childHandoff: handoff,
  child, role: "builder", tmpAccess: false,
});
const danger = (command: string, child: boolean): string | null => {
  const o = gateEvaluate("bash", { command }, wt, { env: (c) => baseFloorEnv(c, child ? { child: true, scratch: [scr, out], out } : {}), roots: () => roots(child) });
  return o.danger?.name ?? null;
};

// The evidence lines of 2026-11-28 (placeholders) and the shapes around them.
const RUNS = [
  "rt exec --on host-a -- git clone https://example.com/r.git /work/new",
  "rt exec --on host-a -- npm ci",
  "rt exec --on host-a -- node --test",
  "rt exec --on host-a -- git checkout main",
  "rt exec --on host-a -- git status",
  "rt exec --on host-a --cwd /work/repo -- npm ci",
  'rt exec --opt host-a -- "$CMD"',
  "rt exec --on=host-a -- ls /work/repo",
];
// A concrete hit behind the program, or a reading that stays unknown.
const FIRES = [
  "rt exec --on host-a -- rm -rf ~",
  "rt exec --on host-a -- git push origin main",
  'rt exec --on host-a -- bash -c "$X"',
  'caffeinate trap "$X" EXIT',
  'caffeinate builtin exec -c "$X"',
  'caffeinate exec bash -c "rm -rf ~"',
  'rt exec -a "$X" cmd',
];

for (const child of [false, true]) {
  const who = child ? "child" : "main";
  test(`${who}: remote-runner lines whose only unknown reading is the option of the exec word run`, { skip: posixOnly }, () => {
    for (const l of RUNS) {
      if (child && l.includes("/work/new")) continue; // a clone target outside the checkout is the child's own write-target rule, not this one
      assert.notEqual(danger(l, child), "danger-unknown-program", l);
    }
  });
  test(`${who}: a concrete hit behind the runner, or a reading that stays unknown, still judges the line`, { skip: posixOnly }, () => {
    for (const l of FIRES) assert.notEqual(danger(l, child), null, l);
  });
  test(`${who}: the line's own exec with an unknown option is still an unknown program`, { skip: posixOnly }, () => {
    assert.equal(danger("exec --on host-a git status", child), "danger-unknown-program");
  });
}

test("a trial of find -exec or npx that reads exec with an option keeps its reading", { skip: posixOnly }, () => {
  assert.equal(danger("npx exec --on host-a git status", false), "danger-unknown-program");
});
