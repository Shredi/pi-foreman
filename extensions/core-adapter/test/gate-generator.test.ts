// Generator test for the permission gate (skill: .agents/skills/verifying-permission-gate). The rule: a shell line that holds a dangerous command never runs without a
// block, a judge look or an owner ask, whatever construct hides it. Seven dangerous payloads are hidden in about fifty shell constructs (alone, then nested two and three
// deep, seeded) and every line goes through the real gate (gateEvaluate) as a builder and as a reviewer. The main session is left out (LEFT_OUT in _gate-gen.ts).
//   A. a dangerous line is never silent (no block, no judge, no ask), except for the shapes marked in KNOWN_GAPS; a mark whose gap closed fails the run
//   B. the same constructs with a harmless payload are not stricter than today (pinned per construct) and composed harmless chains are never blocked
//   quoting test: every construct, built with a marker payload, really runs it in a real bash (syntax check only where this machine lacks a need)
//   handler sample: about twenty chains through the real tool_call handler (judge stubbed) agree with the fast oracle class by class
//   self-tests: the checker run against broken fake oracles reports the break
// Env: FOREMAN_GATE_GEN_SEED (default 1), FOREMAN_GATE_GEN_SEEDS (a sweep of N seeds from SEED; npm run test:gate-sweep sets them). Stale marks are checked only at the default seed.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";
import { posixOnly } from "./_platform.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import {
  CONSTRUCTS, DANGEROUS, HARMLESS, KNOWN_GAPS, PLAIN_GAPS, ROLES, TWIN_PINS, WRAPS, buildCommand, checkDanger, checkHarmlessChains, checkPlainGaps, checkTwins, chainNames, construct, depthOneCases, describeStale,
  describeTwin, describeUnexpected, gateOracle, makeLayout, memoOracle, pairCases, sampleCases, sampleChains, sortFound, staleGaps, sq,
  type Chain, type Cls, type DangerCase, type Found, type Needs, type Oracle,
} from "./_gate-gen.ts";

process.env.PI_OFFLINE = "1";

const DEFAULT_SEED = 1;
/** A positive integer from an env value; anything else (empty, text, zero, negative, fraction) is an error, never an empty seed list. */
export function parseSeedEnv(name: string, raw: string | undefined, dflt: number): number {
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}
const SEED = parseSeedEnv("FOREMAN_GATE_GEN_SEED", process.env.FOREMAN_GATE_GEN_SEED, DEFAULT_SEED);
const SEEDS = parseSeedEnv("FOREMAN_GATE_GEN_SEEDS", process.env.FOREMAN_GATE_GEN_SEEDS, 1);
const SEED_LIST = Array.from({ length: SEEDS }, (_, i) => SEED + i);
const DEFAULT_RUN = SEEDS === 1 && SEED === DEFAULT_SEED;
// Chains per seed, sized so the whole file runs in about ten seconds (one gate call is about 5 ms).
const N_DANGER = { d2: 120, d3: 60 };
const N_HARMLESS = { d2: 60, d3: 30 };
/**
 * Composed harmless chains (only constructs whose harmless twins are silent) may be judged or asked a little: the share that is not silent was measured at MEASURED_SHARE
 * (default seed) and may grow by two percentage points at most (the stated tolerance: it absorbs sample noise and small intended changes, and still catches a new wave of false alarms).
 */
const MEASURED_SHARE = 0;
const CEILING = MEASURED_SHARE + 0.02;

