// Pre-bash hook extension point (R41 item 20): `safety.preBash.hooks`, an ordered list run before every bash tool call, in the order given.
// A hook entry is a module (a path ending .mjs, .js or .cjs; absolute, or relative to the agent dir) whose default export (or `preBash`) is
// `(input) => void | { block: true, reason?: string }` (sync or async), or a command (argv split on whitespace, no shell) that gets the same
// input as JSON on stdin. A hook can only tighten: it blocks or it passes, it never allows. Module: return `{ block: true }`. Command: exit 2 blocks,
// stderr is the reason, exit 0 passes. A hook error (a throw, a rejected promise, any other exit code, a start failure, the timeout) is traced and
// ignored (fail-open, the default); with `safety.preBash.strict: true` it blocks the call. An explicit block always blocks. The project layer cannot
// set `safety.preBash` (foreman_config.py drops an unknown project safety key), because a hook runs code.
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Spawner } from "./spawn.ts";

export const PREBASH_TIMEOUT_MS = 5000;

export interface PreBashInput {
  command: string;
  cwd: string;
  tool: string;
  session: string;
  role: string;
}

export interface PreBashConfig {
  hooks: string[];
  strict: boolean;
}

/** `safety.preBash` as a config: hooks = the non-empty strings of the list, strict only for an explicit true. */
export function preBashConfigOf(v: unknown): PreBashConfig {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as { hooks?: unknown; strict?: unknown }) : {};
  return { hooks: Array.isArray(o.hooks) ? o.hooks.filter((h): h is string => typeof h === "string" && h.trim() !== "").map((h) => h.trim()) : [], strict: o.strict === true };
}

export interface PreBashResult {
  /** The refusal text when a hook blocked, or when a hook errored in strict mode. */
  blocked?: string;
  /** Hook errors, one per failed hook (traced by the caller; ignored unless strict). */
  errors: { hook: string; error: string }[];
}

export interface PreBashDeps {
  spawner: Spawner;
  agentDir: string;
  timeoutMs?: number;
  /** Module loader (tests); default dynamic import of a file URL. */
  load?: (file: string) => Promise<Record<string, unknown>>;
}

const MODULE_HOOK = /\.(?:mjs|cjs|js)$/i;

const defer = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

type Outcome = { pass: true } | { block: string } | { error: string };

async function runOne(hook: string, input: PreBashInput, d: PreBashDeps): Promise<Outcome> {
  const ms = d.timeoutMs ?? PREBASH_TIMEOUT_MS;
  try {
    if (MODULE_HOOK.test(hook)) {
      const file = path.isAbsolute(hook) ? hook : path.join(d.agentDir, hook);
      const mod = await defer((d.load ?? ((f) => import(pathToFileURL(f).href) as Promise<Record<string, unknown>>))(file), ms);
      const fn = typeof mod.default === "function" ? mod.default : mod.preBash;
      if (typeof fn !== "function") return { error: "the module exports no default or preBash function" };
      const r = (await defer(Promise.resolve((fn as (i: PreBashInput) => unknown)(input)), ms)) as { block?: unknown; reason?: unknown } | void;
      if (r && typeof r === "object" && r.block === true) return { block: typeof r.reason === "string" && r.reason ? r.reason : "blocked by the hook" };
      return { pass: true };
    }
    const argv = hook.split(/\s+/).filter(Boolean);
    const r = await d.spawner(argv[0], argv.slice(1), { timeoutMs: ms, cwd: input.cwd, input: JSON.stringify(input) });
    if (r.error) return { error: r.error.message };
    if (r.timedOut) return { error: `timed out after ${ms} ms` };
    if (r.code === 0) return { pass: true };
    if (r.code === 2) return { block: r.stderr.trim().split(/\r?\n/).slice(-1)[0]?.slice(0, 300) || "blocked by the hook" };
    return { error: `exit ${r.code}` };
  } catch (err) {
    return { error: (err as Error).message || String(err) };
  }
}

/** Run the hooks in order; the first block stops the run. A hook error is collected, and blocks only in strict mode. */
export async function runPreBashHooks(cfg: PreBashConfig, input: PreBashInput, d: PreBashDeps): Promise<PreBashResult> {
  const errors: PreBashResult["errors"] = [];
  for (const hook of cfg.hooks) {
    const o = await runOne(hook, input, d);
    if ("block" in o) return { blocked: `pi-foreman: blocked by the pre-bash hook ${hook}: ${o.block}`, errors };
    if ("error" in o) {
      errors.push({ hook, error: o.error });
      if (cfg.strict) return { blocked: `pi-foreman: the pre-bash hook ${hook} failed (${o.error}) and safety.preBash.strict is on, so the command is blocked. Fix or remove the hook.`, errors };
    }
  }
  return { errors };
}
