// D80: foreman_ledger {action: "init", topic, texts?} creates and binds a ledger for a session without the write tool.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { boundLedger, markerPath } from "../marker.ts";
import { isLedgerOnlyCommand, LEDGER_ACTIONS, planLedgerInit } from "../ledgercall.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig } from "./_r11rig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

type Res = { content: { text: string }[]; isError?: boolean };
type Rig = Awaited<ReturnType<typeof makeRig>>;
let shared: Rig | undefined;
const ends: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const fn of ends) await fn();
});
/** One session for every case but the child's: each case gets it back with an empty .workflow and its marker without a binding. */
async function rig(t: Parameters<typeof r11Rig>[0], child = false): Promise<Rig> {
  if (child) return makeRig(t, true);
  if (!shared) return (shared = await makeRig({ after: (fn) => void ends.push(fn) }, false));
  const dir = path.join(shared.a.project, ".workflow");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const marker = markerPath(path.join(shared.a.agentDir, "pi-foreman", "state"), shared.a.sessionId);
  const { session_id, started } = JSON.parse(fs.readFileSync(marker, "utf8")) as { session_id: string; started: number };
  fs.writeFileSync(marker, JSON.stringify({ session_id, started })); // no binding, same session
  return shared;
}
async function makeRig(t: Parameters<typeof r11Rig>[0], child: boolean) {
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<Res> }>();
  const a = await r11Rig(t, { ledgerHelper: "tool" }, { child, piExtra: { registerTool: (d: { name: string; execute: never }) => void tools.set(d.name, d as never) } });
  const bound = () => boundLedger(path.join(a.agentDir, "pi-foreman", "state"), a.sessionId);
  const init = async (params: Record<string, unknown>) => {
    const r = await tools.get("foreman_ledger")!.execute("id", { action: "init", ...params }, undefined, undefined, a.ctx);
    return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
  };
  return { a, bound, init, real: (f: string) => fs.realpathSync.native(f), file: (topic: string) => path.join(a.project, ".workflow", `LEDGER-${topic}.md`) };
}

test("D80: init without write in the tools creates, binds, and a builder launch is accepted", { skip }, async (t) => {
  const r = await rig(t);
  const task = `Build the thing. ${"detail ".repeat(400)}`;
  const before = await r.a.launch({ agent: "builder", task });
  assert.ok(before.res?.block, "no ledger: the spawn gate refuses");
  const res = await r.init({ topic: "d80", texts: ["first thing", "second thing"] });
  assert.equal(res.isError, false, res.text);
  const file = r.file("d80");
  assert.match(res.text, /created .*LEDGER-d80\.md/);
  assert.match(res.text, /first thing/);
  assert.equal(r.bound(), r.real(file));
  const body = fs.readFileSync(file, "utf8");
  assert.match(body, /^# LEDGER d80\n\n- \[ \] 1\. first thing\n- \[ \] 2\. second thing\n- \[ \] V\. fresh-eyes verification passed\n$/);
  const after = await r.a.launch({ agent: "builder", task });
  assert.equal(after.res, undefined, String(after.res?.reason));
});

test("D80: init creates .workflow when it is missing", { skip }, async (t) => {
  const r = await rig(t);
  fs.rmSync(path.join(r.a.project, ".workflow"), { recursive: true });
  const res = await r.init({ topic: "fresh", texts: ["x"] });
  assert.equal(res.isError, false, res.text);
  assert.equal(r.bound(), r.real(r.file("fresh")));
});

test("D80: init of an existing unbound file binds it unchanged, without texts", { skip }, async (t) => {
  const r = await rig(t);
  const file = r.file("old");
  fs.writeFileSync(file, "# old\n\n- [ ] 1. keep me\n- [ ] V. fresh-eyes verification passed\n");
  const res = await r.init({ topic: "old" });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /bound .*LEDGER-old\.md/);
  assert.equal(r.bound(), r.real(file));
  assert.equal(fs.readFileSync(file, "utf8"), "# old\n\n- [ ] 1. keep me\n- [ ] V. fresh-eyes verification passed\n");
  const again = await r.init({ topic: "old" });
  assert.equal(again.isError, false, "the same path binds again");
});

test("D80: init of an existing file while bound elsewhere is refused and names the live ledger", { skip }, async (t) => {
  const r = await rig(t);
  const made = await r.init({ topic: "live", texts: ["a"] });
  assert.equal(made.isError, false, made.text);
  const other = r.file("other");
  fs.writeFileSync(other, "# other\n- [ ] 1. x\n");
  const res = await r.init({ topic: "other" });
  assert.equal(res.isError, true);
  assert.match(res.text, /ledger_bound_elsewhere/);
  assert.match(res.text, /LEDGER-live\.md/);
  assert.equal(r.bound(), r.real(r.file("live")));
});

test("D80: a new ledger replaces a live binding like a write of it", { skip }, async (t) => {
  const r = await rig(t);
  await r.init({ topic: "one", texts: ["a"] });
  const res = await r.init({ topic: "two", texts: ["b"] });
  assert.equal(res.isError, false, res.text);
  assert.equal(r.bound(), r.real(r.file("two")));
});

test("D80: texts with an existing file is refused (ledger_exists) and the file is untouched", { skip }, async (t) => {
  const r = await rig(t);
  const file = r.file("there");
  fs.writeFileSync(file, "# there\n");
  const res = await r.init({ topic: "there", texts: ["new"] });
  assert.equal(res.isError, true);
  assert.match(res.text, /ledger_exists/);
  assert.equal(fs.readFileSync(file, "utf8"), "# there\n");
  assert.equal(r.bound(), null);
});

test("D80: a bad topic, an archive name, bad texts are refused and nothing is written", { skip }, async (t) => {
  const r = await rig(t);
  for (const p of [{ topic: "../x" }, { topic: "" }, { topic: "a b" }, { topic: ".hidden" }, { topic: "x".repeat(65) }, { topic: "old-archive" }, { topic: "old_archive" }, {}, { topic: "ok", texts: ["a\nb"] }, { topic: "ok", texts: Array.from({ length: 33 }, () => "x") }, { topic: "ok", texts: "x" }]) {
    const res = await r.init(p as Record<string, unknown>);
    assert.equal(res.isError, true, JSON.stringify(p).slice(0, 60));
  }
  assert.deepEqual(fs.readdirSync(path.join(r.a.project, ".workflow")), []);
  assert.equal(r.bound(), null);
});

test("D80: a child session is refused", { skip }, async (t) => {
  const r = await rig(t, true);
  const res = await r.init({ topic: "kid", texts: ["x"] });
  assert.equal(res.isError, true);
  assert.equal(fs.existsSync(r.file("kid")), false);
});

test("D80: init is no shell ledger action and no tool-less shape change: LEDGER_ACTIONS, isLedgerOnlyCommand, planLedgerInit", () => {
  assert.ok(!(LEDGER_ACTIONS as readonly string[]).includes("init"));
  assert.equal(isLedgerOnlyCommand("ledger init foo"), false);
  assert.equal(isLedgerOnlyCommand("ledger status"), true);
  assert.deepEqual(planLedgerInit({ topic: "a.b-c_1", texts: [" x "] }), { topic: "a.b-c_1", texts: ["x"] });
  assert.ok("error" in planLedgerInit({ topic: "a-archive" }));
});
