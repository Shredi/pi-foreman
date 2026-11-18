// The review occasion of a reviewer launch comes from the launch field `occasion` or a tag at the head of the task (occasion.ts launchOccasion);
// a tag only later in the text is refused, never guessed. In-process, no child process: the pure parts directly, the wiring through the adapter's
// tool_call handler on the r11 rig with stand-ins for git, the python probe and the config CLI.
import cp from "node:child_process";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dupRefusalText, dupReview, initialReviewGate } from "../bound.ts";
import { ReviewFacts } from "../diffscan.ts";
import { applyLedgerItems } from "../ledgerblock.ts";
import { launchOccasion, occasionOf, withOccasionMarker, type Occasion } from "../occasion.ts";
import { liftSizing, takeLaunchFlags } from "../sizing.ts";
import { readDefaults } from "../config.ts";
import { PROBE_CODE } from "../python.ts";
import type { Spawner } from "../spawn.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const PKG_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const ROLES = Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }]));

/**
 * The adapter rig with no child process: the spawner answers the python probe and the config CLI (the L1 defaults with the rig's overrides and
 * the fake roles) and answers every other script with no decision; git calls go to an in-process stand-in that reports "not a repository".
 */
async function launchRig(t: Parameters<typeof r11Rig>[0], opts: { child?: boolean } = {}) {
  const origSync = cp.spawnSync;
  const origFile = cp.execFile;
  const fakeSync = ((file: string, ...rest: unknown[]) => (file === "git" ? { status: 1, stdout: "", stderr: "" } : (origSync as (...a: unknown[]) => unknown)(file, ...rest))) as typeof cp.spawnSync;
  const fakeFile = ((file: string, ...rest: unknown[]) => {
    if (file !== "git") return (origFile as (...a: unknown[]) => unknown)(file, ...rest);
    const cb = rest.find((x) => typeof x === "function") as ((err: Error | null, out: string) => void) | undefined;
    setImmediate(() => cb?.(new Error("git is not started by this rig"), ""));
    return undefined;
  }) as unknown as typeof cp.execFile;
  cp.spawnSync = fakeSync;
  cp.execFile = fakeFile;
  syncBuiltinESMExports();
  const defaults = readDefaults(PKG_ROOT) as Json;
  const config = { ...defaults, presence: { ...(defaults.presence as Json), enabled: false }, trace: { enabled: true }, ceremony: { ...(defaults.ceremony as Json), launchWait: "detach" } };
  const spawner: Spawner = async (_command, args) => {
    if (args.includes(PROBE_CODE)) return { code: 0, stdout: "3.13\n/usr/bin/python3\n/usr/bin/python3\n/usr\n", stderr: "", timedOut: false };
    if (args.some((a) => a.endsWith("foreman_config.py"))) return { code: 0, stdout: JSON.stringify({ config, warnings: [], errors: [], safetyFallback: false, roles: ROLES }), stderr: "", timedOut: false };
    return { code: 0, stdout: "", stderr: "", timedOut: false }; // a guard script with no decision: the launch goes on
  };
  const rig = await r11Rig(t, {}, { ...reviewAllowOpts(), ...opts, deps: { spawner } });
  // registered after the rig's own hook: the session shutdown still runs on the stand-ins
  t.after(() => {
    cp.spawnSync = origSync;
    cp.execFile = origFile;
    syncBuiltinESMExports();
  });
  return rig;
}

type Json = Record<string, unknown>;
const KINDS = ["pre-pr", "high-stakes", "plan-review", "second-opinion"] as const;

/** The result of `launchOccasion` as one word: the occasion, or the refusal code. */
const of = (task: string, taken?: string, extra: Json = {}): string => {
  const r = launchOccasion({ agent: "reviewer", task, ...extra }, taken);
  return "refused" in r ? r.refused : r.occasion;
};

test("a [pre-pr] task that mentions an earlier [high-stakes] review is pre-pr (it was refused before)", () => {
  assert.equal(of("[pre-pr] Review the branch; an earlier [high-stakes] review passed"), "pre-pr");
  assert.equal(of("[high-stakes] Review the change; the [pre-pr] review passed"), "high-stakes");
});

