// PR B2 revision 4: heredocs under xargs (a shell with -c reads them), ssh options -B and -P.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-b2-rev4-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
const run = (command: string, child: boolean): string => {
  const o = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { scratch: [scr], home: "/Users/fixture", ...(child ? { child: true, builder: true } : {}) }), roots: () => roots(child) });
  const x = o.result;
  return x && "block" in x ? `${x.rule}:block` : x && "ask" in x ? `${x.rule}:ask` : o.danger ? `${o.danger.name}:judge` : "allow";
};
const refused = (line: string): void => {
  for (const child of [false, true]) assert.notEqual(run(line, child), "allow", `${child ? "child" : "foreman"}: ${line}`);
};

test("a shell with -c under xargs reads the heredoc or here-string as its script", () => {
  refused("xargs -0 sh -c <<< 'rm -rf ~'");
  refused("xargs -I{} bash -c {} <<'E'\nrm -rf $X\nE");
  refused("xargs sh -c <<'E'\nfind $X -delete\nE");
  for (const child of [false, true]) assert.equal(run("xargs bash <<'E'\nrm -rf $X\nE", child), "danger-inline-code:judge", `${child ? "child" : "foreman"}: xargs bash heredoc`);
});

test("ssh options -B and -P step over their value", () => {
  refused("ssh -B eth0 h <<'E'\nfind $X -delete\nE");
  refused("ssh -P tag h <<'E'\nfind $X -delete\nE");
});
