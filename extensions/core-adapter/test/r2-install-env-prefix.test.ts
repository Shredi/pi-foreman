// C: installs and env-prefixed lines carry no label (`danger-install` and `danger-opaque` left the judge-first list): the gate decides nothing and names nothing for them, for every role.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-installenv-"));
const wt = path.join(base, "wt");
fs.mkdirSync(wt, { recursive: true });
after(() => rmTestTmp(base));

const roots = (role: string, readOnly: boolean): GateRoots => ({ worktree: wt, scratch: [], tmp: [], scratchBase: path.join(base, "scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: role !== "foreman", role, tmpAccess: false, ...(readOnly ? { roundReadOnly: true } : {}) });
const run = (command: string, role: string, readOnly: boolean) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, role === "foreman" ? {} : { child: true }), roots: () => roots(role, readOnly) });

const ROLES = [["foreman", false], ["builder", false], ["reviewer", true], ["explorer", true]] as const;

// line -> labels (none under C), the same for the main session, a builder and a read-only role
const ROWS: [string, string[]][] = [
  ["npm ci", []],
  ["FOO=1 npm ci", []],
  ["FOO=1 npm install", []],
  ["FOO=1 pnpm install", []],
  ["npm_config_registry=http://x.invalid npm ci", []],
  ["env FOO=1 npm ci", []],
  ["PATH=/x npm ci", []],
  ["FOO=$(npm ci) ls", []],
  ["FOO=1 npm test", []],
  ["FOO=1 npm run build", []],
  ["FOO=1 ls", []],
  ["FOO=1 git status", []],
  ["FOO=1 gh pr view 1", []],
  ["FOO=1", []],
];

for (const [line, labels] of ROWS) {
  test(`labels of ${JSON.stringify(line)}`, { skip: posixOnly }, () => {
    for (const [role, ro] of ROLES) {
      const o = run(line, role, ro);
      assert.deepEqual(o.result ?? {}, {}, `${role}`);
      assert.deepEqual([...(o.dangers ?? [])].sort(), [...labels].sort(), `${role}`);
    }
  });
}
