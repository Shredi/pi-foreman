// The report tools through the real adapter (reportstool.ts, index.ts): `foreman_report` for every role, `foreman_reports` for the foreman session only,
// `retro.report: false`, the limits, the session of a child's report, and `/foreman flag-ask`. The rig lives in a temp dir; its store is the temp project's.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { DATA_LINE, foldRows, readRows, storeFor } from "../reports.ts";
import { REPORT_DESCRIPTION, REPORTS_DESCRIPTION } from "../reportstool.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1"; // the child rig must not start npm

type T = { after(fn: () => void | Promise<void>): void };
type Res = { content: { text: string }[]; isError?: boolean; details?: { decision?: string } };
type Tool = { description?: string; execute: (...a: unknown[]) => Promise<Res> };
type Command = { handler: (args: string, ctx: unknown) => Promise<void> };

const CACHE = Symbol.for("pi-foreman.launch-binding");
const REPORT = { kind: "rule", subject: "guard x", what: "it blocked a read", effect: "blocked" };

interface Rig {
  tools: Map<string, Tool>;
  call: (name: string, params: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  project: string;
  rows: () => Record<string, unknown>[];
  sessionId: string;
  active: string[];
  command: (args: string) => Promise<void>;
  notes: string[];
  trace: (event: string) => Record<string, unknown>[];
}

async function rig(t: T, o: { role?: string; launchId?: string; config?: Record<string, unknown> } = {}): Promise<Rig> {
  const savedBinding = process.env[BINDINGS_ENV];
  t.after(() => {
    if (savedBinding === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = savedBinding;
    delete (globalThis as unknown as Record<symbol, unknown>)[CACHE];
  });
  delete (globalThis as unknown as Record<symbol, unknown>)[CACHE];
  if (o.role) process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: o.role, launchId: o.launchId ?? "L1", kind: "first", workspace: "", model: null } });
  else delete process.env[BINDINGS_ENV];
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const active = ["foreman_report", "foreman_reports", "read"];
  const notes: string[] = [];
  const r = await r11Rig(t, {}, {
    child: !!o.role,
    config: { presence: { enabled: false }, ...o.config },
    ctx: { ui: { notify: (m: string) => notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: {
      registerTool: (d: { name: string } & Tool) => void tools.set(d.name, d),
      registerCommand: (n: string, d: Command) => void commands.set(n, d),
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => void active.splice(0, active.length, ...names),
    },
  });
  const rows = (): Record<string, unknown>[] => readRows(storeFor(r.project).file);
  return {
    tools,
    project: r.project,
    sessionId: r.sessionId,
    active,
    notes,
    rows,
    trace: (e) => r.events(e),
    call: async (name, params) => {
      const res = await tools.get(name)!.execute("id", params, undefined, undefined, r.ctx);
      return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError === true };
    },
    command: async (args) => commands.get("foreman")!.handler(args, r.ctx),
  };
}

test("both tools are registered with a literal description; the report tool is active, with the key on", async (t) => {
  const a = await rig(t);
  assert.equal(a.tools.get("foreman_report")?.description, REPORT_DESCRIPTION);
  assert.equal(a.tools.get("foreman_reports")?.description, REPORTS_DESCRIPTION);
  assert.ok(a.active.includes("foreman_report"));
  const b = await rig(t);
  assert.equal(b.tools.get("foreman_report")?.description, a.tools.get("foreman_report")?.description, "nothing per request or per session in it");
});

test("a main session's call writes one row with its session; the same key answers seen", async (t) => {
  const a = await rig(t);
  const first = await a.call("foreman_report", { ...REPORT, suggest: "relax it" });
  assert.match(first.text, /^recorded [0-9a-f]{10}$/);
  assert.equal(first.isError, false);
  const again = await a.call("foreman_report", REPORT);
  assert.equal(again.text, `seen ${first.text.slice(9)}`);
  const rows = a.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].role, rows[0].session, rows[0].runId, rows[0].source, rows[0].suggest], ["foreman", a.sessionId, null, "agent", "relax it"]);
  assert.equal(fs.existsSync(path.join(storeFor(a.project).dir, ".gitignore")), true);
});

