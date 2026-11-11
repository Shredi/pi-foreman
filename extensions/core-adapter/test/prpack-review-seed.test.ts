// Review drift, round 2: the number-only watch lookup of pr_status is gone, and pr_create seeds a pending watch with the head it opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead, WatchSnapshot } from "../prwatch.ts";
import { headOf } from "../reviews.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> };

const A = "aaaaaaa1111111";
const B = "bbbbbbb2222222";
const snap = (head: string): WatchSnapshot => ({ state: "open", mergeable: "mergeable", head, base: "main", updatedAt: "t0", runs: [] });

function setup(reviewed: string[], result: Record<string, unknown>, store: StoreRead = { kind: "down" }) {
  const tools = new Map<string, Tool>();
  const sent: string[] = [];
  const spawner: Spawner = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, ...result }) + "\n", stderr: "", timedOut: false });
  const watches = new PrWatches({ storeEntry: async () => store, reviewedHeads: () => reviewed, send: (m) => void sent.push(m.content), idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0 });
  const session: PrPackSession = { python: "/py", isChild: false, packOn: true, config: { baseBranch: "x", prHost: "auto" }, gateOn: false, reviewed: async () => reviewed, watches, trace: () => {}, githubHosts: () => ({ hosts: ["github.com"] }), tracker: { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/app" }) } };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const call = async (name: string, params: Record<string, unknown>) => (await tools.get(name)!.execute("id", params, undefined, undefined, { cwd: process.cwd() })).content[0].text;
  return { watches, sent, call };
}

test("pr_status: an address that does not parse never takes the watch of another repository's PR with the same number", async () => {
  const h = setup([A], { action: "pr_status", number: 5, url: "https://gitlab.example.test/group/sub/proj/-/merge_requests/5", state: "open", headSha: B });
  h.watches.start({ host: "github.com", repo: "acme/app", n: 5 }, snap(A), 1);
  const text = await h.call("pr_status", { number: 5 });
  assert.match(text, /"review":"no review record"/);
});

test("pr_status: an address that does not parse still answers 'reviewed' when the head itself has a PASS", async () => {
  const h = setup([B], { action: "pr_status", number: 5, url: "https://gitlab.example.test/group/sub/proj/-/merge_requests/5", state: "open", headSha: B });
  assert.match(await h.call("pr_status", { number: 5 }), new RegExp(`"review":"head ${B.slice(0, 7)} reviewed"`));
});

test("pr_create with no stored snap seeds the pending watch with the reviewed head it opened", async () => {
  const head = (await headOf(process.cwd()))!;
  assert.ok(head);
  const h = setup([head], { action: "pr_create", number: 5, url: "https://github.com/acme/app/pull/5" });
  await h.call("pr_create", { title: "t", body: "b" });
  assert.equal(h.watches.reviewOf({ host: "github.com", repo: "acme/app", n: 5 }), head);
});

test("pr_create does not seed when the head it opened has no PASS", async () => {
  const h = setup([A], { action: "pr_create", number: 5, url: "https://github.com/acme/app/pull/5" });
  await h.call("pr_create", { title: "t", body: "b" });
  assert.equal(h.watches.reviewOf({ host: "github.com", repo: "acme/app", n: 5 }), "");
});
