// The launch fields through the real adapter hooks: the triage tool's `prepareLoadout` extends the declared `subagent` schema, a call with only
// declared keys passes Pi's check and the gates, the same keys inside `options` are lifted, and a refused launch allocates nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { createSubagentParamsSchema } from "../../../node_modules/pi-subagents/src/extension/schemas.js";
import { keptRoot } from "../childscratch.ts";
import { isReadCall } from "../budget.ts";
import { recordSessionDir } from "../verdict.ts";
import { TRIAGE_TOOL } from "../triage.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { bindingOf } from "./_verdict-rig.ts";

type Json = Record<string, unknown>;
type T = Parameters<typeof r11Rig>[0];
type Def = { name: string; prepareLoadout?: (l: { declared: { name: string; description?: string; parameters?: unknown }[] }) => { descriptions?: Record<string, string> } | undefined };

const FIELDS = ["reason", "items", "occasion", "reads", "install", "size", "risk"];
const ROLES = Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}`, ...(r === "builder" ? { strong: { model: "fake/builder-s" } } : {}) }]));
const config = { providers: { fake: { roles: ROLES } } };
const ledgerText = `# LF\n\n${Array.from({ length: 4 }, (_, i) => `- [ ] ${i + 1}. item ${i + 1}`).join("\n")}\n- [ ] V. verify\n`;
const settle = (ms = 800): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A rig that keeps the tools the adapter registers. */
async function toolRig(t: T) {
  const registered = new Map<string, Def>();
  const r = await r11Rig(t, {}, { config, piExtra: { registerTool: (d: Def) => void registered.set(d.name, d) } });
  return { r, triage: registered.get(TRIAGE_TOOL)! };
}

const props = (s: unknown): Json => (s as { properties: Json }).properties;

test("prepareLoadout sets the extended copy on the declared subagent entry and leaves the source and a recorded declaration alone", async (t) => {
  const { triage } = await toolRig(t);
  assert.ok(triage?.prepareLoadout, "the triage tool has a prepareLoadout hook");
  const src = createSubagentParamsSchema() as unknown as Json;
  const before = structuredClone(src);
  const wrapper = { name: "subagent", description: "Delegate.", parameters: src as unknown };
  const out = triage.prepareLoadout!({ declared: [{ name: "bash" }, wrapper] });
  for (const f of FIELDS) assert.ok(props(wrapper.parameters)[f], `${f} is declared on the wrapper`);
  assert.equal(props(src).reason, undefined, "pi-subagents' schema object is not mutated");
  assert.deepEqual(src, before);
  assert.match(out?.descriptions?.subagent ?? "", /Builder launches \(pi-foreman\)/, "the description patch still applies");
  // a second build gives the same object
  const first = wrapper.parameters;
  triage.prepareLoadout!({ declared: [wrapper] });
  assert.equal(wrapper.parameters, first);
  // a pinned recorded declaration: pi-subagents registers the transcript entry's own object; it is replaced on the wrapper, never changed
  const recorded = structuredClone(before);
  const snapshot = structuredClone(recorded);
  const pinned = { name: "subagent", description: "Delegate.", parameters: recorded as unknown };
  triage.prepareLoadout!({ declared: [pinned] });
  assert.deepEqual(recorded, snapshot);
  assert.notEqual(pinned.parameters, recorded);
  assert.ok(props(pinned.parameters).items);
  // a recorded declaration that already has the fields is kept as it is
  const withFields = { name: "subagent", description: "Delegate.", parameters: first };
  triage.prepareLoadout!({ declared: [withFields] });
  assert.equal(withFields.parameters, first);
});

