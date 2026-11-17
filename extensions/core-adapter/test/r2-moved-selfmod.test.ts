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

// step 2, rows 5b to 5d (ruling D1): the user-level harness and config folders, with a fixture home, agent dir and config home
const uHome = path.join(base, "uh", "home");
const uAgent = path.join(uHome, ".pi", "agent");
const uXdg = path.join(base, "uh", "xdg");
const uHand = path.join(uAgent, "pi-foreman", "handoffs", "20261115-100000-x");
for (const d of [uAgent, uXdg, uHand]) fs.mkdirSync(d, { recursive: true });
const userAns = (role: string, tool: string, input: Record<string, unknown>, rootsExtra: object = { home: uHome, configHome: uXdg }): string => {
  const r: GateResult = gateDecide(tool, input, work, { env: () => envOf(role !== "foreman", { home: uHome, agentDir: uAgent }), roots: () => mkRoots(role, { agentDir: uAgent, ...rootsExtra }) });
  return r === null || r === undefined ? "none" : "block" in r && r.block ? `block:${r.rule}` : "ask" in r && r.ask ? `ask:${r.rule}` : `allow:${(r as { rule?: string }).rule}`;
};
/** main asks with `rule`, a builder is denied by it, a reviewer is refused by it. */
function refused(rule: string, tool: string, input: Record<string, unknown>, rootsExtra?: object): void {
  const at = `${tool} ${JSON.stringify(input)}`;
  assert.equal(userAns("foreman", tool, input, rootsExtra), `ask:${rule}`, `foreman: ${at}`);
  assert.equal(userAns("builder", tool, input, rootsExtra), `block:${rule}`, `builder: ${at}`);
  assert.equal(userAns("reviewer", tool, input, rootsExtra), `block:${rule}`, `reviewer: ${at}`);
}

test("5b: the agent dir harness folders and files are asked for main, denied for a builder, refused for a reviewer, whatever the write", posixOnly, () => {
  for (const name of ["extensions", "npm", "agents", "intercom", "claude-config"]) {
    const dir = path.join(uAgent, name);
    const file = path.join(dir, "x.ts");
    refused("selfmod-agent-harness", "write", { path: file, content: "x" });
    refused("selfmod-agent-harness", "bash", { command: `echo x > ${file}` });
    refused("selfmod-agent-harness", "bash", { command: `cp a ${dir}/` });
    refused("selfmod-agent-harness", "bash", { command: `cp a ${file}` });
    refused("selfmod-agent-harness", "bash", { command: `sed -i s/a/b/ ${file}` });
    refused("selfmod-agent-harness", "bash", { command: `mv d ${dir}` });
    refused("selfmod-agent-harness", "bash", { command: `mv ${file} ${scr}/y` });
  }
  for (const name of ["foreman.json", "claude-bridge.json"]) {
    const file = path.join(uAgent, name);
    refused("selfmod-agent-harness", "write", { path: file, content: "{}" });
    refused("selfmod-agent-harness", "bash", { command: `echo x > ${file}` });
    refused("selfmod-agent-harness", "bash", { command: `cp a ${file}` });
    refused("selfmod-agent-harness", "bash", { command: `sed -i s/a/b/ ${file}` });
    refused("selfmod-agent-harness", "bash", { command: `mv a ${file}` });
  }
});

test("5b: a tilde spelling of the agent dir harness is resolved against the home folder", posixOnly, () => {
  refused("selfmod-agent-harness", "bash", { command: "echo x > ~/.pi/agent/extensions/x.ts" });
  refused("selfmod-agent-harness", "bash", { command: "cp a ~/.pi/agent/agents/" });
  refused("selfmod-agent-harness", "write", { path: "~/.pi/agent/foreman.json", content: "{}" });
});

test("5b: the handoff identity files live.json, parent and child are asked for main, denied for a builder, refused for a reviewer", posixOnly, () => {
  for (const name of ["live.json", "parent", "child"]) {
    refused("selfmod-identity", "write", { path: path.join(uHand, name), content: "x" });
    refused("selfmod-identity", "bash", { command: `echo x > ${path.join(uHand, name)}` });
  }
});

test("5c: the user git config and the Claude folder are asked for main and denied for children", posixOnly, () => {
  const where: [string, string][] = [
    [path.join(uHome, ".gitconfig"), "~/.gitconfig"],
    [path.join(uHome, ".config", "git", "config"), "~/.config/git/config"],
    [path.join(uXdg, "git", "config"), path.join(uXdg, "git", "config")],
    [path.join(uHome, ".claude", "settings.json"), "~/.claude/settings.json"],
  ];
  for (const [abs, spelled] of where) {
    for (const role of ["foreman", "builder", "reviewer"]) {
      const ask = role === "foreman" ? "ask" : "block";
      for (const [tool, input] of [["write", { path: abs, content: "x" }], ["write", { path: spelled, content: "x" }], ["bash", { command: `echo x > ${spelled}` }], ["bash", { command: `echo x | tee ${spelled}` }], ["bash", { command: `sed -i s/a/b/ ${spelled}` }]] as [string, Record<string, unknown>][]) {
        assert.equal(userAns(role, tool, input), `${ask}:selfmod-user-config`, `${role}: ${tool} ${JSON.stringify(input)}`);
      }
    }
  }
});

