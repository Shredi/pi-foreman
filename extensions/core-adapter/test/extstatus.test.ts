import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadMergedConfig } from "../config.ts";
import { defaultSpawner } from "../spawn.ts";
import { defaultStatusSpawner, ExtStatus, MAX_STDERR, MAX_STDOUT, parseItems, resolveProgram, splitCommandLine } from "../extstatus.ts";
import type { ExtStatusDeps, StatusRunOptions, StatusRunResult } from "../extstatus.ts";
import type { Timers } from "../prwatch.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const win = process.platform === "win32";

function tree() {
  const root = mkTestTmp("extstatus-");
  const ws = path.join(root, "ws");
  const bin = path.join(root, "bin");
  fs.mkdirSync(ws);
  fs.mkdirSync(bin);
  const tool = path.join(bin, "statuscmd");
  fs.writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { root, ws, bin, tool };
}

function harness(over: Partial<ExtStatusDeps> & { reply?: Partial<StatusRunResult> | (() => Partial<StatusRunResult>) } = {}) {
  const t = tree();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const fake: Timers = { set: (fn, ms) => (timers.push({ fn, ms, live: true }), timers.length - 1), clear: (h) => void (typeof h === "number" && timers[h] && (timers[h].live = false)) };
  const runs: { program: string; args: string[]; o: StatusRunOptions }[] = [];
  const traces: Record<string, unknown>[] = [];
  let changed = 0;
  const reply = over.reply;
  const x = new ExtStatus({
    enabled: () => true,
    command: () => "statuscmd --flag 'two words'",
    intervalMs: () => 60_000,
    workspace: () => t.ws,
    cwd: () => t.ws,
    sessionId: () => "sess-1",
    branch: async () => "feat/x",
    env: { PATH: t.bin, KEEP: "1" },
    platform: process.platform,
    spawner: async (program, args, o) => {
      runs.push({ program, args, o });
      const r = typeof reply === "function" ? reply() : reply;
      return { code: 0, stdout: "[]", stderr: "", overflow: false, timedOut: false, ...r };
    },
    timers: fake,
    trace: (r) => void traces.push(r),
    changed: () => void changed++,
    ...over,
  });
  const fire = async () => {
    const live = [...timers].reverse().find((q) => q.live);
    assert.ok(live, "a live timer");
    live.live = false;
    live.fn();
    await new Promise((r) => setImmediate(r));
  };
  return { x, t, runs, traces, fire, timers, changed: () => changed, done: () => rmTestTmp(t.root) };
}

const out = (v: unknown) => ({ stdout: typeof v === "string" ? v : JSON.stringify(v) });

test("a valid list is shown; the run gets the program, args, cwd, timeout, caps and the env", { skip: win }, async () => {
  const h = harness({ reply: out([{ label: "deploy", state: "ok", other: 1 }, { label: "ci", state: "run" }]) });
  h.x.start();
  await h.fire();
  assert.deepEqual(h.x.items(), [{ label: "deploy", state: "ok" }, { label: "ci", state: "run" }]);
  const r = h.runs[0];
  assert.equal(r.program, fs.realpathSync.native(h.t.tool));
  assert.deepEqual(r.args, ["--flag", "two words"]);
  assert.equal(r.o.cwd, h.t.ws);
  assert.equal(r.o.timeoutMs, 10_000);
  assert.equal(r.o.maxStdout, MAX_STDOUT);
  assert.equal(r.o.maxStderr, MAX_STDERR);
  assert.equal(r.o.env.PI_FOREMAN_SESSION_ID, "sess-1");
  assert.equal(r.o.env.PI_FOREMAN_BRANCH, "feat/x");
  assert.equal(r.o.env.KEEP, "1");
  assert.deepEqual(h.traces, [{ event: "sidebar_status", outcome: "ok", count: 2 }]);
  assert.equal(h.changed(), 1);
  assert.equal([...h.timers].reverse().find((q) => q.live)?.ms, 60_000);
  h.done();
});

test("more than 8 items: the first 8 are kept", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ label: `i${i}`, state: "ok" }));
  const got = parseItems(JSON.stringify(items));
  assert.deepEqual(got?.map((i) => i.label), ["i0", "i1", "i2", "i3", "i4", "i5", "i6", "i7"]);
});

test("labels: Cc and Cf stripped (bidi override, zero width), token shapes redacted, cut to 20, empty dropped", () => {
  const got = parseItems(JSON.stringify([
    { label: "a\u202Eb\u200Bc\u0007d", state: "ok" },
    { label: "x ghp_abcdefghijklmnop1234 y", state: "ok" },
    { label: "build and deploy pipeline stage", state: "ok" },
    { label: "0123456789abcdefghijKLMNOP", state: "ok" },
    { label: "\u202E\u200B\u0001  ", state: "ok" },
    { label: "", state: "ok" },
  ]));
  assert.deepEqual(got?.map((i) => i.label), ["abcd", "x [redacted] y", "build and deploy pip", "[redacted]"]);
  for (const i of got ?? []) assert.doesNotMatch(i.label, /[\p{Cc}\p{Cf}]/u);
});

