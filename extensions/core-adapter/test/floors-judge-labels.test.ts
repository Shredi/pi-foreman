// A mixed line carries every judge-first label the floors found, not only the first: a later one (a delete or write the gate cannot read) behind a terminal injection is still named.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-floorlabels-"));
const wt = path.join(base, "wt");
fs.mkdirSync(wt, { recursive: true });
after(() => rmTestTmp(base));

const roots = (role: string): GateRoots => ({ worktree: wt, scratch: [], tmp: [], scratchBase: path.join(base, "scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: role !== "foreman", role, tmpAccess: false });
const run = (command: string, role: string) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, role === "foreman" ? {} : { child: true }), roots: () => roots(role) });

const ROWS: [string, string][] = [
  ["tmux send-keys -t x hi; f(){ rm -rf /srv/x; }; f", "danger-delete-unknown-target"],
  ['tmux send-keys -t x hi; printf x > "$T"', "danger-unknown-write-target"],
];

for (const [line, label] of ROWS) {
  for (const role of ["foreman", "builder"]) {
    test(`${role}: ${JSON.stringify(line)} names ${label}`, { skip: posixOnly }, () => {
      const o = run(line, role);
      assert.equal(o.result, undefined);
      assert.ok(o.dangers?.includes(label), JSON.stringify(o.dangers));
      assert.ok(o.dangers?.includes("danger-inject"), JSON.stringify(o.dangers));
    });
  }
}