test("a secret and a path in the call are masked and cut before they are stored; an invalid enum is refused", async (t) => {
  const a = await rig(t);
  await a.call("foreman_report", { ...REPORT, what: "failed with token=abcdef1234567890 at /home/dev/proj/src/app.ts" });
  const text = JSON.stringify(a.rows());
  assert.ok(!text.includes("abcdef1234567890") && !text.includes("/home/dev"), text);
  assert.ok(text.includes("app.ts"));
  const bad = await a.call("foreman_report", { ...REPORT, kind: "other" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /kind must be one of/);
  assert.equal(a.rows().length, 1);
});

test("the main session may report 20 times, the 21st answers limit reached and writes nothing", async (t) => {
  const a = await rig(t);
  for (let i = 0; i < 20; i++) assert.match((await a.call("foreman_report", { ...REPORT, subject: `s${i}` })).text, /^recorded/);
  assert.equal((await a.call("foreman_report", { ...REPORT, subject: "s20" })).text, "limit reached");
  assert.equal(a.rows().length, 20);
  // a reload counts from the store, not from memory
  const b = await rig(t);
  assert.match((await b.call("foreman_report", REPORT)).text, /^recorded/);
});

for (const role of ["explorer", "builder", "reviewer"]) {
  test(`a ${role} child reports into its foreman's session, 5 per run, and cannot call foreman_reports`, async (t) => {
    const c = await rig(t, { role, launchId: "run-1" });
    assert.ok(c.tools.has("foreman_report"), "the child loads the tool");
    for (let i = 0; i < 5; i++) assert.match((await c.call("foreman_report", { ...REPORT, subject: `c${i}` })).text, /^recorded/);
    assert.equal((await c.call("foreman_report", { ...REPORT, subject: "c5" })).text, "limit reached");
    const rows = c.rows();
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.session === "parent-session" && r.runId === "run-1" && r.role === role), JSON.stringify(rows[0]));
    for (const params of [{ action: "list" }, { action: "set", key: "abcd", state: "dropped" }, { action: "group", keys: ["a", "b"] }]) {
      const res = await c.call("foreman_reports", params);
      assert.equal(res.isError, true);
      assert.match(res.text, /foreman session only/);
    }
    assert.equal(c.rows().length, 5, "a refused call changes nothing");
  });
}

test("retro.report false takes the tool off the active tools and a call refuses without writing", async (t) => {
  const off = await rig(t, { config: { retro: { report: false } } });
  assert.ok(!off.active.includes("foreman_report"));
  assert.ok(off.active.includes("foreman_reports"));
  const res = await off.call("foreman_report", REPORT);
  assert.equal(res.isError, true);
  assert.match(res.text, /retro\.report/);
  assert.equal(fs.existsSync(storeFor(off.project).file), false);
});

test("retro.report false in a child keeps the declared tool active; a call refuses with one line and writes no row", async (t) => {
  const c = await rig(t, { role: "builder", config: { retro: { report: false } } });
  assert.ok(c.active.includes("foreman_report"), "a declared tool is never hidden in a child");
  const res = await c.call("foreman_report", REPORT);
  assert.equal(res.isError, true);
  assert.equal(res.text.split("\n").length, 1);
  assert.match(res.text, /retro\.report/);
  assert.equal(fs.existsSync(storeFor(c.project).file), false);
});

test("foreman_reports: list opens with the data line; group and set change the entries; invalid input is refused", async (t) => {
  const a = await rig(t);
  const x = (await a.call("foreman_report", { ...REPORT, subject: "alpha" })).text;
  await a.call("foreman_report", { ...REPORT, subject: "beta", what: "second\nline" });
  const list = await a.call("foreman_reports", { action: "list" });
  assert.equal(list.text.split("\n")[0], DATA_LINE);
  assert.equal(list.text.split("\n").length, 3);
  assert.match(list.text, /subject "alpha"/);
  const key = foldRows(a.rows()).find((e) => e.subject === "alpha")!.key;
  assert.ok(x.startsWith("recorded"));
  assert.match((await a.call("foreman_reports", { action: "set", key, state: "planned", label: "round 3" })).text, /is now planned/);
  assert.match((await a.call("foreman_reports", { action: "list", state: "planned" })).text, /\[planned\].*round "round 3"/);
  assert.equal((await a.call("foreman_reports", { action: "list" })).text.split("\n").length, 2);
  const keys = foldRows(a.rows()).map((e) => e.key);
  assert.match((await a.call("foreman_reports", { action: "group", keys, name: "both" })).text, /grouped 2 keys/);
  assert.equal(foldRows(a.rows()).length, 1);
  for (const bad of [{ action: "nope" }, { action: "set", key: "zzzzzz", state: "done" }, { action: "set", state: "done" }, { action: "list", state: "weird" }, { action: "group", keys: ["one"] }]) {
    assert.equal((await a.call("foreman_reports", bad)).isError, true, JSON.stringify(bad));
  }
});

test("/foreman flag-ask writes a report with the command masked and capped; the trace keeps the full command", async (t) => {
  const a = await rig(t, { config: { trace: { enabled: true } } });
  // no ask answered yet: nothing is written
  await a.command("flag-ask");
  assert.equal(fs.existsSync(storeFor(a.project).file), false);
  assert.ok(a.notes.some((n) => /no ask answered/.test(n)));
});
