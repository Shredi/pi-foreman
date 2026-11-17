// Pages revision: "PR opened" for every PR pr_create made (not only draft-managed ones), linear code spans and links, the plan page line's real reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import { inline } from "../pages.ts";
import { planPageLine, showOffReason } from "../show.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> };

function setup(result: Record<string, unknown>, tracker: boolean) {
  const tools = new Map<string, Tool>();
  const seen: string[] = [];
  const spawner: Spawner = async () => ({ code: 0, stdout: JSON.stringify({ ok: true, ...result }) + "\n", stderr: "", timedOut: false });
  const watches = new PrWatches({ storeEntry: async () => ({ kind: "down" }), reviewedHeads: () => [], send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0, milestone: (k, n) => void seen.push(`${k}:${n}`) });
  const session: PrPackSession = { python: "/py", isChild: false, packOn: true, config: { baseBranch: "x", prHost: "auto" }, gateOn: false, reviewed: async () => [], watches, trace: () => {}, githubHosts: () => ({ hosts: ["github.com"] }), ...(tracker ? { tracker: { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/app" }) } } : {}) };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const call = async (name: string, params: Record<string, unknown>) => (await tools.get(name)!.execute("id", params, undefined, undefined, { cwd: process.cwd() })).content[0].text;
  return { seen, call };
}

test("pr_create records PR opened without the draft flow", async () => {
  const h = setup({ action: "pr_create", number: 5, url: "https://github.com/acme/app/pull/5" }, true);
  await h.call("pr_create", { title: "t", body: "b" });
  assert.deepEqual(h.seen, ["pr_opened:5"]);
});

test("a plain pr_watch of a PR this session did not create records nothing", async () => {
  const h = setup({ action: "pr_status", number: 6, url: "https://github.com/acme/app/pull/6", state: "open", headSha: "a".repeat(40) }, true);
  await h.call("pr_watch", { number: 6 });
  assert.deepEqual(h.seen, []);
});

test("code spans: same output on ordinary text, linear on growing backtick runs", () => {
  assert.equal(inline("a `x` b"), "a <code>x</code> b");
  assert.equal(inline("``a ` b``"), "<code>a ` b</code>");
  assert.equal(inline("`` x ``"), "<code>x</code>");
  assert.equal(inline("`a` and `b`"), "<code>a</code> and <code>b</code>");
  assert.equal(inline("```a`` b"), "```a`` b");
  let src = "";
  for (let i = 1; src.length < 20_000; i++) src += "`".repeat(i) + "x ";
  const t = Date.now();
  inline(src);
  assert.ok(Date.now() - t < 300, `took ${Date.now() - t} ms`);
});

test("links: same output on ordinary text, linear on unclosed brackets", () => {
  assert.equal(inline("[a](https://x.test/p)"), '<a href="https://x.test/p">a</a>');
  assert.equal(inline("see [a **b**](/rel) and [c](https://y.test)"), 'see <a href="/rel">a <strong>b</strong></a> and <a href="https://y.test">c</a>');
  assert.equal(inline("[bad](javascript:alert(1))"), "[bad](javascript:alert(1))");
  assert.equal(inline("[bad](javascript:x)"), "bad");
  assert.equal(inline("[a] (b) [](x)"), "[a] (b) [](x)");
  assert.equal(inline("[[a](/r)"), '<a href="/r">[a</a>'); // the leftmost `[` wins, as the regex did
  const t = Date.now();
  inline("[".repeat(256 * 1024));
  inline("[a".repeat(128 * 1024) + "]");
  assert.ok(Date.now() - t < 300, `took ${Date.now() - t} ms`);
});

test("plan page line names why there is no page", async () => {
  assert.equal(showOffReason(false, "abc"), "live state off");
  assert.equal(showOffReason(true, "a/b"), "session id unsafe");
  assert.equal(showOffReason(true, ".."), "session id unsafe");
  assert.equal(showOffReason(true, "abc"), "scratch dir off");
  assert.equal(await planPageLine(undefined, 10, "live state off"), "Plan page: not available (live state off)");
  assert.equal(await planPageLine(undefined), "Plan page: not available (scratch dir off)");
});