test("each tag only mid-text, with no field, is refused late and the fix line names the field and that kind", () => {
  for (const kind of KINDS) {
    const r = launchOccasion({ agent: "reviewer", task: `Please review the branch. The kind is [${kind}] here.` }, undefined);
    assert.ok("refused" in r, kind);
    assert.equal(r.refused, "review_occasion_late");
    assert.ok(r.text.includes(`set occasion: "${kind}" on the launch (or put [${kind}] first in the task)`), r.text);
  }
});

test("a tag inside backticks or a fence is a mention: item", () => {
  for (const kind of KINDS) {
    assert.equal(of(`Review it, not a \`[${kind}]\` one`), "item");
    assert.equal(of(`Review it\n\`\`\`\n[${kind}]\n\`\`\`\n`), "item");
  }
});

test("the field alone gives its occasion and asks for the marker; field plus the same head marker adds none; a different head marker is ambiguous", () => {
  for (const kind of KINDS) {
    const r = launchOccasion({ agent: "reviewer", task: "review it" }, kind);
    assert.deepEqual(r, { occasion: kind, prepend: true });
    assert.deepEqual(launchOccasion({ agent: "reviewer", task: `[${kind}] review it` }, kind), { occasion: kind, prepend: false });
  }
  assert.equal(withOccasionMarker("review it", "pre-pr"), "[pre-pr] review it");
  assert.equal(withOccasionMarker("[pre-pr] review it", "pre-pr"), "[pre-pr] review it", "one marker");
  assert.equal(of("[pre-pr] review it", "high-stakes"), "review_occasion_ambiguous");
  assert.equal(of("review it", "pre-pr", { reason: "second-opinion" }), "review_occasion_ambiguous", "reason second-opinion against a field");
  assert.equal(of("review it", "second-opinion", { reason: "second-opinion" }), "second-opinion");
  assert.equal(of("review it", "pre-pr", {}), "pre-pr");
  assert.deepEqual(launchOccasion({ agent: "reviewer", task: "review it" }, undefined, "second-opinion"), { occasion: "second-opinion", prepend: false });
});

test("a field never rescues a head run naming [pre-pr] and [high-stakes]", () => {
  assert.equal(of("[pre-pr] [high-stakes] review", "pre-pr"), "review_occasion_ambiguous");
  assert.equal(of("[pre-pr] [high-stakes] review", "high-stakes"), "review_occasion_ambiguous");
  assert.equal(of("[pre-pr] [high-stakes] review"), "review_occasion_ambiguous");
});

test("head-run forms: skipped tokens before the tag, and the precedence of today", () => {
  assert.equal(of("[panel-shadow:m] [pre-pr] review"), "pre-pr");
  assert.equal(of("[[replay:r-p2]] [pre-pr] review"), "pre-pr");
  assert.equal(of("[[replay:r-q2]] [plan-review] review the plan"), "plan-review");
  assert.equal(of("[[replay:r-s4]] [second-opinion] look"), "second-opinion");
  assert.equal(of("[pre-pr] [second-opinion] look"), "second-opinion");
  assert.equal(of("[re-review items: 2, 4] [pre-pr] review"), "pre-pr");
  assert.equal(of("[pi-foreman re-review] Review the revision diff.\n[pre-pr] review"), "pre-pr");
  assert.equal(of("[high-stakes] review the change, then [pre-pr] later"), "high-stakes");
});

test("a non-reviewer entry is item without a text check; a tag in a builder task is no occasion", () => {
  const r = launchOccasion({ agent: "builder", task: "build it; [pre-pr] and [high-stakes] later" }, "pre-pr");
  assert.deepEqual(r, { occasion: "item", prepend: false });
  assert.deepEqual(launchOccasion({ agent: "explorer", task: "[plan-review] look" }, undefined), { occasion: "item", prepend: false });
});

