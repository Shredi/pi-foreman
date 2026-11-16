// Round 2, step 2 (S2): the old permission layer's fold of Windows 8.3 short names (`CLAUDE~1`, `MCP~1.JSO`, `FOREMA~1.JSO`, hash form `CL4F2A~5`) lives in the
// gate's path comparison: the selfmod rules, the secret path floor and a child's `.git` refusal. Win32 rows are simulated on every host (path.win32 fixtures,
// platform "win32", realpath injected as null so the short name stays a name); posix rows prove nothing folds there.
// Old-layer pins of winpaths.test.ts:35-39 and their gate labels:
//   CLAUDE~1\settings.json        ask/deny -> selfmod-project-claude
//   claude~1/settings.local.json  ask/deny -> selfmod-project-claude
//   MCP~1.JSO                     ask/deny -> selfmod-project-claude
//   C:\Profiles\u\PI~1\agent\settings.json ask/deny -> selfmod-agent-settings
//   C:\Profiles\u\CL4F2A~5\settings.json   ask/deny -> selfmod-user-config (the home's .claude folder)
//   GIT~1\config                  deny/deny -> folderProtected (child .git refusal)
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { pathSelfmod } from "../selfmod.ts";
import { secretPath, type FloorEnv } from "../floors.ts";
import { folderProtected, type GateRoots } from "../pathrules.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import { shortNameFits, shortNameSpellings } from "../pathnorm.ts";

const roots = (platform: string, o: Partial<GateRoots> = {}): GateRoots => {
  const win = platform === "win32";
  return {
    worktree: win ? "C:\\work" : "/w/work", scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: true,
    agentDir: win ? "C:\\Profiles\\u\\.pi\\agent" : "/w/home/.pi/agent", home: win ? "C:\\Profiles\\u" : "/w/home", realpath: () => null, ...o,
  };
};
const rule = (platform: string, p: string): string | undefined => pathSelfmod("write", { path: p }, platform === "win32" ? "C:\\work" : "/w/work", roots(platform), platform)?.rule;

test("win32: the winpaths.test.ts pins hold at the gate (selfmod rows)", () => {
  assert.equal(rule("win32", "CLAUDE~1\\settings.json"), "selfmod-project-claude");
  assert.equal(rule("win32", "claude~1/settings.local.json"), "selfmod-project-claude");
  assert.equal(rule("win32", "MCP~1.JSO"), "selfmod-project-claude");
  assert.equal(rule("win32", "C:\\Profiles\\u\\PI~1\\agent\\settings.json"), "selfmod-agent-settings");
  assert.equal(rule("win32", "C:\\Profiles\\u\\CL4F2A~5\\settings.json"), "selfmod-user-config", "hash form");
  assert.equal(rule("win32", "C:\\work\\CLAUDE~1"), "selfmod-project-claude", "the folder itself");
});

test("win32: FOREMA~1.JSO in the agent dir and the other harness names are hits", () => {
  assert.equal(rule("win32", "C:\\Profiles\\u\\.pi\\agent\\FOREMA~1.JSO"), "selfmod-agent-harness");
  assert.equal(rule("win32", "C:\\Profiles\\u\\.pi\\agent\\CLAUDE~1.JSO"), "selfmod-agent-harness", "claude-bridge.json");
  assert.equal(rule("win32", "C:\\Profiles\\u\\.pi\\agent\\EXTENS~1\\x.ts"), "selfmod-agent-harness");
  assert.equal(rule("win32", "C:\\Profiles\\u\\.pi\\AGENT~1\\foreman.json"), undefined, "AGENT~1 is no spelling of the agent dir `agent` here: real path expansion covers existing dirs");
  assert.equal(rule("win32", "C:\\work\\PI~1\\x.json"), "selfmod-project-pi");
});

test("win32 controls: RUNNER~1, a short name that fits no protected name and an ordinary name change nothing", () => {
  assert.equal(rule("win32", "C:\\Users\\RUNNER~1\\x.json"), undefined);
  assert.equal(rule("win32", "C:\\work\\PROGRA~1\\settings.json"), undefined);
  assert.equal(rule("win32", "C:\\work\\XYZ~1\\x"), undefined);
  assert.equal(rule("win32", "C:\\work\\sub\\MCP~1.JSO"), undefined, "only where the protected name sits");
  assert.equal(rule("win32", "C:\\work\\.mcp.json"), "selfmod-project-claude", "the long name is unchanged");
  assert.equal(rule("win32", "C:\\work\\notes.md"), undefined);
});