test("an unknown or missing state becomes none", () => {
  const got = parseItems(JSON.stringify([{ label: "a", state: "red" }, { label: "b" }, { label: "c", state: 3 }, { label: "d", state: "fail" }]));
  assert.deepEqual(got?.map((i) => i.state), ["none", "none", "none", "fail"]);
});

test("any other shape rejects the whole output", () => {
  for (const bad of ["not json", "", "{}", '{"label":"a","state":"ok"}', '"x"', "[1]", '["a"]', "[null]", "[[]]", '[{"label":1}]', '[{"state":"ok"}]', '[{"label":"ok","state":"ok"}, 5]']) assert.equal(parseItems(bad), null, bad);
  assert.deepEqual(parseItems("[]"), []);
});

test("a rejected run keeps the previous items for one more interval, then clears them", { skip: win }, async () => {
  let reply: Partial<StatusRunResult> = out([{ label: "a", state: "ok" }]);
  const h = harness({ reply: () => reply });
  h.x.start();
  await h.fire();
  assert.equal(h.x.items().length, 1);
  reply = { code: 3, stderr: "first line token=abcdef0123456789abcdef0123456789\nsecond" };
  await h.fire();
  assert.equal(h.x.items().length, 1, "kept once");
  await h.fire();
  assert.equal(h.x.items().length, 0, "cleared");
  const failed = h.traces.filter((t) => t.outcome === "failed");
  assert.equal(failed.length, 2);
  assert.match(String(failed[0].stderr), /^first line /);
  assert.doesNotMatch(String(failed[0].stderr), /abcdef0123456789|second/);
  reply = out([{ label: "b", state: "run" }]);
  await h.fire();
  assert.deepEqual(h.x.items(), [{ label: "b", state: "run" }]);
  h.done();
});

test("outcomes: bad_output, timeout, failed (spawn error), and an oversize stdout", { skip: win }, async () => {
  const cases: [Partial<StatusRunResult>, string][] = [
    [{ stdout: "nope" }, "bad_output"],
    [{ timedOut: true, code: null }, "timeout"],
    [{ error: new Error("EACCES"), code: null }, "failed"],
    [{ overflow: true, code: null }, "bad_output"],
    [{ stdout: "[" + " ".repeat(MAX_STDOUT) + "]" }, "bad_output"],
    [{ code: 1 }, "failed"],
  ];
  for (const [reply, outcome] of cases) {
    const h = harness({ reply });
    h.x.start();
    await h.fire();
    assert.deepEqual(h.traces.map((t) => t.outcome), [outcome]);
    assert.deepEqual(h.x.items(), []);
    h.done();
  }
});

test("a child (gate closed) never runs the command; an unset command is off", { skip: win }, async () => {
  const h = harness({ enabled: () => false });
  h.x.start();
  assert.equal(h.timers.length, 0);
  assert.equal(h.runs.length, 0);
  const off = harness({ command: () => null });
  off.x.start();
  assert.equal(off.timers.length, 0);
  assert.equal(off.x.describe(), "off");
  assert.equal(h.x.describe(), "on (statuscmd)");
  h.done();
  off.done();
});

