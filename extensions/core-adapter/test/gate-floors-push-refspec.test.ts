// Push floor narrowing: a `src:dst` refspec is no longer always a force push. Only a leading `+` or an empty source (`:dst`, a delete) is force/delete;
// for `src:dst` the destination goes through the protected/default-branch check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", platform: "linux", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/tmp"], scratch: [], protectedBranches: ["release/*"], currentBranch: () => "feature/x", remoteHead: () => "main" };
const floor = (line: string): string | null => lineFloors(line, parseShell(line, { cwd: env.cwd, platform: "linux" }), env)?.rule ?? null;

test("push refspecs: src:dst to an own branch passes", () => {
  assert.equal(floor("git push origin HEAD:round/x"), null);
  assert.equal(floor("git push origin a:feature/b"), null);
  assert.equal(floor("git push -u origin round/x-y:round/x-y"), null);
  assert.equal(floor("git push origin HEAD:refs/heads/round/x"), null);
});

test("push refspecs: +src, :dst, force flags and a protected or default destination stay refused", () => {
  assert.equal(floor("git push origin +round/x"), "floor-git-push-force");
  assert.equal(floor("git push origin +a:round/x"), "floor-git-push-force");
  assert.equal(floor("git push origin :round/x"), "floor-git-push-force");
  assert.equal(floor("git push --force origin round/x"), "floor-git-push-force");
  assert.equal(floor("git push -f origin round/x"), "floor-git-push-force");
  assert.equal(floor("git push origin HEAD:main"), "floor-git-push-protected");
  assert.equal(floor("git push origin HEAD:refs/heads/main"), "floor-git-push-protected");
  assert.equal(floor("git push origin a:release/1.0"), "floor-git-push-protected");
});
