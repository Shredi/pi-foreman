// The permission baseline file (config/permissions.baseline.json) as typed lists.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Json } from "./config.ts";

export interface Baseline {
  bash: { deny: string[]; ask: string[]; allow?: string[] };
  paths: { deny: string[]; except: string[] };
  protect: { deny: string[]; ask: string[]; childDeny: string[]; writeAsk: string[]; writeAskSelfHost?: string[]; removeAsk?: string[] };
  externalDirectory?: { probe?: string[] };
}

export const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
export const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

export function readBaseline(pkgRoot: string): Baseline | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pkgRoot, "config", "permissions.baseline.json"), "utf8")) as Json;
    const bash = obj(raw.bash);
    const paths = obj(raw.paths);
    const pr = obj(raw.protect);
    return {
      bash: { deny: strs(bash.deny), ask: strs(bash.ask), allow: strs(bash.allow) },
      paths: { deny: strs(paths.deny), except: strs(paths.except) },
      protect: { deny: strs(pr.deny), ask: strs(pr.ask), childDeny: strs(pr.childDeny), writeAsk: strs(pr.writeAsk), writeAskSelfHost: strs(pr.writeAskSelfHost), removeAsk: strs(pr.removeAsk) },
      externalDirectory: { probe: strs(obj(raw.externalDirectory).probe) },
    };
  } catch {
    return null;
  }
}
