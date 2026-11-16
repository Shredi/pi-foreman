// pr_create, draft asked, the undo fails: the by-hand line says "watched, tracker down" when the watch is armed and the tracker is not running,
// and keeps the old text when the PR is not watched or tracked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { StoreRead } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> };

const created = { ok: true, action: "pr_create", number: 12, url: "https://github.com/acme/app/pull/12", head: "feat", base: "main" };
const out = (o: Record<string, unknown>) => ({ code: 0, stdout: JSON.stringify(o) + "\n", stderr: "", timedOut: false });
const NEW_LINE = "the PR was opened as a draft and is watched, but no PR tracker is running: take it out of draft by hand";
const OLD_LINE = "the PR was opened as a draft and is not watched or tracked: take it out of draft by hand";

async function create(o: { store: () => StoreRead; track?: "added" | "unavailable" }): Promise<string> {
  const tools = new Map<string, Tool>();
  const spawner: Spawner = async (_c, _a, opt) => {
    const req = JSON.parse(opt.input ?? "{}") as { op: string };
    if (req.op === "pr_create") return out(created);
    if (req.op === "pr_draft") return out({ ok: false, error: "pr_host_failed", message: "no" });
    return out({ ok: false, error: "x", message: "unexpected op " + req.op });
  };
  const watches = new PrWatches({ storeEntry: o.store, githubHosts: () => ({ hosts: ["github.com"] }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} } });
  const session: PrPackSession = {
    python: "/py",
    isChild: false,
    packOn: true,
    config: { prHost: "auto" },
    gateOn: false,
    reviewed: async () => [],
    watches,
    trace: () => {},
    tracker: { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/app" }) },
    track: async () => o.track ?? "added",
    githubHosts: () => ({ hosts: ["github.com"] }),
    draftFlow: () => true,
  };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const r = await tools.get("pr_create")!.execute("id", { title: "T", body: "B" }, undefined, undefined, { cwd: process.cwd() });
  return r.content[0].text;
}

test("tracker live at the ask, down at the arm, undo fails: the new by-hand line, no stale phrase", async () => {
  let n = 0;
  const text = await create({ store: () => (++n === 1 ? { kind: "waiting" } : { kind: "down" }) });
  assert.ok(text.includes(NEW_LINE));
  assert.ok(!text.includes("is not watched or tracked"));
  assert.ok(!text.includes("no PR tracker running: take"));
});

test("tracker live but the PR was not added to the tracked list (not owned), undo fails: the old by-hand line", async () => {
  const text = await create({ store: () => ({ kind: "waiting" }), track: "unavailable" });
  assert.ok(text.includes(OLD_LINE));
  assert.ok(!text.includes(NEW_LINE));
});
