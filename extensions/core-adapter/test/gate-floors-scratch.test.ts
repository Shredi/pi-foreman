// r79 item 4 (gate-log false positives, 2026-10-31): config-keys and git-config ignore files and repos under the child's own OS-temp scratch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, pathFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";

const SCR = "/var/folders/zz/T/pi-foreman-scratch/sess/run";
const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", SCR], scratch: [SCR], protectedBranches: [], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const floor = (line: string, e: FloorEnv = env): string | null => lineFloors(line, parseShell(line, { cwd: e.cwd }), e)?.rule ?? null;

test("config-keys: a scratch copy of the schema or config is not a live config file", () => {
  assert.equal(floor(`sed -i 's/"gate"/"gate2"/' ${SCR}/x/config/foreman.schema.json`), null);
  assert.equal(floor(`sed -i 's/"gate"/"gate2"/' ${SCR}/x/config/foreman.json`), null);
  assert.equal(floor(`echo '{"gate":{}}' > ${SCR}/x/config/foreman.schema.json`), null);
  assert.equal(pathFloors({ path: `${SCR}/x/config/foreman.schema.json`, content: '{"gate":{}}' }, env, "write"), null);
});

test("config-keys: live config files still fire", () => {
  assert.equal(floor(`sed -i 's/"gate"/"gate2"/' /w/repo/config/foreman.schema.json`), "floor-config-keys");
  assert.equal(floor(`echo '{"gate":{}}' > /h/me/.pi/agent/foreman.json`), "floor-config-keys");
  assert.equal(pathFloors({ path: "/w/repo/config/foreman.schema.json", content: '{"gate":{}}' }, env, "write")?.rule, "floor-config-keys");
  assert.equal(floor(`sed -i 's/"gate"/"gate2"/' /var/folders/zz/T/other/pi-foreman-scratch/s/r/../../../../../../../../w/repo/config/foreman.json`), "floor-config-keys");
});

test("git-config: a repo under the own scratch is not the repo's config", () => {
  assert.equal(floor(`git -C ${SCR}/repo config user.email a@b`), null);
  assert.equal(floor(`git -C ${SCR}/repo config core.hooksPath /x`), null);
  assert.equal(floor(`cd ${SCR}/repo && git config user.name x`), null);
  assert.equal(floor(`git --git-dir=${SCR}/repo/.git config user.name x`), null);
  assert.equal(floor(`git config --file ${SCR}/repo/cfg user.name x`), null);
  assert.equal(floor("git config user.email a@b", { ...env, cwd: SCR }), null);
});

test("git-config: the worktree, the global and the system config are unchanged", () => {
  assert.equal(floor("git config core.hooksPath /x"), "floor-git-config");
  assert.equal(floor("git config user.email a@b"), null);
  assert.equal(floor(`git -C /w/repo config core.hooksPath ${SCR}/h`), "floor-git-config");
  assert.equal(floor("git config --global core.hooksPath /x"), "floor-git-config");
  assert.equal(floor("git config --system credential.helper x"), "floor-git-config");
  assert.equal(floor(`git -C ${SCR}/repo config --global core.hooksPath /x`), "floor-git-config");
});
