// Bridge isolation: keeps the host's Claude Code config (settings, hooks, plugins, CLAUDE.md)
// out of claude-bridge turns by pointing CLAUDE_CONFIG_DIR at an empty folder. The bridge
// spawns its SDK child with `{...process.env}` at query time, so setting it here is enough.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const BRIDGE_PROVIDER = "claude-bridge";
/** Entries that make the folder a non-empty Claude Code config by existing. settings*.json and plugins/ are judged by content (see hostConfigFindings). */
export const FORBIDDEN_ENTRIES = ["hooks", "CLAUDE.md", "agents", "skills", "commands"];
const SETTINGS_FILES = ["settings.json", "settings.local.json"];
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

/** Settings keys that load or run code, beyond COMMAND_SETTINGS_KEYS (defined below): MCP servers spawn processes. */
const EXTRA_CODE_KEYS = ["mcpServers"];
/** Settings keys known to change only display/UI (allow list); any other key fails the doctor. */
export const INERT_SETTINGS_KEYS = ["$schema", "theme", "verbose", "preferredNotifChannel", "spinnerTipsEnabled", "editorMode"];

/**
 * Judges the isolation folder by what can load code, not by existence: a settings file passes
 * only when it parses as a JSON object holding known-inert keys (INERT_SETTINGS_KEYS); a
 * code-loading key or any other key (e.g. permissions, enableAllProjectMcpServers) fails, named.
 * Installed plugins fail, a marketplace catalog alone does not. Other forbidden entries fail on existence.
 */
export function hostConfigFindings(dir: string): { fail: string[]; info: string[] } {
  const fail: string[] = [];
  const info: string[] = [];
  const codeKeys = [...COMMAND_SETTINGS_KEYS, ...EXTRA_CODE_KEYS];
  for (const n of SETTINGS_FILES) {
    const f = path.join(dir, n);
    if (!fs.existsSync(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf8")) as unknown;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
      const keys = Object.keys(data);
      const bad = keys.filter((k) => codeKeys.includes(k));
      const unknown = keys.filter((k) => !codeKeys.includes(k) && !INERT_SETTINGS_KEYS.includes(k));
      if (bad.length) fail.push(`${n}: ${bad.join(", ")}`);
      if (unknown.length) fail.push(`${n}: keys not known to be inert (${unknown.join(", ")})`);
      if (!bad.length && !unknown.length) info.push(`holds ${n} with harmless keys only (${keys.join(", ") || "none"})`);
    } catch {
      fail.push(`${n}: unreadable or not a JSON object`);
    }
  }
  const plugins = path.join(dir, "plugins");
  if (fs.existsSync(plugins)) {
    let installed = false;
    let unreadable = false;
    const reg = path.join(plugins, "installed_plugins.json");
    if (fs.existsSync(reg)) {
      try {
        const data = JSON.parse(fs.readFileSync(reg, "utf8")) as { plugins?: unknown };
        const p = data && typeof data === "object" ? data.plugins : undefined;
        if (p && typeof p === "object") installed = Object.values(p as object).some((v) => (Array.isArray(v) ? v.length > 0 : true));
      } catch {
        unreadable = true;
      }
    }
    let cached = false;
    try {
      cached = fs.readdirSync(path.join(plugins, "cache")).length > 0;
    } catch {
      cached = false;
    }
    const known = ["known_marketplaces.json", "marketplaces", "installed_plugins.json", "cache"];
    let unknown: string[] = [];
    try {
      unknown = fs.readdirSync(plugins).filter((e) => !known.includes(e)).sort();
    } catch {
      unknown = ["unreadable"];
    }
    if (unknown.length) fail.push(`plugins/ unknown entries (${unknown.join(", ")})`);
    if (installed || cached || unreadable) fail.push(`plugins/ (${[installed && "installed plugins", cached && "plugin cache", unreadable && "unreadable installed_plugins.json"].filter(Boolean).join(", ")})`);
    else info.push("holds plugins/ with no installed plugin (marketplace catalog only)");
  }
  const present = FORBIDDEN_ENTRIES.filter((e) => fs.existsSync(path.join(dir, e)));
  fail.push(...present);
  return { fail, info };
}

export interface IsoDoctorInput {
  dir: string;
  env: Env;
  platform: string;
  keychain?: KeychainProbe;
}

/** Doctor lines for an active isolation. Never prints a credential value. */
export function isolationDoctor(input: IsoDoctorInput): string[] {
  const out: string[] = [];
  const { fail, info } = hostConfigFindings(input.dir);
  if (fail.length) out.push(`FAIL bridge isolation folder ${input.dir} holds host config (${fail.join(", ")}) — fix: remove those entries; the folder must hold only login data.`);
  else out.push(`OK   bridge isolation folder ${input.dir} holds no code-loading settings, hooks, installed plugins, CLAUDE.md, agents, skills or commands`);
  for (const i of info) out.push(`INFO bridge isolation folder ${i}`);
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
 * Claude Code settings keys that run a command or script (CC 2.1.289 settings schema): hooks,
 * auth/header helpers, cloud auth refresh/export, status lines, file suggestion and the
 * process wrapper; `env` (it reaches every command CC spawns, e.g. `NODE_OPTIONS`) and
 * `enabledPlugins`/`extraKnownMarketplaces` (plugins bring hooks and MCP servers). `policyHelper` is honoured only from admin policy sources, so it is not listed.
 */
export const COMMAND_SETTINGS_KEYS = ["hooks", "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "otelHeadersHelper", "proxyAuthHelper", "statusLine", "subagentStatusLine", "fileSuggestion", "processWrapper", "env", "enabledPlugins", "extraKnownMarketplaces"];

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
      if (data && typeof data === "object" && !Array.isArray(data)) keys = COMMAND_SETTINGS_KEYS.filter((k) => k in (data as object));
    } catch {
      keys = ["unreadable"];
    }
    if (keys.length) out.push(`.claude/${n} (${keys.join(", ")})`);
  }
  if (fs.existsSync(path.join(cwd, ".mcp.json"))) out.push(".mcp.json");
  return out;
}

