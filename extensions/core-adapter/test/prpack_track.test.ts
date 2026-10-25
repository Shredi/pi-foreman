import { test } from "node:test";
import assert from "node:assert/strict";
import { PR_TOOL_NAMES, registerPrPack } from "../gitpack.ts";
import type { PrPackSession, PrTracker } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";
import type { PrKey } from "../prtrack.ts";

type Tool = { name: string; parameters: { properties: Record<string, unknown> }; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

function setup(opts: { isChild?: boolean; sessionChild?: boolean; packOn?: boolean; answer?: Record<string, unknown>; allowed?: string[] } = {}) {
  const tools = new Map<string, Tool>();
  const traces: Record<string, unknown>[] = [];
  const sent: { op: string; args: Record<string, unknown> }[] = [];
  const tracked: { key: PrKey; head?: string }[] = [];
  const untracked: PrKey[] = [];
  const spawner: Spawner = async (_c, _a, o) => {
    sent.push(JSON.parse(o.input ?? "{}"));
    return { code: 0, stdout: JSON.stringify({ ok: true, action: "pr_status", number: 5, state: "open", title: "t\u0085itle", url: "https://github.com/acme/app/pull/5", ...opts.answer }) + "\n", stderr: "", timedOut: false };
  };
  const tracker: PrTracker = {
    hostAllowed: async (h) => (opts.allowed ?? ["github.com"]).includes(h),
    resolveRepo: async (_cwd, repo, host) => ({ host: host ?? "github.com", repo: repo ?? "acme/app" }),
    trackTool: (key, head) => void tracked.push({ key, head }),
    untrack: (key) => void untracked.push(key),
  };
  const session: PrPackSession = {
    python: "/py",
    isChild: opts.isChild ?? opts.sessionChild ?? false,
    packOn: opts.packOn ?? true,
    config: {},
    gateOn: false,
    reviewed: async () => [],
    watches: new PrWatches({ poll: async () => ({ error: "x" }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0 }),
    trace: (r) => void traces.push(r),
    tracker,
  };
  const names = registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, {
    isChild: opts.isChild ?? false,
    session: async () => session,
    script: "/s.py",
    spawner,
    env: () => ({}),
    pushRefusal: async () => null,
  });
  const call = (name: string, params: Record<string, unknown> = {}) => tools.get(name)!.execute("id1", params, undefined, undefined, { cwd: process.cwd() });
  return { tools, names, traces, sent, tracked, untracked, call };
}

test("pr_track and pr_untrack are foreman tools; a child registers only the reads", () => {
  assert.ok(PR_TOOL_NAMES.includes("pr_track") && PR_TOOL_NAMES.includes("pr_untrack"));
  assert.deepEqual(setup({ isChild: true }).names, ["pr_status", "pr_checks", "pr_comments"]);
  assert.ok(setup().names.includes("pr_track"));
});

test("pr_track and pr_untrack are refused in a child session [pr_refused:child] and with the PR pack off [pr_off]", async () => {
  const child = setup({ sessionChild: true });
  for (const n of ["pr_track", "pr_untrack"]) {
    const r = await child.call(n, { number: 5 });
    assert.equal(r.details.decision, "pr_refused");
    assert.equal(r.details.reason, "child");
    assert.match(r.content[0].text, /\[pr_refused:child\]/);
  }
  assert.equal(child.sent.length + child.tracked.length + child.untracked.length, 0);
  const off = setup({ packOn: false });
  for (const n of ["pr_track", "pr_untrack"]) {
    const r = await off.call(n, { number: 5 });
    assert.equal(r.details.decision, "pr_off");
  }
  assert.equal(off.sent.length, 0);
});

test("pr_track: arguments are validated before anything runs", async () => {
  const h = setup();
  for (const params of [{}, { number: 0 }, { number: 1.5 }, { number: 2e9 }, { number: 5, repo: "-x/y" }, { number: 5, repo: "a/.." }, { number: 5, repo: "one" }, { number: 5, host: "bad host" }]) {
    const r = await h.call("pr_track", params);
    assert.equal(r.details.decision, "bad_request", JSON.stringify(params));
  }
  assert.equal(h.sent.length, 0);
  assert.equal(h.tracked.length, 0);
});

test("pr_track: one pr_status for the identity; an open PR registers under the answer's URL and the title is sanitised", async () => {
  const h = setup({ answer: { headRefName: "feat" } });
  const r = await h.call("pr_track", { number: 5, repo: "acme/lib", host: "github.com" });
  assert.equal(r.details.decision, "ran");
  assert.deepEqual(h.sent.map((s) => [s.op, s.args]), [["pr_status", { number: 5, repo: "acme/lib", host: "github.com" }]]);
  assert.deepEqual(h.tracked, [{ key: { host: "github.com", repo: "acme/app", n: 5 }, head: "feat" }]);
  assert.equal(r.content[0].text, 'pr_track: {"key":"github.com/acme/app#5","title":"title"}');
  const plain = setup();
  await plain.call("pr_track", { number: 5 });
  assert.deepEqual(plain.sent[0].args, { number: 5 }, "no repo argument for the current repository");
});

test("pr_track: a merged or closed PR is pr_gone and nothing is tracked", async () => {
  for (const state of ["merged", "closed"]) {
    const h = setup({ answer: { state } });
    const r = await h.call("pr_track", { number: 5 });
    assert.equal(r.details.decision, "pr_gone");
    assert.match(r.content[0].text, /\[pr_gone\]/);
    assert.equal(h.tracked.length, 0);
  }
});

test("pr_untrack drops the key without running the host", async () => {
  const h = setup();
  const r = await h.call("pr_untrack", { number: 5, repo: "acme/lib" });
  assert.equal(r.details.decision, "ran");
  assert.deepEqual(h.untracked, [{ host: "github.com", repo: "acme/lib", n: 5 }]);
  assert.equal(h.sent.length, 0);
  assert.equal((await h.call("pr_untrack", {})).details.decision, "bad_request");
});

test("host: refused unless it is the current host, a remote's or a tracked PR's; the read tools pass repo, host and required on", async () => {
  for (const isChild of [false, true]) {
    const h = setup({ isChild });
    for (const n of ["pr_status", "pr_checks", "pr_comments"]) {
      const bad = await h.call(n, { host: "evil.example.net" });
      assert.equal(bad.details.decision, "pr_refused");
      assert.equal(bad.details.reason, "pr_host_refused");
      assert.match(bad.content[0].text, /\[pr_host_refused\]/);
    }
    assert.equal(h.sent.length, 0, "no op ran");
    const ok = await h.call("pr_checks", { number: 5, repo: "acme/lib", host: "github.com", required: true });
    assert.equal(ok.details.decision, "ran");
    assert.deepEqual(h.sent[0].args, { number: 5, repo: "acme/lib", host: "github.com", required: true });
    assert.equal((await h.call("pr_status", { host: "bad host" })).details.decision, "bad_request");
    assert.ok(h.traces.some((t) => t.event === "pr_refused" && t.reason === "host"));
  }
});

test("the read tools' schema carries repo and host; pr_checks also required", () => {
  const h = setup();
  for (const n of ["pr_status", "pr_checks", "pr_comments"]) assert.ok("repo" in h.tools.get(n)!.parameters.properties && "host" in h.tools.get(n)!.parameters.properties, n);
  assert.ok("required" in h.tools.get("pr_checks")!.parameters.properties);
  assert.ok(!("required" in h.tools.get("pr_status")!.parameters.properties));
});
