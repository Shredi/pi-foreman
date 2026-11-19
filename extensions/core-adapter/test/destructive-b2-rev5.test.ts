// PR B2 revision 5: xargs heredoc shells: clustered -c options and ash.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-b2-rev5-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
const run = (command: string, child: boolean): string => {
  const o = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { scratch: [scr], home: "/Users/fixture", ...(child ? { child: true, builder: true } : {}) }), roots: () => roots(child) });
  const x = o.result;
  return x && "block" in x ? `${x.rule}:block` : x && "ask" in x ? `${x.rule}:ask` : "allow";
};
const refused = (line: string): void => {
  for (const child of [false, true]) assert.notEqual(run(line, child), "allow", `${child ? "child" : "foreman"}: ${line}`);
};
const runs = (line: string): void => {
  for (const child of [false, true]) assert.equal(run(line, child), "allow", `${child ? "child" : "foreman"}: ${line}`);
};

test("under xargs a clustered -c and ash read the heredoc or here-string as a script", () => {
  refused("xargs -0 bash -ce <<< 'rm -rf ~'");
  refused("xargs -0 bash -ec <<< 'rm -rf ~'");
  refused("xargs -0 ash -c <<< 'rm -rf ~'");
  refused("xargs -0 env ash -c <<< 'rm -rf ~'");
  refused("xargs -0 busybox ash -c <<< 'rm -rf ~'");
  runs("xargs bash <<'E'\nrm -rf $X\nE");
  runs("xargs bash -s <<'E'\nrm -rf $X\nE");
});