test("posix: the same spellings are ordinary names", () => {
  assert.equal(rule("linux", "CLAUDE~1/settings.json"), undefined);
  assert.equal(rule("linux", "MCP~1.JSO"), undefined);
  assert.equal(rule("linux", "/w/home/.pi/agent/FOREMA~1.JSO"), undefined);
  assert.equal(rule("linux", "/w/home/PI~1/agent/settings.json"), undefined);
  assert.equal(rule("linux", "/w/work/.mcp.json"), "selfmod-project-claude");
  assert.deepEqual(shortNameSpellings("linux", "CLAUDE~1/settings.json", [".claude"]), []);
  assert.deepEqual(shortNameSpellings("darwin", "CLAUDE~1/settings.json", [".claude"]), []);
});

const wenv: FloorEnv = { platform: "win32", cwd: "C:\\work\\repo", home: "C:\\Users\\me", agentDir: "C:\\Users\\me\\.pi\\agent" };
const lenv: FloorEnv = { platform: "linux", cwd: "/w/repo", home: "/w/me", agentDir: "/w/me/.pi/agent" };

test("win32 secret floor: a short-name folder or file of a secret name is a secret path", () => {
  for (const p of ["C:\\Users\\me\\.ssh\\id_x", "C:\\Users\\me\\SSH~1\\id_x", "C:\\Users\\me\\GNUPG~1\\key", "C:\\Users\\me\\AWS~1\\credentials", "C:\\Users\\me\\.aws\\CREDEN~1",
    "C:\\Users\\me\\NETRC~1", "C:\\Users\\me\\GIT-CR~1", "C:\\Users\\me\\.pi\\agent\\AUTH~1.JSO", "C:\\Users\\me\\.pi\\AGENT~1\\auth.json", "C:\\Users\\me\\.CONFIG\\GCLOUD~1\\x", "C:\\work\\repo\\GIT~1\\config"]) {
    assert.equal(secretPath(p, wenv)?.rule, "floor-secret-path", p);
  }
});

test("win32 secret floor controls: RUNNER~1, a non-fitting short name, a plain path and the long names", () => {
  for (const p of ["C:\\Users\\RUNNER~1\\x.txt", "C:\\Users\\me\\PROGRA~1\\x", "C:\\Users\\me\\FOO~1\\id_x", "C:\\Users\\me\\docs\\notes.txt", "C:\\work\\repo\\GITHUB~1\\x"]) {
    assert.equal(secretPath(p, wenv), null, p);
  }
  assert.equal(secretPath("C:\\Users\\me\\.ssh\\id_x", wenv)?.rule, "floor-secret-path");
});

test("posix secret floor: the short-name spellings are not folded", () => {
  for (const p of ["/w/me/SSH~1/id_x", "/w/me/.pi/agent/AUTH~1.JSO", "/w/me/GNUPG~1/key", "/w/repo/GIT~1/config"]) assert.equal(secretPath(p, lenv), null, p);
  assert.equal(secretPath("/w/me/.ssh/id_x", lenv)?.rule, "floor-secret-path");
});

test("win32 child .git refusal: GIT~1 is a .git alias, RUNNER~1 is not (folderProtected, unchanged)", () => {
  const w = path.win32;
  const r = roots("win32", { workFolders: [{ path: "C:\\work", mode: "auto" }] });
  assert.equal(folderProtected(r, "win32", w.join("C:\\work", "repo", "GIT~1", "config")), true);
  assert.equal(folderProtected(r, "win32", w.join("C:\\work", "repo", ".git", "config")), true);
  assert.equal(folderProtected(r, "win32", w.join("C:\\work", "repo", "RUNNER~1", "x")), false);
  assert.equal(folderProtected(roots("linux"), "linux", "/w/work/repo/GIT~1/config"), false);
});

// The gate: a child's write into git internals under an 8.3 or cased spelling of `.git` is refused like the long form (`child-write-outside`, in the worktree and
// in the scratch dir); the main session's answer for the short form is its answer for the long form (no decision from the path step).
type Res = { block?: boolean; allow?: boolean; rule?: string } | undefined;
const gate = (platform: string, role: string, child: boolean, tool: string, input: Record<string, unknown>): Res => {
  const win = platform === "win32";
  const r: GateRoots = {
    worktree: win ? "C:\\work" : "/w/work", scratch: [win ? "C:\\scratch\\mine" : "/w/scratch/mine"], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child, role, tmpAccess: false,
    agentDir: win ? "C:\\Profiles\\u\\.pi\\agent" : "/w/home/.pi/agent", home: win ? "C:\\Profiles\\u" : "/w/home", realpath: () => null, ...(role === "reviewer" ? { roundReadOnly: true } : {}),
  };
  return gateEvaluate(tool, input, r.worktree, { env: (c) => baseFloorEnv(c, { child, platform }), roots: () => r }).result as Res;
};
const label = (r: Res): string => (r ? (r.block ? `block:${r.rule}` : r.allow ? `allow:${r.rule}` : "other") : "undecided");
const WIN_DIRS: Array<[string, string]> = [["C:\\work", "worktree"], ["C:\\scratch\\mine", "scratch"]];