test("the occasion field is taken: single, tasks, chain and parallel entries; JSON text parses; options/args copies lift; the field never stays", () => {
  const single: Json = { agent: "reviewer", task: "t", occasion: "pre-pr" };
  const s = takeLaunchFlags(single);
  assert.equal(s.occasions.get(single), "pre-pr");
  assert.ok(!("occasion" in single));
  const text: Json = { agent: "reviewer", task: "t", occasion: '"high-stakes"' };
  assert.equal(takeLaunchFlags(text).occasions.get(text), "high-stakes", "JSON text");
  const a: Json = { agent: "reviewer", task: "a", occasion: "pre-pr" };
  const b: Json = { agent: "reviewer", task: "b", occasion: "second-opinion" };
  const c: Json = { agent: "reviewer", task: "c" };
  const par: Json = { agent: "reviewer", task: "d", occasion: "plan-review" };
  const group: Json = { tasks: [a, b, c], chain: [{ parallel: [par] }] };
  const g = takeLaunchFlags(group);
  assert.equal(g.occasionError, undefined);
  assert.deepEqual([g.occasions.get(a), g.occasions.get(b), g.occasions.get(c), g.occasions.get(par)], ["pre-pr", "second-opinion", undefined, "plan-review"]);
  assert.ok(![a, b, par].some((e) => "occasion" in e));
  const boxed: Json = { agent: "reviewer", task: "t", options: { occasion: "pre-pr" } };
  assert.deepEqual(liftSizing(boxed).from, ["options"]);
  assert.equal(takeLaunchFlags(boxed).occasions.get(boxed), "pre-pr", "a field in options is lifted");
  assert.ok(!("options" in boxed));
});

test("an unknown field value, and a top-level field on a tasks or chain launch, are refused review_occasion_unknown", () => {
  const bad = takeLaunchFlags({ agent: "reviewer", task: "t", occasion: "item" });
  assert.match(bad.occasionError ?? "", /\[review_occasion_unknown\].*pre-pr \| high-stakes \| plan-review \| second-opinion|\[review_occasion_unknown\].*second-opinion/);
  const top = takeLaunchFlags({ occasion: "pre-pr", tasks: [{ agent: "reviewer", task: "t" }] });
  assert.match(top.occasionError ?? "", /\[review_occasion_unknown\].*each reviewer entry/);
  const chain = takeLaunchFlags({ occasion: "pre-pr", chain: [{ agent: "reviewer", task: "t" }] });
  assert.match(chain.occasionError ?? "", /\[review_occasion_unknown\]/);
  const bare = takeLaunchFlags({ agent: "reviewer", task: "t", occasion: 7 });
  assert.match(bare.occasionError ?? "", /\[review_occasion_unknown\]/);
});

test("the field on a builder entry has no effect: item, and a builder tag beside a plain reviewer leaves the reviewer item", () => {
  const builder: Json = { agent: "builder", task: "build it [pre-pr]", occasion: "pre-pr" };
  const reviewer: Json = { agent: "reviewer", task: "review items 1" };
  const input: Json = { tasks: [builder, reviewer] };
  const taken = takeLaunchFlags(input);
  const got = [builder, reviewer].map((e) => launchOccasion(e, taken.occasions.get(e)));
  assert.deepEqual(got, [{ occasion: "item", prepend: false }, { occasion: "item", prepend: false }]);
  assert.equal(builder.task, "build it [pre-pr]");
});

test("the ledger block and the facts never change the recorded occasion: a ledger holding each tag keeps it, and the marker sits directly before the caller's text", () => {
  for (const kind of KINDS) {
    const ledger = `# L\n\n- [ ] 1. a review that mentions [${KINDS.join("] and [")}] in an item\n- [ ] V. verify\n`;
    const entry: Json = { agent: "reviewer", task: "check item 1" };
    const taken = new Map<Json, string>([[entry, kind]]);
    const r = launchOccasion(entry, taken.get(entry));
    assert.ok(!("refused" in r));
    assert.equal(r.occasion, kind);
    entry.task = withOccasionMarker(String(entry.task), kind);
    const recorded = new Map<Json, Occasion>([[entry, r.occasion]]);
    applyLedgerItems(entry, ledger, new Set(), null, [], { sha: null }, undefined, recorded);
    assert.ok(String(entry.task).endsWith(`[${kind}] check item 1`), String(entry.task));
    assert.ok(String(entry.task).startsWith("[pi-foreman ledger items]"), "the ledger block is in front of the marker");
    assert.equal(recorded.get(entry), kind);
  }
});

