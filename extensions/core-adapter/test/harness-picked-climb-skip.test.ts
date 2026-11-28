// A strong-rung climb the harness picks by itself (a sizing rule, design falling to strong, the heavy-tier default) that the rank policy refuses
// is skipped (ladder.ts skipPicked): the builder runs on its normal model, the launch result says so, rung_top carries the source. The
// foreman's own `model: "strong"` is still refused; a tie with a strong risk tag under equalOnStrongRisk still runs on the strong rung.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { rankRefusalFor } from "../ranks.ts";
import { RANK_CAPPED_REASON } from "../ladder.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

type Rig = Awaited<ReturnType<typeof r11Rig>>;
const PRESETS = ["claude-bridge", "claude-bridge-sonnet-reviewer"] as const;
const PRESET = (name: string): Record<string, any> => JSON.parse(fs.readFileSync(new URL(`../../../config/presets/${name}.json`, import.meta.url), "utf8"));
const OPUS = "claude-bridge/claude-opus-5-5";
const SONNET = "claude-bridge/claude-sonnet-5-5";
const base = (m: unknown): string => String(m).split(":")[0];
const BIG = "x\n".repeat(1700);
const texts = (res: unknown): string => ((res as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("\n");
const HAIKU = "claude-bridge/claude-haiku-5-5";
const builder = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ agent: "builder", task: "build it", ...extra });

const PLAN = "# Widget\n\n## For the owner\n\nGoal: ship the widget.\n\n## Goal\nShip it.\n";

/** The rig; at the heavy tier a builder needs an approved plan (a passing plan review, then the owner's checkpoint), so that is done first. */
type Opts = { tier?: string; key?: boolean; builder?: string };
async function rig(t: Parameters<typeof r11Rig>[0], preset: string, foreman: string, o: Opts = {}): Promise<Rig> {
  const config = PRESET(preset);
  delete config.ceremony; // r11Rig spreads opts.config shallowly: a preset ceremony key would replace the rig's tier
  if (o.builder) config.providers["claude-bridge"].roles.builder.model = o.builder;
  if (o.key !== undefined) config.ladder.equalOnStrongRisk = o.key;
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ details: { decision: string } }> }>();
  const a = await r11Rig(t, { default: o.tier ?? "standard", revisionRounds: { standard: 1 } }, { ctx: { ...reviewAllowOpts().ctx, model: { provider: "claude-bridge", id: foreman } }, config, piExtra: { registerTool: (d: { name: string }) => void tools.set(d.name, d as never) } });
  if (o.tier !== "heavy") return a;
  fs.mkdirSync(path.join(a.project, ".workflow", "scratch"), { recursive: true });
  fs.writeFileSync(path.join(a.project, ".workflow", "scratch", "plan-widget.md"), PLAN);
  const review = { agent: "reviewer", task: "[plan-review] review .workflow/scratch/plan-widget.md" };
  const { id, res } = await a.launch(review);
  assert.equal(res, undefined, res?.reason);
  await a.started(id, review, "run-plan");
  a.end({ runId: "run-plan", agent: "reviewer", success: true, status: "completed", results: [{ agent: "reviewer", status: "completed", success: true, output: "Overall verdict: PASS" }] });
  await new Promise((r) => setTimeout(r, 25));
  const ck = await tools.get("foreman_checkpoint")!.execute("ck", { path: ".workflow/scratch/plan-widget.md" }, undefined, undefined, a.ctx);
  assert.equal(ck.details.decision, "approve");
  return a;
}

// each sizing rule separately: [rule id, the declared fields that trigger it]
const RULES: [string, Record<string, unknown>][] = [
  ["large_file", { size: { files: ["big.py"] } }],
  ["modules", { size: { files: ["a/x/1.py", "b/y/2.py", "c/z/3.py"] } }],
  ["risk_strong", { risk: ["guard"] }],
  ["risk_top", { risk: ["design"] }],
];

/** One launch that is expected to skip: no block, the normal model, the note line, rung_top with its source, the rated rung in launch_sizing. */
async function skipped(t: Parameters<typeof r11Rig>[0], preset: string, foreman: string, fields: Record<string, unknown>, source: string, o: Opts = {}): Promise<void> {
  const a = await rig(t, preset, foreman, o);
  fs.writeFileSync(path.join(a.project, "big.py"), BIG);
  const input = builder(fields);
  const { id, res } = await a.launch(input);
  assert.equal(res, undefined, res?.reason);
  assert.equal(base(input.model), o.builder ?? SONNET, `${preset} ${foreman} ${source}`);
  assert.match(texts(await a.started(id, input, "run-1")), /the climb of builder to its strong rung claude-bridge\/claude-opus-5-5 was skipped/);
  assert.deepEqual(a.events("rung_top").map((r) => [r.role, r.reason, r.source]), [["builder", RANK_CAPPED_REASON, source]]);
  assert.deepEqual(a.events("launch_refused"), []);
  assert.deepEqual(a.events("rank_equal_model"), []);
  // the launched model passes the rank policy of the preset under this foreman
  assert.equal(rankRefusalFor(PRESET(preset), `claude-bridge/${foreman}`, base(input.model), ["builder"]), null);
  const sz = a.events("launch_sizing");
  if (source.startsWith("sizing:")) {
    assert.equal(sz.length, 1);
    assert.equal(sz[0].rung, "default");
    assert.equal(sz[0].rated, "strong"); // design: no top model passes the policy, so the rated rung fell back to strong
    assert.match(String(sz[0].note), /rank_capped/);
  }
}