export const PROJECT_CLAUDE_FIX = "review and remove them (hooks, command helpers such as apiKeyHelper or awsAuthRefresh, and MCP servers in project files run as you in every claude-bridge turn, also when a subagent wrote them), or use another provider for this project.";

/** The bridge's project config (pi-claude-bridge 0.9.1 src/config.ts:84-91: `<cwd>/.pi/claude-bridge.json`, merged over the global one). */
export const PROJECT_BRIDGE_CONFIG = ".pi/claude-bridge.json";

/** Key names that point at a program, script or path the bridge could run (future keys included). */
const PATHLIKE_KEY = /path|executable|exe$|command|cmd|binary|program|script|helper|wrapper/i;

/**
 * Keys of the project bridge config that make a claude-bridge turn or summary run something the
 * project chose (R3-H1). Judged keys (0.9.1 Config):
 *  - provider.pathToClaudeCodeExecutable: the program every bridge turn, summary and AskClaude
 *    call spawns. FAIL. Any other key at any depth whose name looks like a path, executable,
 *    command, script or helper: FAIL (future keys of that kind);
 *  - askClaude.enabled true: registers AskClaude, which runs Claude Code with the project's
 *    setting sources and bypassPermissions. FAIL. askClaude.defaultMode "full": makes that
 *    full-tool mode the default when the user enabled AskClaude globally. FAIL;
 *  - provider.strictMcpConfig false: lets `.mcp.json` and project MCP servers load in bridge
 *    turns. FAIL;
 *  - not flagged: provider.autoMemoryEnabled (memory files, runs nothing), plan,
 *    longContextExtraUsage, forceTwoHundredK (model and billing), startupNoticeShown, and
 *    askClaude name/label/description/defaultIsolated/appendSkills/allowFullMode (allowFullMode
 *    defaults to true, so true changes nothing; false only restricts).
 * An unparseable file is ignored by the bridge (tryParseJson returns {}), so it is reported as
 * `unreadable` for the doctor only.
 */
export function projectBridgeConfigRisks(cwd: string): string[] {
  const k = bridgeConfigKeys(path.join(cwd, ...PROJECT_BRIDGE_CONFIG.split("/")));
  if (!k) return [];
  if (k.unreadable) return [`${PROJECT_BRIDGE_CONFIG} (unreadable; the bridge ignores it)`];
  const keys = [...k.path, ...k.other];
  return keys.length ? [`${PROJECT_BRIDGE_CONFIG} (${keys.join(", ")})`] : [];
}

/**
 * The user-level bridge config `<agentDir>/claude-bridge.json`, judged by the same keys. An
 * executable path there may be the user's own choice, so it only warns; AskClaude and
 * strictMcpConfig false fail as in the project file.
 */
export function userBridgeConfigRisks(agentDir: string): { fail: string[]; warn: string[] } {
  const k = bridgeConfigKeys(path.join(agentDir, "claude-bridge.json"));
  if (!k) return { fail: [], warn: [] };
  if (k.unreadable) return { fail: [], warn: ["unreadable; the bridge ignores it"] };
  return { fail: k.other, warn: k.path };
}