test("the re-review line goes to a recorded item review only, whatever the ledger text names", () => {
  const entry: Json = { agent: "reviewer", task: "check item 1" };
  const ledger = "# L\n\n- [ ] 1. look at [pre-pr] things\n- [ ] V. verify\n";
  applyLedgerItems(entry, ledger, new Set(), null, [], { sha: "abc" }, undefined, new Map<Json, Occasion>([[entry, "item"]]));
  assert.ok(String(entry.task).includes("[pi-foreman re-review]"), String(entry.task));
  const other: Json = { agent: "reviewer", task: "check item 1" };
  applyLedgerItems(other, ledger, new Set(), null, [], { sha: "abc" }, undefined, new Map<Json, Occasion>([[other, "pre-pr"]]));
  assert.ok(!String(other.task).includes("[pi-foreman re-review]"));
});

test("the plan facts callback gets the step: a field-only plan-review launch (no tag in its task) gets the plan block", async () => {
  const facts = new ReviewFacts();
  const step: Json = { agent: "reviewer", task: "review the plan" };
  const recorded = new Map<Json, Occasion>([[step, "plan-review"]]);
  const n = await facts.augment({ tasks: [step] }, "/nonexistent-occasion-field", (task, s) => ((recorded.get(s) ?? occasionOf(task)) === "plan-review" ? "PLAN FACTS" : null));
  assert.equal(n, 0);
  assert.equal(step.task, "review the plan\nPLAN FACTS\n");
});

test("dupReview after a PASS: a backticked [second-opinion] is a repeat, the field is exempt, one item entry among second opinions refuses, a resume keeps today's check", () => {
  const pass = { last: "pass" as const, revised: false };
  const roles = ["reviewer"];
  const mk = (task: string, taken?: string): { input: Json; map: Map<Json, string> } => {
    const e: Json = { agent: "reviewer", task };
    const r = launchOccasion(e, taken);
    assert.ok(!("refused" in r));
    return { input: e, map: new Map<Json, string>([[e, r.occasion]]) };
  };
  const quoted = mk("review it, not a `[second-opinion]` one");
  assert.equal(dupReview(pass, roles, quoted.input, quoted.map), "refuse");
  assert.equal(dupReview(pass, roles, quoted.input), "second-opinion", "the old text check still reads the quoted tag when no map is given");
  const field = mk("review it", "second-opinion");
  assert.equal(dupReview(pass, roles, field.input, field.map), "second-opinion");
  const a: Json = { agent: "reviewer", task: "a" };
  const b: Json = { agent: "reviewer", task: "b" };
  const group: Json = { tasks: [a, b] };
  assert.equal(dupReview(pass, ["reviewer", "reviewer"], group, new Map<Json, string>([[a, "second-opinion"], [b, "item"]])), "refuse");
  assert.equal(dupReview(pass, ["reviewer", "reviewer"], group, new Map<Json, string>([[a, "second-opinion"], [b, "second-opinion"]])), "second-opinion");
  assert.equal(dupReview(pass, roles, { action: "resume", id: "r1", message: "more" }, new Map()), "refuse", "a resume: the empty map keeps today's check");
  assert.match(dupRefusalText(), /occasion: "second-opinion"/);
});

// ------------------------------------------------------------------ wiring: the adapter's tool_call handler

