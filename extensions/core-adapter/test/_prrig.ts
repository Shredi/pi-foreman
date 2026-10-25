// Test rig for PrDots with registration, batch polling and discovery on (prtrack.test.ts, prdots_track.test.ts).
import { PrDots } from "../prdots.ts";
import type { PrDotsDeps } from "../prdots.ts";
import type { PrOp } from "../gitpack.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import type { Timers } from "../prwatch.ts";

export const ran = (result: Record<string, unknown>): SafeOpOutcome => ({ kind: "ran", result: { ok: true, ...result } });
export const pre = (precondition: string): SafeOpOutcome => ({ kind: "precondition", precondition, message: "m" });
export const url = (repo: string, n: number, host = "github.com") => `https://${host}/${repo}/pull/${n}`;

export interface Call {
  op: PrOp;
  args: Record<string, unknown>;
  cwd?: string;
}

export function rig(opts: { branch?: string; enabled?: boolean; batch?: boolean; discover?: boolean; repoLookup?: boolean; watched?: () => number[]; interactions?: unknown; merged?: PrDotsDeps["merged"]; baseBranch?: string | null; quietBranch?: string; remotes?: string[] } = {}) {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const fake: Timers = { set: (fn, ms) => (timers.push({ fn, ms, live: true }), timers.length - 1), clear: (h) => void (typeof h === "number" && timers[h] && (timers[h].live = false)) };
  const calls: Call[] = [];
  const traces: Record<string, unknown>[] = [];
  const tracks: Record<string, unknown>[] = [];
  let clock = 1_000_000;
  const state = {
    branch: opts.branch ?? "feat",
    /** pr_repo answers by cwd; "*" is the default. */
    repos: { "*": { host: "github.com", repo: "acme/app" } } as Record<string, { host: string; repo: string } | null>,
    handle: (_c: Call): SafeOpOutcome | Promise<SafeOpOutcome> | undefined => undefined,
  };
  const d = new PrDots({
    enabled: () => opts.enabled ?? true,
    preflight: async () => undefined,
    branch: async () => state.branch,
    run: async (op, args, cwd) => {
      const c: Call = { op, args, cwd };
      calls.push(c);
      const custom = state.handle(c);
      if (custom) return custom;
      if (op === "pr_repo") {
        const at = cwd ?? "/w";
        const r = at in state.repos ? state.repos[at] : state.repos["*"];
        return r ? ran({ host: r.host, repo: r.repo, url: `https://${r.host}/${r.repo}` }) : pre("pr_not_found");
      }
      if (op === "pr_status" && args.number === undefined) return pre("pr_not_found");
      if (op === "pr_find") return ran({ prs: [] });
      if (op === "pr_batch") return ran({ prs: [], errors: [] });
      return pre("pr_not_found");
    },
    watched: opts.watched ?? (() => []),
    watchChecks: () => null,
    intervalMs: () => 60_000,
    trace: (r) => void traces.push(r),
    traceTrack: (r) => void tracks.push(r),
    timers: fake,
    cwd: () => "/w",
    repoLookup: opts.repoLookup ?? true,
    discover: opts.discover ?? true,
    batch: opts.batch ?? true,
    now: () => clock,
    interactions: () => opts.interactions,
    remoteHosts: async () => opts.remotes ?? ["github.com"],
    quietBranch: async () => opts.quietBranch ?? "",
    baseBranch: () => (opts.baseBranch === undefined ? null : opts.baseBranch),
    merged: opts.merged,
  });
  const live = () => [...timers].reverse().find((t) => t.live);
  const fire = async () => {
    const t = live();
    if (!t) throw new Error("no live timer");
    t.live = false;
    t.fn();
    await new Promise((r) => setImmediate(r));
  };
  return { d, state, calls, traces, tracks, fire, live, advance: (ms: number) => void (clock += ms), callsOf: (op: PrOp) => calls.filter((c) => c.op === op) };
}