const base = fs.realpathSync(mkTestTmp("pf-gategen-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const real: Oracle = memoOracle(gateOracle(makeLayout(path.join(base, "gate"))));

// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Run once, share between the tests of this file. */
const lazy = <T>(f: () => T): (() => T) => {
  let v: { value: T } | undefined;
  return () => (v ??= { value: f() }).value;
};

/** The deterministic set: depth 1, every ordered pair that has an entry, and the seeded sample. */
const deterministic = lazy(() => {
  const fixedPart = checkDanger(real, [...depthOneCases(), ...pairCases(KNOWN_GAPS)]);
  const perSeed = SEED_LIST.map((seed) => ({ seed, ...checkDanger(real, sampleCases(seed, N_DANGER.d2, N_DANGER.d3)) }));
  return { fixedPart, perSeed };
});

test("precondition: each plain dangerous payload is not silent", { skip: posixOnly }, () => {
  for (const role of ROLES) {
    for (const p of DANGEROUS) assert.notEqual(real(p.text, role), "silent", `${role}: plain payload ${p.name} (${p.text}) already runs silent, so no wrapper can be blamed; drop or replace the payload`);
  }
});

test("property A: no dangerous line runs silent outside the marked gaps", { skip: posixOnly }, () => {
  const { fixedPart, perSeed } = deterministic();
  const bad: string[] = [];
  const first = sortFound(fixedPart.found, KNOWN_GAPS).unexpected;
  if (first.length > 0) bad.push(describeUnexpected(first, SEED));
  for (const r of perSeed) {
    const u = sortFound(r.found, KNOWN_GAPS).unexpected;
    if (u.length > 0) bad.push(describeUnexpected(u, r.seed));
  }
  assert.equal(bad.length, 0, bad.join("\n\n"));
});

test("known gaps: a mark whose gap is closed fails (default seed only)", { skip: posixOnly || (DEFAULT_RUN ? false : "stale marks are checked at the default seed only") }, () => {
  const { fixedPart, perSeed } = deterministic();
  const matched = sortFound([...fixedPart.found, ...perSeed.flatMap((r) => r.found)], KNOWN_GAPS).matched;
  const stale = staleGaps(matched, KNOWN_GAPS);
  assert.equal(stale.length, 0, stale.map(describeStale).join("\n"));
});

test("plain gap lines: silent only for the listed roles; a closed one fails (default seed only)", { skip: posixOnly || (DEFAULT_RUN ? false : "stale marks are checked at the default seed only") }, () => {
  const { stale, unexpected } = checkPlainGaps(real, PLAIN_GAPS);
  assert.equal(stale.length + unexpected.length, 0, [...stale, ...unexpected].join("\n"));
});

test("property B: a harmless twin is not stricter than its pinned class today", { skip: posixOnly }, () => {
  const { violations } = checkTwins(real, TWIN_PINS);
  assert.equal(
    violations.length, 0,
    `${violations.length} harmless line(s) got stricter (a false block or look). If the change meant it, edit TWIN_PINS in _gate-gen.ts and say why in the change:\n${violations.slice(0, 8).map((v) => describeTwin(v, SEED)).join("\n")}`,
  );
});

test("property B: composed harmless chains are never blocked and stay under the pinned ceiling", { skip: posixOnly }, () => {
  let total = 0;
  let notSilent = 0;
  const blocked: string[] = [];
  for (const seed of SEED_LIST) {
    const { run } = checkHarmlessChains(real, TWIN_PINS, seed, N_HARMLESS.d2, N_HARMLESS.d3);
    total += run.total;
    notSilent += run.notSilent;
    for (const b of run.blocked.slice(0, 5)) blocked.push(`[${b.role}] seed ${seed}: ${b.names.join(" > ")}: ${b.command.replaceAll("\n", "\\n")}`);
  }
  assert.equal(blocked.length, 0, `harmless chains are blocked:\n${blocked.join("\n")}`);
  const share = notSilent / total;
  assert.ok(share <= CEILING, `${notSilent} of ${total} harmless chains (${(share * 100).toFixed(1)} %) are judged or asked; the pinned ceiling is ${(CEILING * 100).toFixed(1)} % (measured ${(MEASURED_SHARE * 100).toFixed(1)} % + 2 points). Edit MEASURED_SHARE only for an intended change.`);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Quoting test: a construct that does not run its payload is a generator fault, found here and not in property A

const bashVersion = ((): [number, number] => {
  const r = spawnSync("bash", ["-c", 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], { encoding: "utf8" });
  const [a, b] = (r.stdout ?? "").trim().split(" ").map(Number);
  return Number.isFinite(a) ? [a, b] : [0, 0];
})();
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const onPath = (prog: string): boolean =>
  (process.env.PATH ?? "").split(path.delimiter).some((d) => {
    try {
      fs.accessSync(path.join(d, prog), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
const probeOk = new Map<string, boolean>();
const probes = (snippet: string): boolean => {
  let ok = probeOk.get(snippet);
  if (ok === undefined) {
    ok = spawnSync("bash", ["-c", snippet], { stdio: "ignore", timeout: 5000 }).status === 0;
    probeOk.set(snippet, ok);
  }
  return ok;
};

/** The needs of a chain: the union of its constructs' needs. */
function needsOf(chain: Chain): Needs {
  const n: Needs = { progs: [] };
  for (const c of chain) {
    const x = c.needs;
    if (x.bash && (!n.bash || x.bash[0] > n.bash[0] || (x.bash[0] === n.bash[0] && x.bash[1] > n.bash[1]))) n.bash = x.bash;
    n.progs?.push(...(x.progs ?? []));
    if (x.neverRun) n.neverRun = x.neverRun;
    if (x.rootSyntaxOnly) n.rootSyntaxOnly = true;
    if (x.aliases) n.aliases = true;
    if (x.probe) n.probe = n.probe ? `${n.probe} && ${x.probe}` : x.probe;
  }
  return n;
}

/** Why this machine cannot run the chain for real, or null. */
function unmet(n: Needs): string | null {
  if (n.neverRun) return n.neverRun;
  if (n.rootSyntaxOnly && isRoot) return "bash ignores PS4 from the environment as root";
  if (n.bash && (bashVersion[0] < n.bash[0] || (bashVersion[0] === n.bash[0] && bashVersion[1] < n.bash[1]))) return `needs bash ${n.bash.join(".")}, this is ${bashVersion.join(".")}`;
  const missing = (n.progs ?? []).filter((p) => !onPath(p));
  if (missing.length > 0) return `${[...new Set(missing)].join(", ")} not on PATH`;
  if (n.probe && !probes(n.probe)) return `the probe \`${n.probe}\` failed`;
  return null;
}

const syntaxOnly: string[] = [];

/** Run `chain` with a marker payload in a real bash (own empty cwd, marker by absolute path, stdin closed, 5 s limit), or only check the syntax. */
function checkQuoting(chain: Chain, label: string): void {
  const dir = fs.mkdtempSync(path.join(base, "q-"));
  try {
    const cwd = path.join(dir, "cwd");
    const marks = path.join(dir, "marks");
    fs.mkdirSync(cwd);
    fs.mkdirSync(marks);
    const marker = path.join(marks, "marker");
    const n = needsOf(chain);
    const line = buildCommand(chain, `touch ${sq(marker)}`);
    const why = unmet(n);
    if (why) {
      const r = spawnSync("bash", ["-n", "-c", line], { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 5000 });
      assert.equal(r.status, 0, `${label}: bash -n rejects the line (${why}):\n${line}\n${r.stderr}`);
      syntaxOnly.push(`${label} (${why})`);
      return;
    }
    const script = `${n.aliases ? "shopt -s expand_aliases\n" : ""}${line}`;
    const r = spawnSync("bash", ["-c", script], { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 5000 });
    assert.ok(fs.existsSync(marker), `${label}: the marker payload did not run in a real bash (generator fault, exit ${r.status}, ${r.error ? r.error.message : "no spawn error"}):\n${script}\n${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("quoting: every construct runs its payload in a real bash (syntax check only where a need is unmet)", { skip: posixOnly }, (t) => {
  for (const c of WRAPS) checkQuoting([c], c.name);
  const chains = [...sampleChains(SEED, 2, 25, WRAPS, WRAPS), ...sampleChains(SEED, 3, 15, WRAPS, WRAPS)];
  for (const chain of chains) checkQuoting(chain, chainNames(chain).join(" > "));
  t.diagnostic(`bash ${bashVersion.join(".")}; ${WRAPS.length} constructs and ${chains.length} chains; syntax check only: ${syntaxOnly.length}: ${[...new Set(syntaxOnly.map((s) => s.replace(/^.*\((.*)\)$/, "$1")))].join("; ")}`);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The real tool_call handler

test("the fast oracle agrees with the real tool_call handler on a sample (judge stubbed)", { skip: posixOnly }, async (t) => {
  const saved = { b: process.env[BINDINGS_ENV], c: process.env.FOREMAN_CHECKOUT };
  t.after(() => {
    if (saved.b === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = saved.b;
    if (saved.c === undefined) delete process.env.FOREMAN_CHECKOUT;
    else process.env.FOREMAN_CHECKOUT = saved.c;
  });
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "builder", launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
  delete process.env.FOREMAN_CHECKOUT;
  let judged = 0;
  const verdict = JSON.stringify({ verdict: "clear", reason: "stub" });
  const modelRegistry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => { judged++; return { content: [{ type: "text", text: verdict }], stopReason: "stop", usage: { input: 1, output: 1 } }; } };
  const ui = { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
  const config = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } } };
  const rig = await r11Rig(t, {}, { ctx: { modelRegistry, ui }, config, child: true });
  // the rig's builder child: its worktree is the rig project and it has no scratch or out folder (no launch binding names one)
  const fast = gateOracle({ worktree: rig.project, scratch: [], scratchBase: path.join(base, "rig-scratch") });

  // About twenty lines drawn from a seeded pool so that every class is reached: up to 7 silent, 6 judge and 5 block (fewer when the pool has fewer). The handler stops a run
  // that gets the same refusal twice (repeatedDeny), so the block lines carry different payloads, which refuse for different reasons.
  const pool: { command: string; payload: string }[] = [];
  const dangerous = (chain: Chain, i: number) => ({ command: buildCommand(chain, chain[chain.length - 1].kind === "fixed" ? "" : DANGEROUS[i % DANGEROUS.length].text), payload: DANGEROUS[i % DANGEROUS.length].name });
  [...sampleChains(SEED, 2, 40, WRAPS, CONSTRUCTS), ...sampleChains(SEED, 3, 20, WRAPS, CONSTRUCTS)].forEach((chain, i) => pool.push(dangerous(chain, i)));
  sampleChains(SEED + 1, 1, 6, WRAPS, WRAPS).forEach((chain, i) => pool.push({ command: buildCommand(chain, HARMLESS[i % HARMLESS.length].text), payload: HARMLESS[i % HARMLESS.length].name }));
  sampleChains(SEED + 2, 2, 6, WRAPS, WRAPS).forEach((chain, i) => pool.push({ command: buildCommand(chain, HARMLESS[i % HARMLESS.length].text), payload: HARMLESS[i % HARMLESS.length].name }));
  const quota: Record<Cls, number> = { silent: 7, judge: 6, ask: 3, block: 5 };
  const lines: string[] = [];
  const seen: Record<Cls, number> = { silent: 0, judge: 0, ask: 0, block: 0 };
  const blockedPayloads = new Set<string>();
  for (const { command, payload } of pool) {
    if (lines.includes(command)) continue;
    const cls = fast(command, "builder");
    if (seen[cls] >= quota[cls] || (cls === "block" && blockedPayloads.has(payload))) continue;
    if (cls === "block") blockedPayloads.add(payload);
    seen[cls]++;
    lines.push(command);
  }

  // The handler (index.ts, the first tool_call hook): a `block` result is refused; an `ask` result (an ask-kind floor, a self-modification rule, a protected match) opens
  // the owner dialog and is never judged; no result with a judge-first label goes to the judge and runs when the judge clears it; an allow, or no result and no label, runs
  // at once ("mode:no-rule"). So: block -> refused, judge -> exactly one judge request and runs, silent -> runs with no request. An ask line is not sent through the rig (the
  // dialog of a child waits for its parent); it must not be silent, and the fast oracle says so.
  for (const command of lines) {
    const cls = fast(command, "builder");
    if (cls !== "block" && cls !== "judge") continue;
    const before = judged;
    const res = await rig.call("bash", { command });
    const what = `${cls} line through the handler: ${command.replaceAll("\n", "\\n")}\n${JSON.stringify(res)} (judge requests ${judged - before})`;
    if (cls === "block") {
      assert.ok(res?.block, what);
      assert.equal(judged, before, what);
    } else if (cls === "judge") {
      assert.ok(!res?.block, what);
      assert.equal(judged, before + 1, what);
    }
  }
  for (const command of lines) {
    if (fast(command, "builder") !== "silent") continue;
    const before = judged;
    const res = await rig.call("bash", { command });
    assert.equal(res, undefined, `silent line is refused by the handler: ${command}`);
    assert.equal(judged, before, `silent line reached the judge: ${command}`);
  }
  t.diagnostic(`handler sample: ${lines.length} lines, classes ${JSON.stringify(seen)}`);
  assert.ok(seen.silent > 0 && seen.judge > 0 && seen.block > 0, `the sample should reach silent, judge and block lines: ${JSON.stringify(seen)}`);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Self-tests: the checker against fakes that are broken on purpose

test("self-test: a gate that calls everything inside $( ) silent is reported, shrunk to the single construct", { skip: posixOnly }, () => {
  const fake: Oracle = (command, role) => (command.includes("$(") ? "silent" : real(command, role));
  const nested: DangerCase = { chain: [construct("brace"), construct("nice"), construct("cmdsub")], payload: DANGEROUS[3], role: "builder", where: "depth 3 #0" };
  assert.ok(checkDanger(fake, depthOneCases()).found.length > 0, "the broken gate went unnoticed at depth 1");
  const { found } = checkDanger(fake, [nested]);
  const hit = found.find((f: Found) => f.where === "depth 3 #0");
  assert.ok(hit, "the nested case was not reported");
  assert.deepEqual(hit.names, ["brace", "nice", "cmdsub"]);
  assert.deepEqual(hit.shrunk.names, ["cmdsub"]);
  assert.equal(hit.shrunk.command, "echo $(cat ~/.ssh/id_rsa)");
  const text = describeUnexpected(found, 4242);
  for (const part of ["seed 4242", "brace > nice > cmdsub", "shrunk command: echo $(cat ~/.ssh/id_rsa)", "FOREMAN_GATE_GEN_SEED=4242"]) assert.ok(text.includes(part), `${part} is missing from:\n${text}`);
});

test("self-test: a gate that blocks harmless for loops fails the twin property", { skip: posixOnly }, () => {
  const fake: Oracle = (command, role) => (command.startsWith("for ") ? "block" : real(command, role));
  const { violations } = checkTwins(fake, TWIN_PINS);
  assert.ok(violations.some((v) => v.construct === "for" && v.got === "block"), JSON.stringify(violations.slice(0, 3)));
  assert.ok(describeTwin(violations[0], 1).includes("FOREMAN_GATE_GEN_SEED=1"));
});

test("self-test: a gate that closes one marked gap makes the stale check name it", { skip: posixOnly }, () => {
  const fake: Oracle = (command, role) => (command.startsWith("trap ") ? "judge" : real(command, role));
  const { found } = checkDanger(fake, [...depthOneCases(), ...pairCases(KNOWN_GAPS)]);
  const stale = staleGaps(sortFound(found, KNOWN_GAPS).matched, KNOWN_GAPS);
  assert.deepEqual(stale.map((g) => g.id), ["trap"]);
  assert.ok(describeStale(stale[0]).includes("gap trap is closed: remove its line from KNOWN_GAPS"));
});

test("self-test: a gate that closes the plain git-outside-tilde line makes the stale check name it", { skip: posixOnly }, () => {
  const fake: Oracle = (command, role) => (command.includes("~/other") ? "block" : real(command, role));
  const { stale, unexpected } = checkPlainGaps(fake, PLAIN_GAPS);
  assert.equal(unexpected.length, 0);
  assert.equal(stale.length, 1);
  assert.ok(stale[0].includes("gap git-outside-tilde is closed: remove its line from PLAIN_GAPS"));
  const loose: Oracle = (command, role) => (command.includes("~/other") ? "silent" : real(command, role));
  assert.ok(checkPlainGaps(loose, PLAIN_GAPS).unexpected.some((m) => m.includes("[reviewer]")));
});

test("seed settings: a non-numeric or non-positive value fails with a message, a positive integer parses", () => {
  assert.equal(parseSeedEnv("FOREMAN_GATE_GEN_SEEDS", undefined, 1), 1);
  assert.equal(parseSeedEnv("FOREMAN_GATE_GEN_SEED", "7", 1), 7);
  for (const bad of ["abc", "0", "-3", "", "  ", "1.5", "NaN"]) {
    assert.throws(() => parseSeedEnv("FOREMAN_GATE_GEN_SEEDS", bad, 1), /FOREMAN_GATE_GEN_SEEDS must be a positive integer/, JSON.stringify(bad));
  }
});
