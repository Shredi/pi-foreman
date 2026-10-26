// MCP in a child (round 68): core-adapter loads Pi's own MCP extension in every child with a filtered server list and
// registers Pi's `tool_search`, so a child loads an MCP tool on demand and only within its role's scope (mcpscope.ts).
// The binding is captured at factory time and the allowed set is computed from it in `start` (the child's
// session_start), never from env later. A child without a binding allows nothing (fail closed).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "./env.ts";
import type { Env } from "./env.ts";
import { allowedMcp, directProviders, filterMcpConfig, mcpCallAllowed, mcpEmpty, serverKey } from "./mcpscope.ts";
import type { McpAllowed, McpLoadedLike } from "./mcpscope.ts";

export const TOOL_SEARCH = "tool_search";
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
/** Pi's MCP config loader, relative to the Pi package root (docs/install.md "Updating Pi"). */
export const LOADER_PATH = ["dist", "extensions", "mcp", "config.js"] as const;

type LoadMcpConfig = (options: { agentDir: string; cwd: string; projectTrusted: boolean }) => McpLoadedLike;

/** The Pi package root holding `dir` or an ancestor `package.json` named like Pi's package, else null. */
function packageRootOf(file: string): string | null {
  let dir = path.dirname(file);
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown };
      if (pkg.name === PI_PACKAGE_NAME) return dir;
    } catch {
      // keep walking up
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/**
 * The Pi package root whose loader a child imports: the pi-subagents env var, else the running Pi (the main entry of
 * this process), else the installed package. The first root that is identified decides, even when its loader is
 * missing (a different Pi's loader is never mixed in).
 */
export function resolvePiRoot(env: Env = process.env, argv1: string | undefined = process.argv[1], installed: () => string | null = installedPiRoot): string | null {
  const fromEnv = env[PI_ROOT_ENV]?.trim();
  if (fromEnv && fs.existsSync(path.join(fromEnv, "package.json"))) return fromEnv;
  if (argv1) {
    try {
      const running = packageRootOf(fs.realpathSync(argv1));
      if (running) return running;
    } catch {
      // not a file on disk
    }
  }
  return installed();
}

/** The installed package resolved from this module's own location. */
function installedPiRoot(): string | null {
  try {
    return packageRootOf(fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME)));
  } catch {
    return null;
  }
}

