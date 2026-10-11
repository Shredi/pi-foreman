import { test } from "node:test";
import assert from "node:assert/strict";
import { applyGitPack, envNamesPack, GIT_PACK_TOOL_NAMES, gitPackOn, PACK_ENV, registerGitPack } from "../gitpack.ts";
import type { GitPackSession } from "../gitpack.ts";
import type { SpawnResult, Spawner } from "../spawn.ts";

type Tool = { name: string; defaultActive?: boolean; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

function setup(opts: { packOn?: boolean; reply?: Partial<SpawnResult>; block?: boolean } = {}) {
  const tools = new Map<string, Tool>();
  const traces: Record<string, unknown>[] = [];
  const calls: { input?: string }[] = [];
  const spawner: Spawner = async (_cmd, _args, o) => {
    calls.push({ input: o.input });
    return { code: 0, stdout: JSON.stringify({ ok: true, action: "status", branch: "b" }) + "\n", stderr: "", timedOut: false, ...opts.reply };
  };
  const session: GitPackSession = { python: "/py", isChild: false, packOn: opts.packOn ?? true, opsConfig: { baseBranch: "x" }, trace: (r) => void traces.push(r) };
  registerGitPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, {
    session: async () => session,
    script: "/s.py",
    spawner,
    env: () => ({}),
    preflight: opts.block ? async () => ({ block: true as const, reason: "git config changed." }) : undefined,
  });
  const call = (name: string, params: Record<string, unknown> = {}) => tools.get(name)!.execute("id1", params, undefined, undefined, { cwd: "/ws" });
  return { tools, traces, calls, call };
}

function fakePi(active: string[]) {
  const state = { active };
  return { state, pi: { getActiveTools: () => state.active, setActiveTools: (n: string[]) => void (state.active = n) } };
}

test("gitpack: four tools are registered inactive", () => {
  const h = setup();
  assert.deepEqual([...h.tools.keys()], [...GIT_PACK_TOOL_NAMES]);
  assert.ok([...h.tools.values()].every((t) => t.defaultActive === false));
});

test("gitpack: the foreman activates the tools and exports the env, off clears it", () => {
  const env: Record<string, string | undefined> = { [PACK_ENV]: "stale" };
  const { pi, state } = fakePi(["read"]);
  applyGitPack(pi, true, false, env);
  assert.deepEqual(state.active, ["read", ...GIT_PACK_TOOL_NAMES]);
  assert.equal(env[PACK_ENV], "git");
  applyGitPack(pi, false, false, env);
  assert.equal(env[PACK_ENV], undefined);
});

test("gitpack: a child keeps the tools only with env and config on", () => {
  const cfg = { tools: { git: true } };
  const env = { [PACK_ENV]: "x, git" };
  assert.equal(gitPackOn({ config: cfg, isChild: true, env }), true);
  assert.equal(gitPackOn({ config: cfg, isChild: true, env: {} }), false);
  assert.equal(gitPackOn({ config: { tools: { git: false } }, isChild: true, env }), false);
  assert.equal(envNamesPack({ [PACK_ENV]: "gitx" }), false);
  const keep = fakePi(["bash", ...GIT_PACK_TOOL_NAMES]);
  applyGitPack(keep.pi, true, true, {});
  assert.deepEqual(keep.state.active, ["bash", ...GIT_PACK_TOOL_NAMES]);
  const drop = fakePi(["bash", ...GIT_PACK_TOOL_NAMES]);
  applyGitPack(drop.pi, false, true, {});
  assert.deepEqual(drop.state.active, ["bash"]);
  const env2: Record<string, string | undefined> = {};
  applyGitPack(drop.pi, true, true, env2);
  assert.equal(env2[PACK_ENV], undefined);
});

test("gitpack: a call with the pack off is refused without a trace", async () => {
  const h = setup({ packOn: false });
  const r = await h.call("git_status");
  assert.equal(r.isError, true);
  assert.equal(r.details.decision, "pack_off");
  assert.match(r.content[0].text, /^git_status: the git tool pack is off/);
  assert.deepEqual(h.traces, []);
  assert.equal(h.calls.length, 0);
});

test("gitpack: a call is traced with pack and op and runs the read op", async () => {
  const h = setup();
  const r = await h.call("git_log", { n: 3 });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /^git_log: \{"action":"status","branch":"b"\}$/);
  assert.deepEqual(h.traces, [{ event: "tool_pack", pack: "git", op: "log" }]);
  assert.deepEqual(JSON.parse(h.calls[0].input!), { op: "log", args: { n: 3 }, cwd: "/ws", config: { baseBranch: "x" } });
});

test("gitpack: a precondition failure is a tool error", async () => {
  const h = setup({ reply: { stdout: JSON.stringify({ ok: false, precondition: "bad_request", message: "precondition failed: bad_request (n)" }) } });
  const r = await h.call("git_log", { n: 0 });
  assert.equal(r.isError, true);
  assert.equal(r.details.precondition, "bad_request");
});

test("gitpack: a preflight block refuses before the script runs", async () => {
  const h = setup({ block: true });
  const r = await h.call("git_diff_stat");
  assert.equal(r.details.decision, "blocked");
  assert.equal(h.calls.length, 0);
});
