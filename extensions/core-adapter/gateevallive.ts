// R41 gate eval, live run (ledger item 10, Addendum 3 F3): `node scripts/foreman_perms.mjs eval --model <provider/id>` calls this.
// It replays the fixture cases through the same gateDecide and gateReview (prompt and verdict parser) as the offline runner
// tests/gate-eval.test.ts; the cases that reach the review model go to the registry given, and its answers are recorded in the
// gate-eval-answers.json format together with latency and token statistics. The registry is injected, so tests use a fake one.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateDecide } from "./gate.ts";
import { GateCache, gateReview } from "./gatereview.ts";
import { loadPolicy } from "./policy.ts";
import type { RegistryLike } from "./review.ts";
import type { GateRoots } from "./pathrules.ts";
import type { FloorEnv } from "./floors.ts";
import type { GitFacts } from "./defaults.ts";

export interface EvalCase {
  id: string;
  kind: string;
  role: string;
  tool: string;
  input: Record<string, unknown>;
  /** Gate facts the case context supplies to the review (the real gate computes them). */
  facts?: string[];
  expect: "allow" | "deny" | "ask";
  source: "log" | "import";
  platform?: string;
}

export interface LiveStats {
  reviewCases: number;
  modelCalls: number;
  cacheHits: number;
  invalid: number;
  /** ids of the live allows where the fixture expects deny or ask, by case source */
  falseAllows: { import: string[]; log: string[] };
  unreachable: number;
  agreement: { agree: number; human: number };
  latencyP50Ms: number;
  latencyP95Ms: number;
  inputTokens: number;
  outputTokens: number;
}

export type Answers = Record<string, { verdict: string; entry: string }>;

/** Nearest-rank percentile of a list of numbers (0 for none). */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const WIN = { wt: "D:\\work\\repo", scr: "D:\\tmp\\pi-foreman-scratch\\mine", home: "C:\\Users\\x", agent: "C:\\Users\\x\\.pi\\agent", tmp: "D:\\tmp", other: "E:\\other" };
const facts: GitFacts = { currentBranch: () => "round/41-x", protectedBranches: () => ["main", "master", "trunk"], pushConfigured: () => false };

