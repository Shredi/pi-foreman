// R39: launch sizing (sizing.ts): parse and strip, measure, the rule table, the combination with an explicit model.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { belowMessage, combine, componentOf, decide, measure, planSizing, prependProbe, rungOfModel, sizingConfig, sizingTrace, takeSizing, topModel, MAX_BYTES, type Declared, type Measured } from "../sizing.ts";
import { ranksOf } from "../ranks.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const CFG = sizingConfig(undefined);
const M = (o: Partial<Measured> = {}): Measured => ({ files: 1, lines: 10, declaredLines: 0, modules: 1, declaredModules: 0, large: false, outside: 0, ...o });
const ROLES = { builder: { model: "p/small", strong: { model: "p/mid" } } };
const CONFIG = { providers: { p: { ranks: [{ match: "big", tier: 0 }, { match: "mid", tier: 1 }, { match: "small", tier: 2 }] } } };
const RANKS = ranksOf(CONFIG);

function repo(t: { after(fn: () => void): void }): string {
  const root = fs.realpathSync(mkTestTmp("pf-sizing-"));
  t.after(() => rmTestTmp(root));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}
const put = (root: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

test("sizingConfig: the L1 values without ladder.sizing, config values otherwise", () => {
  assert.deepEqual(sizingConfig(undefined), { enabled: true, largeFileLines: 1500, maxModules: 2, strongRisks: ["guard", "permission", "parser", "concurrency", "security"], topRisks: ["design"], topRung: null });
  const c = sizingConfig({ ladder: { sizing: { enabled: false, largeFileLines: 10, maxModules: 4, strongRisks: ["guard"], topRisks: [], topRung: " x/y " } } });
  assert.deepEqual(c, { enabled: false, largeFileLines: 10, maxModules: 4, strongRisks: ["guard"], topRisks: [], topRung: "x/y" });
});

test("decide: rows 1-5 and first match wins", () => {
  assert.deepEqual(decide(M({ lines: 5000 }), ["design", "guard"], CFG), { rule: "risk_top", rung: "top" });
  assert.deepEqual(decide(M({ lines: 5000 }), ["guard"], CFG), { rule: "risk_strong", rung: "strong" });
  for (const r of ["permission", "parser", "concurrency", "security"]) assert.equal(decide(M(), [r], CFG).rule, "risk_strong");
  assert.deepEqual(decide(M({ lines: 1501, modules: 9 }), [], CFG), { rule: "large_file", rung: "strong" });
  assert.equal(decide(M({ lines: 1500 }), [], CFG).rule, "small");
  assert.equal(decide(M({ large: true }), [], CFG).rule, "large_file");
  assert.deepEqual(decide(M({ modules: 3 }), [], CFG), { rule: "modules", rung: "strong" });
  assert.deepEqual(decide(M({ files: 0, lines: 0, modules: 0 }), [], CFG), { rule: "small", rung: "default" });
});

test("componentOf: first two directory segments; root files, docs, markdown and test dirs do not count", () => {
  assert.equal(componentOf("extensions/core-adapter/index.ts"), "extensions/core-adapter");
  assert.equal(componentOf("scripts/foo.py"), "scripts");
  assert.equal(componentOf("config/foreman.defaults.json"), "config");
  for (const rel of ["CHANGELOG.md", "package.json", "docs/ladder.md", "docs/x.txt", "extensions/core-adapter/README.md", "extensions/core-adapter/test/a.ts", "tests/test_a.py", "a/b/__tests__/c.ts"]) assert.equal(componentOf(rel), null, rel);
});

test("takeSizing strips every level, the entry wins over the call, and reports malformed values", () => {
  const input: Record<string, unknown> = {
    size: { files: ["a.ts"] },
    risk: ["guard"],
    tasks: [{ agent: "builder", task: "x", size: { files: ["b.ts"], modules: 3 } }, { agent: "reviewer", task: "y" }, { parallel: [{ agent: "builder", task: "z", risk: ["parser"] }] }],
  };
  const t = takeSizing(input);
  assert.equal(t.error, undefined);
  assert.ok(!("size" in input) && !("risk" in input));
  const tasks = input.tasks as Record<string, unknown>[];
  assert.ok(tasks.every((e) => !("size" in e) && !("risk" in e)));
  const [a, b] = [tasks[0], (tasks[2].parallel as Record<string, unknown>[])[0]];
  assert.deepEqual(t.entries.get(a), { size: { files: ["b.ts"], modules: 3 }, risk: ["guard"] });
  assert.deepEqual(t.entries.get(b), { size: { files: ["a.ts"] }, risk: ["parser"] });
  assert.ok(t.carried.has(tasks[1]));
  const single: Record<string, unknown> = { agent: "builder", task: "x", size: { files: [] } };
  const s = takeSizing(single);
  assert.deepEqual(s.entries.get(single), { size: { files: [] }, risk: null });
  assert.ok(!("size" in single));
});

test("takeSizing: every malformed case names [sizing_invalid] and still strips", () => {
  const bad: Record<string, unknown>[] = [
    { size: "big" },
    { size: [] },
    { size: {} },
    { size: { files: "a.ts" } },
    { size: { files: [1] } },
    { size: { files: ["a"], largestFileLines: -1 } },
    { size: { files: ["a"], largestFileLines: 1.5 } },
    { size: { files: ["a"], modules: -2 } },
    { risk: "guard" },
    { risk: ["speed"] },
    { risk: [3] },
  ];
  for (const b of bad) {
    const input = { agent: "builder", task: "x", ...b };
    const t = takeSizing(input);
    assert.match(t.error ?? "", /\[sizing_invalid\]/, JSON.stringify(b));
    assert.ok(!("size" in input) && !("risk" in input));
  }
  const entry = { tasks: [{ agent: "builder", task: "x", risk: ["nope"] }] };
  assert.match(takeSizing(entry).error ?? "", /\[sizing_invalid\]/);
});

test("measure: lines, modules, ENOENT, directories, big files, outside files, more than 20 files", (t) => {
  const root = repo(t);
  put(root, "extensions/core-adapter/a.ts", "x\n".repeat(1600));
  put(root, "extensions/core-adapter/test/a.test.ts", "x\n");
  put(root, "CHANGELOG.md", "x\n");
  put(root, "scripts/s.py", "x\n");
  const one = measure({ files: ["extensions/core-adapter/a.ts", "extensions/core-adapter/test/a.test.ts", "CHANGELOG.md"] }, root, root);
  assert.deepEqual([one.files, one.lines, one.modules, one.large, one.outside], [3, 1600, 1, false, 0]);
  const two = measure({ files: ["extensions/core-adapter/a.ts", "scripts/s.py", "config/new.json"] }, root, root);
  assert.equal(two.modules, 3);
  assert.equal(two.lines, 1600);
  const absent = measure({ files: ["scripts/new.py"] }, root, root);
  assert.deepEqual([absent.lines, absent.large, absent.invalid], [0, false, undefined]);
  assert.match(measure({ files: ["scripts"] }, root, root).invalid ?? "", /\[sizing_invalid\].*directories/);
  put(root, "big.bin", "x".repeat(MAX_BYTES + 1));
  assert.equal(measure({ files: ["big.bin"] }, root, root).large, true);
  const outside = measure({ files: ["/etc/hosts", "../escape.ts"] }, root, root);
  assert.deepEqual([outside.outside, outside.lines, outside.large], [2, 0, false]);
  const many = measure({ files: Array.from({ length: 21 }, (_, i) => `scripts/f${i}.py`) }, root, root);
  assert.equal(many.large, true);
  assert.equal(measure({ files: Array.from({ length: 20 }, (_, i) => `scripts/f${i}.py`) }, root, root).large, false);
});

test("measure: an unreadable file counts as large (not on a root user)", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("permissions are not enforced here");
  const root = repo(t);
  put(root, "scripts/locked.py", "x\n");
  fs.chmodSync(path.join(root, "scripts/locked.py"), 0);
  assert.equal(measure({ files: ["scripts/locked.py"] }, root, root).large, true);
});

