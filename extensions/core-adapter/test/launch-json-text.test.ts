// Launch fields sent as JSON text (size, risk, mcp, reads, install): the strict shared helper and every consumer, in process.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fromJsonText } from "../jsontext.ts";
import { liftSizing, takeSizing, takeLaunchFlags } from "../sizing.ts";
import { planMcpLaunch } from "../mcplaunch.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const SIZE_TEXT = '{"files":["a"],"largestFileLines":181,"modules":1}';
const SIZE_TEXT2 = '{"files": ["tests/installer/setup-gitbash.test.mjs"], "modules": 1}';
const RISK_TEXT = '["guard", "permission", "security"]';

test("fromJsonText: each wanted type parses; every other shape comes back untouched", () => {
  assert.deepEqual(fromJsonText('{"a":1}', "object"), { a: 1 });
  assert.deepEqual(fromJsonText("[]", "array"), []);
  assert.deepEqual(fromJsonText('["x", "y/z"]', "array"), ["x", "y/z"]);
  assert.equal(fromJsonText("3", "number"), 3);
  assert.equal(fromJsonText("true", "boolean"), true);
  assert.equal(fromJsonText("false", "boolean"), false);
  const same: [unknown, "object" | "array" | "number" | "boolean"][] = [
    ["not json", "object"], ["null", "object"], ["3", "object"], ['"x"', "object"], ["[1]", "object"], ["{}", "array"], ["[]", "object"],
    ['"[]"', "array"], ['"{}"', "object"], ['"3"', "number"], ['"true"', "boolean"], ["yes", "boolean"], ["1", "boolean"], ["True", "boolean"],
    ["true", "number"], ["3", "boolean"], ["1.5x", "number"], ["", "object"],
    [" 9", "number"], ["9 ", "number"], [' {"a":1}', "object"], ["[]\n", "array"], [" true", "boolean"], ["true ", "boolean"],
    [3, "number"], [true, "boolean"], [null, "object"], [null, "array"], [[1], "array"], [{ a: 1 }, "object"], [undefined, "object"], [[], "object"],
  ];
  for (const [v, want] of same) assert.ok(Object.is(fromJsonText(v, want), v), `${JSON.stringify(v)} as ${want}`);
});

test("size and risk text: same Declared and stripped input as the object form, top level and entries", () => {
  for (const [text, obj] of [[SIZE_TEXT, JSON.parse(SIZE_TEXT)], [SIZE_TEXT2, JSON.parse(SIZE_TEXT2)]] as const) {
    const a: Record<string, unknown> = { agent: "builder", task: "x", size: text, risk: RISK_TEXT };
    const b: Record<string, unknown> = { agent: "builder", task: "x", size: obj, risk: JSON.parse(RISK_TEXT) };
    const ta = takeSizing(a);
    const tb = takeSizing(b);
    assert.equal(ta.error, undefined);
    assert.deepEqual(ta.entries.get(a), tb.entries.get(b));
    assert.deepEqual(a, b);
    assert.ok(!("size" in a) && !("risk" in a));
  }
  const empty: Record<string, unknown> = { agent: "builder", task: "x", risk: "[]" };
  assert.deepEqual(takeSizing(empty).entries.get(empty)?.risk, []);
  const mk = (size: unknown, risk: unknown): Record<string, unknown> => ({ tasks: [{ agent: "builder", task: "a", size, risk }], chain: [{ parallel: [{ agent: "builder", task: "b", size, risk }] }] });
  const ta = mk(SIZE_TEXT, RISK_TEXT);
  const tb = mk(JSON.parse(SIZE_TEXT), JSON.parse(RISK_TEXT));
  const ra = takeSizing(ta);
  const rb = takeSizing(tb);
  assert.equal(ra.error, undefined);
  const flat = (r: ReturnType<typeof takeSizing>): unknown[] => [...r.entries.values()];
  assert.deepEqual(flat(ra), flat(rb));
  assert.deepEqual(ta, tb);
});

