// Round 2, step 2: project files that run as the owner. `.claude/settings*.json` and `.mcp.json` of the own worktree or cwd are a self-modification
// hit (`selfmod-project-claude`, the class of the project `.pi` rule); the `.agents` / `.claude/agents` rows and the package-file rows pin what the gate answers today.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateDecide, type GateResult } from "../gate.ts";
import type { FloorEnv } from "../floors.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { pathSelfmod } from "../selfmod.ts";

const posixOnly = { skip: process.platform === "win32" };
const base = fs.realpathSync.native(mkTestTmp("pf-r2-selfmod-"));
test.after(() => rmTestTmp(base));
const home = path.join(base, "home");
const work = path.join(base, "work");
const other = path.join(base, "other");
const scr = path.join(base, "scr");
for (const d of [home, scr, path.join(work, ".claude", "agents"), path.join(work, "sub"), path.join(other, ".claude"), path.join(other, ".agents", "skills", "x")]) fs.mkdirSync(d, { recursive: true });
const PKG_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const mkRoots = (role: string, extra: object = {}) => ({ worktree: work, scratch: [scr], tmp: [fs.realpathSync.native(os.tmpdir()), "/tmp"], scratchBase: path.join(base, "scrbase"), owned: [], install: [], roundFlow: [], handoffs: [], child: role !== "foreman", role, tmpAccess: true, ...(role === "reviewer" ? { roundReadOnly: true } : {}), ...extra }) as never;
const envOf = (child: boolean, extra: Partial<FloorEnv> = {}): FloorEnv => ({ cwd: work, home, agentDir: path.join(home, ".pi", "agent"), writeRoots: [work, scr], scratch: [scr], pkgRoot: PKG_ROOT, child, ...extra });
const ans = (role: string, tool: string, input: Record<string, unknown>, extra: Partial<FloorEnv> = {}): string => {
  const r: GateResult = gateDecide(tool, input, work, { env: () => envOf(role !== "foreman", extra), roots: () => mkRoots(role, extra.pkgRoot ? { pkgRoot: extra.pkgRoot } : {}) });
  return r === null || r === undefined ? "none" : "block" in r && r.block ? `block:${r.rule}` : "ask" in r && r.ask ? `ask:${r.rule}` : `allow:${(r as { rule?: string }).rule}`;
};
const RULE = "selfmod-project-claude";
const FILES = [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"];
const writers = (f: string): [string, Record<string, unknown>][] => [
  ["write", { path: f, content: "{}" }], ["edit", { path: f, edits: [] }], ["bash", { command: `echo x > ${f}` }], ["bash", { command: `cp a ${f}` }], ["bash", { command: `sed -i s/a/b/ ${f}` }], ["bash", { command: `tee ${f}` }],
];

test("5g: a write of .claude/settings*.json or .mcp.json asks main, is denied for a builder, and a reviewer is refused by the same rule", () => {
  for (const f of FILES) {
    for (const [tool, input] of writers(f)) {
      const at = `${tool} ${JSON.stringify(input)}`;
      assert.equal(ans("foreman", tool, input), `ask:${RULE}`, at);
      assert.equal(ans("builder", tool, input), `block:${RULE}`, at);
      // the selfmod layer answers before the read-only round refusal (`child-readonly-write`)
      assert.equal(ans("reviewer", tool, input), `block:${RULE}`, at);
    }
  }
});

test("5g: a write whose target is the .claude folder itself is a hit", () => {
  for (const line of ["cp f .claude/", "cp -t .claude f", "mv d .claude", "ln -s d .claude"]) {
    assert.equal(ans("foreman", "bash", { command: line }), `ask:${RULE}`, line);
    assert.equal(ans("builder", "bash", { command: line }), `block:${RULE}`, line);
    assert.equal(ans("reviewer", "bash", { command: line }), `block:${RULE}`, line);
  }
});

test("5g: other paths in .claude, a nested .mcp.json and reads stay free", () => {
  for (const f of [".claude/agents/x.md", ".claude/commands/y.md", ".claude/settingsdir/x", "sub/.mcp.json"]) {
    for (const [tool, input] of writers(f)) {
      for (const role of ["foreman", "builder"]) assert.ok(!/selfmod/.test(ans(role, tool, input)), `${role}: ${tool} ${JSON.stringify(input)}`);
    }
  }
  assert.equal(ans("foreman", "write", { path: ".claude/agents/x.md", content: "x" }), "allow:path-write-worktree");
  assert.equal(ans("builder", "write", { path: "sub/.mcp.json", content: "x" }), "allow:path-write-worktree");
  for (const role of ["foreman", "builder", "reviewer"]) {
    assert.equal(ans(role, "read", { path: ".claude/settings.json" }), "allow:path-read-worktree", role);
    assert.equal(ans(role, "bash", { command: "cat .claude/settings.json" }), "allow:default-read", role);
  }
});

test("5g: the same files in another project are unchanged: a builder is refused as a write outside, main answers as for a plain file", posixOnly, () => {
  for (const f of [path.join(other, ".claude", "settings.json"), path.join(other, ".mcp.json")]) {
    for (const [tool, input] of writers(f)) {
      assert.equal(ans("builder", tool, input), "block:child-write-outside", `${tool} ${JSON.stringify(input)}`);
      const plain = JSON.parse(JSON.stringify(input).split(f).join(path.join(other, "plain.txt")));
      assert.equal(ans("foreman", tool, input), ans("foreman", tool, plain), `${tool} ${JSON.stringify(input)}`);
    }
  }
});

test("5a: .agents/skills and .claude/agents in the own worktree are free for main and a builder, a reviewer gets child-readonly-write", () => {
  for (const f of [".agents/skills/x/SKILL.md", ".claude/agents/x.md"]) {
    for (const [tool, input] of [["write", { path: f, content: "x" }], ["bash", { command: `echo x > ${f}` }]] as const) {
      const [m, b] = tool === "write" ? ["allow:path-write-worktree", "allow:path-write-worktree"] : ["none", "none"];
      assert.equal(ans("foreman", tool, input), m, `${tool} ${f}`);
      assert.equal(ans("builder", tool, input), b, `${tool} ${f}`);
      assert.equal(ans("reviewer", tool, input), "block:child-readonly-write", `${tool} ${f}`);
    }
  }
});

test("5a: a builder's write to .agents in another project is a write outside", posixOnly, () => {
  const f = path.join(other, ".agents", "skills", "x", "SKILL.md");
  assert.equal(ans("builder", "write", { path: f, content: "x" }), "block:child-write-outside");
  assert.equal(ans("builder", "bash", { command: `echo x > ${f}` }), "block:child-write-outside");
});

// spellings the rule must hold on wherever the `.pi/settings.json` neighbour holds: the answer kind is compared row by row
const direct = (platform: string, wt: string, p: string, extra: object = {}): string | undefined =>
  pathSelfmod("write", { path: p }, wt, { ...(mkRoots("builder") as object), worktree: wt, scratch: [], realpath: () => null, ...extra } as never, platform)?.rule;

test("5g win32: a lowercase drive letter, forward slashes, trailing dot, space and ::$DATA hit as they do on .pi/settings.json", () => {
  const wt = "C:\\work";
  const rows: [string, string][] = [
    ["c:\\work\\.mcp.json", "c:\\work\\.pi\\settings.json"], ["c:/work/.mcp.json", "c:/work/.pi/settings.json"], ["C:\\WORK\\.MCP.JSON", "C:\\WORK\\.PI\\SETTINGS.JSON"],
    ["c:/work/.CLAUDE/Settings.Local.json", "c:/work/.PI/Settings.json"], ["C:\\work\\.claude\\settings.json.", "C:\\work\\.pi\\settings.json."],
    ["C:\\work\\.claude\\settings.json::$DATA", "C:\\work\\.pi\\settings.json::$DATA"], ["C:\\work\\.claude\\settings.json ", "C:\\work\\.pi\\settings.json "],
    ["C:\\work\\.mcp.json.", "C:\\work\\.pi\\settings.json."], ["C:\\work\\.mcp.json::$DATA", "C:\\work\\.pi\\settings.json::$DATA"],
  ];
  for (const [claude, pi] of rows) {
    assert.ok(direct("win32", wt, pi), `neighbour ${pi}`);
    assert.equal(direct("win32", wt, claude), RULE, claude);
  }
  assert.equal(direct("win32", wt, "C:\\work\\sub\\.mcp.json"), undefined);
  assert.equal(direct("win32", wt, "C:\\work\\.claude\\settingsx"), undefined);
});

test("5g linux: the name test stays case-sensitive", () => {
  const wt = "/w";
  assert.equal(direct("linux", wt, "/w/.claude/settings.local.json"), RULE);
  assert.equal(direct("linux", wt, "/w/.claude/Settings.Local.json"), undefined);
  assert.equal(direct("linux", wt, "/w/.MCP.json"), undefined);
  assert.equal(direct("linux", wt, "/w/.mcp.json"), RULE);
});

test("5g darwin: a case variant of a settings file that does not exist yet hits (the filesystem is case-insensitive)", { skip: process.platform !== "darwin" }, (t) => {
  const dir = path.join(base, "cs");
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  if (!fs.existsSync(path.join(dir, ".CLAUDE"))) return t.skip("case-sensitive volume");
  assert.equal(direct("darwin", dir, path.join(dir, ".claude", "Settings.Local.json"), { realpath: undefined }), RULE);
  assert.equal(direct("darwin", dir, path.join(dir, ".MCP.json"), { realpath: undefined }), RULE);
  assert.ok(direct("darwin", dir, path.join(dir, ".PI", "settings.json"), { realpath: undefined }), "neighbour");
});

test("5g: a write to a hard link of .claude/settings*.json or .mcp.json from a free path hits, as for .pi/settings.json", posixOnly, (t) => {
  const dir = path.join(base, "hl");
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  const targets: [string, string][] = [[".claude/settings.json", RULE], [".claude/settings.local.json", RULE], [".mcp.json", RULE], [".pi/settings.json", "selfmod-project-settings"]];
  for (const [rel, rule] of targets) {
    fs.writeFileSync(path.join(dir, rel), "{}");
    const lnk = path.join(dir, `link-${rel.replace(/[\\/]/g, "_")}`);
    try {
      fs.linkSync(path.join(dir, rel), lnk);
    } catch {
      t.skip("hard links unsupported");
      return;
    }
    assert.equal(direct(process.platform, dir, lnk, { realpath: undefined }), rule, rel);
  }
  const plain = path.join(dir, "plain.json");
  fs.writeFileSync(plain, "{}");
  assert.equal(direct(process.platform, dir, plain, { realpath: undefined }), undefined);
});

test("5e: config/foreman.defaults.json and package.json of the own worktree are free for main and a builder, whether or not the worktree is the package root", () => {
  const elsewhere = path.join(base, "pkg-elsewhere");
  fs.mkdirSync(elsewhere, { recursive: true });
  for (const extra of [{ pkgRoot: elsewhere }, { pkgRoot: work }]) {
    for (const f of ["config/foreman.defaults.json", "package.json"]) {
      for (const role of ["foreman", "builder"]) {
        assert.equal(ans(role, "write", { path: f, content: "{}" }, extra), "allow:path-write-worktree", `${role} write ${f} ${JSON.stringify(extra)}`);
        assert.equal(ans(role, "bash", { command: `echo x > ${f}` }, extra), "none", `${role} redirect ${f} ${JSON.stringify(extra)}`);
      }
    }
  }
});
