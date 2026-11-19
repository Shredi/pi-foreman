// `foreman rounds [--workspace here|KEY] [--branch B] [--pr N] [--since 30d] [--json]` (bin/foreman, .cmd, .ps1): the review rounds per change,
// counted from the findings store (reviewrounds.ts, docs/review.md#review-rounds). Read-only.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { get, loadMergedConfig } from "./config.ts";
import { piAgentDir } from "./env.ts";
import { resolvePython } from "./python.ts";
import { defaultSpawner } from "./spawn.ts";
import { parseSince, readStore, roundsOf } from "./reviewrounds.ts";
import type { RoundsFilter } from "./reviewrounds.ts";
import { workspaceKeyOf } from "./workspacekey.ts";

export const USAGE = "usage: foreman rounds [--workspace here|KEY] [--branch B] [--pr N] [--since 30d] [--json]";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RoundsDeps {
  agentDir: string;
  cwd: string;
  now(): number;
  /** `retro.workspaceKey` of the merged config for `cwd`; undefined when none or the config does not load. */
  workspaceOverride(): Promise<string | undefined>;
}

export function realDeps(env: NodeJS.ProcessEnv = process.env): RoundsDeps {
  const agentDir = piAgentDir(env, env.HOME ?? env.USERPROFILE ?? "");
  const cwd = process.cwd();
  return {
    agentDir,
    cwd,
    now: Date.now,
    workspaceOverride: async () => {
      try {
        const spawner = defaultSpawner;
        const py = await resolvePython({ configPath: null, envPath: env.PI_FOREMAN_PYTHON, platform: process.platform, spawner });
        const cfg = await loadMergedConfig({ python: py.ok ? py.info.executable : null, pkgRoot: PKG_ROOT, agentDir, projectDir: cwd, trusted: false, spawner });
        const v = get(cfg.config, "retro.workspaceKey");
        return typeof v === "string" && v.trim() ? v : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** The CLI: argv after `rounds`. Returns the exit code. */
export async function main(argv: string[], out: (s: string) => void, err: (s: string) => void, deps: () => RoundsDeps = realDeps): Promise<number> {
  const opts: { workspace?: string; branch?: string; pr?: number; since?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string | undefined => argv[++i];
    if (a === "--json") opts.json = true;
    else if (a === "--workspace" || a === "--branch" || a === "--since") {
      const v = val();
      if (!v) return usage(err);
      opts[a.slice(2) as "workspace" | "branch" | "since"] = v;
    } else if (a === "--pr") {
      const v = val();
      if (!v || !/^\d{1,10}$/.test(v) || Number(v) < 1) return usage(err);
      opts.pr = Number(v);
    } else return usage(err);
  }
  const d = deps();
  const filter: RoundsFilter = {};
  if (opts.since !== undefined) {
    const t = parseSince(opts.since, d.now());
    if (t === null) {
      err(`foreman rounds: bad --since ${opts.since} (use 7d, 12h, 2w or an ISO timestamp)\n`);
      return 2;
    }
    filter.since = t;
  }
  if (opts.workspace === "here") {
    try {
      filter.workspace = workspaceKeyOf(d.cwd, await d.workspaceOverride());
    } catch (e) {
      err(`foreman rounds: ${(e as Error).message}\n`);
      return 2;
    }
  } else if (opts.workspace !== undefined) filter.workspace = opts.workspace;
  if (opts.branch !== undefined) filter.branch = opts.branch;
  if (opts.pr !== undefined) filter.pr = opts.pr;
  const changes = roundsOf(readStore(d.agentDir), filter);
  if (opts.json) out(`${JSON.stringify(changes)}\n`);
  else if (changes.length === 0) out("no review rounds\n");
  else for (const c of changes) out(`${c.workspace} ${c.branch}: ${c.line}\n`);
  return 0;
}

function usage(err: (s: string) => void): number {
  err(`${USAGE}\n`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));
}