test("program rules: PATH lookup outside the workspace; inside, through a symlink, relative, .cmd and missing are refused", { skip: win }, () => {
  const t = tree();
  const input = { workspace: t.ws, env: { PATH: t.bin }, platform: process.platform };
  const realTool = fs.realpathSync.native(t.tool);
  assert.equal(resolveProgram("statuscmd", input), realTool);
  assert.equal(resolveProgram(t.tool, input), realTool);
  assert.equal(resolveProgram("nothere", input), null);
  assert.equal(resolveProgram("./statuscmd", input), null, "a separator needs an absolute path");
  assert.equal(resolveProgram("bin/statuscmd", input), null);
  // inside the workspace
  const inside = path.join(t.ws, "tool.sh");
  fs.writeFileSync(inside, "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(resolveProgram(inside, input), null);
  assert.equal(resolveProgram("tool.sh", { ...input, env: { PATH: t.ws } }), null);
  // an outside path that is a symlink into the workspace
  const link = path.join(t.bin, "linked");
  fs.symlinkSync(inside, link);
  assert.equal(resolveProgram(link, input), null);
  assert.equal(resolveProgram("linked", input), null);
  // a workspace reached through a symlinked path
  const wsLink = path.join(t.root, "wslink");
  fs.symlinkSync(t.ws, wsLink);
  assert.equal(resolveProgram(path.join(wsLink, "tool.sh"), input), null);
  // not executable, a directory
  const plain = path.join(t.bin, "plain");
  fs.writeFileSync(plain, "x", { mode: 0o644 });
  assert.equal(resolveProgram(plain, input), null);
  assert.equal(resolveProgram(t.bin, input), null);
  // .cmd and .bat
  for (const ext of [".cmd", ".bat", ".CMD"]) {
    const f = path.join(t.bin, `prog${ext}`);
    fs.writeFileSync(f, "@echo off\n", { mode: 0o755 });
    assert.equal(resolveProgram(f, input), null, ext);
  }
  rmTestTmp(t.root);
});

test("a refused program runs nothing and traces program_missing", { skip: win }, async () => {
  const h = harness({ command: () => "nothere --x" });
  h.x.start();
  await h.fire();
  assert.equal(h.runs.length, 0);
  assert.deepEqual(h.traces, [{ event: "sidebar_status", outcome: "program_missing", count: 0 }]);
  h.done();
});

test("splitCommandLine: POSIX quoting without any expansion", () => {
  assert.deepEqual(splitCommandLine("a  b\tc"), ["a", "b", "c"]);
  assert.deepEqual(splitCommandLine(`a 'b c' "d e" f\\ g ""`), ["a", "b c", "d e", "f g", ""]);
  assert.deepEqual(splitCommandLine(`a"b c"'d'`), ["ab cd"]);
  assert.deepEqual(splitCommandLine(`a "x\\"y" "$HOME" '$(z)' ;ls`), ["a", 'x"y', "$HOME", "$(z)", ";ls"]);
  assert.equal(splitCommandLine("a 'b"), null);
  assert.equal(splitCommandLine('a "b'), null);
  assert.equal(splitCommandLine("a \\"), null);
  assert.equal(splitCommandLine("   "), null);
});

test("the real spawner: stdout over the cap stops the run, stderr is capped, a non-zero exit is reported", { skip: win }, async () => {
  const dir = mkTestTmp("extstatus-spawn-");
  const env = { PATH: process.env.PATH ?? "" };
  const base = { cwd: dir, env, timeoutMs: 10_000, maxStdout: MAX_STDOUT, maxStderr: MAX_STDERR };
  const big = await defaultStatusSpawner(process.execPath, ["-e", `process.stdout.write("x".repeat(${MAX_STDOUT * 2}))`], base);
  assert.equal(big.overflow, true);
  const noisy = await defaultStatusSpawner(process.execPath, ["-e", `process.stderr.write("e".repeat(${MAX_STDERR * 5})); process.exit(2)`], base);
  assert.equal(noisy.code, 2);
  assert.equal(noisy.stderr.length, MAX_STDERR);
  const ok = await defaultStatusSpawner(process.execPath, ["-e", `process.stdout.write('[{"label":"a","state":"ok"}]')`], base);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, '[{"label":"a","state":"ok"}]');
  const missing = await defaultStatusSpawner(path.join(dir, "nope"), [], base);
  assert.ok(missing.error);
  rmTestTmp(dir);
});

test("the real spawner: the timeout kills the whole process group, grandchildren included", { skip: win }, async () => {
  const dir = mkTestTmp("extstatus-kill-");
  const pidFile = path.join(dir, "child.pid");
  const script = path.join(dir, "parent.js");
  fs.writeFileSync(script, `const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
setInterval(() => {}, 1000);
`);
  const r = await defaultStatusSpawner(process.execPath, [script], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 700, maxStdout: MAX_STDOUT, maxStderr: MAX_STDERR });
  assert.equal(r.timedOut, true);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(pid > 1);
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((res) => setTimeout(res, 50));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the grandchild is gone");
  rmTestTmp(dir);
});

test("project-layer sidebar keys are ignored with a warning; the user layer applies", { skip: win }, async () => {
  const root = mkTestTmp("extstatus-cfg-");
  const agent = path.join(root, "agent");
  const proj = path.join(root, "proj");
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(path.join(proj, ".pi"), { recursive: true });
  const pkgRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const load = () => loadMergedConfig({ python: "python3", pkgRoot, agentDir: agent, projectDir: proj, trusted: true, spawner: defaultSpawner, env: { ...process.env, PI_CODING_AGENT_DIR: agent } as Record<string, string> });
  fs.writeFileSync(path.join(proj, ".pi", "foreman.json"), JSON.stringify({ sidebar: { statusCommand: "/bin/evil", statusSeconds: 10 } }));
  const a = await load();
  assert.equal((a.config.sidebar as Record<string, unknown> | undefined)?.statusCommand, undefined);
  assert.equal((a.config.sidebar as Record<string, unknown>).statusSeconds, 60);
  assert.equal(a.warnings.filter((w) => /sidebar\.status(Command|Seconds)/.test(w)).length, 2, a.warnings.join("\n"));
  fs.writeFileSync(path.join(agent, "foreman.json"), JSON.stringify({ sidebar: { statusCommand: "/usr/bin/true", statusSeconds: 30 } }));
  const b = await load();
  assert.deepEqual(b.config.sidebar, { statusCommand: "/usr/bin/true", statusSeconds: 30 });
  assert.deepEqual(b.errors, []);
  rmTestTmp(root);
});
