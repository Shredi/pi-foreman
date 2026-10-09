// Security re-check T1/U1 fixes: drift gate on every foreman safe op (HIGH-1), submodule git dirs
// and info/attributes in the snapshot (HIGH-2), project Claude Code config snapshot (M2) and
// persisted snapshots across sessions (M4). Temp dirs only (removed on that exact path). Planted
// filters only append a marker line to a file inside the temp dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GitDriftWatch, diffGitSnapshots, safeOpDriftPreflight, takeGitSnapshot } from "../gitdrift.ts";
import { ClaudeConfigWatch } from "../claudedrift.ts";
import { registerSafeOps } from "../safeops.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "safe_ops.py");
const HOME = os.tmpdir();
const PRINT = { mode: "print", hasUI: false };
const noTrace = () => undefined;

function tmp(t: { after(fn: () => void): void }, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
function g(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}
const hasGit = spawnSync("git", ["--version"]).status === 0;
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
// The planted filter is a `sh -c` marker command; Windows hosts may have no sh.
const skipReal = !hasGit ? "no git" : process.platform === "win32" ? "sh marker filter" : false;

test("HIGH-1: foreman_move is drift-gated; a planted clean filter does not run without approval", { skip: skipReal || (!py.ok ? "no Python >= 3.9" : false) }, async (t) => {
  const dir = tmp(t, "pf-h1-");
  g(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, ".gitattributes"), "*.txt filter=pf\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  g(dir, "add", ".");
  g(dir, "commit", "-q", "-m", "init");
  const watch = new GitDriftWatch();
  watch.snapshot(dir, HOME); // the child launch
  g(dir, "config", "filter.pf.clean", "sh -c 'echo ran-clean >> MARK; cat'"); // what the child plants
  fs.utimesSync(path.join(dir, "a.txt"), new Date(), new Date(Date.now() + 5000));
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
  let ask: { mode: string; hasUI: boolean; confirm?: (a: string, b: string) => Promise<boolean> } = PRINT;
  registerSafeOps({ registerTool: (x: unknown) => void tools.set((x as { name: string }).name, x as never) } as never, {
    isChild: false,
    session: async () => ({ python: py.ok ? py.info.executable : null, isChild: false, opsConfig: {}, trace: noTrace }),
    script: SCRIPT,
    spawner: defaultSpawner,
    env: () => Object.fromEntries(Object.entries(GIT_ENV).filter((e): e is [string, string] => typeof e[1] === "string")),
    preflight: (ctx, op, id) => safeOpDriftPreflight(watch, false, (ctx as { cwd: string }).cwd, HOME, op, ask, noTrace, id),
  });
  const blocked = await tools.get("foreman_move")!.execute("c1", { src: "a.txt", dst: "b.txt" }, undefined, undefined, { cwd: dir });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /foreman_move.*git:config: added filter\.pf\.clean/s);
  assert.equal(fs.existsSync(path.join(dir, "MARK")), false, "the planted filter must not run");
  assert.equal(fs.existsSync(path.join(dir, "a.txt")), true);
  // Approved: the op runs, and the marker proves the repro is live.
  ask = { mode: "rpc", hasUI: true, confirm: async () => true };
  const ran = await tools.get("foreman_move")!.execute("c2", { src: "a.txt", dst: "b.txt" }, undefined, undefined, { cwd: dir });
  assert.equal(ran.isError, undefined, ran.content[0].text);
  assert.match(fs.readFileSync(path.join(dir, "MARK"), "utf8"), /ran-clean/);
});

