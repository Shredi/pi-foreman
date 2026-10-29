// R41 offline gate eval (ledger item 10): drives gateDecide (floors, selfmod, path rules, defaults) and, for a call the gate does
// not decide, gateReview with a fake review model that answers from tests/fixtures/gate-eval-answers.json. No network, no real model.
// Reports agreement on the human-decided cases (source import), false allows (must be 0), dialogs, default share, model calls,
// cache hits and the opaque share; also greps the fixture for private strings.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gateDecide } from "../gate.ts";
import { GateCache, gateReview } from "../gatereview.ts";
import { loadPolicy } from "../policy.ts";
import { parseShell } from "../shellast.ts";
import type { GateRoots } from "../pathrules.ts";
import type { FloorEnv } from "../floors.ts";
import type { GitFacts } from "../defaults.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { shPath } from "./_shpath.ts";
import { buildEval, findPrivate, main as permsMain } from "../../../scripts/foreman_perms.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..", "..", "..");
const fixtureFile = path.join(pkgRoot, "tests", "fixtures", "gate-eval.jsonl");
const answersFile = path.join(pkgRoot, "tests", "fixtures", "gate-eval-answers.json");

interface EvalCase { id: string; kind: string; role: string; tool: string; input: Record<string, unknown>; facts?: string[]; expect: "allow" | "deny" | "ask"; source: "log" | "import"; rule?: string; platform?: string }
type Outcome = { verdict: "allow" | "deny" | "ask"; layer: "floor" | "selfmod" | "default" | "review" | "cache"; rule: string };

