import * as fs from "node:fs";
import * as path from "node:path";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** True when any provider maps a role to a model or sets a review model. */
export function hasModelConfig(config: unknown): boolean {
  const providers = isObj(config) ? config.providers : undefined;
  if (!isObj(providers)) return false;
  for (const p of Object.values(providers)) {
    if (!isObj(p)) continue;
    if (isObj(p.review) && typeof p.review.model === "string" && p.review.model) return true;
    if (isObj(p.roles)) for (const r of Object.values(p.roles)) if (isObj(r) && typeof r.model === "string" && r.model) return true;
  }
  return false;
}

/** Basenames of the package's config/presets/*.json, sorted. */
export function presetNames(pkgRoot: string): string[] {
  try {
    return fs.readdirSync(path.join(pkgRoot, "config", "presets")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

/** The first-run notice, or null. Interactive top-level sessions with no model configured only; `quiet: true` silences it. */
export function firstRunNotice(opts: { mode: string | undefined; isChild: boolean; config: unknown; presets: string[] }): string | null {
  if (opts.mode !== "tui" || opts.isChild) return null;
  if (isObj(opts.config) && opts.config.quiet === true) return null;
  if (hasModelConfig(opts.config)) return null;
  const list = opts.presets.length ? opts.presets.join(", ") : "none found";
  return `pi-foreman: no role models are configured, so children run on Pi's default model. Available presets: ${list}. Apply one with: foreman config apply-preset <name> [--foreman <model id>]. Set "quiet": true in foreman.json to hide this notice.`;
}

/** Each preset's name and the provider prefix of its foreman model (null when it has none). */
export function presetProviders(pkgRoot: string): { name: string; provider: string | null }[] {
  return presetNames(pkgRoot).map((name) => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "config", "presets", `${name}.json`), "utf8")) as unknown;
      const providers = isObj(cfg) && isObj(cfg.providers) ? Object.values(cfg.providers) : [];
      for (const p of providers) {
        const model = isObj(p) && isObj(p.roles) && isObj(p.roles.foreman) ? p.roles.foreman.model : undefined;
        if (typeof model === "string" && model.includes("/")) return { name, provider: model.slice(0, model.indexOf("/")) };
      }
    } catch {
      // unreadable preset: no provider
    }
    return { name, provider: null };
  });
}

/**
 * Warning for a session whose model provider has no `providers.<id>` map, or null. Top-level sessions in tui or
 * rpc mode only. Not silenced by `quiet`: role launches fail without the map.
 */
export function providerGapNotice(opts: { provider: string | undefined; config: unknown; presets: { name: string; provider: string | null }[]; mode: string | undefined; isChild: boolean }): string | null {
  if (!opts.provider || opts.isChild || (opts.mode !== "tui" && opts.mode !== "rpc")) return null;
  const providers = isObj(opts.config) ? opts.config.providers : undefined;
  if (isObj(providers) && providers[opts.provider] !== undefined) return null;
  const fit = opts.presets.filter((p) => p.provider === opts.provider).map((p) => p.name);
  const head = `pi-foreman: no role map for provider ${opts.provider}; role launches will fail.`;
  return fit.length
    ? `${head} Fitting presets: ${fit.join(", ")} (foreman config apply-preset <name>)`
    : `${head} Add providers.${opts.provider} to foreman.json (see docs/roles.md).`;
}