test("a launch with only declared keys passes Pi's check and every adapter gate: reason, items, occasion, size and risk are honoured", async (t) => {
  const base = reviewAllowOpts();
  const registered = new Map<string, Def>();
  const r = await r11Rig(t, { default: "standard" }, { ...base, config: { ...base.config, ...config }, piExtra: { registerTool: (d: Def) => void registered.set(d.name, d) } });
  const wrapper = { name: "subagent", description: "d", parameters: createSubagentParamsSchema() as unknown };
  registered.get(TRIAGE_TOOL)!.prepareLoadout!({ declared: [wrapper] });
  const model = (args: Json): Json => validateToolArguments({ name: "subagent", description: "d", parameters: wrapper.parameters } as never, { type: "toolCall", id: "c", name: "subagent", arguments: args } as never) as Json;
  const ledger = path.join(r.project, ".workflow", "LEDGER-lf.md");
  fs.writeFileSync(ledger, ledgerText);
  await r.toolDoing("write", { path: ledger }, () => undefined);
  // a strong builder: the top-level reason is read, size and risk reach the sizing records
  const builder = model({ agent: "builder", task: "build", model: "strong", reason: "the default model cannot do it", size: { files: ["a.ts"], modules: 1 }, risk: ["guard"] });
  const b = await r.launch(builder);
  assert.equal(b.res, undefined, b.res?.reason);
  assert.equal(r.events("launch_refused").length, 0);
  assert.equal(String(builder.model).split(":")[0], "fake/builder-s");
  assert.deepEqual(r.events("launch_sizing").map((e) => e.risk).flat(), ["guard"]);
  assert.equal("reason" in builder || "size" in builder || "risk" in builder, false, "the adapter removes the fields");
  // a reviewer: items scope its record, occasion pre-pr is honoured (no re-review line after a FAIL needs a FAIL, so it is the field the gate read)
  const reviewer = model({ agent: "reviewer", task: "review the change", items: [1, "V"], occasion: "pre-pr" });
  const rv = await r.launch(reviewer);
  assert.equal(rv.res, undefined, rv.res?.reason);
  assert.deepEqual(bindingOf(reviewer)?.items, [1, "V"]);
  assert.equal(r.events("review_occasion_unknown").length, 0);
  assert.equal("items" in reviewer || "occasion" in reviewer, false);
});

test("options.items, options.reads and options.install are lifted to the top level and honoured; options.mcp is refused naming the top-level key", async (t) => {
  const base = reviewAllowOpts();
  const r = await r11Rig(t, { default: "standard" }, { ...base, config: { ...base.config, ...config } });
  const ledger = path.join(r.project, ".workflow", "LEDGER-lf.md");
  fs.writeFileSync(ledger, ledgerText);
  await r.toolDoing("write", { path: ledger }, () => undefined);
  const reviewer: Json = { agent: "reviewer", task: "review item 2", options: { items: [2], reads: 5, install: true } };
  const res = await r.launch(reviewer);
  assert.equal(res.res, undefined, res.res?.reason);
  assert.equal("options" in reviewer, false, "the emptied options box is gone");
  assert.deepEqual(bindingOf(reviewer)?.items, [2]);
  assert.deepEqual(r.events("sizing_lifted").map((e) => e.from), ["options"]);
  // an unknown item in options.items is refused by the items gate, with its own text
  const bad: Json = { agent: "reviewer", task: "review", options: { items: [99] } };
  const refused = await r.launch(bad);
  assert.match(refused.res?.reason ?? "", /items 99 is not open on the ledger/);
  // options.mcp stays refused; the text names mcp as a top-level key beside agent and task
  const mcp = await r.launch({ agent: "builder", task: "t", options: { mcp: ["srv"] } });
  assert.match(mcp.res?.reason ?? "", /options\.mcp is not a launch option/);
  assert.match(mcp.res?.reason ?? "", /top-level key of the call, beside agent and task/);
});

