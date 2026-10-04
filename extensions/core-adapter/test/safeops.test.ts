import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerSafeOps } from "../safeops.ts";
import type { SafeOpsSession } from "../safeops.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import type { SpawnResult, Spawner } from "../spawn.ts";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "safe_ops.py");

type Tool = { name: string; parameters: { required: string[] }; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

function setup(opts: { isChild?: boolean; sessionChild?: boolean; python?: string | null; reply?: Partial<SpawnResult>; spawner?: Spawner }) {
  const tools = new Map<string, Tool>();
  const traces: Record<string, unknown>[] = [];
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const spawner: Spawner = opts.spawner ?? (async (cmd, args, o) => {
    calls.push({ cmd, args, input: o.input });
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...opts.reply };
  });
  const session: SafeOpsSession = { python: opts.python === undefined ? "/py" : opts.python, isChild: opts.sessionChild ?? opts.isChild ?? false, opsConfig: { copyMaxBytes: 7 }, trace: (r) => void traces.push(r) };
  const names = registerSafeOps({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, {
    isChild: opts.isChild ?? false,
    session: async () => session,
    script: SCRIPT,
    spawner,
    env: () => ({ PATH: process.env.PATH ?? "" }),
  });
  const call = (name: string, params: Record<string, unknown>, cwd = "/ws") => tools.get(name)!.execute("id1", params, undefined, undefined, { cwd });
  return { tools, names, traces, calls, call };
}

test("safeops: main registers three tools, a child only move and copy", () => {
  assert.deepEqual(setup({}).names, ["foreman_move", "foreman_copy", "foreman_worktree_remove"]);
  const child = setup({ isChild: true });
  assert.deepEqual(child.names, ["foreman_move", "foreman_copy"]);
  assert.deepEqual(setup({}).tools.get("foreman_move")!.parameters.required, ["src", "dst"]);
});

test("safeops: a run sends the request to safe_ops.py and traces `ran`", async () => {
  const h = setup({ reply: { stdout: JSON.stringify({ ok: true, action: "git_mv", src: "a", dst: "b" }) + "\n" } });
  const r = await h.call("foreman_move", { src: "a", dst: "b" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /^foreman_move: done\. action=git_mv src=a dst=b/);
  assert.deepEqual(h.calls[0].args, ["-E", "-s", SCRIPT]);
  assert.deepEqual(JSON.parse(h.calls[0].input!), { op: "move", args: { src: "a", dst: "b" }, cwd: "/ws", config: { copyMaxBytes: 7 } });
  assert.deepEqual(h.traces, [{ event: "safe_op", toolFamily: "move", decision: "ran" }]);
});

test("safeops: a failed precondition is a tool error and traces the name only", async () => {
  const h = setup({ reply: { stdout: JSON.stringify({ ok: false, precondition: "dst_exists", message: "precondition failed: dst_exists (/ws/b already exists)" }) } });
  const r = await h.call("foreman_copy", { src: "a", dst: "b" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^foreman_copy: precondition failed: dst_exists/);
  assert.deepEqual(h.traces, [{ event: "safe_op", toolFamily: "copy", decision: "precondition_failed", precondition: "dst_exists" }]);
});

test("safeops: no Python, timeout, crash and garbage output are errors", async () => {
  const none = setup({ python: null });
  const r0 = await none.call("foreman_move", { src: "a", dst: "b" });
  assert.equal(r0.isError, true);
  assert.match(r0.content[0].text, /no Python/);
  assert.equal(none.calls.length, 0);
  for (const [reply, re] of [
    [{ timedOut: true, code: null }, /no answer within/],
    [{ error: new Error("ENOENT") }, /could not start/],
    [{ code: 1, stderr: "Traceback: boom" }, /failed \(exit 1\): Traceback: boom/],
    [{ code: 0, stdout: "not json" }, /failed \(exit 0\)/],
  ] as [Partial<SpawnResult>, RegExp][]) {
    const h = setup({ reply });
    const r = await h.call("foreman_worktree_remove", { path: "wt" });
    assert.equal(r.isError, true, String(re));
    assert.match(r.content[0].text, re);
    assert.deepEqual(h.traces, [{ event: "safe_op", toolFamily: "worktree_remove", decision: "error" }]);
  }
});

test("safeops: worktree_remove refuses in a child session without running anything", async () => {
  const h = setup({ sessionChild: true });
  const r = await h.call("foreman_worktree_remove", { path: "wt" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /foreman only/);
  assert.equal(h.calls.length, 0);
});

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const git = spawnSync("git", ["--version"]).status === 0;

test("safeops: real safe_ops.py moves once, then reports dst_exists", { skip: !py.ok ? "no Python >= 3.9" : !git ? "no git" : false }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pf-safeops-"));
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: tmp }).status, 0);
    fs.writeFileSync(path.join(tmp, "a.txt"), "x");
    fs.writeFileSync(path.join(tmp, "c.txt"), "y");
    const h = setup({ python: py.ok ? py.info.executable : null, spawner: defaultSpawner });
    const ok = await h.call("foreman_move", { src: "a.txt", dst: "b.txt" }, tmp);
    assert.equal(ok.isError, undefined, ok.content[0].text);
    assert.equal(fs.readFileSync(path.join(tmp, "b.txt"), "utf8"), "x");
    const no = await h.call("foreman_move", { src: "c.txt", dst: "b.txt" }, tmp);
    assert.equal(no.isError, true);
    assert.equal(no.details.precondition, "dst_exists");
    assert.equal(fs.readFileSync(path.join(tmp, "c.txt"), "utf8"), "y");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