/** Import Pi's `loadMcpConfig` from the root's `dist/extensions/mcp/config.js`; null with a reason when it is missing. */
export async function loadLoader(resolveRoot: () => string | null, importFile: (href: string) => Promise<unknown> = (href) => import(href)): Promise<{ load: LoadMcpConfig | null; reason: string }> {
  const root = resolveRoot();
  if (!root) return { load: null, reason: "no Pi package root found" };
  const file = path.join(root, ...LOADER_PATH);
  if (!fs.existsSync(file)) return { load: null, reason: `${LOADER_PATH.join("/")} is missing in the Pi package` };
  try {
    const mod = (await importFile(pathToFileURL(file).href)) as { loadMcpConfig?: unknown };
    return typeof mod.loadMcpConfig === "function" ? { load: mod.loadMcpConfig as LoadMcpConfig, reason: "" } : { load: null, reason: `${LOADER_PATH.join("/")} exports no loadMcpConfig` };
  } catch (error) {
    return { load: null, reason: `${LOADER_PATH.join("/")} failed to load: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Server names of Pi's MCP config (global file plus the trusted project file); null when the loader is unavailable or fails. */
export async function configuredServers(cwd: string, trusted: boolean, env: Env = process.env, resolveRoot: () => string | null = () => resolvePiRoot(env)): Promise<string[] | null> {
  const { load } = await loadLoader(resolveRoot);
  if (!load) return null;
  try {
    return load({ agentDir: piAgentDir(env, os.homedir()), cwd, projectTrusted: trusted }).servers.map((s) => s.name);
  } catch {
    return null;
  }
}

/** Register Pi's `tool_search` (inactive until activated); it must exist in every child before the allowlist is checked. */
export function registerChildToolSearch(pi: Pick<ExtensionAPI, "registerTool">, factory: unknown = (sdk as Record<string, unknown>).createToolSearchExtension): boolean {
  if (typeof factory !== "function") return false;
  try {
    (factory as () => (api: unknown) => void)()(pi);
    return true;
  } catch {
    return false;
  }
}

export interface McpChildOpts {
  /** The launch binding read at factory time (role, optional launch `mcp`); null = none, nothing is allowed. */
  binding: { role: string; mcp?: string[] } | null;
  env?: Env;
  /** Injectable for tests: the Pi package root and the file import of the loader. */
  resolveRoot?: () => string | null;
  importFile?: (href: string) => Promise<unknown>;
  /** Injectable for tests: the SDK's `createMcpExtension`. */
  createMcp?: unknown;
  /** Injectable for tests: how long `preload` waits for the allowed servers' tools (default 10 s, Pi's own startup wait). */
  preloadWaitMs?: number;
}

const PRELOAD_WAIT_MS = 10_000;

export const unsupportedNote = (reason: string): string => `pi-foreman: MCP is not available in this child (${reason}). Do not look for MCP tools; name the missing MCP tool under Friction in your report.`;

export class McpChild {
  /** Set by `start` from the captured binding. */
  allowed: McpAllowed = { servers: [], tools: {} };
  /** The child's provider fixes its tool list per turn (mcp.directProviders): allowed servers are declared up front. */
  direct = false;
  private preloaded = false;
  /** Provider id of the child, set by `start`. */
  provider: string | undefined;
  private trace: (record: Record<string, unknown>) => void = () => {};
  /** Why MCP is refused in this child (loader missing, extension not creatable), else null. */
  unsupported: string | null = null;
  /** Tool name to `server/tool` label, recorded when Pi's MCP extension registers a tool. */
  readonly labels = new Map<string, string>();
  private loader: LoadMcpConfig | null = null;
  private readonly loading: Promise<{ load: LoadMcpConfig | null; reason: string }>;
  private setupError: string | null = null;
  private readonly pi: ExtensionAPI;
  private readonly opts: McpChildOpts;

  constructor(pi: ExtensionAPI, opts: McpChildOpts) {
    this.pi = pi;
    this.opts = opts;
    const env = opts.env ?? process.env;
    this.loading = loadLoader(opts.resolveRoot ?? (() => resolvePiRoot(env)), opts.importFile);
  }

  /** The api handed to Pi's MCP extension: records `name -> label` on registerTool, lists only allowed servers, binds methods. */
  private proxy(): ExtensionAPI {
    const target = this.pi as unknown as Record<string, unknown>;
    return new Proxy(this.pi, {
      get: (_t, prop) => {
        if (prop === "registerTool") {
          return (def: { name?: unknown; label?: unknown }) => {
            if (typeof def?.name === "string" && typeof def.label === "string") this.labels.set(def.name, def.label);
            return (target.registerTool as (d: unknown) => unknown).call(target, def);
          };
        }
        if (prop === "getMcpServers") {
          return () => {
            const list = typeof target.getMcpServers === "function" ? ((target.getMcpServers as () => { name: string; config: Record<string, unknown> }[]).call(target) ?? []) : [];
            return filterMcpConfig({ servers: list as never, errors: [] }, this.allowed).servers;
          };
        }
        const value = target[prop as string];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  /** Create Pi's MCP extension on the proxy; call after core-adapter registered its own session_start handler. */
  install(): void {
    const create = "createMcp" in this.opts ? this.opts.createMcp : (sdk as Record<string, unknown>).createMcpExtension;
    if (typeof create !== "function") {
      this.setupError = "the running Pi has no createMcpExtension";
      return;
    }
    try {
      (create as (o: unknown) => (api: unknown) => void)({ loadConfig: (ctx: ExtensionContext) => this.loadConfig(ctx) })(this.proxy());
      this.pi.on("before_agent_start", async () => this.preload());
    } catch (error) {
      this.setupError = `Pi's MCP extension failed to start: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Pi's loader result reduced to the allowed set; `servers: []` when nothing is allowed or the loader is missing. */
  private loadConfig(ctx: ExtensionContext): McpLoadedLike {
    if (mcpEmpty(this.allowed) || !this.loader || this.unsupported) return { servers: [], errors: [] };
    const loaded = this.loader({ agentDir: piAgentDir(this.opts.env ?? process.env, os.homedir()), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    return filterMcpConfig(loaded, this.allowed);
  }

  /**
   * A provider that fixes its tool list per turn (mcp.directProviders) never sees a tool that `tool_search` loads
   * mid-turn, and Pi will not declare a `direct` MCP tool under a child's `--tools` allowlist. So before the first
   * prompt, once the allowed servers' tools are registered (bounded wait), load the allowed deferred ones the way
   * `tool_search` would: they are declared in the first request. Only tools inside the child's MCP scope are loaded.
   */
  async preload(): Promise<void> {
    if (!this.direct || this.preloaded || mcpEmpty(this.allowed) || this.unsupported) return;
    this.preloaded = true;
    const wanted = (): string[] => [...this.labels].filter(([, label]) => mcpCallAllowed(this.allowed, label)).map(([name]) => name);
    const seen = (): Set<string> => new Set(wanted().map((name) => serverKey(this.labels.get(name)?.split("/", 1)[0] ?? "")));
    const ready = (): boolean => {
      const have = seen();
      return [...this.allowed.servers, ...Object.keys(this.allowed.tools)].every((server) => have.has(serverKey(server)));
    };
    const deadline = Date.now() + (this.opts.preloadWaitMs ?? PRELOAD_WAIT_MS);
    while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const exposure = new Map(this.pi.getAllTools().map((tool) => [tool.name, (tool as { exposure?: string }).exposure]));
    const active = this.pi.getActiveTools();
    const load = wanted().filter((name) => exposure.get(name) === "deferred" && !active.includes(name));
    if (load.length === 0) return;
    this.pi.setActiveTools([...active, ...load]);
    const servers = [...new Set(load.map((name) => this.labels.get(name)?.split("/", 1)[0] ?? ""))].sort();
    this.trace({ event: "mcp_child_direct", provider: this.provider ?? null, servers: servers.join(","), count: load.length });
  }

  /**
   * The child's session_start: compute the allowed set from the captured binding and the role config, wait for the
   * loader import, and take `tool_search` out of the active set when no MCP is available so no declaration is sent.
   * `provider` is the child's model provider id; when `mcp.directProviders` (`configuredDirect`) lists it, `preload`
   * declares the allowed deferred tools up front (a provider that fixes its tool list per turn cannot call a tool
   * that `tool_search` loads mid-turn).
   */
  async start(configRoles: unknown, trace: (record: Record<string, unknown>) => void, provider?: string, configuredDirect?: unknown): Promise<void> {
    const binding = this.opts.binding;
    this.trace = trace;
    this.provider = provider;
    this.direct = provider !== undefined && directProviders(configuredDirect).includes(provider);
    this.allowed = allowedMcp(configRoles, binding?.role, binding?.mcp);
    const { load, reason } = await this.loading;
    this.loader = load;
    if (!mcpEmpty(this.allowed)) {
      const why = this.setupError ?? (load ? null : reason);
      if (why) {
        this.unsupported = why;
        trace({ event: "mcp_child_unsupported", role: binding?.role ?? null, reason: why });
      }
    }
    if (mcpEmpty(this.allowed) || this.unsupported) {
      try {
        const active = this.pi.getActiveTools();
        if (active.includes(TOOL_SEARCH)) this.pi.setActiveTools(active.filter((name) => name !== TOOL_SEARCH));
      } catch {
        // a host without the active-tool api keeps what it has
      }
    }
  }

  /** The prompt line of a child whose MCP is refused, else null. */
  note(): string | null {
    return this.unsupported ? unsupportedNote(this.unsupported) : null;
  }

  /** Block text for a call to `tool` outside the child's MCP scope, else undefined. Only `mcp__` names are judged. */
  callBlock(tool: string): string | undefined {
    if (!tool.startsWith("mcp__")) return undefined;
    if (mcpCallAllowed(this.allowed, this.labels.get(tool))) return undefined;
    const role = this.opts.binding?.role ?? "unknown";
    const launch = this.opts.binding?.mcp !== undefined ? ", launch mcp" : "";
    return `\`${tool}\` is outside the MCP scope of role ${role} (roles.${role}.mcp${launch})`;
  }
}