test("size and risk text over the limit refuse with the object form's text", () => {
  const refusal = (size: unknown, risk?: unknown): string | undefined => takeSizing({ agent: "builder", task: "x", size, risk }).error;
  for (const [text, obj] of [['{"files":"a"}', { files: "a" }], ['{"files":[""]}', { files: [""] }], ['{"files":["a"],"modules":-1}', { files: ["a"], modules: -1 }], ["{}", {}]] as const) {
    assert.ok(refusal(obj));
    assert.equal(refusal(text), refusal(obj), text);
  }
  assert.equal(takeSizing({ agent: "builder", task: "x", risk: '["speed"]' }).error, takeSizing({ agent: "builder", task: "x", risk: ["speed"] }).error);
  assert.match(refusal(undefined, '["speed"]') ?? "", /unknown risk tag "speed"/);
  const plain = "size is not an object";
  for (const v of ["3", "null", '"x"', "[]", '["a"]', "not json", '"{\\"files\\":[\\"a\\"]}"', 3, true, null, ["a"]]) assert.match(refusal(v) ?? "", new RegExp(plain), JSON.stringify(v));
  for (const v of ["{}", '{"a":1}', "3", '"[]"', "x", 3, { a: 1 }]) assert.match(takeSizing({ agent: "builder", task: "x", risk: v }).error ?? "", /risk is not an array/, JSON.stringify(v));
});

const ROLES = { builder: { mcp: ["fx", "other/probe"] }, reviewer: {} };

test("mcp text: same plan and binding as the array form, refused over the limit", () => {
  const run = (mcp: unknown) => { const input: Record<string, unknown> = { agent: "builder", task: "go", mcp }; return { plan: planMcpLaunch(input, ROLES), input }; };
  const a = run('["fx", "other/probe"]');
  const b = run(["fx", "other/probe"]);
  assert.equal(a.plan.refusal, undefined);
  assert.deepEqual(a.plan, b.plan);
  assert.deepEqual(a.input, b.input);
  assert.deepEqual(run("[]").plan, run([]).plan);
  for (const v of ['["nope"]', '[1, 2]', '[""]', "fx", "fx,other", '"[\\"fx\\"]"', '{"a":1}', "3"]) {
    const r = run(v).plan.refusal;
    assert.ok(r, v);
  }
  assert.match(run('["nope"]').plan.refusal?.text ?? "", /outside roles\.builder\.mcp/);
  assert.equal(run('["nope"]').plan.refusal?.text, run(["nope"]).plan.refusal?.text);
  assert.equal(run('[1, 2]').plan.refusal?.text, run([1, 2]).plan.refusal?.text);
  assert.match(run("fx").plan.refusal?.text ?? "", /array of non-empty strings/);
  const entry = (mcp: unknown, on: boolean) => planMcpLaunch({ tasks: [{ agent: "builder", task: "a", mcp }, { agent: "reviewer", task: "b" }] }, ROLES, { perEntryBindings: on });
  assert.deepEqual(entry('["fx"]', true), entry(["fx"], true));
  assert.equal(entry('["fx"]', false).refusal?.reason, "mcp_group_gate");
  assert.equal(entry('["fx"]', false).refusal?.text, entry(["fx"], false).refusal?.text);
  assert.equal(entry('["zz"]', true).refusal?.text, entry(["zz"], true).refusal?.text);
  assert.ok(entry('["zz"]', true).refusal);
});

test("reads and install text: same entries as the native values, strict otherwise", () => {
  const flags = (extra: Record<string, unknown>) => { const input: Record<string, unknown> = { agent: "builder", task: "x", ...extra }; const r = takeLaunchFlags(input); return { r, input }; };
  const a = flags({ reads: "3", install: "true" });
  const b = flags({ reads: 3, install: true });
  assert.equal(a.r.error, undefined);
  assert.deepEqual([...a.r.entries.values()], [...b.r.entries.values()]);
  assert.deepEqual(a.input, b.input);
  assert.ok(!("reads" in a.input) && !("install" in a.input));
  assert.deepEqual([...flags({ install: "false" }).r.entries.values()], [...flags({ install: false }).r.entries.values()]);
  const g = { tasks: [{ agent: "builder", task: "a", reads: "2", install: "true" }] };
  const g2 = { tasks: [{ agent: "builder", task: "a", reads: 2, install: true }] };
  assert.deepEqual([...takeLaunchFlags(g).entries.values()], [...takeLaunchFlags(g2).entries.values()]);
  assert.equal(flags({ reads: "9" }).r.error, undefined);
  assert.equal([...flags({ reads: "9" }).r.entries.values()][0]?.reads, 9);
  const nativeBad = flags({ reads: 0 }).r.error;
  assert.ok(nativeBad);
  assert.equal(flags({ install: "yes" }).r.error, flags({ install: 1 }).r.error);
  for (const reads of ["nine", "0", "1.5", "-1", '"3"', " 9", "9 ", "three", "true"]) {
    assert.match(flags({ reads }).r.error ?? "", /reads is not a positive integer/, reads);
  }
  for (const install of ["yes", "1", "True", '"true"', "TRUE", "0", " true", "true "]) {
    assert.match(flags({ install }).r.error ?? "", /install is not true or false/, install);
  }
});

