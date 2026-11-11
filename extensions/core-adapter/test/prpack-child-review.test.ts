import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { WatchSnapshot } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> };

const A = "aaaaaaa1111111";
const B = "bbbbbbb2222222";
const url = "https://github.com/acme/app/pull/5";
const snap = (head: string): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head, base: "main", updatedAt: "t0", runs: [] });
const CHILD_REVIEW = "not available in a child session (the review record lives with the session that launched it)";

function setup(reviewed: string[], isChild: boolean) {
  const tools = new Map<string, Tool>();
  const spawner: Spawner = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, action: "pr_status", number: 5, url, state: "open", headSha: B }) + "\n", stderr: "", timedOut: false });
  const watches = new PrWatches({ reviewedHeads: () => reviewed, send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0 });
  const session: PrPackSession = { python: "/py", isChild, packOn: true, config: { baseBranch: "x", prHost: "auto" }, gateOn: true, reviewed: async () => reviewed, watches, trace: () => {}, tracker: { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/app" }) } };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  return { watches, call: async () => JSON.parse((await tools.get("pr_status")!.execute("id", { number: 5 }, undefined, undefined, { cwd: process.cwd() })).content[0].text.replace(/^pr_status: /, "")) as Record<string, unknown> };
}

test("pr_status in a child session: the review record is not available there, with or without a watch", async () => {
  assert.equal((await setup([A], true).call()).review, CHILD_REVIEW);
  const h = setup([A], true);
  h.watches.start({ host: "github.com", repo: "acme/app", n: 5 }, snap(A), 1);
  assert.equal((await h.call()).review, CHILD_REVIEW);
});

test("pr_status at top level: no PASS for this PR still says no review record", async () => {
  assert.equal((await setup([A], false).call()).review, "no review record");
});