test("wiring: the field alone marks the task; the field with the same head marker adds none; refusals carry their code and a trace", async (t) => {
  const rig = await launchRig(t);
  const one = async (input: Json) => ({ input, ...(await rig.launch(input)) });

  const field = await one({ agent: "reviewer", task: "review the branch", occasion: "pre-pr" });
  assert.equal(field.res, undefined, field.res?.reason);
  assert.ok(String(field.input.task).includes("[pre-pr] review the branch"), String(field.input.task));
  assert.ok(!("occasion" in field.input), "the field never reaches pi-subagents");

  const same = await one({ agent: "reviewer", task: "[pre-pr] review the branch", occasion: "pre-pr" });
  assert.equal(same.res, undefined, same.res?.reason);
  assert.equal(String(same.input.task).split("[pre-pr]").length - 1, 1, "one marker");

  const late = await one({ agent: "reviewer", task: "review the branch, the [pre-pr] kind" });
  assert.match(late.res?.reason ?? "", /\[review_occasion_late\].*set occasion: "pre-pr" on the launch \(or put \[pre-pr\] first in the task\)/);
  assert.equal(rig.events("review_occasion_late").length, 1);

  const clash = await one({ agent: "reviewer", task: "[pre-pr] review the branch", occasion: "high-stakes" });
  assert.match(clash.res?.reason ?? "", /\[review_occasion_ambiguous\]/);

  const reason = await one({ agent: "reviewer", task: "review the branch", occasion: "pre-pr", reason: "second-opinion" });
  assert.match(reason.res?.reason ?? "", /\[review_occasion_ambiguous\]/);

  const unknown = await one({ agent: "reviewer", task: "review the branch", occasion: "final" });
  assert.match(unknown.res?.reason ?? "", /\[review_occasion_unknown\]/);

  const top = await one({ occasion: "pre-pr", tasks: [{ agent: "reviewer", task: "a" }] });
  assert.match(top.res?.reason ?? "", /\[review_occasion_unknown\]/);
});

test("wiring: a reviewer in a tasks or chain launch is refused (review_single_launch); options lift; a builder entry with a tag stays plain", async (t) => {
  const rig = await launchRig(t);
  const tasks: Json = { tasks: [{ agent: "reviewer", task: "branch", occasion: "pre-pr" }, { agent: "reviewer", task: "look", occasion: "second-opinion" }] };
  const r1 = await rig.launch(tasks);
  assert.match(r1.res?.reason ?? "", /\[review_single_launch\]/);
  assert.equal(rig.events("launch_refused").filter((e) => e.reason === "review_single_launch").length, 1);

  const chain: Json = { chain: [{ agent: "builder", task: "build" }, { agent: "reviewer", task: "check", occasion: "pre-pr" }] };
  const r2 = await rig.launch(chain);
  assert.match(r2.res?.reason ?? "", /\[review_single_launch\]/);

  const boxed: Json = { agent: "reviewer", task: "branch", options: { occasion: "pre-pr" } };
  const r3 = await rig.launch(boxed);
  assert.equal(r3.res, undefined, r3.res?.reason);
  assert.ok(String(boxed.task).includes("[pre-pr] branch"));

  const mixed: Json = { tasks: [{ agent: "builder", task: "build it [pre-pr]" }, { agent: "reviewer", task: "check items 1" }] };
  const r4 = await rig.launch(mixed);
  assert.match(r4.res?.reason ?? "", /\[review_single_launch\]/);
  assert.equal(String((mixed.tasks as Json[])[0].task).includes("[pre-pr] build"), false, "a builder task gets no marker");
});

test("wiring: a head run naming both tags is refused whatever the field says; a mid-text second-opinion with no source is refused late", async (t) => {
  const rig = await launchRig(t);
  const both: Json = { agent: "reviewer", task: "[pre-pr] [high-stakes] review", occasion: "pre-pr" };
  assert.match((await rig.launch(both)).res?.reason ?? "", /\[review_occasion_ambiguous\]/);
  const so: Json = { agent: "reviewer", task: "review again, as a [second-opinion] please" };
  assert.match((await rig.launch(so)).res?.reason ?? "", /\[review_occasion_late\]/);
});

test("wiring: a subagent child session still takes the field and marks a field-only reviewer task", async (t) => {
  const rig = await launchRig(t, { child: true });
  const input: Json = { agent: "reviewer", task: "review the plan", occasion: "plan-review" };
  await rig.launch(input);
  assert.ok(!("occasion" in input));
  assert.ok(String(input.task).includes("[plan-review] review the plan"), String(input.task));
});