// The real gate: text form decides the same rung and trace as the object form.
const BIG = "x\n".repeat(1700);
const providers = { fake: { review: { model: "m" }, roles: { builder: { model: "fake/builder", strong: { model: "fake/strong" } }, explorer: { model: "fake/explorer" }, reviewer: { model: "fake/reviewer" } } } };
const rig = (t: Parameters<typeof r11Rig>[0]) => r11Rig(t, { default: "standard" }, { ctx: reviewAllowOpts().ctx, config: { providers } });

test("whitespace around the JSON text is refused for size, risk and mcp", () => {
  assert.match(takeSizing({ agent: "builder", task: "x", size: ` ${SIZE_TEXT}` }).error ?? "", /size is not an object/);
  assert.match(takeSizing({ agent: "builder", task: "x", risk: "[]\n" }).error ?? "", /risk is not an array/);
  const r = planMcpLaunch({ agent: "builder", task: "go", mcp: ' ["fx"]' }, ROLES).refusal;
  assert.match(r?.text ?? "", /array of non-empty strings/);
});

test("a text value lifted out of options or args is parsed like a top-level one; risk text on an entry", () => {
  const input: Record<string, unknown> = { agent: "builder", task: "b", options: { size: SIZE_TEXT, risk: RISK_TEXT } };
  liftSizing(input);
  const t = takeSizing(input);
  assert.equal(t.error, undefined);
  assert.deepEqual(t.entries.get(input), { size: JSON.parse(SIZE_TEXT), risk: JSON.parse(RISK_TEXT) });
  assert.ok(!("size" in input) && !("options" in input));
  const args: Record<string, unknown> = { agent: "builder", task: "b", args: { size: SIZE_TEXT2 } };
  liftSizing(args);
  assert.equal(takeSizing(args).error, undefined);
});

test("gate: text-form size and risk give the same rung, trace and strip as the object form", async (t) => {
  const a = await rig(t);
  fs.writeFileSync(path.join(a.project, "big.py"), BIG);
  const native = { agent: "builder", task: "build", size: { files: ["big.py"] } };
  const text = { agent: "builder", task: "build", size: '{"files": ["big.py"]}' };
  const ins = [native, text].map((v) => clone(v) as Record<string, unknown>);
  for (const i of ins) assert.equal((await a.launch(i)).res, undefined);
  for (const i of ins) {
    assert.equal(i.model, "fake/strong");
    assert.ok(!("size" in i) && !("risk" in i));
  }
  const rows = a.events("launch_sizing");
  assert.equal(rows.length, 2);
  const shape = (r: Record<string, unknown>) => [r.role, r.rule, r.rung, r.files, r.lines];
  assert.deepEqual(shape(rows[1]), shape(rows[0]));
  assert.equal(rows[0].rule, "large_file");
  // bad text still refuses with [sizing_invalid] (one rig serves every launch here: a rig costs about a dozen child processes)
  for (const bad of [{ size: "3" }, { risk: '["speed"]' }]) {
    const res = (await a.launch({ agent: "builder", task: "x", ...bad })).res;
    assert.equal(res?.block, true, JSON.stringify(bad));
    assert.match(res?.reason ?? "", /\[sizing_invalid\]/);
  }
});