const cases: EvalCase[] = fs.readFileSync(fixtureFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const answers: Record<string, { verdict: string; entry: string }> = JSON.parse(fs.readFileSync(answersFile, "utf8"));

// native realpath: the long form of the temp dir; a shell word with an 8.3 tilde (`RUNNER~1`) is never a literal path (mrg-001 would stop at the floor)
const base = fs.realpathSync.native(mkTestTmp("pf41-eval-"));
const dir = (...p: string[]): string => path.join(base, ...p);
const wt = dir("wt");
const scr = dir("tmp", "pi-foreman-scratch", "mine");
const parent = dir("parent");
const agent = dir("agent");
const install = dir("pi");
for (const d of [path.join(wt, "src"), scr, path.join(parent, ".workflow", "scratch"), path.join(agent, "pi-foreman", "state"), install]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }));
// the worktree is a linked worktree of the parent checkout (the attributes-file floor accepts the main checkout's .workflow/)
fs.mkdirSync(path.join(parent, ".git", "worktrees", "wt"), { recursive: true });
fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(parent, ".git", "worktrees", "wt")}\n`);
after(() => fs.rmSync(base, { recursive: true, force: true }));

const facts: GitFacts = { currentBranch: () => "round/41-x", protectedBranches: () => ["main", "master", "trunk"], pushConfigured: () => false };
const WIN = { wt: "D:\\work\\repo", scr: "D:\\tmp\\pi-foreman-scratch\\mine", home: "C:\\Users\\x", agent: "C:\\Users\\x\\.pi\\agent", tmp: "D:\\tmp", other: "E:\\other" };

/** The placeholders a fixture may use, per platform. */
function subst(c: EvalCase, v0: unknown = c.input): Record<string, unknown> {
  const w = c.platform === "win32";
  const map: Record<string, string> = w
    ? { $WT: WIN.wt, $SCR: WIN.scr, $PARENT: "D:\\parent", $TMP: WIN.tmp, $AGENT: WIN.agent, $HOME: WIN.home, $OTHER: WIN.other, $INSTALL: "D:\\pi" }
    : { $WT: wt, $SCR: scr, $PARENT: parent, $TMP: dir("tmp"), $AGENT: agent, $HOME: "/pf41/home", $OTHER: "/pf41/other", $INSTALL: install };
  // a native-platform path in a shell line is slashed (an unquoted backslash is an escape to the shell parser); the win32 cases keep their literal backslash paths
  const walk = (v: unknown, shell = false): unknown => (typeof v === "string" ? Object.entries(map).reduce((s, [k, x]) => s.split(k).join(shell && !w ? shPath(x) : x), v) : Array.isArray(v) ? v.map((x) => walk(x)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k === "command")])) : v);
  return walk(v0) as Record<string, unknown>;
}

function rootsOf(c: EvalCase): GateRoots {
  const w = c.platform === "win32";
  const child = c.kind === "child";
  return {
    worktree: w ? WIN.wt : wt, scratch: [w ? WIN.scr : scr], tmp: w ? [WIN.tmp] : [dir("tmp"), "/tmp"], scratchBase: w ? "D:\\tmp\\pi-foreman-scratch" : dir("tmp", "pi-foreman-scratch"),
    owned: [], install: [w ? "D:\\pi" : install], roundFlow: child ? [w ? "D:\\parent\\.workflow" : path.join(parent, ".workflow")] : [], handoffs: [],
    child, role: c.role, tmpAccess: true, agentDir: w ? WIN.agent : agent, ...(w ? { realpath: (p: string) => p } : {}),
  };
}

function envOf(c: EvalCase): FloorEnv {
  const w = c.platform === "win32";
  return {
    cwd: w ? WIN.wt : wt, home: w ? WIN.home : "/pf41/home", agentDir: w ? WIN.agent : agent, platform: w ? "win32" : process.platform, protectedBranches: ["trunk"],
    currentBranch: () => "round/41-x", remoteHead: () => "trunk", writeRoots: w ? [WIN.wt, WIN.scr, WIN.tmp] : [wt, scr, dir("tmp"), "/tmp"], child: c.kind === "child",
  };
}

const policy = loadPolicy({ pkgRoot, agentDir: agent, cwd: wt });
const config = { providers: { p: { review: { model: "m" } } } };
let modelCalls = 0;
let cacheHits = 0;
const cache = new GateCache();

/** A registry whose model answers the current case from the answers file. */
function fakeRegistry(id: string): never {
  return {
    find: () => ({ id: "m" }),
    complete: async () => {
      modelCalls++;
      const a = answers[id];
      if (!a) throw new Error(`no answer for ${id} in gate-eval-answers.json`);
      return { content: [{ type: "text", text: JSON.stringify({ verdict: a.verdict, entry: a.entry, reason: "fixture" }) }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  } as never;
}

const payloadOf = (tool: string, input: Record<string, unknown>): string => (typeof input.command === "string" ? input.command : `${tool} ${JSON.stringify(input)}`);

async function run(c: EvalCase): Promise<Outcome> {
  const input = subst(c);
  const cwd = c.platform === "win32" ? WIN.wt : wt;
  const g = gateDecide(c.tool, input, cwd, { env: () => envOf(c), roots: () => rootsOf(c), facts });
  if (g && "block" in g) return { verdict: "deny", layer: g.rule.startsWith("selfmod") ? "selfmod" : "floor", rule: g.rule };
  if (g && "allow" in g) return { verdict: "allow", layer: "default", rule: g.rule };
  if (g && "ask" in g) return { verdict: "ask", layer: "selfmod", rule: g.rule };
  const r = rootsOf(c);
  const v = await gateReview(
    { surface: c.tool, tool: c.tool, role: c.role, kind: c.kind as never, cwd, worktree: r.worktree, owned: r.owned, branch: "round/41-x", head: "h1", mergeHead: null, remotes: ["origin"], ownerMessages: [], payload: payloadOf(c.tool, input), ...(c.facts ? { facts: subst(c, c.facts) as unknown as string[] } : {}) },
    { policy, registry: fakeRegistry(c.id), config, provider: "p", cache },
  );
  if (v.kind === "unreachable") return { verdict: "ask", layer: "review", rule: v.cause };
  if (v.cached) cacheHits++;
  return { verdict: v.kind, layer: v.cached ? "cache" : "review", rule: v.entry };
}

const isOpaque = (c: EvalCase): boolean => {
  if (c.tool === "powershell") return true;
  const cmd = subst(c).command;
  if (typeof cmd !== "string") return false;
  return parseShell(cmd, { cwd: c.platform === "win32" ? WIN.wt : wt, platform: c.platform === "win32" ? "win32" : undefined }).some((s) => s.opaque);
};

test("fixture: every case is well formed and unique", () => {
  const ids = new Set<string>();
  for (const c of cases) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(["allow", "deny", "ask"].includes(c.expect), c.id);
    assert.ok(["log", "import"].includes(c.source), c.id);
    assert.equal(typeof c.tool, "string", c.id);
  }
  assert.ok(cases.length >= 100, `only ${cases.length} cases`);
  for (const id of Object.keys(answers)) assert.ok(ids.has(id), `answer for unknown case ${id}`);
});

test("offline gate eval: no false allows; summary", async () => {
  const falseAllows: string[] = [];
  const mismatches: string[] = [];
  const disagreements: string[] = [];
  const neverDefault: string[] = [];
  let human = 0;
  let humanAgree = 0;
  let dialogs = 0;
  let defaults = 0;
  let opaque = 0;
  let shellLike = 0;
  const reviewed = new Set<string>();
  for (const c of cases) {
    const o = await run(c);
    if (o.layer === "review" || o.layer === "cache") reviewed.add(c.id);
    if (o.verdict === "allow" && c.expect !== "allow") falseAllows.push(`${c.id} (expected ${c.expect})`);
    if (process.env.FOREMAN_EVAL_DUMP) console.log(`dump ${c.id} ${o.layer} ${o.verdict} ${o.rule} (expect ${c.expect})`);
    // an opaque line, the powershell tool and a foreign shell are never a default
    if (o.layer === "default" && isOpaque(c)) neverDefault.push(c.id);
    // import cases are the human reference: a difference lowers the agreement; a replay case must match exactly (verdict and named rule)
    if (c.source === "log" && (o.verdict !== c.expect || (c.rule && o.rule !== c.rule))) mismatches.push(`${c.id}: expected ${c.expect}${c.rule ? ` via ${c.rule}` : ""}, got ${o.verdict} via ${o.layer}/${o.rule}`);
    if (c.source === "import" && o.verdict !== c.expect) disagreements.push(`${c.id} (expected ${c.expect}, got ${o.verdict} via ${o.layer}/${o.rule})`);
    if (c.source === "import") {
      human++;
      if (o.verdict === c.expect) humanAgree++;
    }
    if (o.verdict === "ask") dialogs++;
    if (o.layer === "default") defaults++;
    if (typeof subst(c).command === "string" || c.tool === "powershell") {
      shellLike++;
      if (isOpaque(c)) opaque++;
    }
  }
  const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)}%` : "n/a");
  console.log(`gate-eval: cases=${cases.length} agreement(import)=${humanAgree}/${human} (${pct(humanAgree, human)}) false-allows=${falseAllows.length} dialogs=${dialogs} default-share=${pct(defaults, cases.length)} model-calls=${modelCalls} cache-hits=${cacheHits} opaque-share=${pct(opaque, shellLike)}`);
  assert.deepEqual(falseAllows, [], `false allows: ${falseAllows.join("; ")}`);
  if (disagreements.length) console.log(`gate-eval: import cases that differ: ${disagreements.join("; ")}`);
  assert.deepEqual(neverDefault, [], "opaque calls must never reach a default");
  assert.deepEqual(mismatches, [], `verdicts differ from the fixture: ${mismatches.join("; ")}`);
  for (const id of Object.keys(answers)) assert.ok(reviewed.has(id), `answer for ${id} is never used`);
});