test("5c: the config home spelled as a variable is not resolved (as the agent dir rules treat a variable); a roots object without home gives no 5c answer", posixOnly, () => {
  assert.ok(!/selfmod-user-config/.test(userAns("foreman", "bash", { command: "echo x > $XDG_CONFIG_HOME/git/config" })));
  const bare = { home: undefined, configHome: undefined };
  for (const [tool, input] of [["write", { path: path.join(uHome, ".gitconfig"), content: "x" }], ["write", { path: path.join(uXdg, "git", "config"), content: "x" }], ["bash", { command: "echo x > ~/.gitconfig" }], ["bash", { command: `echo x > ${path.join(uHome, ".claude", "settings.json")}` }]] as [string, Record<string, unknown>][]) {
    for (const role of ["foreman", "builder"]) assert.ok(!/selfmod-user-config/.test(userAns(role, tool, input, bare)), `${role}: ${tool} ${JSON.stringify(input)}`);
  }
});

test("5d: moving, replacing or removing the agent dir, its parent folder or its pi-foreman folder asks main and refuses a child", posixOnly, () => {
  for (const d of [uAgent, path.dirname(uAgent), path.join(uAgent, "pi-foreman")]) {
    // `rmdir` of a dir outside the write roots is already a floor deny (`floor-delete-outside`) for every role, ahead of the selfmod layer
    for (const role of ["foreman", "builder", "reviewer"]) assert.equal(userAns(role, "bash", { command: `rmdir ${d}` }), "block:floor-delete-outside", `${role}: rmdir ${d}`);
    for (const line of [`mv ${d} ${scr}/y`, `mv x ${d}`, `echo x > ${d}`]) {
      assert.equal(userAns("foreman", "bash", { command: line }), "ask:selfmod-agent-dir", line);
      assert.equal(userAns("builder", "bash", { command: line }), "block:selfmod-agent-dir", line);
      assert.equal(userAns("reviewer", "bash", { command: line }), "block:selfmod-agent-dir", line);
    }
    for (const role of ["foreman", "builder", "reviewer"]) assert.equal(userAns(role, "bash", { command: `rm -r ${d}` }), "block:floor-delete-outside", `${role}: rm -r ${d}`);
  }
});

test("5b to 5d: reads stay free", posixOnly, () => {
  const ordinary = (role: string, line: string): string => userAns(role, "bash", { command: line });
  for (const role of ["foreman", "builder"]) {
    assert.equal(ordinary(role, "cat ~/.gitconfig"), ordinary(role, "cat ~/.zshrc"), role);
    assert.equal(ordinary(role, `ls ${uAgent}/extensions`), ordinary(role, `ls ${uAgent}/sessions`), role);
    assert.equal(ordinary(role, `cp ${uAgent}/foreman.json ${scr}/x`), ordinary(role, `cp ${uAgent}/models.json ${scr}/x`), role);
    assert.ok(!/selfmod/.test(ordinary(role, "git config --global --get user.name")), role);
    assert.ok(!/selfmod/.test(userAns(role, "read", { path: path.join(uHome, ".gitconfig") })), role);
  }
});

test("5c: `git config --file <protected>` in a write form is a write target for the self-modification rules; read forms and ordinary files keep their answers", posixOnly, () => {
  const G = path.join(uHome, ".gitconfig");
  const P = path.join(work, ".pi", "settings.json");
  const writes = (f: string, spelled = f): string[] => [
    `git config --file ${spelled} user.name x`, `git config -f ${spelled} user.name x`, `git config --file=${spelled} a b`, `git config set --file ${spelled} a b`,
    `git -C ${path.join(work, "sub")} config -f ${spelled} a b`, `git config --file ${spelled} --unset a`, `git config --file ${spelled} --add a b`,
    `git config --file ${spelled} --replace-all a b`, `git config --file ${spelled} --remove-section a`, `git config --file ${spelled} --rename-section a b`,
  ];
  // a tilde inside `--file=~/x` is not a word of its own (the shell leaves it), so only the spaced spellings are given the tilde
  for (const line of [...writes(G), ...writes(G, "~/.gitconfig").filter((l) => !l.includes("--file="))]) refused("selfmod-user-config", "bash", { command: line });
  for (const line of writes(P)) refused("selfmod-project-settings", "bash", { command: line });
  refused("selfmod-project-settings", "bash", { command: "git config --file .pi/settings.json a b" });
  for (const role of ["foreman", "builder", "reviewer"]) {
    const plain = userAns(role, "bash", { command: "git config --get a.b" });
    for (const line of [`git config --file ${G} --get a.b`, `git config -f ${G} -l`, `git config --file ${G} get a.b`, `git config --file ${G} list`]) {
      assert.ok(!/selfmod/.test(userAns(role, "bash", { command: line })), `${role}: ${line}`);
      // a read-only role keeps its refusal of a `--file` form (unchanged), main and a builder answer as for the plain read
      if (role !== "reviewer") assert.equal(userAns(role, "bash", { command: line }), plain, `${role}: ${line}`);
    }
  }
  // an ordinary file of the worktree: main and a builder answer as before (no decision)
  for (const role of ["foreman", "builder"]) assert.equal(userAns(role, "bash", { command: `git config --file ${work}/x.cfg a b` }), "none", role);
});

