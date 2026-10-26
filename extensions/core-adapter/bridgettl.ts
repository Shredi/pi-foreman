// Bridge prompt-cache TTL: sets Claude Code's CLAUDE_CODE_PROMPT_CACHE_TTL for claude-bridge turns, 1h for the
// foreman and 5m for subagents by default. The bridge spawns its SDK child with `{...process.env}` at query time
// (like CLAUDE_CONFIG_DIR in bridgeiso.ts), so setting it here is enough.
// Mirrors fix_bridge_ttl / derived_bridge_ttl in scripts/foreman_config.py.
import { BRIDGE_PROVIDER } from "./bridgeiso.ts";

export const BRIDGE_TTL_ENV = "CLAUDE_CODE_PROMPT_CACHE_TTL";

export type BridgeTtlValue = "1h" | "5m" | "inherit";
export interface BridgeTtlSetting {
  main: BridgeTtlValue;
  subagent: BridgeTtlValue;
}

const VALUES: readonly string[] = ["1h", "5m", "inherit"];
export const BRIDGE_TTL_DEFAULTS: BridgeTtlSetting = { main: "1h", subagent: "5m" };
const SECONDS: Record<string, number> = { "1h": 3600, "5m": 300 };

type Env = Record<string, string | undefined>;

/** `bridge.promptCacheTtl` of a merged config (or the value itself); a missing or invalid field takes its default. */
export function bridgeTtlSetting(value: unknown): BridgeTtlSetting {
  const v = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const pick = (x: unknown, d: BridgeTtlValue): BridgeTtlValue => (typeof x === "string" && VALUES.includes(x) ? (x as BridgeTtlValue) : d);
  return { main: pick(v.main, BRIDGE_TTL_DEFAULTS.main), subagent: pick(v.subagent, BRIDGE_TTL_DEFAULTS.subagent) };
}

export function bridgeTtlKindValue(setting: BridgeTtlSetting, isChild: boolean): BridgeTtlValue {
  return isChild ? setting.subagent : setting.main;
}

/** FORCE_PROMPT_CACHING_5M counts as set unless empty or 0/false/no/off. */
export function forced5m(env: Env): boolean {
  const v = env.FORCE_PROMPT_CACHING_5M;
  return v !== undefined && !["", "0", "false", "no", "off"].includes(v.trim().toLowerCase());
}

/** TTL in seconds Claude Code gets on the bridge for this process kind; null when forced to 5m by env or set to "inherit". */
export function derivedBridgeTtlS(setting: BridgeTtlSetting, isChild: boolean, env: Env): number | null {
  if (forced5m(env)) return null;
  return SECONDS[bridgeTtlKindValue(setting, isChild)] ?? null;
}

export class BridgeCacheTtl {
  private saved: { value: string | undefined } | null = null;

  /** Sets CLAUDE_CODE_PROMPT_CACHE_TTL on the bridge, restores the prior value on any other provider; "inherit" does nothing. */
  apply(env: Env, setting: BridgeTtlSetting, provider: string | undefined, isChild: boolean): void {
    if (provider !== BRIDGE_PROVIDER) {
      this.restore(env);
      return;
    }
    const kind = bridgeTtlKindValue(setting, isChild);
    if (kind === "inherit") return;
    if (!this.saved) this.saved = { value: env[BRIDGE_TTL_ENV] };
    env[BRIDGE_TTL_ENV] = kind;
  }

  restore(env: Env): void {
    if (!this.saved) return;
    if (this.saved.value === undefined) delete env[BRIDGE_TTL_ENV];
    else env[BRIDGE_TTL_ENV] = this.saved.value;
    this.saved = null;
  }
}