test("measure: the claim only raises", (t) => {
  const root = repo(t);
  put(root, "scripts/a.py", "x\n".repeat(30));
  const under = measure({ files: ["scripts/a.py"], largestFileLines: 5, modules: 0 }, root, root);
  assert.equal(under.lines, 30);
  assert.equal(under.declaredLines, 5);
  const over = measure({ files: ["scripts/a.py"], largestFileLines: 2000, modules: 4 }, root, root);
  assert.deepEqual([over.lines, over.modules], [2000, 4]);
  assert.equal(decide(over, [], CFG).rung, "strong");
});

test("measure: a sibling worktree is measured against its own root; a foreign repo falls back to the session root", (t) => {
  const root = repo(t);
  const sibling = path.join(root, "..", `${path.basename(root)}-wt`);
  t.after(() => rmTestTmp(sibling));
  fs.mkdirSync(path.join(root, ".git", "worktrees", "w"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "w", "commondir"), "../..\n");
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "w")}\n`);
  put(sibling, "scripts/big.py", "x\n".repeat(1700));
  const m = measure({ files: ["scripts/big.py"] }, sibling, root);
  assert.deepEqual([m.lines, m.outside], [1700, 0]);
  const foreign = fs.realpathSync(mkTestTmp("pf-sizing-foreign-"));
  t.after(() => rmTestTmp(foreign));
  fs.mkdirSync(path.join(foreign, ".git"));
  put(foreign, "scripts/big.py", "x\n".repeat(1700));
  const f = measure({ files: ["scripts/big.py"] }, foreign, root);
  assert.deepEqual([f.lines, f.outside], [0, 1]);
});

test("rungOfModel: keywords, the mapped models, the top model and ranks; an unranked id is not below", () => {
  const c = { roles: ROLES, ranks: RANKS, top: "p/big:high" };
  assert.equal(rungOfModel("default", c), "default");
  assert.equal(rungOfModel("strong:high", c), "strong");
  assert.equal(rungOfModel("p/small", c), "default");
  assert.equal(rungOfModel("p/mid:low", c), "strong");
  assert.equal(rungOfModel("p/big", c), "top");
  assert.equal(rungOfModel("q/other", c), null);
  const ranked = { roles: { builder: { model: "p/small", strong: { model: "p/mid" } } }, ranks: ranksOf({ providers: { p: { ranks: [{ match: "huge", tier: 0 }, { match: "mid", tier: 1 }, { match: "tiny", tier: 3 }] } } }), top: null };
  assert.equal(rungOfModel("p/huge", ranked), "top");
  assert.equal(rungOfModel("p/tiny", ranked), "default");
});

test("topModel: topRung, else the next rank above strong, else null (strong falls back)", () => {
  assert.equal(topModel({ ...CONFIG, ladder: { sizing: { topRung: "p/big:xhigh" } } }, ROLES, "high", undefined), "p/big:high");
  assert.equal(topModel({ ...CONFIG, ladder: { sizing: { topRung: "p/mid" } } }, ROLES, undefined, undefined), null, "topRung equal to strong is no top");
  assert.equal(topModel(CONFIG, ROLES, undefined, undefined), "p/big", "a literal rank above strong counts");
  const noTop = { providers: { p: { ranks: [{ match: "mid", tier: 1 }, { match: "small", tier: 2 }] } } };
  assert.equal(topModel(noTop, ROLES, undefined, undefined), null);
  const roles = { ...ROLES, reviewer: { model: "p/small", strong: { model: "p/big" } } };
  assert.equal(topModel({ providers: { p: { ranks: [{ match: "b*", tier: 0 }, { match: "mid", tier: 1 }, { match: "small", tier: 2 }] } } }, roles, undefined, undefined), "p/big", "another role's strong rung above");
  assert.equal(topModel(undefined, ROLES, undefined, undefined), null);
});

test("combine: below the sizing rung needs a reason; at or above is unchanged; no strong rung is capped", () => {
  const base = { target: "strong" as const, capped: false, base: "default" as const, reason: false, hasStrong: true };
  assert.deepEqual(combine({ ...base, passed: "none" }), { climb: true, note: [] });
  assert.deepEqual(combine({ ...base, passed: "none", base: "strong" }), { note: [] });
  assert.deepEqual(combine({ ...base, passed: "default" }), { refuse: true, note: ["explicit"] });
  assert.deepEqual(combine({ ...base, passed: "default", reason: true }), { note: ["explicit", "override"] });
  assert.deepEqual(combine({ ...base, passed: "strong" }), { note: ["explicit"] });
  assert.deepEqual(combine({ ...base, passed: null }), { note: ["explicit"] });
  assert.deepEqual(combine({ ...base, passed: "strong", target: "top" }), { refuse: true, note: ["explicit"] });
  assert.deepEqual(combine({ ...base, passed: "none", capped: true }), { climb: true, note: ["capped"] });
  assert.deepEqual(combine({ ...base, passed: "default", hasStrong: false }), { note: ["capped"] });
  assert.deepEqual(combine({ ...base, passed: "none", target: "default", hasStrong: false }), { note: [] });
});

test("planSizing: strong climbs per entry, undeclared and not_builder are traced, a refusal names the rule", (t) => {
  const root = repo(t);
  put(root, "scripts/big.py", "x\n".repeat(1700));
  const o = { config: CONFIG, roles: ROLES, ranks: RANKS, cwd: root, tier: "standard", revisionClimb: false, pressureHigh: false, top: null };
  const mk = (): Record<string, unknown> => ({ tasks: [{ agent: "builder", task: "a", size: { files: ["scripts/big.py"] } }, { agent: "builder", task: "b", size: { files: ["scripts/x.py"] } }, { agent: "builder", task: "c" }, { agent: "reviewer", task: "d", risk: ["guard"] }] });
  const input = mk();
  const t1 = takeSizing(input);
  const p = planSizing(input, t1.entries, t1.carried, o);
  assert.equal(p.block, undefined);
  const [a, b, c, d] = input.tasks as Record<string, unknown>[];
  assert.equal(a.model, "strong");
  assert.equal(b.model, undefined);
  assert.equal(p.climbs.size, 1);
  assert.deepEqual(p.plans.map((x) => x.rule), ["large_file", "small", "undeclared", "not_builder"]);
  assert.deepEqual(sizingTrace(p.plans[0], "strong"), { event: "launch_sizing", role: "builder", rule: "large_file", rung: "strong", base: "default", files: 1, lines: 1700, declaredLines: 0, modules: 1, declaredModules: 0, outside: 0 });
  assert.equal(c.model, undefined);
  assert.equal(d.model, undefined);
  // pressure drops the climb and says so
  const hi = mk();
  const t2 = takeSizing(hi);
  const ph = planSizing(hi, t2.entries, t2.carried, { ...o, pressureHigh: true });
  assert.equal((hi.tasks as Record<string, unknown>[])[0].model, undefined);
  assert.deepEqual([ph.plans[0].suppressed, ph.plans[0].combo.note], [true, ["suppressed"]]);
  // below the rung
  const low = { agent: "builder", task: "x", model: "default", size: { files: ["scripts/big.py"] } };
  const t3 = takeSizing(low);
  const r = planSizing(low, t3.entries, t3.carried, o);
  assert.match(r.block ?? "", /\[sizing_below\].*large_file.*1 file\(s\), 1700 lines, 1 module\(s\)/);
  const withReason = { agent: "builder", task: "x", model: "default", reason: "tiny edit", size: { files: ["scripts/big.py"] } };
  const t4 = takeSizing(withReason);
  const w = planSizing(withReason, t4.entries, t4.carried, o);
  assert.equal(w.block, undefined);
  assert.deepEqual(w.plans[0].combo.note, ["explicit", "override"]);
  assert.equal(withReason.model, "default");
  assert.match(belowMessage("r", "strong", M()), /sizing_below/);
});

test("planSizing: a risk-top entry without a top model falls back to strong, capped; the probe tags are strong risks only", (t) => {
  const root = repo(t);
  const o = { config: CONFIG, roles: ROLES, ranks: RANKS, cwd: root, tier: "standard", revisionClimb: false, pressureHigh: false, top: null as string | null };
  const input = { agent: "builder", task: "x", risk: ["design", "guard"] };
  const tk = takeSizing(input);
  const p = planSizing(input, tk.entries, tk.carried, o);
  assert.deepEqual([p.plans[0].rule, p.plans[0].target, p.plans[0].combo.note, p.plans[0].probe], ["risk_top", "strong", ["capped"], ["guard"]]);
  const top = { agent: "builder", task: "x", risk: ["design"] };
  const t2 = takeSizing(top);
  const q = planSizing(top, t2.entries, t2.carried, { ...o, top: "p/big" });
  assert.deepEqual([q.plans[0].target, q.plans[0].combo.climb, top.model], ["top", true, "strong"]);
});

test("planSizing: the heavy tier keeps strong for a small task; no strong rung changes nothing", (t) => {
  const root = repo(t);
  const o = { config: CONFIG, roles: ROLES, ranks: RANKS, cwd: root, tier: "heavy", revisionClimb: false, pressureHigh: false, top: null };
  const input = { agent: "builder", task: "x", size: { files: [] } };
  const tk = takeSizing(input);
  const p = planSizing(input, tk.entries, tk.carried, o);
  assert.deepEqual([p.plans[0].rule, p.plans[0].base, p.plans[0].target], ["small", "strong", "default"]);
  const bare = { builder: { model: "p/small" } };
  const risky = { agent: "builder", task: "x", risk: ["security"] };
  const t2 = takeSizing(risky);
  const q = planSizing(risky, t2.entries, t2.carried, { ...o, roles: bare, tier: "standard" });
  assert.deepEqual([q.block, q.plans[0].combo, risky.model], [undefined, { note: ["capped"] }, undefined]);
});

test("prependProbe: one line with the tags, once; nothing without tags", () => {
  const out = prependProbe("review it", new Set(["guard", "parser"]));
  assert.ok(out.startsWith("[pi-foreman risk] guard, parser: probe for bypasses (alternate spellings, quoting and chaining, path tricks, races) and list each probe you ran.\n\nreview it"));
  assert.equal(prependProbe(out, new Set(["guard"])), out);
  assert.equal(prependProbe("x", new Set()), "x");
});

test("Declared type is exported for callers", () => {
  const d: Declared = { size: null, risk: null };
  assert.equal(d.size, null);
});