test("HIGH-2: submodule git dir config and hooks, info/attributes (common and per worktree) are snapshotted", { skip: skipReal }, async (t) => {
  const root = tmp(t, "pf-h2-");
  const src = path.join(root, "subsrc");
  const sup = path.join(root, "sup");
  fs.mkdirSync(src);
  fs.mkdirSync(sup);
  g(src, "init", "-q");
  fs.writeFileSync(path.join(src, ".gitattributes"), "*.txt filter=pf\n");
  g(src, "add", ".");
  g(src, "commit", "-q", "-m", "s");
  g(sup, "init", "-q");
  g(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", src, "sub");
  g(sup, "commit", "-q", "-m", "add sub");
  g(sup, "worktree", "add", "-q", "-b", "w", path.join(root, "wt"));
  const before = takeGitSnapshot(sup, HOME);
  assert.deepEqual(diffGitSnapshots(before, takeGitSnapshot(sup, HOME)), []);
  g(path.join(sup, "sub"), "config", "filter.pf.clean", "sh -c 'echo ran-sub-clean >> MARK_sub; cat'");
  fs.writeFileSync(path.join(sup, ".git", "modules", "sub", "hooks", "post-checkout"), "#!/bin/sh\n");
  fs.mkdirSync(path.join(sup, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(sup, ".git", "info", "attributes"), "*.md filter=pf\n");
  fs.mkdirSync(path.join(sup, ".git", "worktrees", "wt", "info"), { recursive: true });
  fs.writeFileSync(path.join(sup, ".git", "worktrees", "wt", "info", "attributes"), "*.md filter=pf\n");
  const lines = diffGitSnapshots(before, takeGitSnapshot(sup, HOME));
  for (const want of ["git:info/attributes: new file", "git:modules/sub/config: added filter.pf.clean", "git:modules/sub/hooks/post-checkout: new file", "worktrees: 1 changed (wt: info/attributes new file)"]) {
    assert.ok(lines.includes(want), `${want} missing from ${JSON.stringify(lines)}`);
  }
  assert.doesNotMatch(lines.join("\n"), /ran-sub-clean/);
  const w = new GitDriftWatch();
  w.snap = before;
  assert.match((await w.gate(sup, HOME, "this git command", PRINT, noTrace))?.reason ?? "", /modules\/sub\/config/);
});

test("M2: project Claude Code config drift asks, blocks without UI, re-snapshots on approve; names only", async (t) => {
  const state = tmp(t, "pf-m2s-");
  const cwd = tmp(t, "pf-m2c-");
  fs.writeFileSync(path.join(cwd, ".mcp.json"), "{}");
  const w = new ClaudeConfigWatch();
  assert.deepEqual(w.bind(state, cwd), [], "first session: silent snapshot");
  assert.equal(await w.check(cwd, "x", PRINT, noTrace), undefined);
  fs.mkdirSync(path.join(cwd, ".claude"));
  fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), '{"hooks":{"Stop":[{"command":"SECRET-CMD"}]}}');
  fs.unlinkSync(path.join(cwd, ".mcp.json"));
  const traces: Record<string, unknown>[] = [];
  const printed = await w.check(cwd, "this claude-bridge prompt", PRINT, (r) => void traces.push(r));
  assert.match(printed?.reason ?? "", /no UI.*\.claude\/settings\.json: created\n\.mcp\.json: removed/s);
  let asked = "";
  const denied = await w.check(cwd, "x", { mode: "tui", hasUI: true, confirm: async (_a, m) => ((asked = m), false) }, noTrace);
  assert.match(denied?.reason ?? "", /^Denied by the user/);
  assert.doesNotMatch(asked, /SECRET/);
  assert.equal(await w.check(cwd, "x", { mode: "rpc", hasUI: true, confirm: async () => true }, (r) => void traces.push(r)), undefined);
  assert.equal(await w.check(cwd, "x", PRINT, noTrace), undefined, "approved state is the new baseline");
  assert.deepEqual(traces, [{ event: "claude_config_drift", decision: "no-ui" }, { event: "claude_config_drift", decision: "approved" }]);
  for (const f of fs.readdirSync(state)) assert.doesNotMatch(fs.readFileSync(path.join(state, f), "utf8"), /SECRET|hooks/);
});

test("M4: snapshots persist per workspace; a change planted between sessions asks in the next one", async (t) => {
  const state = tmp(t, "pf-m4s-");
  const dir = tmp(t, "pf-m4r-");
  fs.mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\tbare = false\n");
  const first = new GitDriftWatch();
  assert.deepEqual(first.bind(state, dir, HOME), [], "no stored snapshot: taken silently");
  assert.equal(await first.gate(dir, HOME, "x", PRINT, noTrace), undefined);
  const firstCfg = new ClaudeConfigWatch();
  firstCfg.bind(state, dir);
  // Between sessions (e.g. a detached child still running): plant config, a hook and Claude settings.
  fs.appendFileSync(path.join(dir, ".git", "config"), "[core]\n\tfsmonitor = /x/PLANTED-VALUE\n");
  fs.writeFileSync(path.join(dir, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude", "settings.local.json"), "{}");
  const next = new GitDriftWatch();
  assert.deepEqual(next.bind(state, path.join(dir), HOME), ["git:config: added core.fsmonitor", "hooks: added post-checkout"]);
  assert.match((await next.gate(dir, HOME, "this git command", PRINT, noTrace))?.reason ?? "", /core\.fsmonitor/);
  const nextCfg = new ClaudeConfigWatch();
  assert.deepEqual(nextCfg.bind(state, dir), [".claude/settings.local.json: created"]);
  assert.ok(await nextCfg.check(dir, "x", PRINT, noTrace));
  const stored = fs.readdirSync(state).map((f) => fs.readFileSync(path.join(state, f), "utf8")).join("\n");
  assert.doesNotMatch(stored, /PLANTED|\/x\//, "only names and hashes are stored");
});
