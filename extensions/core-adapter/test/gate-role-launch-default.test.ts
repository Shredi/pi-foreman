// Ledger item 26: the session's own single role launch is a deterministic gate allow (`default-role-launch`), with no review model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { toolDefault } from "../defaults.ts";
import { noReviewModelText } from "../reviewwarn.ts";

const ROLES = ["explorer", "builder", "reviewer"];
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

test("an unknown agent still asks the owner and is denied headless", async (t) => {
  const owner = await rig(t);
  const o = await owner.launch({ agent: "scout", task: "x" });
  assert.equal(o.res?.block, true);
  assert.equal(selects, 1, "the owner dialog");
  const headless = await rig(t, { hasUI: false, mode: "print" });
  const h = await headless.launch({ agent: "scout", task: "x" });
  assert.equal(h.res?.block, true);
  assert.equal(selects, 0);
  assert.match(String(h.res?.reason), /the permission review is unreachable/);
});

test("a management action, a workflow and a group with a non-role agent are not covered", async (t) => {
  for (const input of [{ action: "create", config: { name: "x" } }, { action: "schedule.create" }, { chain: [{ agent: "scout", task: "x" }] }, { tasks: [{ agent: "scout", task: "x" }] }]) {
    const r = await rig(t, { hasUI: false, mode: "print" });
    const { res } = await r.launch(input);
    assert.equal(res?.block, true, JSON.stringify(input));
    assert.ok(!gateRecs(r.trace()).some((x) => x.rule === "default-role-launch"), JSON.stringify(input));
  }
});

test("a launch the adapter's gates refuse stays refused (the default does not bypass them)", async (t) => {
  const r = await rig(t, {}, { providers: { fake: { roles: { explorer: { model: "fake/explorer" } } } } });
  const { res } = await r.launch({ agent: "builder", task: "x" });
  assert.equal(res?.block, true, JSON.stringify(res));
  assert.ok(gateRecs(r.trace()).some((x) => x.rule === "default-role-launch"), "the gate allowed it first");
});

test("the first gate review that finds no model shows one notice naming the key; once per session", async (t) => {
  const r = await rig(t, { hasUI: false, mode: "print" });
  await r.call("bash", { command: "terraform plan" });
  await r.call("bash", { command: "terraform apply" });
  const n = notes.filter((m) => m.includes("providers.<p>.roles.review.model"));
  assert.equal(n.length, 1, JSON.stringify(notes));
  assert.ok(n[0].includes(noReviewModelText("fake")));
});

test("the warning text names the key and the role launches", () => {
  const w = noReviewModelText("p");
  assert.match(w, /^no review model for provider p: /);
  assert.match(w, /providers\.<p>\.roles\.review\.model/);
  assert.match(w, /Role launches/);
});