// Row 4: a child's writes of foreman-owned paths. Roots as a child session builds them: no owned roots, its own scratch and its own handoff dir (`childHandoff`).
const agentDirC = path.join(home, ".pi", "agent");
const ownHandoff = path.join(agentDirC, "pi-foreman", "handoffs", "own");
const otherHandoff = path.join(agentDirC, "pi-foreman", "handoffs", "other");
const otherScratch = path.join(base, "scrbase", "other");
const siblingWt = path.join(base, "work.worktrees", "b1");
for (const d of [ownHandoff, otherHandoff, otherScratch, siblingWt, path.join(agentDirC, "sessions", "x", "subagent-artifacts", "run"), path.join(agentDirC, "claude-config")]) fs.mkdirSync(d, { recursive: true });
const ansChild = (role: string, tool: string, input: Record<string, unknown>): string => {
  const r: GateResult = gateDecide(tool, input, work, { env: () => envOf(true), roots: () => mkRoots(role, { agentDir: agentDirC, home, pkgRoot: PKG_ROOT, childHandoff: ownHandoff }) });
  return r === null || r === undefined ? "none" : "block" in r && r.block ? `block:${r.rule}` : "ask" in r && r.ask ? `ask:${r.rule}` : `allow:${(r as { rule?: string }).rule}`;
};
const writesOf = (p: string): [string, Record<string, unknown>][] => [["write", { path: p, content: "x" }], ["bash", { command: `echo x > ${p}` }]];

test("row 4: a child's write of another session's handoff dir, artifacts, harness config, a sibling worktree or another child's scratch is refused", posixOnly, () => {
  const rows: [string, string][] = [
    [path.join(otherHandoff, "plan.md"), "child-write-outside"], [path.join(otherHandoff, "ruling.md"), "child-write-outside"], [path.join(otherHandoff, "brief.md"), "child-write-outside"],
    [path.join(agentDirC, "sessions", "x", "subagent-artifacts", "run", "result.json"), "child-write-outside"],
    [path.join(agentDirC, "sessions", "x", "y.jsonl"), "floor-policy-file"],
    [path.join(agentDirC, "foreman.json"), "selfmod-agent-harness"], [path.join(agentDirC, "claude-config", "x.json"), "selfmod-agent-harness"],
    [path.join(siblingWt, "f.txt"), "child-write-outside"], [path.join(otherScratch, "x.txt"), "child-write-outside"],
  ];
  for (const [p, rule] of rows) {
    for (const role of ["builder", "reviewer"]) {
      for (const [tool, input] of writesOf(p)) assert.equal(ansChild(role, tool, input), `block:${rule}`, `${role}: ${tool} ${p}`);
    }
  }
});

test("row 4: a child's own handoff plan.md and result.md, scratch and worktree stay open", posixOnly, () => {
  for (const role of ["builder", "reviewer"]) {
    for (const f of ["plan.md", "result.md"]) {
      assert.equal(ansChild(role, "write", { path: path.join(ownHandoff, f), content: "x" }), "allow:path-write-handoff", `${role}: ${f}`);
      assert.ok(!ansChild(role, "bash", { command: `echo x > ${path.join(ownHandoff, f)}` }).startsWith("block"), `${role}: redirect ${f}`);
    }
    assert.equal(ansChild(role, "write", { path: path.join(scr, "x.txt"), content: "x" }), "allow:path-write-scratch", role);
    assert.equal(ansChild(role, "read", { path: path.join(scr, "x.txt") }), "allow:path-read-scratch", role);
    assert.equal(ansChild(role, "bash", { command: `cat ${path.join(scr, "x.txt")}` }), "allow:default-read", role);
    assert.equal(ansChild(role, "read", { path: path.join(work, "a.txt") }), "allow:path-read-worktree", role);
  }
  assert.equal(ansChild("builder", "write", { path: path.join(work, "a.txt"), content: "x" }), "allow:path-write-worktree");
  assert.equal(ansChild("reviewer", "write", { path: path.join(work, "a.txt"), content: "x" }), "block:child-readonly-write");
});
