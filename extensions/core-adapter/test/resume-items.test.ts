// D142: a resumed reviewer takes the items open now, not its first launch's: the foreman writes them into the record folder (the child's `review_verdict` reads them on
// every call) and into the resumed run's route (the parent's record parse). An id that is not open stays refused on both sides.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { ITEMS_FILE, readItemsSidecar, writeItemsSidecar } from "../verdict.ts";
import { tick, world } from "./_r46world.ts";
import { bindingOf } from "./_verdict-rig.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1";

const LEDGER = "# Ledger: x\nTier: standard\n\n- [ ] 1. first\n- [ ] 2. second\n";
const LEDGER_16 = `${LEDGER}- [ ] 16. late item\n`;

type Res = { content: { text: string }[]; isError?: boolean };
type Tool = { execute: (...a: unknown[]) => Promise<Res> };

/** A reviewer child whose launch binding names `verdictDir` and the first launch's items; returns its `review_verdict` call. */
async function child(t: { after(fn: () => void | Promise<void>): void }, verdictDir: string, items: (number | "V")[]) {
  const saved = process.env[BINDINGS_ENV];
  t.after(() => {
    if (saved === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = saved;
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-foreman.launch-binding")];
  });
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-foreman.launch-binding")];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "reviewer", launchId: "L1", kind: "first", workspace: "", verdictDir, items } });
  const tools = new Map<string, Tool>();
  const r = await r11Rig(t, { ledgerHelper: "tool" }, {
    child: true,
    config: { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: { reviewer: { model: "fake/reviewer" } } } } },
    piExtra: { registerTool: (d: { name: string } & Tool) => void tools.set(d.name, d), registerCommand: () => undefined, getActiveTools: () => ["review_verdict"] },
  });
  return async (params: Record<string, unknown>) => {
    const res = await tools.get("review_verdict")!.execute("id", params, undefined, undefined, r.ctx);
    return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
  };
}

test("sidecar: write and read; a malformed file reads as none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-items-"));
  try {
    assert.equal(readItemsSidecar(dir), null);
    writeItemsSidecar(dir, [1, "V", 16]);
    assert.deepEqual(readItemsSidecar(dir), [1, "V", 16]);
    assert.deepEqual(fs.readdirSync(dir), [ITEMS_FILE]);
    fs.writeFileSync(path.join(dir, ITEMS_FILE), JSON.stringify({ v: 1, items: [1, "x"] }));
    assert.equal(readItemsSidecar(dir), null);
    fs.writeFileSync(path.join(dir, ITEMS_FILE), "{");
    assert.equal(readItemsSidecar(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reviewer's review_verdict reads the resume's items from the record folder on each call; an unknown id stays refused", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-items-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const call = await child(t, dir, [1, 2]);
  const item = (id: number) => ({ verdict: "pass", items: [{ id, result: "pass" }] });
  assert.equal((await call(item(16))).isError, true, "item 16 is not in the first launch's items");
  writeItemsSidecar(dir, [1, 2, 16]); // what the resume writes
  const ok = await call(item(16));
  assert.equal(ok.isError, false, ok.text);
  assert.equal((await call(item(99))).isError, true, "an id that is not listed is refused");
});

test("adapter: item 16 added after the launch, resume, verdict on 16: written for the child and kept by the parent; an unknown item in the resume is refused", async (t) => {
  const w = world(t);
  const a = await w.adapter("startup");
  await a.writeLedger(LEDGER);
  const first = await a.reviewLaunch("review items 1 and 2 of the diff");
  assert.equal(first.blocked, null, String(first.blocked));
  const dir = bindingOf(a.inputOf(first.id))!.verdictDir!;
  assert.deepEqual(bindingOf(a.inputOf(first.id))!.items, [1, 2]);
  assert.equal(readItemsSidecar(dir), null, "a first launch writes none");
  a.endRun(first.id, "Overall verdict: FAIL\n1. FAIL: first is wrong\n");
  await tick(200);

  await a.writeLedger(LEDGER_16);
  const resume = async (extra: Record<string, unknown>) => {
    const id = `r${Math.random().toString(36).slice(2, 8)}`;
    const input: Record<string, unknown> = { action: "resume", id: `run-${first.id}`, message: "go on", ...extra };
    await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
    const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
    if (res?.block) return { blocked: res.reason ?? "blocked", runId: "" };
    await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false });
    return { blocked: null, runId: `run-${id}` };
  };
  const unknown = await resume({ items: [7] });
  assert.match(unknown.blocked ?? "", /items 7 is not open on the ledger\. Open items: 1, 2, 16/);
  assert.equal(readItemsSidecar(dir), null, "a refused resume writes nothing");

  const resumed = await resume({});
  assert.equal(resumed.blocked, null, String(resumed.blocked));
  assert.deepEqual(readItemsSidecar(dir), [1, 2, 16], "the open items now");
  a.record(first.id, { verdict: "pass", items: [{ id: 16, result: "pass" }] }); // the child's verdict on item 16 (its tool accepted it)
  a.endEvent({ runId: resumed.runId, agent: "reviewer", success: true, status: "completed", results: [{ agent: "reviewer", status: "completed", success: true, output: "report" }] });
  await tick(300);
  const events = await w.traceEvents();
  assert.deepEqual(events.filter((e) => e.event === "review_record_invalid"), [], "the parent's parse keeps item 16");
});
