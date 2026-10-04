// Bridge isolation: keeps the host's Claude Code config (settings, hooks, plugins, CLAUDE.md)
// out of claude-bridge turns by pointing CLAUDE_CONFIG_DIR at an empty folder. The bridge
// spawns its SDK child with `{...process.env}` at query time, so setting it here is enough.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const BRIDGE_PROVIDER = "claude-bridge";
/** Entries that make the folder a non-empty Claude Code config. */
export const FORBIDDEN_ENTRIES = ["settings.json", "settings.local.json", "plugins", "hooks", "CLAUDE.md", "agents", "skills", "commands"];
/** Files Claude Code fetches from the account's cloud settings into the config folder (not host config). */
export const CLOUD_ENTRIES = ["remote-settings.json", "policy-limits.json"];

type Env = Record<string, string | undefined>;

/** `true`/`false` as configured; "auto" (or anything else) = on when the provider is the bridge. */
export function isolationOn(setting: unknown, provider: string | undefined): boolean {
  if (setting === true) return true;
  if (setting === false) return false;
  return provider === BRIDGE_PROVIDER;
}

export function isolationDir(agentDir: string): string {
  return path.join(agentDir, "pi-foreman", "claude-config");
}

export class BridgeIsolation {
  private saved: { value: string | undefined } | null = null;

  /** Sets or restores CLAUDE_CONFIG_DIR. Returns the folder when isolation is active. */
  apply(env: Env, agentDir: string, setting: unknown, provider: string | undefined): string | null {
    if (isolationOn(setting, provider)) {
      const dir = isolationDir(agentDir);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // not supported on this platform
      }
      if (!this.saved) this.saved = { value: env.CLAUDE_CONFIG_DIR };
      env.CLAUDE_CONFIG_DIR = dir;
      return dir;
    }
    this.restore(env);
    return null;
  }

  restore(env: Env): void {
    if (!this.saved) return;
    if (this.saved.value === undefined) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = this.saved.value;
    this.saved = null;
  }
}

/** Claude Code's macOS keychain service for a non-default config dir. */
export function keychainService(dir: string): string {
  return `Claude Code-credentials-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").substring(0, 8)}`;
}

export type KeychainProbe = (service: string) => boolean;

/** Presence only: `security find-generic-password -s` without -w/-g prints no secret. */
export const macKeychainProbe: KeychainProbe = (service) => {
  const r = spawnSync("security", ["find-generic-password", "-s", service], { stdio: "ignore", timeout: 5000 });
  return r.status === 0;
};

export interface IsoDoctorInput {
  dir: string;
  env: Env;
  platform: string;
  keychain?: KeychainProbe;
}

/** Doctor lines for an active isolation. Never prints a credential value. */
export function isolationDoctor(input: IsoDoctorInput): string[] {
  const out: string[] = [];
  const present = FORBIDDEN_ENTRIES.filter((e) => fs.existsSync(path.join(input.dir, e)));
  if (present.length) out.push(`FAIL bridge isolation folder ${input.dir} holds host config (${present.join(", ")}) — fix: remove those entries; the folder must hold only login data.`);
  else out.push(`OK   bridge isolation folder ${input.dir} holds no settings, hooks, plugins, CLAUDE.md, agents, skills or commands`);
  const cloud = CLOUD_ENTRIES.filter((e) => fs.existsSync(path.join(input.dir, e)));
  if (cloud.length) out.push(`INFO bridge isolation folder holds cloud-fetched ${cloud.join(", ")} (written by Claude Code from the account's managed settings; not host config)`);
  const login: string[] = [];
  if (fs.existsSync(path.join(input.dir, ".credentials.json"))) login.push("credentials file");
  if (input.platform === "darwin" && (input.keychain ?? macKeychainProbe)(keychainService(input.dir))) login.push("keychain entry");
  if (input.env.CLAUDE_CODE_OAUTH_TOKEN) login.push("CLAUDE_CODE_OAUTH_TOKEN set");
  if (login.length) out.push(`OK   bridge login present (${login.join(", ")})`);
  else out.push(`WARN bridge login not found for ${input.dir} — fix: run CLAUDE_CONFIG_DIR=${input.dir} claude, then /login; or set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token).`);
  return out;
}

/**
 * Project-level Claude Code config that runs code in a claude-bridge turn (U1): isolation covers
 * the user level only; the bridge still loads the project's setting sources. Returns findings
 * like `.claude/settings.json (hooks)` and `.mcp.json`; empty when there is nothing to fear.
 * CLAUDE.md is not listed: the bridge excludes it (claudeMdExcludes).
 */
export function projectClaudeRisks(cwd: string): string[] {
  const out: string[] = [];
  const dir = path.join(cwd, ".claude");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^settings.*\.json$/i.test(n)).sort();
  } catch {
    names = [];
  }
  for (const n of names) {
    let keys: string[] = [];
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as unknown;
      if (data && typeof data === "object" && !Array.isArray(data)) keys = ["hooks", "apiKeyHelper"].filter((k) => k in (data as object));
    } catch {
      keys = ["unreadable"];
    }
    if (keys.length) out.push(`.claude/${n} (${keys.join(", ")})`);
  }
  if (fs.existsSync(path.join(cwd, ".mcp.json"))) out.push(".mcp.json");
  return out;
}

export const PROJECT_CLAUDE_FIX = "review and remove them (hooks, apiKeyHelper and MCP servers in project files run as you in every claude-bridge turn, also when a subagent wrote them), or use another provider for this project.";
