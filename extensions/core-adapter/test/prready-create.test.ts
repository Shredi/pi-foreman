import { test } from "node:test";
import assert from "node:assert/strict";
import { PR_TOOL_NAMES, registerPrPack } from "../gitpack.ts";
import type { PrPackSession, TrackOutcome } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

const URL = "https://ghe.example.com/acme/app/pull/12";
const created = { ok: true, action: "pr_create", number: 12, url: URL, head: "feat", base: "main" };
const out = (o: Record<string, unknown>) => ({ code: 0, stdout: JSON.stringify(o) + "\n", stderr: "", timedOut: false });

interface Opts {
  flow?: boolean;
  host?: string;
  tracked?: TrackOutcome;
  createAnswers?: Record<string, unknown>[];
  store?: () => StoreRead;
  repoFor?: boolean;
}

function setup(o: Opts = {}) {
  const tools = new Map<string, Tool>();
  const ops: { op: string; args: Record<string, unknown> }[] = [];
  const answers = [...(o.createAnswers ?? [created])];
  const spawner: Spawner = async (_c, _a, opt) => {
    const req = JSON.parse(opt.input ?? "{}") as { op: string; args: Record<string, unknown> };
    ops.push({ op: req.op, args: req.args });
    if (req.op === "pr_create") return out(answers.shift() ?? created);
    if (req.op === "pr_draft") return out({ ok: true, action: "pr_draft", number: 12, draft: req.args.draft });
    return out({ ok: false, error: "x", message: "unexpected op " + req.op });
  };
  const watches = new PrWatches({ storeEntry: o.store ?? (() => ({ kind: "waiting" })), githubHosts: () => ({ hosts: ["ghe.example.com"] }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} } });
  const session: PrPackSession = {
    python: "/py",
    isChild: false,
    packOn: true,
    config: { prHost: "auto" },
    gateOn: false,
    reviewed: async () => [],
    watches,
    trace: () => {},
    tracker: { hostAllowed: async () => true, repoFor: async () => (o.repoFor === false ? null : { host: o.host ?? "ghe.example.com", repo: "acme/app" }) },
    track: async () => o.tracked ?? "added",
    githubHosts: () => ({ hosts: ["ghe.example.com"] }),
    ...(o.flow === undefined || o.flow ? { draftFlow: () => true } : {}),
  };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const create = (extra: Record<string, unknown> = {}) => tools.get("pr_create")!.execute("id", { title: "T", body: "B", ...extra }, undefined, undefined, { cwd: process.cwd() });
  const call = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("id", params, undefined, undefined, { cwd: process.cwd() });
  return { create, call, ops, watches, creates: () => ops.filter((x) => x.op === "pr_create"), drafts: () => ops.filter((x) => x.op === "pr_draft") };
}

test("pr_draft is not a model-facing tool", () => {
  assert.ok(!PR_TOOL_NAMES.includes("pr_draft"));
});

test("flow on, a GitHub host the watch covers: the PR opens as a draft and the watch owns it", async () => {
  const x = setup();
  const r = await x.create();
  assert.equal(x.creates().length, 1);
  assert.equal(x.creates()[0].args.draft, true);
  assert.equal(x.watches.records()[0].owned, true);
  assert.deepEqual(x.drafts(), []);
  assert.ok(r.content[0].text.includes("pr_watch: armed"));
});

test("the draft parameter has no extra effect with the flow on", async () => {
  const x = setup();
  await x.create({ draft: false });
  assert.equal(x.creates()[0].args.draft, true);
});

test("flow off: pr_create as always (the draft parameter as given), nothing owned", async () => {
  const x = setup({ flow: false });
  await x.create();
  assert.equal("draft" in x.creates()[0].args, false);
  assert.equal(x.watches.records()[0].owned, undefined);
  const y = setup({ flow: false });
  await y.create({ draft: true });
  assert.equal(y.creates()[0].args.draft, true);
  assert.equal(y.watches.records()[0].owned, undefined);
});

test("a GitLab or template host (not a host the watch covers, or none found) asks for no draft", async () => {
  for (const o of [{ host: "gitlab.com" }, { repoFor: false }]) {
    const x = setup(o);
    await x.create();
    assert.equal("draft" in x.creates()[0].args, false, JSON.stringify(o));
    assert.deepEqual(x.drafts(), []);
  }
});

test("draft refused at opening (repository without drafts): one more create without it, once, the watch not owned", async () => {
  const x = setup({ createAnswers: [{ ok: false, error: "pr_host_failed", message: "pr_host_failed: gh: GraphQL: Draft pull requests are not supported in this repository." }, created] });
  const r = await x.create();
  assert.deepEqual(x.creates().map((c) => c.args.draft), [true, false]);
  assert.equal(r.isError, undefined);
  assert.equal(x.watches.records()[0].owned, undefined);
  assert.deepEqual(x.drafts(), []);
});

test("any other create failure is not retried", async () => {
  const x = setup({ createAnswers: [{ ok: false, error: "pr_host_failed", message: "pr_host_failed: gh: HTTP 502 Bad Gateway" }, created] });
  const r = await x.create();
  assert.equal(x.creates().length, 1);
  assert.equal(r.isError, true);
  assert.equal(x.watches.size(), 0);
  // a draft word with no refusal in it is no refusal either
  const y = setup({ createAnswers: [{ ok: false, error: "pr_host_failed", message: "pr_host_failed: gh: a pull request already exists (draft)" }, created] });
  await y.create();
  assert.equal(y.creates().length, 1);
});

test("arming fails after a draft was opened: the PR is taken out of draft at once", async () => {
  const x = setup({
    store: () => {
      throw new Error("store unreadable");
    },
  });
  const r = await x.create();
  assert.equal(x.creates()[0].args.draft, true);
  assert.deepEqual(x.drafts().map((d) => d.args), [{ number: 12, repo: "acme/app", host: "ghe.example.com", draft: false }]);
  assert.equal(x.watches.size(), 0);
  assert.ok(r.content[0].text.includes("taken out of draft"));
});

test("tracked list full or unavailable: the PR is taken out of draft at once and the watch gets no draft handling", async () => {
  for (const tracked of ["full", "unavailable"] as const) {
    const x = setup({ tracked });
    const r = await x.create();
    assert.deepEqual(x.drafts().map((d) => d.args.draft), [false], tracked);
    assert.equal(x.watches.records()[0].owned, undefined, tracked);
    assert.ok(r.content[0].text.includes("taken out of draft"));
  }
});

test("a PR adopted with pr_watch is never owned", async () => {
  const x = setup();
  await x.create();
  await x.call("pr_watch", { number: 5 });
  const recs = x.watches.records();
  assert.deepEqual(recs.map((w) => [w.key.n, w.owned === true]), [[12, true], [5, false]]);
  assert.deepEqual(x.drafts(), []);
});
