// Ledger item 26: the session's own single role launch is a deterministic gate allow (`default-role-launch`), with no classifier model.
// r79 item 11: an unmatched call that is not of the dangerous class runs in mode auto, so an unknown agent is no longer asked about.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { toolDefault } from "../defaults.ts";
import { NO_MODEL_NOTICE } from "../classifier.ts";

const ROLES = ["explorer", "planner", "builder", "reviewer", "senior-reviewer", "finalizer"];
let completes = 0;
let selects = 0;
let notes: string[] = [];
const modelRegistry = { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }), complete: async () => (completes++, { content: [], stopReason: "stop" }) };
const ui = { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => (selects++, "deny with reason"), input: async () => "no", setStatus: () => undefined, setWidget: () => undefined };
const rig = (t: Parameters<typeof r11Rig>[0], ctx: Record<string, unknown> = {}, config?: Record<string, unknown>) => {
  completes = 0;
  selects = 0;
  notes = [];
  return r11Rig(t, {}, { ctx: { modelRegistry, ui, ...ctx }, config: config ?? { providers: { fake: { roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } } } });
};
const gateRecs = (recs: Record<string, unknown>[]) => recs.filter((x) => x.event === "guard" && x.guard === "gate" && x.toolFamily === "subagent");

test("toolDefault: only a single role launch of a session that is not a child", () => {
  for (const a of ROLES) assert.equal(toolDefault("subagent", { agent: a, task: "x" }, { child: false }), "default-role-launch", a);
  assert.equal(toolDefault("subagent", { agent: "builder", task: "x" }, { child: true }), undefined);
  assert.equal(toolDefault("subagent", { agent: "builder", task: "x" }), undefined);
  for (const i of [{ agent: "scout" }, { agent: "builder", action: "create" }, { action: "status" }, { agent: "builder", tasks: [{ agent: "builder", task: "x" }] }, { chain: [{ agent: "scout" }] }, { agent: "builder", workflow: "x" }, {}])
    assert.equal(toolDefault("subagent", i, { child: false }), undefined, JSON.stringify(i));
});

test("no review model: each role launch is allowed with no dialog and no review call, the trace names the rule", async (t) => {
  for (const agent of ROLES) {
    const r = await rig(t);
    const { id, res } = await r.launch({ agent, task: "look around" });
    assert.equal(res?.block, undefined, `${agent}: ${JSON.stringify(res)}`);
    assert.equal(selects, 0);
    assert.equal(completes, 0);
    const g = gateRecs(r.trace());
    assert.ok(g.some((x) => x.decision === "allowed" && x.rule === "default-role-launch"), JSON.stringify(g));
    assert.deepEqual(r.events("review"), []);
    assert.ok(id);
  }
});

test("an unknown agent is no default allow but is no gate ask either: mode auto runs it, with no dialog and no classifier call", async (t) => {
  for (const ctx of [{}, { hasUI: false, mode: "print" }]) {
    const r = await rig(t, ctx);
    const o = await r.launch({ agent: "scout", task: "x" });
    // the adapter's own role check refuses a non-role agent; the gate itself neither asks nor calls a model
    assert.match(String(o.res?.reason), /is not a pi-foreman role/);
    assert.equal(selects, 0);
    assert.equal(completes, 0);
    assert.ok(!gateRecs(r.trace()).some((x) => x.rule === "default-role-launch"));
  }
});

test("a management action, a workflow and a group with a non-role agent are not the role-launch default", async (t) => {
  for (const input of [{ action: "create", config: { name: "x" } }, { action: "schedule.create" }, { chain: [{ agent: "scout", task: "x" }] }, { tasks: [{ agent: "scout", task: "x" }] }]) {
    const r = await rig(t, { hasUI: false, mode: "print" });
    await r.launch(input);
    assert.ok(!gateRecs(r.trace()).some((x) => x.rule === "default-role-launch"), JSON.stringify(input));
  }
});

test("a launch the adapter's gates refuse stays refused (the default does not bypass them)", async (t) => {
  const r = await rig(t, {}, { providers: { fake: { roles: { explorer: { model: "fake/explorer" } } } } });
  const { res } = await r.launch({ agent: "builder", task: "x" });
  assert.equal(res?.block, true, JSON.stringify(res));
  assert.ok(gateRecs(r.trace()).some((x) => x.rule === "default-role-launch"), "the gate allowed it first");
});

test("the first classifier call that finds no model shows one notice naming the key; once per session", async (t) => {
  const r = await rig(t, { hasUI: false, mode: "print" });
  fs.mkdirSync(path.join(r.agentDir, "pi-foreman"), { recursive: true });
  fs.writeFileSync(path.join(r.agentDir, "pi-foreman", "permissions.json"), JSON.stringify({ classifier: { allow: ["Apply terraform changes"] } }));
  await r.call("bash", { command: "terraform apply -auto-approve" });
  await r.call("bash", { command: "terraform destroy -auto-approve" });
  const n = notes.filter((m) => m.includes("providers.<p>.roles.review.model"));
  assert.equal(n.length, 1, JSON.stringify(notes));
  assert.equal(n[0], NO_MODEL_NOTICE);
});
