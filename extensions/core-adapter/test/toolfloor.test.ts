// The foreman tool floor (ledger item 9): the pure helper of toolfloor.ts and its wiring at session_start and before_agent_start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingFloorTools, TOOL_FLOOR } from "../toolfloor.ts";
import { r11Rig } from "./_r11rig.ts";

type T = { after(fn: () => void | Promise<void>): void };

test("the floor holds the deferred floor and the top-level foreman tools", () => {
  for (const n of ["foreman_triage", "subagent", "foreman_session_open", "foreman_wait", "foreman_checkpoint", "foreman_bg", "intercom"]) assert.ok(TOOL_FLOOR.includes(n), n);
});

test("only registered, inactive floor tools are returned, in floor order", () => {
  const all = ["read", "bash", "subagent", "foreman_triage", "intercom", "other_tool"];
  const got = missingFloorTools({ all, active: ["read", "subagent", "other_tool"], isChild: false, planMode: false });
  assert.deepEqual(got, ["foreman_triage", "intercom"]);
});

test("a floor tool that is not registered is ignored", () => {
  assert.deepEqual(missingFloorTools({ all: ["foreman_wait"], active: [], isChild: false, planMode: false }), ["foreman_wait"]);
});

test("tools the owner may switch off (codemode, tool_search, read, bash) are left alone", () => {
  assert.deepEqual(missingFloorTools({ all: ["codemode", "tool_search", "read", "bash", "ask_user_question"], active: [], isChild: false, planMode: false }), []);
});

test("a child and a plan-mode session get nothing", () => {
  const input = { all: ["subagent", "foreman_triage"], active: [] as string[] };
  assert.deepEqual(missingFloorTools({ ...input, isChild: true, planMode: false }), []);
  assert.deepEqual(missingFloorTools({ ...input, isChild: false, planMode: true }), []);
});

async function rigWith(t: T, o: { child?: boolean; branch?: unknown[]; active: string[]; all: string[] }) {
  let active = [...o.active];
  const sets: string[][] = [];
  const rig = await r11Rig(t, {}, {
    child: o.child,
    ctx: { sessionManager: { getSessionId: () => "tf-1", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => o.branch ?? [] } },
    piExtra: {
      getActiveTools: () => [...active],
      getAllTools: () => o.all.map((name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} }, exposure: "direct" })),
      setActiveTools: (n: string[]) => { active = [...n]; sets.push([...n]); },
      appendEntry: () => undefined,
    },
  });
  const turn = () => rig.fire("before_agent_start", { prompt: "go", systemPromptOptions: { sections: {} } });
  return { rig, sets, active: () => active, reset: (n: string[]) => void (active = [...n]), turn };
}

const ALL = ["read", "bash", "zeta", "alpha", "subagent", "foreman_triage", "foreman_wait", "foreman_checkpoint", "intercom"];
const floorSets = (sets: string[][]) => sets.filter((s) => s.includes("foreman_triage"));

test("session_start appends the missing floor tools after the active ones and traces them", async (t) => {
  const r = await rigWith(t, { active: ["bash", "zeta", "read", "alpha"], all: ALL });
  // the adapter's own pr and codemode tools join the set too; the original order is kept and the floor tools follow in floor order
  const got = r.active();
  assert.deepEqual(got.slice(0, 4), ["bash", "zeta", "read", "alpha"]);
  assert.deepEqual(got.filter((n) => ["subagent", "foreman_triage", "foreman_wait", "foreman_checkpoint", "intercom"].includes(n)), ["subagent", "foreman_triage", "foreman_wait", "foreman_checkpoint", "intercom"]);
  assert.equal(new Set(got).size, got.length, "no duplicates");
  assert.deepEqual(r.rig.events("tools_floor_restored").map((e) => e.names), ["subagent,foreman_triage,foreman_wait,foreman_checkpoint,intercom"]);
});

test("nothing missing means no call; a reset between turns is repaired at before_agent_start", async (t) => {
  const r = await rigWith(t, { active: [...ALL], all: ALL });
  const before = r.sets.length;
  await r.turn();
  assert.equal(r.sets.length, before, "no setActiveTools call when nothing is missing");
  assert.equal(r.rig.events("tools_floor_restored").length, 0);
  r.reset(["read", "alpha"]);
  await r.turn();
  assert.deepEqual(r.active().slice(0, 2), ["read", "alpha"]);
  for (const n of ["subagent", "foreman_triage", "foreman_wait", "foreman_checkpoint", "intercom"]) assert.ok(r.active().includes(n), n);
  assert.equal(r.rig.events("tools_floor_restored").length, 1);
});

test("a child and plan mode leave the active set alone", async (t) => {
  const child = await rigWith(t, { child: true, active: ["read"], all: ALL });
  assert.equal(floorSets(child.sets).length, 0);
  assert.equal(child.rig.events("tools_floor_restored").length, 0);
  const plan = await rigWith(t, { branch: [{ type: "custom", customType: "plan-mode", data: { enabled: true } }], active: ["read"], all: ALL });
  assert.equal(floorSets(plan.sets).length, 0);
  assert.equal(plan.rig.events("tools_floor_restored").length, 0);
});
