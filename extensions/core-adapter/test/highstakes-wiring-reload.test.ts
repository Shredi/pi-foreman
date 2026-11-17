// The high-stakes review wired into the adapter: the checkout of a run survives a reload (a FAIL is cleared only where it ran), the migration of a legacy
// first HEAD, the config and doctor side of the retired size bounds.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { get, loadMergedConfig } from "../config.ts";
import { retiredHighStakesLines } from "../doctorcache.ts";
import { defaultSpawner } from "../spawn.ts";
import { build, commitIn, git, hsRun, launch, end, persisted, pr, settle, setup, tick, worktree } from "./_hsrig.ts";

const TAGGED = { size: { files: ["src/b/x.ts"] }, risk: ["design"] };

test("a [high-stakes] FAIL of a sibling worktree is restored after a reload with its checkout: a normal PASS in the own checkout does not clear it, a revision and a normal PASS in the sibling does; an old per-checkout array entry then migrates on a reload and its seenHead becomes the review base", async (t) => {
  const { w, a, seed } = await setup(t, { cfg: { safety: { ops: { baseBranch: "no-such-branch" } } } }); // no merge-base resolves: the recorded base decides
  const sib = worktree(w, "sib");
  w.state.answer = "allow once"; // a launch in the sibling asks the gate
  commitIn(w.project, "src/a/small.ts"); // the own checkout: an untagged change, normal PASS
  await build(a);
  commitIn(sib, "src/b/x.ts");
  await build(a, TAGGED, sib);
  // a run end is read only by the process that launched the run (launchedRoles), so the FAIL ends before the reload and is restored from the entry
  const run = await hsRun(a, "FAIL", sib);
  await persisted(w, (hs) => hs?.runIds?.some((r: { id: string; cwd: string }) => r.id === `run-${run.id}` && r.cwd === sib) && hs.runs.length === 1);

  await a.down();
  const b = await w.adapter("reload"); // the state is restored from the persisted entry
  assert.match(await pr(b), /\[pr_refused:high_stakes_failed\]/, "the FAIL is recorded");
  assert.ok((await pr(b)).includes(`in the checkout ${sib}`), "for the sibling checkout");

  // a revision and a normal PASS in the own checkout do not clear it
  commitIn(w.project, "src/a/own.ts");
  await build(b);
  assert.match(await pr(b), /\[pr_refused:high_stakes_failed\]/, "a normal PASS in the own checkout does not clear it");
  assert.match(await settle(b), /FAILED/);

  // a revision and a normal PASS in the sibling do
  commitIn(sib, "src/b/fix.ts");
  await build(b, {}, sib);
  assert.doesNotMatch(await pr(b), /high_stakes_failed/, "cleared in the checkout it ran in");
  assert.equal(git(sib, "rev-parse", "--is-inside-work-tree"), "true");
  assert.ok(fs.existsSync(path.join(sib, "src/b/fix.ts")));

  // the same session, a second reload: an old per-checkout array entry loads (reasons migrated, retired ones dropped) and its seenHead (a real SHA) becomes the review base
  // the sibling PASS that cleared the FAIL (the last review record) lands after the builder launch wrote the fired tag: wait for both
  const fixHead = git(sib, "rev-parse", "HEAD");
  await persisted(w, (hs, en) => {
    const last = en?.reviews?.at(-1) as { verdict?: string; head?: string | null } | undefined;
    return last?.verdict === "pass" && last.head === fixHead && hs?.fired?.reasons?.includes("design");
  });
  const e = w.ceremonyEntries().at(-1)!.data as { highStakes?: unknown };
  await b.down();
  const e2 = w.ceremonyEntries().at(-1)!.data as { highStakes?: unknown };
  assert.equal(e2, e, "shutdown wrote no newer entry");
  e.highStakes = [{ cwd: w.project, fired: { reasons: ["lines", "design"], files: 1, lines: 100, modules: 1 }, runs: [], runIds: [], seenHead: seed }];
  const c = await w.adapter("reload");
  const refusal = await pr(c);
  assert.match(refusal, /\[pr_refused:high_stakes_required\]/);
  assert.match(refusal, /risk tag design/);
  assert.doesNotMatch(refusal, /lines/);
  const s = await launch(c, "reviewer", "[high-stakes] review the whole change");
  assert.equal(s.blocked, null, String(s.blocked));
  assert.ok(String(s.input.task).includes(`against ${seed.slice(0, 12)}`), "the legacy first HEAD is the base");
});

const MODELX = "fake/hs";
const BOUNDS = "ceremony.highStakes.lines/modules are retired and ignored";

test("with lines and modules set under ceremony.highStakes the doctor command prints the retired-bounds line once and the TS-side config load gives no error and no warning; without them the doctor prints none", async (t) => {
  const { w, a, root } = await setup(t, { ceremony: { highStakes: { model: MODELX, lines: 2000, modules: 3 } } });
  await a.command("foreman", "doctor");
  const text = w.notes.at(-1) ?? "";
  assert.equal(text.split(BOUNDS).length, 2, text);
  const cfgFile = path.join(root, "agent", "foreman.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as { ceremony: Record<string, unknown> };
  cfg.ceremony.highStakes = { model: MODELX, lines: 2000, modules: -1 };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const m = await loadMergedConfig({ python: "python3", pkgRoot: path.resolve(import.meta.dirname, "..", "..", ".."), agentDir: path.join(root, "agent"), projectDir: w.project, trusted: false, spawner: defaultSpawner, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "agent") } as Record<string, string> });
  assert.equal(m.source, "cli");
  assert.deepEqual(m.errors, []);
  assert.deepEqual(m.warnings.filter((x) => /highStakes|lines|modules/.test(x)), []);
  assert.equal(get(m.config, "ceremony.highStakes.model"), MODELX);
  cfg.ceremony.highStakes = { model: MODELX };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const b = await w.adapter("reload"); // the config is read at session start
  await b.command("foreman", "doctor");
  assert.doesNotMatch(w.notes.at(-1) ?? "", /highStakes\.lines\/modules/);
});

test("retiredHighStakesLines: one WARN when lines or modules is set, none otherwise", () => {
  assert.equal(retiredHighStakesLines({ ceremony: { highStakes: { model: null, lines: 50 } } }).length, 1);
  assert.equal(retiredHighStakesLines({ ceremony: { highStakes: { modules: 0 } } }).length, 1);
  assert.deepEqual(retiredHighStakesLines({ ceremony: { highStakes: { model: "x/y" } } }), []);
  assert.deepEqual(retiredHighStakesLines({}), []);
});
