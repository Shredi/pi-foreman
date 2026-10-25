// Bridge project-config trust (R41 item 19): the owner's record that the project's `.pi/claude-bridge.json` may run in claude-bridge turns.
// The record lives in the user layer, `<agentDir>/pi-foreman/state/bridge-trust.json` ({ version: 1, projects: { <real project dir>: <sha256 of the
// file bytes> } }). It is silent while the hash matches, and a changed file is untrusted again. Only the `/foreman trust bridge` slash command
// writes it, behind a confirm dialog that no model verdict ever answers; there is no CLI subcommand and the file is a policy floor (never a tool write).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_BRIDGE_CONFIG } from "./bridgeiso.ts";

export const BRIDGE_TRUST_FILE = "bridge-trust.json";
export const bridgeTrustPath = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", BRIDGE_TRUST_FILE);

const realOf = (d: string): string => {
  try {
    return fs.realpathSync.native(d);
  } catch {
    return path.resolve(d);
  }
};

/** sha256 of the project's `.pi/claude-bridge.json` bytes, or null when the file is absent or unreadable. */
export function bridgeConfigHash(cwd: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, ...PROJECT_BRIDGE_CONFIG.split("/")))).digest("hex");
  } catch {
    return null;
  }
}

function readRecord(agentDir: string): Record<string, string> {
  try {
    const v = JSON.parse(fs.readFileSync(bridgeTrustPath(agentDir), "utf8")) as { version?: unknown; projects?: unknown };
    if (!v || v.version !== 1 || !v.projects || typeof v.projects !== "object" || Array.isArray(v.projects)) return {};
    return Object.fromEntries(Object.entries(v.projects as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** True when the record holds the project's current config hash (no file, no record or another hash = false). */
export function bridgeTrusted(agentDir: string, cwd: string): boolean {
  const hash = bridgeConfigHash(cwd);
  return hash !== null && readRecord(agentDir)[realOf(cwd)] === hash;
}

/** Write the record for the project's current config (temp file + rename). Returns the hash, or null when there is no config or the write failed. */
export function writeBridgeTrust(agentDir: string, cwd: string): string | null {
  const hash = bridgeConfigHash(cwd);
  if (hash === null) return null;
  const file = bridgeTrustPath(agentDir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects: { ...readRecord(agentDir), [realOf(cwd)]: hash } }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return hash;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    return null;
  }
}

export interface TrustUi {
  hasUI: boolean;
  mode: string;
  confirm(title: string, message: string): Promise<boolean>;
}

/**
 * `/foreman trust bridge`: show what the project's config sets and its hash, ask the owner, write the record on yes. The dialog is the owner's
 * alone: no auto review, no model answer. Returns the text to show.
 */
export async function trustBridgeCommand(agentDir: string, cwd: string, risks: readonly string[], ui: TrustUi): Promise<string> {
  const hash = bridgeConfigHash(cwd);
  if (hash === null) return `pi-foreman: no ${PROJECT_BRIDGE_CONFIG} in ${cwd}; nothing to trust.`;
  if (bridgeTrusted(agentDir, cwd)) return `pi-foreman: ${PROJECT_BRIDGE_CONFIG} is already trusted (sha256 ${hash.slice(0, 12)}).`;
  if (!ui.hasUI || (ui.mode !== "tui" && ui.mode !== "rpc")) return "pi-foreman: /foreman trust bridge needs an interactive session (a confirm dialog); nothing was written.";
  let ok = false;
  try {
    ok = await ui.confirm("pi-foreman: trust the project's claude-bridge config?", `${PROJECT_BRIDGE_CONFIG} (sha256 ${hash.slice(0, 12)}) makes the bridge run what this project chose:\n${risks.length ? risks.join("\n") : "(no risky keys)"}\nTrust it until the file changes?`);
  } catch {
    ok = false;
  }
  if (!ok) return "pi-foreman: not trusted; nothing was written.";
  return writeBridgeTrust(agentDir, cwd) ? `pi-foreman: trusted ${PROJECT_BRIDGE_CONFIG} (sha256 ${hash.slice(0, 12)}) until it changes.` : "pi-foreman: could not write the trust record; nothing is trusted.";
}
