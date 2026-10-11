import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPrPack, GIT_PACK_TOOL_NAMES, PACK_ENV, PR_TOOL_NAMES, prHostLabel, prPackOn, registerPrPack, setPackToken } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { SpawnResult, Spawner } from "../spawn.ts";

type Tool = { name: string; defaultActive?: boolean; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

function setup(opts: { packOn?: boolean; isChild?: boolean; reply?: Partial<SpawnResult>; block?: boolean; reviewed?: string[]; push?: string | null; gateOn?: boolean; sessionChild?: boolean } = {}) {
  const tools = new Map<string, Tool>();
  const traces: Record<string, unknown>[] = [];
  const calls: { input: string }[] = [];
  const spawner: Spawner = async (_c, _a, o) => {
    calls.push({ input: o.input ?? "" });
    return { code: 0, stdout: JSON.stringify({ ok: true, action: "pr_create", number: 5, url: "https://h.invalid/pull/5" }) + "\n", stderr: "", timedOut: false, ...opts.reply };
  };
  const watches = new PrWatches({ poll: async () => ({ error: "x" }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0 });
  const session: PrPackSession = { python: "/py", isChild: opts.sessionChild ?? opts.isChild ?? false, packOn: opts.packOn ?? true, config: { baseBranch: "x", prHost: "auto" }, gateOn: opts.gateOn ?? true, reviewed: async () => opts.reviewed ?? [], watches, trace: (r) => void traces.push(r) };
  const names = registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, {
    isChild: opts.isChild ?? false,
    session: async () => session,
    script: "/s.py",
    spawner,
    env: () => ({}),
    preflight: opts.block ? async () => ({ block: true as const, reason: "git config changed." }) : undefined,
    pushRefusal: async () => opts.push ?? null,
  });
  const call = (name: string, params: Record<string, unknown> = {}) => tools.get(name)!.execute("id1", params, undefined, undefined, { cwd: process.cwd() });
  return { tools, names, traces, calls, call };
}

function fakePi(active: string[]) {
  const state = { active };
  return { state, pi: { getActiveTools: () => state.active, setActiveTools: (n: string[]) => void (state.active = n) } };
}

test("prpack: five tools registered inactive, a child registers the three reads", () => {
  const h = setup();
  assert.deepEqual(h.names, [...PR_TOOL_NAMES]);
  assert.ok([...h.tools.values()].every((t) => t.defaultActive === false));
  assert.deepEqual(setup({ isChild: true }).names, ["pr_status", "pr_checks", "pr_comments"]);
});

test("prpack: env tokens git,pr / pr / removal, child removal when off", () => {
  const env: Record<string, string | undefined> = { [PACK_ENV]: "git" };
  const { pi, state } = fakePi(["read"]);
  applyPrPack(pi, true, false, env);
  assert.equal(env[PACK_ENV], "git,pr");
  assert.deepEqual(state.active, ["read", ...PR_TOOL_NAMES]);
  setPackToken(env, "git", false);
  assert.equal(env[PACK_ENV], "pr");
  applyPrPack(pi, false, false, env);
  assert.equal(env[PACK_ENV], undefined);
  assert.equal(prPackOn({ config: { tools: { pr: true } }, isChild: true, env: { [PACK_ENV]: "git,pr" } }), true);
  assert.equal(prPackOn({ config: { tools: { pr: true } }, isChild: true, env: { [PACK_ENV]: "git" } }), false);
  const kid = fakePi(["bash", ...GIT_PACK_TOOL_NAMES, "pr_status", "pr_checks"]);
  applyPrPack(kid.pi, false, true, {});
  assert.deepEqual(kid.state.active, ["bash", ...GIT_PACK_TOOL_NAMES]);
});

test("prpack: pr_off refuses without a trace or a script run", async () => {
  const h = setup({ packOn: false });
  const r = await h.call("pr_status");
  assert.equal(r.details.decision, "pr_off");
  assert.match(r.content[0].text, /^pr_status: the PR tools are off \(tools\.pr\); nothing was done\.$/);
  assert.deepEqual(h.traces, []);
  assert.equal(h.calls.length, 0);
});

test("prpack: a preflight block means no tool_pack trace; a read passes config.prHost through", async () => {
  const blocked = setup({ block: true });
  assert.equal((await blocked.call("pr_checks")).details.decision, "blocked");
  assert.deepEqual(blocked.traces, []);
  const h = setup({ reply: { stdout: JSON.stringify({ ok: true, action: "pr_status", number: 5 }) } });
  const r = await h.call("pr_status", { number: 5 });
  assert.match(r.content[0].text, /^pr_status: \{"action":"pr_status","number":5\}$/);
  assert.deepEqual(h.traces, [{ event: "tool_pack", pack: "git", op: "pr_status" }]);
  assert.deepEqual(JSON.parse(h.calls[0].input), { op: "pr_status", args: { number: 5 }, cwd: process.cwd(), config: { baseBranch: "x", prHost: "auto" } });
});

test("prpack: pr_create order, gate refusal traced, push refusal, upstream stale, ran text", async () => {
  const none = setup();
  const r1 = await none.call("pr_create", { title: "t", body: "b" });
  assert.equal(r1.details.decision, "pr_refused");
  assert.match(r1.content[0].text, /\[pr_refused:no_review\]/);
  assert.deepEqual(none.traces, [{ event: "tool_pack", pack: "git", op: "pr_create" }, { event: "pr_refused", reason: "no_review", toolFamily: "pr_create" }]);
  assert.equal(none.calls.length, 0);
  const off = setup({ gateOn: false, push: "protected branch" });
  const r2 = await off.call("pr_create", { title: "t", body: "b" });
  assert.equal(r2.details.decision, "push_refused");
  assert.match(r2.content[0].text, /^pr_create: the git guard would refuse pushing this branch \(protected branch\); nothing was done\.$/);
  const ok = setup({ gateOn: false });
  const r3 = await ok.call("pr_create", { title: "t", body: "b" });
  assert.equal(r3.details.decision, "ran");
  assert.match(r3.content[0].text, /^pr_create: \{"action":"pr_create","number":5,"url":"https:\/\/h\.invalid\/pull\/5"\}$/);
});

test("prpack: a child session refuses pr_create and pr_watch with the child text", async () => {
  const h = setup({ sessionChild: true });
  for (const n of ["pr_create", "pr_watch"]) {
    const r = await h.call(n, { title: "t", body: "b" });
    assert.equal(r.details.reason, "child");
    assert.match(r.content[0].text, /\[pr_refused:child\]: children may not create pull requests/);
  }
  assert.equal(h.calls.length, 0);
});

test("prHostLabel: templates, explicit, none", () => {
  assert.equal(prHostLabel({ create: "x" }, "/ws", {}, "linux"), "on, host from tools.prHost templates");
  assert.match(prHostLabel("auto", "/ws", { PATH: "" }, "linux"), /^on, no host CLI \(gh, glab\) found outside the workspace; every PR tool call refuses pr_host_missing/);
});
