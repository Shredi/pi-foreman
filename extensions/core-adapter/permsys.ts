// The permission-system package (@gotgenes/pi-permission-system, "PS") as the adapter sees it:
// where it is installed, the files it reads, and the drift checks for /foreman doctor.
// The installer owns <agentDir>/extensions/pi-permission-system/config.json (generated from
// config/permissions.baseline.json plus safety.permissions of L1 -> L3 -> L2); the user's own
// rules belong in foreman.json.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonical } from "./config.ts";
import type { Json } from "./config.ts";
import type { Spawner } from "./spawn.ts";

export const PS_PACKAGE = "@gotgenes/pi-permission-system";
export const PS_CHILD_ID = "pi-permission-system";

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

export const psGlobalConfigPath = (agentDir: string): string => path.join(agentDir, "extensions", "pi-permission-system", "config.json");
export const psProjectConfigPath = (cwd: string): string => path.join(cwd, ".pi", "extensions", "pi-permission-system", "config.json");

/** Entry file of a PS package directory (its `pi.extensions[0]`, default `src/index.ts`), if it exists. */
function entryOf(dir: string): string | null {
  const pj = readJson(path.join(dir, "package.json"));
  if (!isObj(pj) || pj.name !== PS_PACKAGE) return null;
  const ext = isObj(pj.pi) && Array.isArray(pj.pi.extensions) && typeof pj.pi.extensions[0] === "string" ? pj.pi.extensions[0] : "./src/index.ts";
  const file = path.resolve(dir, ext);
  try {
    return fs.statSync(file).isFile() ? fs.realpathSync(file) : null;
  } catch {
    return null;
  }
}

function localPackageDirs(settingsFile: string): string[] {
  const settings = readJson(settingsFile);
  const list = isObj(settings) && Array.isArray(settings.packages) ? settings.packages : [];
  const out: string[] = [];
  for (const e of list) {
    const src = typeof e === "string" ? e : isObj(e) && typeof e.source === "string" ? e.source : null;
    if (!src || /^(npm|git|https?|ssh):/.test(src) || src.startsWith("git@")) continue;
    out.push(path.resolve(path.dirname(settingsFile), src));
  }
  return out;
}

/**
 * Where PS is installed, as the entry file every child must load. Looks in: the agent dir's
 * npm install (`pi install npm:...`), the project's `.pi/npm`, a node_modules above the
 * pi-foreman package, and local-path package entries of the user and project settings.
 */
export function resolvePermissionSystem(input: { agentDir: string; cwd: string; pkgRoot: string }): string | null {
  const dirs = [
    path.join(input.agentDir, "npm", "node_modules", PS_PACKAGE),
    path.join(input.cwd, ".pi", "npm", "node_modules", PS_PACKAGE),
  ];
  for (let d = input.pkgRoot, prev = ""; d !== prev; prev = d, d = path.dirname(d)) dirs.push(path.join(d, "node_modules", PS_PACKAGE));
  dirs.push(...localPackageDirs(path.join(input.agentDir, "settings.json")), ...localPackageDirs(path.join(input.cwd, ".pi", "settings.json")));
  for (const dir of dirs) {
    const entry = entryOf(dir);
    if (entry) return entry;
  }
  return null;
}

export const sha256 = (v: unknown): string => crypto.createHash("sha256").update(canonical(v)).digest("hex");

export type PermFileState =
  | { state: "ok" }
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "stale"; detail: string }
  | { state: "edited"; detail: string };

/**
 * The generated global file against what the generator renders now (`wanted`) and the hash the
 * installer recorded in its managed state. `wanted` null = the generator could not run.
 */
export function permFileState(agentDir: string, wanted: Json | null): PermFileState {
  const file = psGlobalConfigPath(agentDir);
  if (!fs.existsSync(file)) return { state: "missing" };
  const cur = readJson(file);
  if (!isObj(cur)) return { state: "unreadable" };
  if (wanted && canonical(cur) === canonical(wanted)) return { state: "ok" };
  const managed = readJson(path.join(agentDir, "pi-foreman", "managed.json"));
  const recorded = isObj(managed) && isObj(managed.files) ? managed.files[file] : undefined;
  if (typeof recorded === "string" && recorded === sha256(cur)) return { state: "stale", detail: "foreman.json (or the baseline) changed since the installer wrote it" };
  return { state: "edited", detail: typeof recorded === "string" ? `hash ${sha256(cur).slice(0, 12)} differs from the recorded ${recorded.slice(0, 12)}` : "no hash recorded by the installer" };
}

/** `permissions_gen.py render` -> the PS config object, or null. */
export async function renderPermissions(input: { python: string | null; pkgRoot: string; agentDir: string; cwd: string; spawner: Spawner }): Promise<Json | null> {
  if (!input.python) return null;
  const args = ["-E", "-s", path.join(input.pkgRoot, "scripts", "permissions_gen.py"), "render", "--agent-dir", input.agentDir];
  const r = await input.spawner(input.python, args, { timeoutMs: 10_000, cwd: input.cwd });
  if (r.error || r.timedOut || r.code !== 0) return null;
  try {
    const data = JSON.parse(r.stdout) as Json;
    return isObj(data.config) ? data.config : null;
  } catch {
    return null;
  }
}