for (const preset of PRESETS) for (const foreman of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
  const tie = foreman === "claude-opus-5-5";
  // a Sonnet foreman has the shipped builder's own normal model (Sonnet) refused, as for any launch: its skips are shown with a Haiku builder
  const own: Opts = tie ? {} : { builder: HAIKU };
  for (const [rule, fields] of RULES) {
    // an Opus foreman ties with the strong rung: the strong risk tag keeps it (key on, covered below), every other rule is skipped; a Sonnet foreman is below the strong rung: always skipped
    test(`${preset}, ${foreman} foreman, rule ${rule}: the climb is skipped${rule === "risk_strong" ? ", key off" : ""}`, async (t) => {
      await skipped(t, preset, foreman, fields, `sizing:${rule}`, rule === "risk_strong" ? { ...own, key: false } : own);
    });
  }
  test(`${preset}, ${foreman} foreman, strong risk tag with the key on: ${tie ? "the tie runs on the strong rung" : "skipped, never a tie"}`, async (t) => {
    if (!tie) return skipped(t, preset, foreman, { risk: ["guard"] }, "sizing:risk_strong", { ...own, key: true });
    const a = await rig(t, preset, foreman, { key: true });
    const input = builder({ risk: ["guard"] });
    const { res } = await a.launch(input);
    assert.equal(res, undefined, res?.reason);
    assert.equal(base(input.model), OPUS);
    assert.equal(a.events("rank_equal_model").length, 1);
    assert.deepEqual(a.events("rung_top"), []);
  });
  test(`${preset}, ${foreman} foreman, heavy tier without a risk tag: skipped`, async (t) => {
    await skipped(t, preset, foreman, {}, "heavy", { ...own, tier: "heavy" });
  });
  test(`${preset}, ${foreman} foreman, heavy tier with a strong risk tag and the key on: ${tie ? "rank_equal_model on the strong rung" : "skipped"}`, async (t) => {
    if (!tie) return skipped(t, preset, foreman, { risk: ["guard"] }, "heavy", { ...own, tier: "heavy", key: true });
    const a = await rig(t, preset, foreman, { tier: "heavy", key: true });
    const input = builder({ risk: ["guard"] });
    const { res } = await a.launch(input);
    assert.equal(res, undefined, res?.reason);
    assert.equal(base(input.model), OPUS);
    assert.equal(a.events("rank_equal_model").length, 1);
    assert.deepEqual(a.events("rung_top"), []);
  });
  test(`${preset}, ${foreman} foreman: an explicit "strong" is still refused, also with a size that rates strong`, async (t) => {
    for (const fields of [{}, { size: { files: ["big.py"] } }]) {
      const a = await rig(t, preset, foreman, tie ? undefined : { key: true });
      fs.writeFileSync(path.join(a.project, "big.py"), BIG);
      const res = (await a.launch(builder({ model: "strong", reason: "needs the strong model", ...fields }))).res;
      assert.equal(res?.block, true, JSON.stringify(fields));
      assert.match(res?.reason ?? "", /\[rank_policy:below\]/);
      assert.ok(a.events("launch_refused").some((r) => r.reason === "rank_policy"));
      assert.deepEqual(a.events("rung_top"), []);
    }
  });
}

test("claude-bridge presets, Fable foreman: the sizing rules and the heavy tier still climb to Opus", async (t) => {
  for (const preset of PRESETS) for (const [rule, fields] of [RULES[0], RULES[1], RULES[2]] as [string, Record<string, unknown>][]) {
    const a = await rig(t, preset, "claude-fable-5-1", { key: false });
    fs.writeFileSync(path.join(a.project, "big.py"), BIG);
    const input = builder(fields);
    const { res } = await a.launch(input);
    assert.equal(res, undefined, `${rule}: ${res?.reason}`);
    assert.equal(base(input.model), OPUS, rule);
    assert.deepEqual(a.events("rung_top"), []);
  }
  const heavy = await rig(t, "claude-bridge", "claude-fable-5-1", { tier: "heavy" });
  const input = builder();
  assert.equal((await heavy.launch(input)).res, undefined);
  assert.equal(base(input.model), OPUS);
  assert.deepEqual(heavy.events("rung_top"), []);
});

test("claude-bridge presets, Sonnet foreman, shipped builder map: Opus is never launched or tied, the refusal names the builder's own Sonnet", async (t) => {
  for (const preset of PRESETS) for (const fields of [{}, { size: { files: ["big.py"] } }, { risk: ["guard"] }]) {
    const a = await rig(t, preset, "claude-sonnet-5-5", { key: true });
    fs.writeFileSync(path.join(a.project, "big.py"), BIG);
    const input = builder(fields);
    const res = (await a.launch(input)).res;
    assert.equal(res?.block, true, JSON.stringify(fields));
    assert.match(res?.reason ?? "", /child model claude-bridge\/claude-sonnet-5-5 \(tier 2\) is not below the foreman model claude-bridge\/claude-sonnet-5-5/);
    assert.doesNotMatch(res?.reason ?? "", /opus/);
    assert.deepEqual(a.events("rank_equal_model"), []);
  }
});

test("google and openai presets with their shipped foreman models: the strong rung is allowed, nothing is skipped or refused", () => {
  const cases: [string, string, string][] = [["google", "google/gemini-3.1-pro-preview", "google/gemini-3.1-pro-preview"], ["openai", "openai/gpt-6-astra", "openai/gpt-6.1-sol"]];
  for (const [name, foreman, strong] of cases) assert.equal(rankRefusalFor(PRESET(name), foreman, strong, ["builder"]), null, name);
});
