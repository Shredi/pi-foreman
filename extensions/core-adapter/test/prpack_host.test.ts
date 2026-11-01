import { test } from "node:test";
import assert from "node:assert/strict";
import { PR_TOOL_NAMES, registerPrPack } from "../gitpack.ts";
import type { PrPackSession, PrTracker } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; parameters: { properties: Record<string, unknown> }; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

function setup(opts: { isChild?: boolean; allowed?: string[] } = {}) {
  const tools = new Map<string, Tool>();
  const traces: Record<string, unknown>[] = [];
  const sent: { op: string; args: Record<string, unknown> }[] = [];
  const spawner: Spawner = async (_c, _a, o) => {
    sent.push(JSON.parse(o.input ?? "{}"));
    return { code: 0, stdout: JSON.stringify({ ok: true, action: "pr_status", number: 5, state: "open", title: "title", url: "https://github.com/acme/app/pull/5" }) + "\n", stderr: "", timedOut: false };
  };
  const tracker: PrTracker = { hostAllowed: async (h) => (opts.allowed ?? ["github.com"]).includes(h) };
  const session: PrPackSession = {
    python: "/py",
    isChild: opts.isChild ?? false,
    packOn: true,
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
  return { tools, names, traces, sent, call };
}

test("the PR tools no longer include pr_track and pr_untrack", () => {
  assert.ok(!PR_TOOL_NAMES.includes("pr_track") && !PR_TOOL_NAMES.includes("pr_untrack"));
  assert.ok(!setup().names.includes("pr_track"));
});

test("host: refused unless it is the current host or a remote's; the read tools pass repo, host and required on", async () => {
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
