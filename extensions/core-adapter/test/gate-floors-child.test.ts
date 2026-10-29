import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";

const base: FloorEnv = { cwd: "/w/repo", home: "/h/me", writeRoots: ["/w/repo", "/tmp"], currentBranch: () => "feature/x", remoteHead: () => "main" };
const child: FloorEnv = { ...base, child: true };
const hit = (line: string, e: FloorEnv) => lineFloors(line, parseShell(line, { cwd: e.cwd }), e);

test("a child never pushes: every form is a floor deny", () => {
  for (const l of [
    "git push origin HEAD",
    "git push -u origin feature/x",
    "git -C /w/other push origin feature/x",
    "git push --no-verify origin feature/x",
    "git status && git push origin feature/x",
    "echo ok; git push",
    "FOO=1 git push origin HEAD",
  ]) {
    const h = hit(l, child);
    assert.equal(h?.rule, "floor-git-push-child", l);
    assert.match(h?.reason ?? "", /never push; the foreman pushes/, l);
  }
});

test("a child's non-push git lines are not floored", () => {
  for (const l of ["git status", "git log --oneline -3", "git commit -m push"]) assert.equal(hit(l, child), null, l);
});

test("owner, round and headless sessions keep the push for review (own branch not floored)", () => {
  assert.equal(hit("git push -u origin feature/x", base), null);
  assert.equal(hit("git -C /w/other push origin feature/x", base), null);
  assert.equal(hit("git status && git push origin feature/x", { ...base, child: false }), null);
});

test("push floors for force and protected targets still apply outside the child kind", () => {
  assert.equal(hit("git push --force origin feature/x", base)?.rule, "floor-git-push-force");
  assert.equal(hit("git push origin main", base)?.rule, "floor-git-push-protected");
});
