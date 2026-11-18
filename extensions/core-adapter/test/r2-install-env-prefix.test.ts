// An env prefix does not hide an install: `FOO=1 npm ci` carries `danger-install` next to the `danger-opaque` the prefix gives. Other lines keep their labels.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-installenv-"));
const wt = path.join(base, "wt");
fs.mkdirSync(wt, { recursive: true });
after(() => rmTestTmp(base));

const roots = (role: string, readOnly: boolean): GateRoots => ({ worktree: wt, scratch: [], tmp: [], scratchBase: path.join(base, "scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child: role !== "foreman", role, tmpAccess: false, ...(readOnly ? { roundReadOnly: true } : {}) });
const run = (command: string, role: string, readOnly: boolean) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, role === "foreman" ? {} : { child: true }), roots: () => roots(role, readOnly) });

const ROLES = [["foreman", false], ["builder", false], ["reviewer", true], ["explorer", true]] as const;

// line -> labels, the same for the main session, a builder and a read-only role
const ROWS: [string, string[]][] = [
  ["npm ci", ["danger-install"]],
  ["FOO=1 npm ci", ["danger-install", "danger-opaque"]],
  ["FOO=1 npm install", ["danger-install", "danger-opaque"]],
  ["FOO=1 pnpm install", ["danger-install", "danger-opaque"]],
  ["npm_config_registry=http://x.invalid npm ci", ["danger-install", "danger-opaque"]],
  ["env FOO=1 npm ci", ["danger-install", "danger-opaque"]],
  ["PATH=/x npm ci", ["danger-install", "danger-opaque"]],
  ["FOO=$(npm ci) ls", ["danger-install", "danger-opaque"]],
  ["FOO=1 npm test", ["danger-opaque"]],
  ["FOO=1 npm run build", ["danger-opaque"]],
  ["FOO=1 ls", ["danger-opaque"]],
  ["FOO=1 git status", ["danger-opaque"]],
  ["FOO=1 gh pr view 1", ["danger-opaque"]],
  ["FOO=1", ["danger-opaque"]],
];

for (const [line, labels] of ROWS) {
  test(`labels of ${JSON.stringify(line)}`, { skip: !posix }, () => {
    for (const [role, ro] of ROLES) {
      const o = run(line, role, ro);
      assert.deepEqual(o.result ?? {}, {}, `${role}`);
      assert.deepEqual([...(o.dangers ?? [])].sort(), [...labels].sort(), `${role}`);
    }
  });
}
