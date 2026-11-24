// A protected path inside another segment's script argument (a sed `w` command) is carried by that segment, not read by the clean read beside it:
// the line keeps its owner ask (main) or deny (child) instead of going silent or to the judge.
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
const shape = (line: string, e: FloorEnv): string | null => { const h = lineFloors(line, parseShell(line, { cwd: e.cwd }), e); return h ? `${h.kind}/${h.rule}` : null; };

const G = "$HOME/.pi/agent/pi-foreman/state/gate/log.jsonl";
const F = "$HOME/.pi/agent/foreman.json";

// [line, rule]: main asks, the child is denied
const LINES: [string, string][] = [
  [`tail -n1 ${G} | sed -n "w ${G}"`, "floor-policy-file"],
  [`tail -n1 ${G} | sed -n "s/a/b/w ${G}"`, "floor-policy-file"],
  [`grep gate.judge ${F}; sed -n "w ${F}" y; echo gate.judge`, "floor-config-keys"],
  [`grep gate.judge ${F}; sed -n "s/a/b/w ${F}" y; echo gate.judge`, "floor-config-keys"],
];

test("a protected path inside a sed script argument keeps the ask (main) and the deny (child)", () => {
  for (const [l, rule] of LINES) {
    const m = shape(l, env);
    assert.ok(m === `ask/${rule}`, `main: ${l}: ${m}`);
    assert.equal(shape(l, kid), `deny/${rule}`, `child: ${l}`);
  }
});

const base = fs.realpathSync(mkTestTmp("pf-embedded-write-"));
const wt = path.join(base, "wt");
fs.mkdirSync(wt, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));
type Res = { block?: boolean; ask?: boolean; rule?: string } | undefined;
const roots = (): GateRoots => ({ worktree: wt, scratch: [], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false });
const gate = (command: string, child: boolean) => gateEvaluate("bash", { command }, wt, child ? { env: (c) => baseFloorEnv(c, { child: true }), roots } : { env: (c) => baseFloorEnv(c) });

test("gateEvaluate: the same lines stop at the floor, main and builder", { skip: posixOnly }, () => {
  for (const child of [false, true]) {
    for (const [l, rule] of LINES) {
      const r = gate(l, child);
      assert.equal((r.result as Res)?.rule, rule, `${child ? "child" : "main"} ${l}: ${JSON.stringify(r.result)}`);
      assert.ok((r.result as Res)?.ask || (r.result as Res)?.block, `${child ? "child" : "main"} ${l}`);
    }
  }
});
