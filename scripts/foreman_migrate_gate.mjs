// Config migration to the tool gate (r41, ledger item 12), called by `foreman setup`.
// Maps the user's foreman.json keys of the removed permission package to gate.* keys (one printed line per key), writes the
// backup (foreman.json.pre-gate and the package's rendered config) before any change, then removes the rendered config.
// The doctor shares the leftover texts below (`gateLeftovers`).
import * as fs from "node:fs";
import * as path from "node:path";

export const REMOVED_REASON = "the permission package is gone; the gate decides";
const CHILD_REASON = "the gate itself denies a child or headless ask with the allowed forms";
const PKG = "@gotgenes/pi-permission-system";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const toJson = (v) => `${JSON.stringify(v, null, 2)}\n`;

export const migrationDir = (agentDir) => path.join(agentDir, "pi-foreman", "state", "migration");
export const renderedConfigPath = (agentDir) => path.join(agentDir, "extensions", "pi-permission-system", "config.json");
export const packageInstallPath = (agentDir) => path.join(agentDir, "npm", "node_modules", ...PKG.split("/"));

/** The one text for a key the gate migration removes or moves; setup and the doctor print it. */
export const removedKeyText = (key, reason = REMOVED_REASON) => `${key}: removed (${reason})`;
export const mappedKeyText = (from, to) => `${from}: moved to ${to}`;
export const renderedConfigText = (file) => `rendered permission config ${file}: removed (${REMOVED_REASON})`;
export const packageInstallText = (dir) => `permission package install ${dir}: remove it (${REMOVED_REASON})`;

const get = (o, parts) => parts.reduce((a, k) => (isObj(a) ? a[k] : undefined), o);
const has = (o, parts) => get(o, parts) !== undefined;
function del(o, parts) {
  const parent = get(o, parts.slice(0, -1));
  if (isObj(parent)) delete parent[parts[parts.length - 1]];
}
function set(o, parts, v) {
  let cur = o;
  for (const k of parts.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = v;
}
function prune(o, parts) {
  for (let n = parts.length; n > 0; n--) {
    const v = get(o, parts.slice(0, n));
    if (isObj(v) && Object.keys(v).length === 0) del(o, parts.slice(0, n));
    else break;
  }
}
/** Leaf key paths (arrays and scalars are leaves) below `parts`. */
function leaves(o, parts) {
  const v = get(o, parts);
  if (!isObj(v) || Object.keys(v).length === 0) return [parts];
  return Object.keys(v).flatMap((k) => leaves(o, [...parts, k]));
}

/** Plan the key changes: [{ parts, text, run(config) }] in a stable order. */
function planKeys(config) {
  const out = [];
  const drop = (parts, reason) => out.push({ parts, text: removedKeyText(parts.join("."), reason), run: (c) => del(c, parts) });
  const move = (parts, to) => out.push({ parts, text: mappedKeyText(parts.join("."), to.join(".")), run: (c) => { set(c, to, get(c, parts)); del(c, parts); } });
  for (const k of ["headless", "childDefer", "fallback"]) if (has(config, ["review", k])) drop(["review", k], CHILD_REASON);

  const providers = get(config, ["providers"]);
  for (const p of isObj(providers) ? Object.keys(providers) : []) {
    const rev = get(config, ["providers", p, "review"]);
    if (!isObj(rev)) continue;
    for (const k of Object.keys(rev)) {
      const parts = ["providers", p, "review", k];
      const target = k === "model" ? ["providers", p, "roles", "review", "model"] : k === "timeoutMs" ? ["gate", "reviewTimeoutMs"] : null;
      if (target && !has(config, target)) move(parts, target);
      else if (target) drop(parts, `${target.join(".")} is already set`);
      else drop(parts, `no gate counterpart; the review rung is providers.${p}.roles.review.model`);
    }
  }

  if (has(config, ["safety", "permissions"])) {
    for (const parts of leaves(config, ["safety", "permissions"])) {
      if (parts.join(".") === "safety.permissions.autoReview.rulesFile" && !has(config, ["gate", "policy", "userFile"])) move(parts, ["gate", "policy", "userFile"]);
      else drop(parts, REMOVED_REASON);
    }
  }
  return out;
}

/**
 * Migrate the user's foreman.json and the rendered permission config.
 * @returns {{lines: string[], changed: boolean, backupDir: string|null}} backupDir is set when something changed.
 */
export function migrateGateConfig({ agentDir, configPath, log = () => {}, dryRun = false }) {
  const lines = [];
  const say = (l) => { lines.push(l); log(l); };
  const rendered = renderedConfigPath(agentDir);
  const dir = migrationDir(agentDir);

  let text = null;
  let config = null;
  try { text = fs.readFileSync(configPath, "utf8"); config = JSON.parse(text); } catch { config = null; }
  const steps = isObj(config) ? planKeys(config) : [];
  const hasRendered = fs.existsSync(rendered);
  if (steps.length === 0 && !hasRendered) return { lines, changed: false, backupDir: null };

  const w = dryRun ? "would " : "";
  const pre = path.join(dir, "foreman.json.pre-gate");
  const cp = path.join(dir, "permission-system-config.json");
  if (steps.length > 0) say(`gate migration: ${w}write ${pre} before changing ${configPath}`);
  if (hasRendered) say(`gate migration: ${w}copy ${rendered} to ${cp} before removing it`);
  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true });
    if (steps.length > 0 && !fs.existsSync(pre)) fs.writeFileSync(pre, text);
    if (hasRendered && !fs.existsSync(cp)) fs.copyFileSync(rendered, cp);
  }
  for (const s of steps) say(`gate migration: ${w}${s.text}`);
  if (hasRendered) say(`gate migration: ${w}${renderedConfigText(rendered)}`);
  if (!dryRun) {
    if (steps.length > 0) {
      for (const s of steps) { s.run(config); prune(config, s.parts.slice(0, -1)); }
      fs.writeFileSync(configPath, toJson(config));
    }
    if (hasRendered) fs.rmSync(rendered, { force: true });
  }
  say(`gate migration: to go back, install the previous pi-foreman release, copy ${pre} over ${configPath}` +
    (hasRendered ? ` and ${cp} back to ${rendered}` : "") +
    ". The previous release rejects gate.* keys, so the backup copy is the way back.");
  return { lines, changed: true, backupDir: dir };
}

/** Doctor view: the leftover texts (same wording as setup prints); empty when the migration is complete. */
export function gateLeftovers({ agentDir, config }) {
  const out = [];
  if (isObj(config)) {
    for (const s of planKeys(config)) if (s.parts[0] === "safety" || s.parts[0] === "review") out.push(s.text);
  }
  if (fs.existsSync(renderedConfigPath(agentDir))) out.push(renderedConfigText(renderedConfigPath(agentDir)));
  if (fs.existsSync(packageInstallPath(agentDir))) out.push(packageInstallText(packageInstallPath(agentDir)));
  return out;
}