test("fixture holds no private strings", () => {
  const bad: string[] = [];
  for (const l of fs.readFileSync(fixtureFile, "utf8").split("\n")) if (l.trim()) for (const f of findPrivate(l)) bad.push(`${f}: ${l.slice(0, 80)}`);
  for (const l of fs.readFileSync(answersFile, "utf8").split("\n")) for (const f of findPrivate(l)) bad.push(`${f}: ${l.slice(0, 80)}`);
  assert.deepEqual(bad, []);
});

test("export-eval: dedupes by shape, drops private strings and counts them", () => {
  const log = [
    { tool: "bash", verdict: "allow", shape: "ls <wt>", kind: "owner", role: "foreman", rule: "default-read" },
    { tool: "bash", verdict: "allow", shape: "ls <wt>", kind: "owner", role: "foreman" },
    { tool: "bash", verdict: "deny", shape: "cat /Users/jdoe/notes.md", kind: "child", role: "builder" },
    { tool: "bash", verdict: "deny", shape: "curl https://internal.corp.test/x", kind: "child", role: "builder" },
    { tool: "bash", verdict: "allow", shape: "git log --author=a@b.co", kind: "owner", role: "foreman" },
    { tool: "bash", verdict: "allow", shape: "echo ghp_abcdefghijklmnopqrstuvwxyz0123", kind: "owner", role: "foreman" },
    { tool: "read", verdict: "nonsense", shape: "<wt>/a" },
  ];
  const from = [{ tool: "bash", input: { command: "ssh 10.1.2.3" }, expect: "deny" }, { tool: "bash", input: { command: "pwd" }, expect: "allow" }];
  const { cases: out, stats } = buildEval(log, from);
  assert.deepEqual(out.map((c: { input: unknown }) => c.input), [{ command: "ls <wt>" }, { command: "pwd" }]);
  assert.deepEqual([stats.duplicates, stats.unusable, stats.dropped], [1, 1, { "home-path": 1, host: 2, email: 1, token: 1, ip: 1 }]);
  assert.equal(permsMain(["bogus"]), 2);
  assert.equal(permsMain(["adopt", "abcd1234"]), 2);
  const f = path.join(base, "prepared.jsonl");
  const o = path.join(base, "out.jsonl");
  fs.writeFileSync(f, JSON.stringify(from[1]) + "\n");
  assert.equal(permsMain(["export-eval", "--log", path.join(base, "missing.jsonl"), "--from", f, "--out", o]), 0);
  assert.equal(JSON.parse(fs.readFileSync(o, "utf8")).source, "import");
});

test("fixture holds none of the strings of the optional local denylist (FOREMAN_EVAL_DENYLIST, not committed)", { skip: !process.env.FOREMAN_EVAL_DENYLIST }, () => {
  const words = fs.readFileSync(process.env.FOREMAN_EVAL_DENYLIST as string, "utf8").split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const text = (fs.readFileSync(fixtureFile, "utf8") + fs.readFileSync(answersFile, "utf8")).toLowerCase();
  assert.deepEqual(words.filter((w) => text.includes(w)).map(() => "denylisted string present"), []);
});
