// Git guard wiring: adapter helpers (main mode) and the child extension (child mode).
// The real-script cases pass command STRINGS to scripts/git_guard.py; nothing is executed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import gitGuard from "../../git-guard/index.ts";
import { CHILD_TRACE_EVENT, gitGuardPayload, mainNeedsGitGuard, runGitGuard } from "../gitguard.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import type { Spawner } from "../spawn.ts";
import { FAIL_POLICY } from "../translate.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const pc = { sessionId: "s1", cwd: os.tmpdir(), home: os.homedir() };

type Handler = (event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => Promise<{ block: true; reason: string } | undefined>;

function loadChildGuard(deps: Parameters<typeof gitGuard>[1]): Handler {
  let handler: Handler | undefined;
  const pi = { on: (name: string, fn: Handler) => { if (name === "tool_call") handler = fn; } };
  gitGuard(pi as never, deps);
  assert.ok(handler, "child git guard registers a tool_call handler");
  return handler!;
}

const ctx = (cwd: string) => ({ sessionManager: { getSessionId: () => "child-1" }, cwd, mode: "rpc", hasUI: false });

test("main fast path and payload: shell flavour and safety.git ride along", () => {
  assert.equal(mainNeedsGitGuard("ls -la"), false);
  assert.equal(mainNeedsGitGuard("GIT push"), true);
  const p = gitGuardPayload("powershell", { command: "& git push" }, pc, { protectedBranches: ["main"] });
  assert.equal(p.tool_name, "Bash");
  assert.deepEqual(p.tool_input, { command: "& git push" });
  assert.equal(p.shell, "powershell");
  assert.deepEqual(p.foreman_git, { protectedBranches: ["main"] });
  assert.equal(gitGuardPayload("bash", { command: "x" }, pc).shell, "bash");
  assert.equal(FAIL_POLICY.git_guard, "closed");
});

test("runGitGuard runs <pkg>/scripts/git_guard.py with --mode", async () => {
  const calls: string[][] = [];
  const spawner: Spawner = async (cmd, args) => (calls.push([cmd, ...args]), { code: 0, stdout: "", stderr: "", timedOut: false });
  await runGitGuard({ python: "py", pkgRoot: "/pkg", mode: "main", payload: {}, env: {}, cwd: "/", spawner });
  assert.deepEqual(calls[0], ["py", "-E", "-s", path.join("/pkg", "scripts", "git_guard.py"), "--mode", "main"]);
});

test("child extension fails closed: no Python, spawn error, timeout, garbage", async () => {
  const noPy: Spawner = async () => ({ code: null, stdout: "", stderr: "", error: new Error("ENOENT"), timedOut: false });
  const h1 = loadChildGuard({ spawner: noPy, env: {} });
  const r1 = await h1({ toolName: "bash", input: { command: "git status" } }, ctx(os.tmpdir()));
  assert.equal(r1?.block, true);
  assert.match(r1!.reason, /git guard could not run/);
  // Python resolves, the guard itself times out / prints garbage.
  for (const answer of [{ code: null, stdout: "", stderr: "", timedOut: true }, { code: 0, stdout: "not json", stderr: "", timedOut: false }]) {
    const sp: Spawner = async (_cmd, args) => (args.includes("-c") ? { code: 0, stdout: "3.12\n/usr/bin/python3\n", stderr: "", timedOut: false } : answer);
    const h = loadChildGuard({ spawner: sp, env: {}, platform: "linux" });
    const r = await h({ toolName: "bash", input: { command: "ls" } }, ctx(os.tmpdir()));
    assert.equal(r?.block, true);
  }
  // Non-shell tools are not its business.
  assert.equal(await h1({ toolName: "read", input: { path: "x" } }, ctx(os.tmpdir())), undefined);
});

test("child extension with the real script blocks push shapes and passes plain git", { skip: !py.ok ? "no Python >= 3.9" : false }, async () => {
  assert.ok(fs.existsSync(path.join(repo, "scripts", "git_guard.py")));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pf-gg-"));
  try {
    const h = loadChildGuard({ env: { ...process.env, PI_FOREMAN_PYTHON: py.ok ? py.info.executable : "" } });
    for (const [tool, command] of [["bash", "git push"], ["bash", "bash -c 'git push origin main'"], ["powershell", "& git.exe push"], ["bash", "git reset --hard"]]) {
      const r = await h({ toolName: tool, input: { command } }, ctx(cwd));
      assert.equal(r?.block, true, command);
      assert.match(r!.reason, /^pi-foreman git guard: /);
    }
    for (const command of ["git status", "git commit -m 'whatever'", "echo git push"]) {
      assert.equal(await h({ toolName: "bash", input: { command } }, ctx(cwd)), undefined, command);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("child extension forwards an allowed test restore to pi.events as test_restore", { skip: !py.ok ? "no Python >= 3.9" : false }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pf-gg-restore-"));
  try {
    const g = (...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "ignore" });
    g("init", "-q");
    fs.mkdirSync(path.join(cwd, "tests"));
    fs.writeFileSync(path.join(cwd, "tests", "test_a.py"), "x = 1\n");
    g("add", "tests");
    g("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "init");
    fs.writeFileSync(path.join(cwd, "tests", "test_a.py"), "x = 2\n");
    const seen: unknown[] = [];
    let handler: Handler | undefined;
    const pi = { on: (name: string, fn: Handler) => { if (name === "tool_call") handler = fn; }, events: { emit: (ch: string, d: unknown) => seen.push([ch, d]), on: () => undefined } };
    gitGuard(pi as never, { env: { ...process.env, PI_FOREMAN_PYTHON: py.ok ? py.info.executable : "" } });
    assert.equal(await handler!({ toolName: "bash", input: { command: "git restore tests/test_a.py" } }, ctx(cwd)), undefined);
    assert.deepEqual(seen, [[CHILD_TRACE_EVENT, { sessionId: "child-1", event: "test_restore", cmd: "tests/test_a.py" }]]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("adapter registers the git guard as a required child extension and package.json does not load it", () => {
  const index = fs.readFileSync(path.join(repo, "extensions", "core-adapter", "index.ts"), "utf8");
  assert.match(index, /\{ id: ADAPTER_ID, path: ENTRY \}, \{ id: GIT_GUARD_ID, path: GIT_GUARD_ENTRY \}/);
  assert.match(index, /guard === "git_guard" && \(s\.isChild \|\|/);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./extensions/core-adapter/index.ts"]);
  assert.ok(fs.existsSync(path.join(repo, "extensions", "git-guard", "index.ts")));
});
