// A child's write into `.git` under any case is refused on every platform (a default macOS disk folds case): `.GIT` and `.Git` answer like `.git`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GateRoots } from "../pathrules.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";

type Res = { block?: boolean; allow?: boolean; rule?: string } | undefined;
const DIRS: Array<[string, string]> = [["/w/work", "worktree"], ["/w/scratch/mine", "scratch"], ["/w/out/mine", "out"]];
const gate = (platform: string, role: string, tool: string, input: Record<string, unknown>): Res => {
  const r: GateRoots = {
    worktree: "/w/work", scratch: ["/w/scratch/mine", "/w/out/mine"], out: "/w/out/mine", tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role, tmpAccess: false,
    agentDir: "/w/home/.pi/agent", home: "/w/home", realpath: () => null, ...(role === "reviewer" ? { roundReadOnly: true } : {}),
  } as GateRoots;
  return gateEvaluate(tool, input, r.worktree, { env: (c) => baseFloorEnv(c, { child: true, platform }), roots: () => r }).result as Res;
};
const label = (r: Res): string => (r ? (r.block ? `block:${r.rule}` : r.allow ? `allow:${r.rule}` : "other") : "undecided");
const PLATFORMS = ["linux", "darwin"];
const ROLES = ["builder", "reviewer"];

test("a child's write into .GIT or .Git is refused like .git", () => {
  for (const platform of PLATFORMS) for (const role of ROLES) for (const [d, where] of DIRS) {
    for (const rel of ["clone/.git/hooks/x", "clone/.GIT/hooks/x", "clone/.Git/hooks/x", ".GIT/HEAD", ".Git/HEAD"]) {
      for (const tool of ["write", "edit"]) {
        const l = label(gate(platform, role, tool, { path: `${d}/${rel}`, content: "x", edits: [] }));
        assert.equal(l, "block:child-write-outside", `${platform} ${role} ${where} ${tool} ${rel}`);
      }
    }
  }
});

test("a shell redirect or cp into .GIT is refused like .git", () => {
  for (const platform of PLATFORMS) for (const role of ROLES) for (const [d, where] of DIRS) {
    for (const sp of [".git", ".GIT", ".Git"]) {
      for (const c of [`echo x > ${d}/clone/${sp}/hooks/x`, `cp a ${d}/clone/${sp}/hooks/x`]) {
        assert.equal(label(gate(platform, role, "bash", { command: c })), "block:child-write-outside", `${platform} ${role} ${where} ${c}`);
      }
    }
  }
});

test("controls: .github, .gitx and .gitignore under scratch stay allowed; GIT~1 is no alias on posix", () => {
  for (const platform of PLATFORMS) for (const [d, where] of DIRS.slice(1)) {
    for (const rel of [".github/x", ".gitx/x", ".gitignore", "GIT~1/x"]) {
      assert.equal(label(gate(platform, "builder", "write", { path: `${d}/clone/${rel}`, content: "x" })).startsWith("block"), false, `${platform} ${where} ${rel}`);
    }
  }
});
