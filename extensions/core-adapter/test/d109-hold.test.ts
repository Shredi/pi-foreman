// D109: `foreman_hold` marks that the foreman waits for the owner on purpose. The finish gate accepts a turn end (the pause branch only), the
// final finish after real work still needs the review, the live file says blockedOn owner / blockedKind hold. Cleared by owner input, a builder
// launch, a project edit or `{off:true}`; survives a reload. The real adapter over the r46 world.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world } from "./_r46world.ts";
import { liveDir } from "../livestate.ts";

const items = (n: number, mark: string) => Array.from({ length: n }, (_, i) => `- [${mark}] ${i + 1}. item ${i + 1}`).join("\n");
const CLOSED = `# Ledger: x\nTier: standard\n\n${items(2, "x")}\n- [x] V. fresh-eyes verification passed\n`;
type R = { continue?: boolean; entries?: { customType?: string }[] } | undefined;
type World = ReturnType<typeof world>;
type Adapter = Awaited<ReturnType<World["adapter"]>>;

const once = async (a: Adapter): Promise<R> => (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
/** The turn end after the ledger stop hold (it fires once per session and ledger): the finish gate's answer. */
const settle = async (a: Adapter): Promise<R> => {
  const r = await once(a);
  return types(r).includes("pi-foreman-stop-gate") ? once(a) : r;
};
const types = (r: R) => (r?.entries ?? []).map((e) => e.customType);
const events = async (w: World, event: string) => (await w.traceEvents()).filter((e) => e.event === event);
const refused = (r: R) => r?.continue === true && types(r).includes("pi-foreman-ceremony-gate");
const hold = (a: Adapter, params: Record<string, unknown> = { note: "the owner picks a model" }) => a.tool("foreman_hold")!.execute("h", params, undefined, undefined, a.ctx) as Promise<{ details: { decision: string }; content: { text: string }[]; isError?: boolean }>;
const live = (w: World): Record<string, unknown> => {
  const dir = liveDir(path.join(w.project, "..", "agent"));
  const f = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  return JSON.parse(fs.readFileSync(path.join(dir, f[0]), "utf8")) as Record<string, unknown>;
};
const flush = () => new Promise((r) => setTimeout(r, 1300)); // the live file writes at most once a second

async function start(t: Parameters<typeof world>[0]) {
  const w = world(t, { ceremony: { default: "standard" } });
  const a = await w.adapter();
  await a.writeLedger(CLOSED);
  await a.ownerPrompt();
  return { w, a };
}

test("without a hold a closed ledger and no work is refused; a hold lets the turn end (reason hold); owner input clears it and the refusal is back", async (t) => {
  const { w, a } = await start(t);
  assert.equal(refused(await settle(a)), true);
  const set = await hold(a);
  assert.equal(set.details.decision, "set");
  assert.equal(await settle(a), undefined);
  assert.equal((await events(w, "ceremony_gate")).some((e) => e.reason === "hold"), true);
  await a.ownerPrompt();
  assert.equal(refused(await settle(a)), true);
  assert.equal((await events(w, "hold")).some((e) => e.decision === "cleared" && e.cause === "owner_input"), true);
  assert.equal((await hold(a, { off: true })).details.decision, "none");
});

test("the final finish still needs the review: a builder launch clears the hold, the refusal comes back", async (t) => {
  const { w, a } = await start(t);
  await hold(a);
  assert.equal(await settle(a), undefined);
  const b = await a.agentLaunch("builder", "build it");
  assert.equal(b.blocked, null);
  a.endRunAs(b.id, "builder", "done", undefined, "built");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(refused(await settle(a)), true, "work after the hold is finished only with a PASS");
  assert.equal((await events(w, "hold")).some((e) => e.cause === "builder"), true);
});

test("a project edit clears the hold; {off:true} ends it; a call with no note is refused", async (t) => {
  const { w, a } = await start(t);
  const none = await hold(a, {});
  assert.equal(none.isError, true);
  await hold(a);
  assert.equal(await settle(a), undefined);
  await a.fire("tool_result", { toolName: "write", toolCallId: "e1", input: { path: path.join(w.project, "src.txt"), content: "x" }, details: {}, content: [{ type: "text", text: "ok" }], isError: false });
  assert.equal((await events(w, "hold")).some((e) => e.cause === "edit"), true);
  await hold(a);
  assert.equal((await hold(a, { off: true })).details.decision, "off");
  assert.equal((await events(w, "hold")).some((e) => e.cause === "off"), true);
});

test("live file: blockedOn owner, blockedKind hold while it stands, gone when it ends; a reload keeps the hold", async (t) => {
  const { w, a } = await start(t);
  await hold(a);
  await flush();
  assert.equal(live(w).blockedOn, "owner");
  assert.equal(live(w).blockedKind, "hold");
  const b = await w.adapter("resume");
  assert.equal(await settle(b), undefined, "the hold survived the reload");
  await flush();
  assert.equal(live(w).blockedKind, "hold");
  await hold(b, { off: true });
  await flush();
  assert.equal("blockedOn" in live(w), false);
  assert.equal(w.ceremonyEntries().at(-1)?.data !== undefined, true);
});