test("a refused launch makes no review-record folder, no scratch folder, no kept output folder and spends no read budget", async (t) => {
  const base = reviewAllowOpts();
  const r = await r11Rig(t, { default: "standard" }, { ...base, config: { ...base.config, ...config } });
  const ledger = path.join(r.project, ".workflow", "LEDGER-lf.md");
  fs.writeFileSync(ledger, ledgerText);
  await r.toolDoing("write", { path: ledger }, () => undefined);
  const records = recordSessionDir(r.agentDir, r.sessionId);
  const kept = keptRoot(r.agentDir) as string;
  const nothing = (what: string): void => {
    assert.equal(fs.existsSync(records), false, `${what}: no review-record folder`);
    assert.equal(fs.existsSync(kept) ? fs.readdirSync(kept).length : 0, 0, `${what}: no kept output folder`);
    assert.equal(r.events("child_scratch_root").length, 0, `${what}: no scratch folder`);
  };
  const refusals: [string, Json, RegExp][] = [
    ["items_unknown", { agent: "reviewer", task: "review", items: [99] }, /items 99 is not open/],
    ["sizing_invalid", { agent: "reviewer", task: "review", size: 5 }, /sizing_invalid/],
  ];
  for (const [what, input, text] of refusals) {
    assert.equal(isReadCall("subagent", input), false, `${what}: a launch is no read`);
    const res = await r.launch(input);
    assert.match(res.res?.reason ?? "", text, what);
    nothing(what);
  }
  const strongBuilder = await r.launch({ agent: "builder", task: "build", model: "strong" });
  assert.match(strongBuilder.res?.reason ?? "", /strong_no_reason/);
  nothing("strong builder");
  // the positive control: a launch that passes makes the folders
  const ok: Json = { agent: "reviewer", task: "review item 1", items: [1] };
  const good = await r.launch(ok);
  assert.equal(good.res, undefined, good.res?.reason);
  assert.equal(fs.existsSync(records), true, "a passing review launch makes its record folder");
  assert.equal(r.events("child_scratch_root").length, 1);
});

/** A rig with a bound ledger, and a reviewer launch that ends with a record. */
async function world(t: T) {
  const base = reviewAllowOpts();
  const r = await r11Rig(t, { default: "standard" }, { ...base, config: { ...base.config, ...config } });
  const ledger = path.join(r.project, ".workflow", "LEDGER-lf.md");
  fs.writeFileSync(ledger, ledgerText);
  await r.toolDoing("write", { path: ledger }, () => undefined);
  let n = 0;
  return {
    r,
    /** Launches a reviewer (a task of its own), returning its input and the refusal text. */
    async review(extra: Json = {}, task = "review the change") {
      const input: Json = { agent: "reviewer", task, ...extra };
      const l = await r.launch(input);
      const runId = `lf-run-${++n}`;
      if (!l.res) await r.started(l.id, input, runId);
      return { input, runId, refused: l.res?.reason ?? "", task: String(input.task) };
    },
    /** A builder run: work happened since the last review, so the next reviewer launch is not a repeat. */
    async build() {
      const input: Json = { agent: "builder", task: "build it" };
      const l = await r.launch(input);
      assert.equal(l.res, undefined, l.res?.reason);
      await r.started(l.id, input, `lf-build-${++n}`);
      r.end({ runId: `lf-build-${n}`, agent: "builder", status: "completed", success: true, summary: "built" });
    },
    /** Ends the run with a record: `fail` names the failed item ids, `pass` the passed ones. */
    async finish(runId: string, verdict: "fail" | "pass", failed: number[] = [], defect = false) {
      const items = failed.map((id) => ({ id, result: "fail" as const }));
      const findings = verdict === "fail" && (defect || items.length === 0) ? [{ kind: "defect" as const, text: `defect ${runId}`, file: "a.ts", line: 1 }] : [];
      assert.ok(r.record(runId, { verdict, items, findings }));
      r.end({ runId, agent: "reviewer", status: "completed", success: true, results: [{ agent: "reviewer", status: "completed", success: true, output: "see the record" }] });
      await settle();
    },
  };
}

const LINE = "[pi-foreman re-review]";
const WHOLE = /review them against the whole change, not only the revision diff\./;

