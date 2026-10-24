// R12 item 10: foreman_copy may read from the foreman's own handoff dirs. The roots come from session state (SafeOpsSession.handoffDirs),
// travel as a top-level `srcRoots` request key for `copy` only, never from tool input, and are dropped for a child.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerSafeOps } from "../safeops.ts";
import type { SafeOpsSession } from "../safeops.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import type { Spawner } from "../spawn.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "safe_ops.py");
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const git = spawnSync("git", ["--version"]).status === 0;
const SKIP = !py.ok ? "no Python >= 3.13" : !git ? "no git" : false;

function setup(opts: { handoffDirs?: string[]; sessionChild?: boolean; isChild?: boolean; real?: boolean }) {
  const tools = new Map<string, Tool>();
  const inputs: Record<string, unknown>[] = [];
  const fake: Spawner = async (_cmd, _args, o) => {
    inputs.push(JSON.parse(o.input ?? "{}"));
    return { code: 0, stdout: JSON.stringify({ ok: true, action: "copy_file" }) + "\n", stderr: "", timedOut: false };
  };
  const spawner: Spawner = opts.real ? async (cmd, args, o) => { inputs.push(JSON.parse(o.input ?? "{}")); return defaultSpawner(cmd, args, o); } : fake;
  const session: SafeOpsSession = { python: opts.real && py.ok ? py.info.executable : "/py", isChild: opts.sessionChild ?? false, opsConfig: {}, ...(opts.handoffDirs ? { handoffDirs: opts.handoffDirs } : {}), trace: () => {} };
  registerSafeOps({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, {
    isChild: opts.isChild ?? false,
    session: async () => session,
    script: SCRIPT,
    spawner,
    env: () => ({ PATH: process.env.PATH ?? "" }),
  });
  const call = (name: string, params: Record<string, unknown>, cwd = "/ws") => tools.get(name)!.execute("id1", params, undefined, undefined, { cwd });
  return { call, inputs };
}

function fixture() {
  // os.tmpdir() on macOS is /var/... (a symlink to /private/var): the roots are passed unresolved, safe_ops.py realpaths them
  const tmp = mkTestTmp("pf-r12-handoff-");
  const ws = path.join(tmp, "ws");
  const own = path.join(tmp, "handoffs", "own");
  const foreign = path.join(tmp, "handoffs", "foreign");
  for (const d of [path.join(ws, "scratch"), own, foreign]) fs.mkdirSync(d, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: ws }).status, 0);
  fs.writeFileSync(path.join(own, "plan.md"), "own plan\n");
  fs.writeFileSync(path.join(foreign, "plan.md"), "foreign plan\n");
  return { tmp, ws, own, foreign };
}

test("foreman_copy_own_handoff_src", { skip: SKIP }, async () => {
  const f = fixture();
  try {
    const h = setup({ handoffDirs: [f.own], real: true });
    const ok = await h.call("foreman_copy", { src: path.join(f.own, "plan.md"), dst: "scratch/plan.md" }, f.ws);
    assert.equal(ok.isError, undefined, ok.content[0].text);
    assert.equal(fs.readFileSync(path.join(f.ws, "scratch", "plan.md"), "utf8"), "own plan\n");
    assert.deepEqual(h.inputs[0].srcRoots, [f.own]);
    assert.equal((h.inputs[0].args as Record<string, unknown>).srcRoots, undefined);
    const no = await h.call("foreman_copy", { src: path.join(f.foreign, "plan.md"), dst: "scratch/other.md" }, f.ws);
    assert.equal(no.details.precondition, "outside_workspace");
    // move never gets the extra root
    const mv = await h.call("foreman_move", { src: path.join(f.own, "plan.md"), dst: "scratch/moved.md" }, f.ws);
    assert.equal(mv.details.precondition, "outside_workspace");
    assert.equal(h.inputs[2].srcRoots, undefined);
    assert.ok(fs.existsSync(path.join(f.own, "plan.md")));
  } finally {
    rmTestTmp(f.tmp);
  }
});

test("foreman_copy_own_handoff_src_child_refused", { skip: SKIP }, async () => {
  const f = fixture();
  try {
    for (const o of [{ sessionChild: true }, { isChild: true }]) {
      const h = setup({ handoffDirs: [f.own], real: true, ...o });
      const r = await h.call("foreman_copy", { src: path.join(f.own, "plan.md"), dst: "scratch/plan.md" }, f.ws);
      assert.equal(r.details.precondition, "outside_workspace", JSON.stringify(o));
      assert.equal(h.inputs[0].srcRoots, undefined);
    }
    assert.ok(!fs.existsSync(path.join(f.ws, "scratch", "plan.md")));
  } finally {
    rmTestTmp(f.tmp);
  }
});

test("foreman_copy_srcroots_not_from_tool_input", { skip: SKIP }, async () => {
  const fakeRun = setup({});
  await fakeRun.call("foreman_copy", { src: "/x/plan.md", dst: "scratch/plan.md", srcRoots: ["/x"] });
  assert.equal(fakeRun.inputs[0].srcRoots, undefined);
  const f = fixture();
  try {
    const h = setup({ real: true });
    const r = await h.call("foreman_copy", { src: path.join(f.own, "plan.md"), dst: "scratch/plan.md", srcRoots: [f.own] }, f.ws);
    assert.equal(r.details.precondition, "outside_workspace");
    assert.equal(h.inputs[0].srcRoots, undefined);
    assert.ok(!fs.existsSync(path.join(f.ws, "scratch", "plan.md")));
  } finally {
    rmTestTmp(f.tmp);
  }
});
