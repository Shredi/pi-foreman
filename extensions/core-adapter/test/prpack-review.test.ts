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

function setup(reviewed: string[], headSha: string | undefined = B) {
  const tools = new Map<string, Tool>();
  const spawner: Spawner = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, action: "pr_status", number: 5, url, state: "open", ...(headSha ? { headSha } : {}) }) + "\n", stderr: "", timedOut: false });
  const watches = new PrWatches({ reviewedHeads: () => reviewed, send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0 });
  const session: PrPackSession = { python: "/py", isChild: false, packOn: true, config: { baseBranch: "x", prHost: "auto" }, gateOn: true, reviewed: async () => reviewed, watches, trace: () => {}, tracker: { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/app" }) } };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  return { watches, call: async () => JSON.parse((await tools.get("pr_status")!.execute("id", { number: 5 }, undefined, undefined, { cwd: process.cwd() })).content[0].text.replace(/^pr_status: /, "")) as Record<string, unknown> };
}

test("pr_status: the current head has a PASS", async () => {
  const h = setup([B]);
  assert.equal((await h.call()).review, `head ${B.slice(0, 7)} reviewed`);
});

test("pr_status: the head is not reviewed, the watch of the PR names the last PASS head", async () => {
  const h = setup([A]);
  h.watches.start({ host: "github.com", repo: "acme/app", n: 5 }, snap(A), 1);
  const r = await h.call();
  assert.equal(r.review, `head ${B.slice(0, 7)} not reviewed (last PASS on ${A.slice(0, 7)})`);
  assert.equal(r.headSha, B, "the host fields stay");
});

test("pr_status: no PASS for this PR (followed only, or no watch): no review record", async () => {
  assert.equal((await setup([A]).call()).review, "no review record");
  const h = setup(["9999999zzz"]);
  h.watches.start({ host: "github.com", repo: "acme/app", n: 5 }, snap(A), 1);
  assert.equal((await h.call()).review, "no review record");
});

test("pr_status: an answer without a head carries no review field", async () => {
  assert.equal("review" in (await setup([A], "").call()), false);
});
