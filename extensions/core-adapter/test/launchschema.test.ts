// The launch fields in the `subagent` schema the model sees (launchschema.ts): the extended copy declares them with a type and a description,
// never changes the source, and lets every value through Pi's argument check unchanged, so only the adapter's gates refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { createSubagentParamsSchema } from "../../../node_modules/pi-subagents/src/extension/schemas.js";
import { extendedParameters, extendSubagentDeclaration, launchFieldSchemas } from "../launchschema.ts";
import { LAUNCH_OCCASIONS } from "../occasion.ts";
import { parseItemsField } from "../verdict.ts";
import { RISKS, takeLaunchFlags, takeSizing } from "../sizing.ts";
import { LadderState } from "../ladder.ts";
import { planMcpLaunch } from "../mcplaunch.ts";

type Json = Record<string, unknown>;
const ON = { sizing: true, mcp: true };
const source = (): Json => createSubagentParamsSchema() as unknown as Json;
const props = (s: Json): Json => s.properties as Json;
const FIELDS = ["reason", "items", "attach", "diffBase", "occasion", "reads", "install", "size", "risk", "mcp"];

/** Pi's argument check of the live tool: what the model's call becomes before `tool_call` runs. */
const validated = (parameters: Json, args: Json): Json => validateToolArguments({ name: "subagent", description: "d", parameters } as never, { type: "toolCall", id: "c", name: "subagent", arguments: args } as never) as Json;

