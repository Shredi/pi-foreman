// Dormant features: mirrors scripts/foreman_docs.py `dormant` (switch unsatisfied in the merged config).
import * as fs from "node:fs";
import * as path from "node:path";

export interface FeatureSwitch { key: string; on: string }
export interface FeatureEntry { id: string; switch?: FeatureSwitch | null }
export interface FeatureMap { features: FeatureEntry[] }

function lookup(cfg: unknown, keys: string[]): unknown[] {
  let nodes: unknown[] = [cfg];
  for (const k of keys) {
    const next: unknown[] = [];
    for (const n of nodes) {
      if (n === null || typeof n !== "object" || Array.isArray(n)) continue;
      const o = n as Record<string, unknown>;
      if (k === "*") next.push(...Object.values(o));
      else if (Object.prototype.hasOwnProperty.call(o, k)) next.push(o[k]);
    }
    nodes = next;
  }
  return nodes;
}

function predicate(on: string, v: unknown): boolean {
  if (on === "true") return v === true;
  if (on === "nonempty") {
    if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
    return v !== null && typeof v === "object" && Object.keys(v as object).length > 0;
  }
  if (on === "nonnull") return v !== null && v !== undefined;
  throw new Error(`unknown switch predicate ${JSON.stringify(on)}`);
}

/** Ids (features.json order) of features with a switch that no config value satisfies. */
export function dormantFeatures(map: FeatureMap, config: unknown): string[] {
  return map.features
    .filter((f) => f.switch && !lookup(config, f.switch.key.split(".")).some((v) => predicate(f.switch!.on, v)))
    .map((f) => f.id);
}

/** The INFO/WARN doctor line for config/features.json under `pkgRoot`; never throws. */
export function dormantDoctorLine(pkgRoot: string, config: unknown): string {
  try {
    const map = JSON.parse(fs.readFileSync(path.join(pkgRoot, "config", "features.json"), "utf8")) as FeatureMap;
    const ids = dormantFeatures(map, config);
    return `INFO dormant: ${ids.length ? ids.join(", ") : "none"}`;
  } catch (e) {
    return `WARN dormant features not computed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
