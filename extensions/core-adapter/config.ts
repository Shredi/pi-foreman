// Merged config through the config CLI (`scripts/foreman_config.py`), with a fail-closed
// fallback to the L1 defaults file when the CLI cannot run.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Spawner } from "./spawn.ts";

export type Json = Record<string, unknown>;

export interface MergedConfig {
  config: Json;
  warnings: string[];
  errors: string[];
  safetyFallback: boolean;
  roles: Record<string, Json>;
  /** "cli" = foreman_config.py answered; "defaults" = L1 file read directly. */
  source: "cli" | "defaults";
  /** safety.permissions after L1 -> L3 -> L2, before the project and session layers (cli only). */
  basePermissions?: Json;
}

const CONFIG_TIMEOUT_MS = 10_000;

const BUILTIN_DEFAULTS: Json = {
  ceremony: { default: "standard", heavySignals: [], heavyFileCount: 8 },
  safety: { requiredChildExtensions: [] },
  python: { path: null },
};

function readJsonFile(file: string): Json | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Json) : null;
  } catch {
    return null;
  }
}

export function readDefaults(pkgRoot: string): Json {
  return readJsonFile(path.join(pkgRoot, "config", "foreman.defaults.json")) ?? BUILTIN_DEFAULTS;
}

export function get(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const k of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Json)[k];
  }
  return cur;
}

/**
 * python.path before the CLI can run (the CLI itself needs Python): last wins over
 * L1 defaults, L2 `<agent dir>/foreman.json` and, when trusted, `.pi/foreman.json`.
 */
export function pythonPathHint(pkgRoot: string, agentDir: string, projectDir: string, trusted: boolean): string | null {
  let value: unknown = get(readDefaults(pkgRoot), "python.path");
  const l2 = readJsonFile(path.join(agentDir, "foreman.json"));
  if (l2 && get(l2, "python.path") !== undefined) value = get(l2, "python.path");
  if (trusted) {
    const proj = readJsonFile(path.join(projectDir, ".pi", "foreman.json"));
    if (proj && get(proj, "python.path") !== undefined) value = get(proj, "python.path");
  }
  return typeof value === "string" && value.trim() ? value : null;
}

export interface LoadInput {
  python: string | null;
  pkgRoot: string;
  provider?: string;
  agentDir: string;
  projectDir: string;
  trusted: boolean;
  spawner: Spawner;
  env?: Record<string, string>;
}

export function configCliArgs(input: LoadInput): string[] {
  const args = ["-E", "-s", path.join(input.pkgRoot, "scripts", "foreman_config.py"), "merged", "--json"];
  if (input.provider) args.push("--provider", input.provider);
  args.push("--agent-dir", input.agentDir, "--project-dir", input.projectDir);
  if (input.trusted) args.push("--trusted-project");
  return args;
}

function fallback(pkgRoot: string, why: string): MergedConfig {
  return {
    config: readDefaults(pkgRoot),
    warnings: [],
    errors: [`pi-foreman: config CLI failed (${why}); using the built-in L1 defaults.`],
    safetyFallback: true,
    roles: {},
    source: "defaults",
  };
}

export async function loadMergedConfig(input: LoadInput): Promise<MergedConfig> {
  if (!input.python) return fallback(input.pkgRoot, "no Python ≥ 3.9");
  const r = await input.spawner(input.python, configCliArgs(input), { timeoutMs: CONFIG_TIMEOUT_MS, env: input.env, cwd: input.projectDir });
  if (r.error) return fallback(input.pkgRoot, r.error.message);
  if (r.timedOut) return fallback(input.pkgRoot, "timed out");
  let data: Json;
  try {
    data = JSON.parse(r.stdout) as Json;
  } catch {
    const err = r.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? "";
    return fallback(input.pkgRoot, `exit ${r.code}, unreadable output${err ? `: ${err.slice(0, 200)}` : ""}`);
  }
  if (!data || typeof data.config !== "object" || data.config === null) return fallback(input.pkgRoot, "no config in output");
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    config: data.config as Json,
    warnings: strs(data.warnings),
    errors: strs(data.errors),
    safetyFallback: data.safetyFallback === true,
    roles: data.roles && typeof data.roles === "object" ? (data.roles as Record<string, Json>) : {},
    source: "cli",
    basePermissions: data.basePermissions && typeof data.basePermissions === "object" ? (data.basePermissions as Json) : undefined,
  };
}

/** `generate-subagents --json` -> `{subagents: {...}}`, or null. */
export async function generateSubagents(input: { python: string | null; pkgRoot: string; agentDir: string; projectDir: string; trusted: boolean; spawner: Spawner; env?: Record<string, string> }): Promise<Json | null> {
  if (!input.python) return null;
  const args = ["-E", "-s", path.join(input.pkgRoot, "scripts", "foreman_config.py"), "generate-subagents", "--json", "--agent-dir", input.agentDir, "--project-dir", input.projectDir];
  if (input.trusted) args.push("--trusted-project");
  const r = await input.spawner(input.python, args, { timeoutMs: CONFIG_TIMEOUT_MS, env: input.env, cwd: input.projectDir });
  if (r.error || r.timedOut || r.code !== 0) return null;
  try {
    const data = JSON.parse(r.stdout) as Json;
    return data && typeof data.subagents === "object" ? (data.subagents as Json) : null;
  } catch {
    return null;
  }
}

/** Stable stringify (sorted keys) for comparing generated blocks. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Json;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
