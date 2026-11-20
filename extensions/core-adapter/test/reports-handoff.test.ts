// The handoff copy of the report tool (reportstool.ts, reportsimport.ts appendHandoff): in a parent-opened session each recorded row is also appended to
// `reports.jsonl` in the handoff dir; a child of such a session writes there through its launch binding; a session without a parent writes nothing;
// a failing copy keeps the local row and the answer. Best effort, traced.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { readRows, storeFor } from "../reports.ts";
import { HANDOFF_REPORTS } from "../reportsimport.ts";
import { realPath } from "../workspacekey.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1";

type T = { after(fn: () => void | Promise<void>): void };
type Res = { content: { text: string }[]; isError?: boolean };
type Tool = { execute: (...a: unknown[]) => Promise<Res> };

const CACHE = Symbol.for("pi-foreman.launch-binding");
const REPORT = { kind: "rule", subject: "guard x", what: "it blocked a read", effect: "blocked" };

async function rig(t: T, o: { role?: string; handoff?: string; env?: string } = {}) {
  const saved = { b: process.env[BINDINGS_ENV], h: process.env.PI_FOREMAN_HANDOFF_DIR };
  t.after(() => {
    for (const [k, v] of [[BINDINGS_ENV, saved.b], ["PI_FOREMAN_HANDOFF_DIR", saved.h]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete (globalThis as unknown as Record<symbol, unknown>)[CACHE];
  });
  delete (globalThis as unknown as Record<symbol, unknown>)[CACHE];
  if (o.role) process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: o.role, launchId: "L1", kind: "first", workspace: "", model: null, ...(o.handoff ? { handoffDir: o.handoff } : {}) } });
  else delete process.env[BINDINGS_ENV];
  if (o.env) process.env.PI_FOREMAN_HANDOFF_DIR = o.env;
  else delete process.env.PI_FOREMAN_HANDOFF_DIR;
  const tools = new Map<string, Tool>();
  const r = await r11Rig(t, {}, {
    child: !!o.role,
    config: { presence: { enabled: false } },
    piExtra: { registerTool: (d: { name: string } & Tool) => void tools.set(d.name, d), getActiveTools: () => ["foreman_report"], setActiveTools: () => undefined },
  });
  return {
    project: r.project,
    rows: () => readRows(storeFor(r.project).file),
    trace: (e: string) => r.events(e),
    call: async (params: Record<string, unknown>) => {
      const res = await tools.get("foreman_report")!.execute("id", params, undefined, undefined, r.ctx);
      return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
    },
  };
}

const dirOf = (t: T): string => {
  const d = realPath(fs.mkdtempSync(path.join(os.tmpdir(), "pf-handoff-")));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test("a main session with a handoff dir appends each recorded row to reports.jsonl there; a repeat (seen) adds nothing", async (t) => {
  const handoff = dirOf(t);
  const a = await rig(t, { env: handoff });
  const first = await a.call(REPORT);
  assert.match(first.text, /^recorded /);
  assert.match((await a.call(REPORT)).text, /^seen /);
  assert.match((await a.call({ ...REPORT, subject: "guard y" })).text, /^recorded /);
  const copy = readRows(path.join(handoff, HANDOFF_REPORTS));
  assert.deepEqual(copy.map((r) => r.id), a.rows().map((r) => r.id), "the same rows, same ids");
  assert.equal(copy.length, 2);
});

test("a child of a parent-opened session writes to the handoff dir of its launch binding", async (t) => {
  const handoff = dirOf(t);
  const c = await rig(t, { role: "builder", handoff });
  assert.equal(process.env.PI_FOREMAN_HANDOFF_DIR, undefined, "the child's env has no handoff variable");
  assert.match((await c.call(REPORT)).text, /^recorded /);
  const copy = readRows(path.join(handoff, HANDOFF_REPORTS));
  assert.equal(copy.length, 1);
  assert.equal(copy[0].session, "parent-session");
  assert.equal(copy[0].role, "builder");
});

test("a session without a parent and a child without a handoff dir write no copy", async (t) => {
  const none = await rig(t);
  assert.match((await none.call(REPORT)).text, /^recorded /);
  const child = await rig(t, { role: "builder" });
  assert.match((await child.call(REPORT)).text, /^recorded /);
  assert.equal(none.rows().length, 1);
  assert.equal(child.rows().length, 1);
});

test("a failing handoff write keeps the local row and the tool result, and is traced", async (t) => {
  const missing = path.join(dirOf(t), "gone", "deeper");
  const a = await rig(t, { env: missing });
  const res = await a.call(REPORT);
  assert.match(res.text, /^recorded /);
  assert.equal(res.isError, false);
  assert.equal(a.rows().length, 1);
  assert.equal(fs.existsSync(missing), false, "the handoff dir is never created");
  const ev = a.trace("report_handoff_failed");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].id, a.rows()[0].id);
});