test("the extended schema declares every launch field with a type and a static description", () => {
  const ext = extendedParameters(source(), ON);
  for (const f of FIELDS) {
    const field = props(ext)[f] as { anyOf?: Json[]; description?: unknown } | undefined;
    assert.ok(field, `${f} is declared`);
    assert.ok(Array.isArray(field.anyOf) && field.anyOf.some((b) => typeof b.type === "string"), `${f} has a typed branch`);
    assert.ok(typeof field.description === "string" && field.description.length > 20, `${f} has a description`);
    assert.ok(!/[\d]{4}-\d\d-\d\d|\/Users\//.test(String(field.description)), `${f}: the description is static`);
  }
  const text = (f: string): string => String((props(ext)[f] as { description: string }).description);
  for (const o of LAUNCH_OCCASIONS) assert.ok(text("occasion").includes(o), `occasion names ${o}`);
  for (const r of RISKS) assert.ok(text("risk").includes(r), `risk names ${r}`);
  assert.match(text("items"), /"V"/);
  assert.match(text("reason"), /strong/);
  assert.equal(props(ext).skill, undefined, "skill is not declared: no gate reads it");
  for (const f of FIELDS) {
    const s = JSON.stringify(props(ext)[f]);
    assert.ok(!/"(enum|minimum|minItems|required|additionalProperties)"/.test(s), `${f} adds no constraint`);
  }
});

test("the source schema is not mutated; the same source and flags give the same object; upstream properties come first", () => {
  const src = source();
  const before = structuredClone(src);
  const ext = extendedParameters(src, ON);
  assert.notEqual(ext, src);
  assert.deepEqual(src, before);
  assert.equal(extendedParameters(src, ON), ext);
  assert.equal(extendedParameters(ext, ON), ext, "an extended copy is not extended again");
  const names = Object.keys(props(ext));
  assert.deepEqual(names.slice(0, Object.keys(props(src)).length), Object.keys(props(src)));
  assert.equal(Object.keys(props(src)).some((k) => FIELDS.includes(k)), false);
});

test("flags: sizing off leaves out size and risk, no MCP role leaves out mcp; the other fields are always declared", () => {
  const names = (flags: { sizing: boolean; mcp: boolean }): string[] => Object.keys(launchFieldSchemas(flags)).sort();
  assert.deepEqual(names({ sizing: true, mcp: true }), [...FIELDS].sort());
  assert.deepEqual(names({ sizing: false, mcp: true }), ["attach", "diffBase", "install", "items", "mcp", "occasion", "reads", "reason"]);
  assert.deepEqual(names({ sizing: true, mcp: false }), ["attach", "diffBase", "install", "items", "occasion", "reads", "reason", "risk", "size"]);
  assert.deepEqual(names({ sizing: false, mcp: false }), ["attach", "diffBase", "install", "items", "occasion", "reads", "reason"]);
  const src = source();
  const lean = extendedParameters(src, { sizing: false, mcp: false });
  assert.equal(props(lean).size, undefined);
  assert.equal(props(lean).mcp, undefined);
  assert.ok(props(lean).reason);
  assert.notEqual(lean, extendedParameters(src, ON));
});

test("a source that already declares the fields (a recorded declaration after a resume) is kept as is", () => {
  const ext = extendedParameters(source(), ON);
  const recorded = structuredClone(ext);
  assert.equal(extendedParameters(recorded, ON), recorded);
  const partial = structuredClone(source());
  props(partial).reason = { type: "string", description: "mine" };
  const out = extendedParameters(partial, ON);
  assert.deepEqual(props(out).reason, { type: "string", description: "mine" });
  assert.ok(props(out).items);
});

test("extendSubagentDeclaration sets the copy on the declared entry only and is idempotent", () => {
  const src = source();
  const sub = { name: "subagent", parameters: src as unknown };
  const other = { name: "bash", parameters: { type: "object", properties: {} } as unknown };
  assert.equal(extendSubagentDeclaration([other, sub], ON), true);
  assert.notEqual(sub.parameters, src);
  assert.deepEqual(other.parameters, { type: "object", properties: {} });
  const first = sub.parameters;
  assert.equal(extendSubagentDeclaration([other, sub], ON), false);
  assert.equal(sub.parameters, first);
  assert.equal(extendSubagentDeclaration([{ name: "bash" }], ON), false);
  assert.equal(extendSubagentDeclaration([{ name: "subagent" }], ON), false);
});

const BASE = { agent: "builder", task: "t" };
const ACCEPTED: [string, Json][] = [
  ["size as JSON text", { size: '{"files":["a.ts"]}' }],
  ["size object with extra keys and empty files", { size: { files: [], largestFileLines: 10, modules: 2, extra: true } }],
  ["risk as JSON text", { risk: '["guard","design"]' }],
  ["risk list", { risk: ["guard"] }],
  ["reads number", { reads: 3 }],
  ["reads as text", { reads: "3" }],
  ["install true", { install: true }],
  ["install as text", { install: "true" }],
  ["occasion", { occasion: "pre-pr" }],
  ["occasion as JSON text", { occasion: '"pre-pr"' }],
  ["items list with numeric strings and v", { items: [1, "4", "v"] }],
  ["items bare value", { items: 3 }],
  ["items as JSON text", { items: "[1,2]" }],
  ["mcp as JSON text", { mcp: '["srv"]' }],
  ["mcp list", { mcp: ["srv", "srv/tool"] }],
  ["reason", { reason: "the default model cannot do it" }],
];
const REFUSED: [string, Json][] = [
  ["install 1", { install: 1 }],
  ["size.files text", { size: { files: "a.ts" } }],
  ["blank reason", { reason: "  " }],
  ["unknown items", { items: ["x"] }],
  ["bad risk tag", { risk: ["nope"] }],
  ["size not an object", { size: 5 }],
  ["negative reads", { reads: -2 }],
];

test("Pi's argument check returns every value of a launch field unchanged, accepted and refused forms alike", () => {
  const ext = extendedParameters(source(), ON) as Json;
  for (const [what, extra] of [...ACCEPTED, ...REFUSED]) {
    const args = structuredClone({ ...BASE, ...extra });
    assert.deepEqual(validated(ext, args), args, what);
  }
  // the upstream declared keys keep their own check
  assert.throws(() => validated(ext, { ...BASE, async: { not: "a boolean" } }), /Validation failed/);
});

test("the gates accept the forms of the first group and refuse the second with their own texts", () => {
  const ok = (extra: Json): string[] => {
    const input: Json = { ...BASE, ...structuredClone(extra) };
    const errors: string[] = [];
    const sized = takeSizing(input);
    if (sized.error) errors.push(sized.error);
    const flags = takeLaunchFlags(input);
    if (flags.error) errors.push(flags.error);
    if (flags.occasionError) errors.push(flags.occasionError);
    for (const raw of flags.items.values()) {
      const given = parseItemsField(raw);
      if ("error" in given) errors.push(given.error);
    }
    if (input.mcp !== undefined) {
      const roles = { builder: { mcp: ["srv"] } };
      const plan = planMcpLaunch(input, roles);
      if (plan.refusal) errors.push(plan.refusal.text);
    }
    return errors;
  };
  for (const [what, extra] of ACCEPTED) {
    if ("reason" in extra) continue;
    assert.deepEqual(ok(extra), [], what);
  }
  assert.match(ok({ install: 1 })[0] ?? "", /install is not true or false/);
  assert.match(ok({ size: { files: "a.ts" } })[0] ?? "", /size.files is not an array/);
  assert.match(ok({ items: ["x"] })[0] ?? "", /items is a list of item numbers/);
  assert.match(ok({ risk: ["nope"] })[0] ?? "", /unknown risk tag/);
  assert.match(ok({ reads: -2 })[0] ?? "", /reads is not a positive integer/);
  // reason: a blank one is no reason for a strong launch, a real one is
  const roles = { builder: { model: "p/small", thinking: "medium", strong: { model: "p/big", thinking: "medium" } } };
  assert.match(new LadderState().plan({ agent: "builder", task: "t", model: "strong", reason: "  " }, roles).block ?? "", /strong_no_reason/);
  assert.equal(new LadderState().plan({ agent: "builder", task: "t", model: "strong", reason: "needs it" }, roles).block, undefined);
});

test("a call with only declared keys passes Pi's check and the gates: reason, items, occasion, size and risk are honoured", () => {
  const ext = extendedParameters(source(), ON) as Json;
  const roles = { builder: { model: "p/small", thinking: "medium", strong: { model: "p/big", thinking: "medium" } } };
  const args = { agent: "builder", task: "t", model: "strong", reason: "needs a deeper refactor", items: [1, "V"], occasion: "pre-pr", size: { files: ["a.ts"], modules: 1 }, risk: ["guard"] };
  const input = validated(ext, structuredClone(args));
  assert.deepEqual(input, args);
  const sized = takeSizing(input);
  assert.equal(sized.error, undefined);
  assert.deepEqual([...sized.entries.values()][0], { size: { files: ["a.ts"], modules: 1 }, risk: ["guard"] });
  const flags = takeLaunchFlags(input);
  assert.equal(flags.error ?? flags.occasionError, undefined);
  assert.equal([...flags.occasions.values()][0], "pre-pr");
  assert.deepEqual("items" in parseItemsField([...flags.items.values()][0]) ? (parseItemsField([...flags.items.values()][0]) as { items: unknown[] }).items : null, [1, "V"]);
  const plan = new LadderState().plan(input, roles);
  assert.equal(plan.block, undefined, "no strong_no_reason: the top-level reason is read");
});
