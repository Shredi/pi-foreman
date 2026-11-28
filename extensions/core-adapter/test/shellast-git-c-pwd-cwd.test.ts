// `git -C "$PWD"` keeps the tracked folder as the segment cwd whatever its spelling: a native drive path (backslashes, any drive-letter case) stays itself,
// also when the parse platform is not win32 (the fastallow-git-c-pwd test runs the gate with platform "linux" on a Windows host). Runs on any host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShell } from "../shellast.ts";

test("git -C $PWD: the segment cwd is the tracked folder, for posix and drive paths, on any parse platform", () => {
  const cases: Array<[string, string]> = [["linux", "/r/wt"], ["linux", "D:\\a\\wt"], ["win32", "D:\\a\\wt"], ["win32", "d:\\a\\wt"]];
  for (const [platform, cwd] of cases) {
    for (const l of ['git -C "$PWD" add x', "git -C $PWD add x", 'git -C "${PWD}" add x']) {
      const segs = parseShell(l, { cwd, platform } as never);
      assert.equal(segs.length, 1, `${platform} ${cwd} ${l}`);
      assert.equal(segs[0].cwd, cwd, `${platform} ${cwd} ${l}`);
    }
  }
});