/** Judged keys of one bridge config file: `path` = executable/path-like keys, `other` = AskClaude and MCP loosening; null = no file. */
function bridgeConfigKeys(file: string): { path: string[]; other: string[]; unreadable: boolean } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { path: [], other: [], unreadable: true };
  }
  const out = { path: [] as string[], other: [] as string[], unreadable: false };
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  const walk = (o: unknown, prefix: string, depth: number): void => {
    if (!o || typeof o !== "object" || Array.isArray(o) || depth > 4) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const name = prefix ? `${prefix}.${k}` : k;
      if (PATHLIKE_KEY.test(k) && v !== null && v !== false && v !== "") out.path.push(name);
      walk(v, name, depth + 1);
    }
  };
  walk(data, "", 0);
  const d = data as { askClaude?: unknown; provider?: unknown };
  const sub = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  if (sub(d.askClaude).enabled === true) out.other.push("askClaude.enabled");
  if (sub(d.askClaude).defaultMode === "full") out.other.push('askClaude.defaultMode "full"');
  if (sub(d.provider).strictMcpConfig === false) out.other.push("provider.strictMcpConfig false");
  return out;
}

export const PROJECT_BRIDGE_FIX = "remove those keys from .pi/claude-bridge.json (an executable path there is the program claude-bridge starts for every turn and summary; AskClaude runs with the project's settings and bypassPermissions; strictMcpConfig false loads project MCP servers), or set them in your user claude-bridge.json if you meant them.";

/** Package spec of a settings.packages entry (string or `{ source }`). */
function packageSpec(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { source?: unknown }).source === "string") return (e as { source: string }).source;
  return "";
}

/**
 * Whether pi-foreman's extension loads before pi-claude-bridge. Pi runs a session_before_compact /
 * session_before_tree handler per extension in load order and stops at the first cancel
 * (runner.js:813-822); the bridge's own handler for those events starts Claude Code, so the
 * drift cancel works only when pi-foreman comes first. Load order = project packages, then
 * user packages, each in list order (package-manager.js:708-715); `-e` extensions load before
 * both (resource-loader.js:403) and are not seen here.
 */
export function bridgeLoadOrder(projectPackages: unknown, userPackages: unknown, pkgRoot: string, projectBase = ".", userBase = "."): "no-bridge" | "foreman-first" | "bridge-first" | "unknown" {
  // Pi stores a local package path relative to the settings file's folder.
  const local = (s: string, base: string): string => {
    if (!s || /^(npm|git|https?|ssh):/.test(s) || s.startsWith("git@")) return s;
    const abs = path.resolve(base, s);
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  };
  const list = [
    ...(Array.isArray(projectPackages) ? projectPackages : []).map((e) => local(packageSpec(e), projectBase)),
    ...(Array.isArray(userPackages) ? userPackages : []).map((e) => local(packageSpec(e), userBase)),
  ];
  // The root is resolved the same way as the entries (a drive is added on Windows), and paths
  // compare case-insensitively where the file system does.
  const fold = process.platform === "win32" || process.platform === "darwin";
  const norm = (s: string): string => {
    const n = s.replace(/\\/g, "/").replace(/\/+$/, "");
    return fold ? n.toLowerCase() : n;
  };
  const roots = new Set([norm(pkgRoot), norm(local(pkgRoot, "."))]);
  const bridge = list.findIndex((s) => /(^|[/:@])pi-claude-bridge(@|$|\/)/.test(s));
  if (bridge < 0) return "no-bridge";
  const foreman = list.findIndex((s) => roots.has(norm(s)) || /^npm:pi-foreman(@|$)/.test(s));
  if (foreman < 0) return "unknown";
  return foreman < bridge ? "foreman-first" : "bridge-first";
}

export const LOAD_ORDER_NOTICE = "pi-foreman: pi-claude-bridge loads before pi-foreman, so the bridge's compaction and branch summaries run before pi-foreman's config-drift check. Fix: re-run the installer (node setup.mjs), which moves pi-foreman first.";

/** Session-start warning when pi-claude-bridge loads first (reads the project and user settings.json). */
export function loadOrderNotice(cwd: string, agentDir: string, pkgRoot: string): string | null {
  const packages = (file: string): unknown => {
    try {
      return (JSON.parse(fs.readFileSync(file, "utf8")) as { packages?: unknown } | null)?.packages;
    } catch {
      return undefined;
    }
  };
  const projectBase = path.join(cwd, ".pi");
  const order = bridgeLoadOrder(packages(path.join(projectBase, "settings.json")), packages(path.join(agentDir, "settings.json")), pkgRoot, projectBase, agentDir);
  return order === "bridge-first" ? LOAD_ORDER_NOTICE : null;
}