/** Replay `cases` against `registry` (model `provider/id`). Resolves with the answers of the cases the model was called for, and the statistics. */
export async function liveEval(cases: EvalCase[], registry: RegistryLike, model: string, pkgRoot: string, opts: { timeoutMs?: number } = {}): Promise<{ answers: Answers; stats: LiveStats }> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf41-live-")));
  const dir = (...p: string[]): string => path.join(base, ...p);
  const wt = dir("wt");
  const scr = dir("tmp", "pi-foreman-scratch", "mine");
  const parent = dir("parent");
  const home = dir("home");
  const agent = path.join(home, ".pi", "agent");
  const other = dir("other-repo");
  const install = dir("pi");
  try {
    for (const d of [path.join(wt, "src"), scr, path.join(parent, ".workflow", "scratch"), path.join(agent, "pi-foreman", "state"), install, path.join(other, "src")]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(wt, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }));
    const subst = (c: EvalCase): Record<string, unknown> => {
      const w = c.platform === "win32";
      const map: Record<string, string> = w
        ? { $WT: WIN.wt, $SCR: WIN.scr, $PARENT: "D:\\parent", $TMP: WIN.tmp, $AGENT: WIN.agent, $HOME: WIN.home, $OTHER: WIN.other, $INSTALL: "D:\\pi" }
        : { $WT: wt, $SCR: scr, $PARENT: parent, $TMP: dir("tmp"), $AGENT: agent, $HOME: home, $OTHER: other, $INSTALL: install };
      // `~` as a whole word or a path prefix is the home dir; $UNSET and $X stay literal unset variables on purpose
      const tilde = (s: string): string => s.replace(/(^|[\s"'=:])~(?=\/|\s|$|"|')/g, `$1${w ? WIN.home : home}`);
      const walk = (v: unknown): unknown => (typeof v === "string" ? tilde(Object.entries(map).reduce((s, [k, x]) => s.split(k).join(x), v)) : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
      return walk(c.input) as Record<string, unknown>;
    };
    const rootsOf = (c: EvalCase): GateRoots => {
      const w = c.platform === "win32";
      const child = c.kind === "child";
      return {
        worktree: w ? WIN.wt : wt, scratch: [w ? WIN.scr : scr], tmp: w ? [WIN.tmp] : [dir("tmp"), "/tmp"], scratchBase: w ? "D:\\tmp\\pi-foreman-scratch" : dir("tmp", "pi-foreman-scratch"),
        owned: [], install: [w ? "D:\\pi" : install], roundFlow: child ? [w ? "D:\\parent\\.workflow" : path.join(parent, ".workflow")] : [], handoffs: [],
        child, role: c.role, tmpAccess: true, agentDir: w ? WIN.agent : agent, ...(w ? { realpath: (p: string) => p } : {}),
      };
    };
    const envOf = (c: EvalCase): FloorEnv => {
      const w = c.platform === "win32";
      return {
        cwd: w ? WIN.wt : wt, home: w ? WIN.home : home, agentDir: w ? WIN.agent : agent, platform: w ? "win32" : process.platform, protectedBranches: ["trunk"],
        currentBranch: () => "round/41-x", remoteHead: () => "trunk", writeRoots: w ? [WIN.wt, WIN.scr, WIN.tmp] : [wt, scr, dir("tmp"), "/tmp"],
      };
    };
    const policy = loadPolicy({ pkgRoot, agentDir: agent, cwd: wt });
    const config = { providers: { live: { roles: { review: { model } } } }, gate: { reviewTimeoutMs: opts.timeoutMs ?? 60000 } };
    const cache = new GateCache();
    const answers: Answers = {};
    const latencies: number[] = [];
    const stats: LiveStats = { reviewCases: 0, modelCalls: 0, cacheHits: 0, invalid: 0, falseAllows: { import: [], log: [] }, unreachable: 0, agreement: { agree: 0, human: 0 }, latencyP50Ms: 0, latencyP95Ms: 0, inputTokens: 0, outputTokens: 0 };
    for (const c of cases) {
      const input = subst(c);
      const cwd = c.platform === "win32" ? WIN.wt : wt;
      if (gateDecide(c.tool, input, cwd, { env: () => envOf(c), roots: () => rootsOf(c), facts })) continue;
      const r = rootsOf(c);
      let called = 0;
      const wrapped: RegistryLike = {
        find: (p, m) => registry.find(p, m),
        complete: async (m, ctx, o) => {
          called++;
          const t0 = Date.now();
          try {
            const reply = await registry.complete(m, ctx, o);
            const usage = (reply as { usage?: { input?: number; output?: number } }).usage;
            stats.inputTokens += usage?.input ?? 0;
            stats.outputTokens += usage?.output ?? 0;
            return reply;
          } finally {
            latencies.push(Date.now() - t0);
          }
        },
      };
      const payload = typeof input.command === "string" ? input.command : `${c.tool} ${JSON.stringify(input)}`;
      const v = await gateReview(
        { surface: c.tool, tool: c.tool, role: c.role, kind: c.kind as never, cwd, worktree: r.worktree, owned: r.owned, branch: "round/41-x", head: "h1", mergeHead: null, remotes: ["origin"], ownerMessages: [], payload, ...(c.facts ? { facts: c.facts } : {}) },
        { policy, registry: wrapped, config, provider: "live", cache },
      );
      stats.reviewCases++;
      if (!called) {
        stats.cacheHits++;
        continue;
      }
      stats.modelCalls += called;
      if (v.kind === "unreachable") {
        // a timeout or provider error has no answer to replay; an invalid reply is recorded as such (the offline runner then asks)
        if (v.cause !== "invalid_verdict") {
          stats.unreachable++;
          continue;
        }
        stats.invalid++;
        answers[c.id] = { verdict: "invalid", entry: "" };
      } else {
        answers[c.id] = { verdict: v.kind, entry: v.entry };
      }
      if (v.kind === "allow" && c.expect !== "allow") stats.falseAllows[c.source].push(c.id);
      if (c.source === "import") {
        stats.agreement.human++;
        if (v.kind === c.expect) stats.agreement.agree++;
      }
    }
    stats.latencyP50Ms = percentile(latencies, 50);
    stats.latencyP95Ms = percentile(latencies, 95);
    return { answers, stats };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