test("win32 gate: a child's write into GIT~1, git~1, GIT~2 or .GIT is refused like .git (child-write-outside)", () => {
  for (const [d, where] of WIN_DIRS) {
    const long = label(gate("win32", "builder", true, "write", { path: `${d}\\.git\\HEAD`, content: "x" }));
    assert.equal(long, "block:child-write-outside", `${where}: the long form`);
    for (const n of ["GIT~1\\HEAD", "git~1/HEAD", "GIT~1\\hooks\\pre-commit", ".GIT\\HEAD", "GIT~2\\HEAD"]) {
      for (const tool of ["write", "edit"]) assert.equal(label(gate("win32", "builder", true, tool, { path: `${d}\\${n}`, content: "x", edits: [] })), long, `${where} ${tool} ${n}`);
      assert.equal(label(gate("win32", "reviewer", true, "write", { path: `${d}\\${n}`, content: "x" })), long, `${where} reviewer ${n}`);
    }
  }
});

test("win32 gate: a shell redirect or copier into GIT~1\\hooks is refused like .git\\hooks", () => {
  for (const [d, where] of WIN_DIRS) {
    const f = d.replace(/\\/g, "/");
    for (const role of ["builder", "reviewer"]) {
      const long = label(gate("win32", role, true, "bash", { command: `echo x > ${f}/.git/hooks/x` }));
      assert.equal(long, "block:child-write-outside", `${where} ${role} long`);
      for (const c of [`echo x > ${f}/GIT~1/hooks/x`, `cp a ${f}/GIT~1/hooks/x`]) assert.equal(label(gate("win32", role, true, "bash", { command: c })), long, `${where} ${role} ${c}`);
    }
  }
});

test("win32 gate: the main session answers the short form as the long form", () => {
  for (const [d] of WIN_DIRS) {
    const long = label(gate("win32", "main", false, "write", { path: `${d}\\.git\\HEAD`, content: "x" }));
    for (const n of ["GIT~1\\HEAD", "git~1/HEAD", "GIT~1\\hooks\\pre-commit", ".GIT\\HEAD", "GIT~2\\HEAD"]) assert.equal(label(gate("win32", "main", false, "write", { path: `${d}\\${n}`, content: "x" })), long, n);
  }
});

test("win32 gate controls: GITHUB~1 and a nested GIT~1X stay ordinary writes", () => {
  assert.equal(label(gate("win32", "builder", true, "write", { path: "C:\\work\\GITHUB~1\\x", content: "x" })), "allow:path-write-worktree");
  assert.equal(label(gate("win32", "builder", true, "write", { path: "C:\\work\\docs\\GIT~1X\\y", content: "x" })), "allow:path-write-worktree");
  assert.equal(label(gate("win32", "builder", true, "write", { path: "C:\\scratch\\mine\\GITHUB~1\\x", content: "x" })), "allow:path-write-scratch");
  assert.equal(label(gate("win32", "main", false, "write", { path: "C:\\work\\GITHUB~1\\x", content: "x" })), "allow:path-write-worktree");
});

test("posix gate: GIT~1 and .GIT are ordinary names for a child, .git is still refused", () => {
  for (const platform of ["linux", "darwin"]) {
    for (const d of ["/w/work", "/w/scratch/mine"]) {
      const ok = d === "/w/work" ? "allow:path-write-worktree" : "allow:path-write-scratch";
      for (const n of ["GIT~1/HEAD", "git~1/HEAD", ".GIT/HEAD"]) assert.equal(label(gate(platform, "builder", true, "write", { path: `${d}/${n}`, content: "x" })), ok, `${platform} ${d} ${n}`);
      assert.equal(label(gate(platform, "builder", true, "write", { path: `${d}/.git/HEAD`, content: "x" })), "block:child-write-outside", `${platform} ${d} .git`);
    }
  }
});

test("shortNameFits keeps the old layer's answers", () => {
  assert.equal(shortNameFits("FOREMA~1.JSO", "foreman.json"), true);
  assert.equal(shortNameFits("CLAUDE~1", ".claude"), true);
  assert.equal(shortNameFits("CL4F2A~5", ".claude"), true);
  assert.equal(shortNameFits("RUNNER~1", ".claude"), false);
});