test("re-review with items: the line names only failed items inside them, and a numbered item beyond the failed set is reviewed against the whole change", async (t) => {
  const w = await world(t);
  const first = await w.review({}, "first review");
  await w.finish(first.runId, "fail", [2]);
  // items [2, "V"]: all failed or V -> the usual re-review, scoped line, no extra sentence
  const a = await w.review({ items: [2, "V"] });
  assert.equal(a.refused, "");
  assert.ok(a.task.startsWith(LINE), a.task);
  assert.match(a.task, /\[re-review items: 2\]\nThese items failed a review since the last PASS; give each of them a result in review_verdict\./);
  assert.doesNotMatch(a.task, /Review only these failed items/);
  assert.doesNotMatch(a.task, WHOLE);
  // items [2, 3]: the line names 2; item 3 gets the one sentence right after the re-review line
  const b = await w.review({ items: [2, 3] });
  assert.match(b.task, /\[re-review items: 2\]\n/);
  assert.match(b.task, /^\[pi-foreman re-review\][^\n]*\nItem 3: review them against the whole change, not only the revision diff\.\n/);
  // numeric strings compare equal to numbers: "2" is the failed item, 3 is beyond it
  const c = await w.review({ items: ["2", 3, "v"] });
  assert.match(c.task, /\[re-review items: 2\]\n/);
  assert.match(c.task, /\nItem 3: review them/);
  // items [3, "V"] with the failed set {2}: no [re-review items:] line, the sentence stays
  const d = await w.review({ items: [3, "V"] });
  assert.doesNotMatch(d.task, /\[re-review items:/);
  assert.ok(d.task.startsWith(LINE));
  assert.match(d.task, /\nItem 3: review them/);
  // V alone changes nothing: no scoped line (no failed item inside), no sentence
  const v = await w.review({ items: ["V"] });
  assert.doesNotMatch(v.task, /\[re-review items:/);
  assert.doesNotMatch(v.task, WHOLE);
  // two beyond the set: one sentence, plural, in the given order
  const e = await w.review({ items: [4, 3] });
  assert.match(e.task, /\nItems 4, 3: review them against the whole change/);
  // without items the line and its text are the ones of every re-review
  const f = await w.review({});
  assert.match(f.task, /\[re-review items: 2\]\nReview only these failed items again; give each of them a result in review_verdict \(pass or fail\)\./);
  assert.doesNotMatch(f.task, WHOLE);
  // a malformed items value is refused by the items check with its own text
  const g = await w.review({ items: ["x"] });
  assert.match(g.refused, /items is a list of item numbers and "V"/);
});

test("re-review with items: a FAIL without failed items keeps the earlier set; a later FAIL that replaces the set lists the item it dropped", async (t) => {
  const w = await world(t);
  const first = await w.review({}, "first review");
  await w.finish(first.runId, "fail", [3]);
  // a FAIL that names no failed item keeps {3}
  const second = await w.review({ items: [3] }, "second review");
  await w.finish(second.runId, "fail", [], true);
  const keep = await w.review({ items: [3, 4] });
  assert.match(keep.task, /\[re-review items: 3\]\n/);
  assert.match(keep.task, /\nItem 4: review them/);
  // FAIL on 4: the set is {4}; 3 is now outside
  const third = await w.review({ items: [3, 4] }, "third review");
  await w.finish(third.runId, "fail", [4]);
  const next = await w.review({ items: [3, 4] });
  assert.match(next.task, /\[re-review items: 4\]\n/);
  assert.match(next.task, /\nItem 3: review them/);
  assert.doesNotMatch(next.task, /Item 4:/);
});

test("re-review with items: a defects-only FAIL after a PASS lists every numbered given item; after an owner prompt nothing is added", async (t) => {
  const w = await world(t);
  const pass = await w.review({}, "first review");
  await w.finish(pass.runId, "pass");
  await w.build();
  const fail = await w.review({}, "second review");
  await w.finish(fail.runId, "fail", [], true);
  const a = await w.review({ items: [1, 2, "V"] });
  assert.ok(a.task.startsWith(LINE), a.task);
  assert.doesNotMatch(a.task, /\[re-review items:/, "the failed set is empty: no scoped line");
  assert.match(a.task, /\nItems 1, 2: review them against the whole change/);
  // a FAIL that names items, then an owner prompt: the failed set stays but the re-review line is gone, so no sentence
  await w.build();
  const named = await w.review({}, "third review");
  await w.finish(named.runId, "fail", [2]);
  await w.r.ownerPrompt("go on");
  const b = await w.review({ items: [1, 2] });
  assert.doesNotMatch(b.task, /pi-foreman re-review\]/);
  assert.doesNotMatch(b.task, WHOLE);
});

test("re-review with items: other occasions get no line and no sentence", async (t) => {
  const w = await world(t);
  const first = await w.review({}, "first review");
  await w.finish(first.runId, "fail", [2]);
  const pre = await w.review({ items: [2, 3], occasion: "pre-pr" });
  assert.equal(pre.refused, "");
  assert.doesNotMatch(pre.task, /pi-foreman re-review\]/);
  assert.doesNotMatch(pre.task, WHOLE);
  assert.doesNotMatch(pre.task, /\[re-review items:/);
});
