// MCP in a child (round 68): core-adapter loads Pi's own MCP extension in every child with a filtered server list and
// registers the harness `tool_search` (toolsearch.ts), so a child loads an MCP tool on demand and only within its role's scope (mcpscope.ts).
// The binding is captured at factory time and the allowed set is computed from it in `start` (the child's
// session_start), never from env later. A child without a binding, or whose launch named no `mcp`, allows nothing (fail closed).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "./env.ts";
import type { Env } from "./env.ts";
import { allowedMcpNamed, directMaxTools, directProviders, filterMcpConfig, mcpCallAllowed, mcpEmpty, namedEntries, serverKey, splitEntry } from "./mcpscope.ts";
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

/** Tool names `roles.<role>.searchable` lets a child find through `tool_search` (none when unset). */
export function searchableOf(configRoles: unknown, role: string | undefined): string[] {
  const list = role && configRoles && typeof configRoles === "object" ? ((configRoles as Record<string, { searchable?: unknown } | undefined>)[role]?.searchable) : undefined;
  return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [];
}

export interface McpChildOpts {
  /** The launch binding read at factory time (role, optional launch `mcp`); null or no `mcp` = nothing is allowed. */
  binding: { role: string; mcp?: string[] } | null;
  env?: Env;
  /** Injectable for tests: the Pi package root and the file import of the loader. */
  resolveRoot?: () => string | null;
  importFile?: (href: string) => Promise<unknown>;
  /** Injectable for tests: the SDK's `createMcpExtension`. */
  createMcp?: unknown;
  /** Injectable for tests: how long `preload` waits for the allowed servers' tools (default 10 s, Pi's own startup wait). */
  preloadWaitMs?: number;
  /** How many skills are hidden from this child's prompt and findable through `tool_search` (default none). */
  hiddenSkills?: () => number;
}

const PRELOAD_WAIT_MS = 10_000;

export const unsupportedNote = (reason: string): string => `pi-foreman: MCP is not available in this child (${reason}). Do not look for MCP tools; name the missing MCP tool under Friction in your report.`;

export const cappedNote = (count: number, cap: number): string =>
  `pi-foreman: the ${count} MCP tools allowed to this child are over the cap of ${cap} (mcp.directMaxTools), so nothing is declared up front: they stay deferred and you find them with tool_search (a tool it loads is callable from the next turn on a provider that fixes its tool list per turn). Do not rely on MCP tools being in your tool list; under Friction in your report write that ${count} MCP tools were over the cap of ${cap}, and that the launch should name the tools the task needs next to the server (mcp: ["server", "server/tool"]; mcp: ["server/tool"] alone narrows to them) or the owner raise mcp.directMaxTools.`;

export const namedCapNote = (count: number, cap: number): string =>
  `pi-foreman: the ${count} MCP tools named for this child are over the cap of ${cap} (mcp.directMaxTools), so none was declared up front. Do not rely on MCP tools; under Friction in your report write that ${count} named MCP tools were over the cap of ${cap}.`;

/**
 * The prompt line of a launch that named MCP: which MCP tools are up front (`upfront` tool names, then `whole` servers
 * declared in bulk with their tool count), where the tools of the servers named whole and not declared (`search`) are
 * found, which named tool the server lacks. `silent` are servers with named tools of which none registered in time;
 * `overCap` are the bulk tools (`bulk`) of the servers named whole that, with the `named` tools declared, did not fit under `cap`;
 * `hidden` are named tools (`server/tool`) the child cannot have because the MCP config hides them.
 */
export function upfrontLine(
  upfront: readonly string[],
  search: readonly string[],
  missing: readonly string[],
  whole: readonly { server: string; count: number }[] = [],
  silent: readonly { server: string; tools: readonly string[] }[] = [],
  overCap: { named: number; bulk: number; cap: number } | null = null,
  hidden: readonly string[] = [],
): string {
  const items = [...upfront, ...whole.map((w) => `all ${w.count} tools of server ${w.server}`)];
  const have = items.length > 0 ? items.join(", ") : "none";
  const rest =
    search.length > 0
      ? `${items.length > 0 ? "The other tools" : "The tools"} of the MCP server${search.length > 1 ? "s" : ""} ${search.join(", ")} are not declared: find them with tool_search (a tool it loads is callable from the next turn on a provider that fixes its tool list per turn).`
      : "No other MCP tool is reachable in this launch.";
  const lacking = missing.length > 0 ? ` Named but not found on the server: ${missing.join(", ")}; name it under Friction in your report.` : "";
  const unavailable = hidden.length > 0 ? ` Named but not available in this child (hidden in the MCP config): ${hidden.join(", ")}; name it under Friction in your report.` : "";
  const quiet = silent.map((s) => ` MCP server ${s.server} did not answer in time, so its named tools (${s.tools.join(", ")}) are not declared; they may be found with tool_search later; name it under Friction in your report.`).join("");
  const over = overCap ? ` ${overCap.named > 0 ? `With the ${overCap.named} named tool${overCap.named === 1 ? "" : "s"}, the` : "The"} ${overCap.bulk} MCP tools of the servers named whole are over the cap of ${overCap.cap} (mcp.directMaxTools), so they are not declared and found with tool_search; name that under Friction in your report.` : "";
  return `pi-foreman: MCP tools declared in your tool list: ${have}. ${rest}${lacking}${unavailable}${quiet}${over}`;
}

export class McpChild {
  /** Set by `start` from the captured binding. */
  allowed: McpAllowed = { servers: [], tools: {} };
  /** `mcp.directProviders` as configured, set by `start`; `preload` matches the turn's provider against it. */
  private configuredDirect: unknown;
  /** `mcp.directMaxTools` as configured, set by `start`. */
  private configuredMax: unknown;
  /** Set by `preload` when the tools it would declare were over the cap. */
  private capped: { count: number; cap: number } | null = null;
  /** Set by `preload` when the named tools alone were over the cap. */
  private namedOver: { count: number; cap: number } | null = null;
  /** The prompt line of a launch that named MCP, set by `preload`: the same text on every turn on one provider; it can change only at a turn where the model provider changes to a direct one: tools get declared, or the over-the-cap note replaces the line (null until `preload` ran with a provider, and when only the over-the-cap note applies). */
  private line: string | null = null;
  /** The named part of `preload`, done at the first prompt with a provider: what the line says about the named tools (null until then, and for a launch without named tools). */
  private stage: { upfront: string[]; count: number; missing: string[]; hidden: string[]; silent: { server: string; tools: string[] }[] } | null = null;
  /** Set once a turn on a direct provider decided the bulk part (or nothing is left to decide). */
  private bulkDone = false;
  /** Servers (`serverKey`) the config filter dropped from Pi's list, e.g. because all their named tools are hidden. */
  private dropped = new Set<string>();
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
            return this.filterLoaded({ servers: list as never, errors: [] }).servers;
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
      this.pi.on("before_agent_start", async (_event, ctx) => this.preload(ctx.model?.provider));
    } catch (error) {
      this.setupError = `Pi's MCP extension failed to start: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Pi's loader result reduced to the allowed set; `servers: []` when nothing is allowed or the loader is missing. */
  private loadConfig(ctx: ExtensionContext): McpLoadedLike {
    if (mcpEmpty(this.allowed) || !this.loader || this.unsupported) return { servers: [], errors: [] };
    const loaded = this.loader({ agentDir: piAgentDir(this.opts.env ?? process.env, os.homedir()), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    return this.filterLoaded(loaded);
  }

  /** `filterMcpConfig` of the allowed set; remembers which servers of the list it dropped, so `preload` can tell a hidden server from a silent one. */
  private filterLoaded<T extends McpLoadedLike>(loaded: T): T {
    const out = filterMcpConfig(loaded, this.allowed);
    const kept = new Set(out.servers.map((s) => serverKey(s.name)));
    this.dropped = new Set(loaded.servers.map((s) => serverKey(s.name)).filter((key) => !kept.has(key)));
    return out;
  }

  /**
   * Before the first prompt, once the allowed servers' tools are registered (bounded wait), declare tools up front the
   * way `tool_search` would load them, so the first request lists them (Pi will not declare a `direct` MCP tool under a
   * child's `--tools` allowlist, and a provider that fixes its tool list per turn never sees a tool loaded mid-turn).
   * Named tools (`server/tool` entries, also of a server named whole) whose exposure is `deferred` or `codemode` (both are
   * what `tool_search` activates) are declared on every provider; more of them than
   * `mcp.directMaxTools` are not declared at all (the launch refuses that first). The remaining tools of the servers named
   * whole without named tools (bulk, `deferred` ones only) are declared only on a provider listed in `mcp.directProviders` and only if named
   * plus bulk fit under the cap, else none of the bulk (a partial set would fail in less visible ways). A server named
   * whole together with named tools never declares its remainder; it stays findable through `tool_search`. Only tools
   * inside the child's MCP scope are loaded. `provider` is the model provider at that prompt (it may be unset at session
   * start); without one nothing is loaded yet. The named part is done once, at the first prompt with a provider; the bulk part stays pending until a turn on a direct provider decides it.
   * A named tool already active (resumed) is listed as declared, not activated again; one whose exposure is neither `deferred` nor `codemode`, or whose server the config filter dropped, is listed as hidden. The prompt line (`note`) is the same text on every turn on one provider; it can change only at a turn where the
   * model provider changes to a direct one: tools get declared, or the over-the-cap note replaces the line (the request prefix changes there anyway).
   * With only bare servers over the cap, `note` gives the over-the-cap note instead of a line.
   */
  async preload(provider: string | undefined): Promise<void> {
    if (provider === undefined || this.bulkDone || mcpEmpty(this.allowed) || this.unsupported) return;
    const entries = namedEntries(this.allowed);
    const direct = directProviders(this.configuredDirect).includes(provider);
    // the named part is done once, at the first prompt with a provider; the bulk part waits for a turn on a direct provider
    const doNamed = this.stage === null && entries.length > 0;
    if (!doNamed && !direct) {
      // nothing is declared on this provider: the same text on every turn here; a later turn on a direct provider declares tools and replaces it
      if (this.stage === null) this.line = upfrontLine([], this.allowed.servers, []);
      return;
    }
    const wanted = (): string[] => [...this.labels].filter(([, label]) => mcpCallAllowed(this.allowed, label)).map(([name]) => name);
    const serverOf = (name: string): string => serverKey(this.labels.get(name)?.split("/", 1)[0] ?? "");
    const seen = (): Set<string> => new Set(wanted().map(serverOf));
    const ready = (): boolean => {
      const have = seen();
      return [...this.allowed.servers, ...Object.keys(this.allowed.tools)].every((server) => have.has(serverKey(server)));
    };
    const deadline = Date.now() + (this.opts.preloadWaitMs ?? PRELOAD_WAIT_MS);
    while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const exposure = new Map(this.pi.getAllTools().map((tool) => [tool.name, (tool as { exposure?: string }).exposure]));
    const active = this.pi.getActiveTools();
    const isNamed = (name: string): boolean => {
      const e = splitEntry(this.labels.get(name));
      return !!e && entries.some((n) => serverKey(n.server) === serverKey(e.server) && n.tool === e.tool);
    };
    const namedServers = new Set(entries.map((n) => serverKey(n.server)));
    const inactive = wanted().filter((name) => !active.includes(name));
    const named = doNamed ? inactive.filter((name) => isNamed(name) && ["deferred", "codemode"].includes(exposure.get(name) ?? "")) : [];
    const activeNamed = doNamed ? wanted().filter((name) => active.includes(name) && isNamed(name)) : [];
    const bulk = direct ? inactive.filter((name) => exposure.get(name) === "deferred" && !namedServers.has(serverOf(name))) : [];
    const cap = directMaxTools(this.configuredMax);
    if (doNamed) {
      const registered = [...this.labels.values()].map((label) => splitEntry(label));
      const missingEntries = entries.filter((n) => !registered.some((e) => e && serverKey(e.server) === serverKey(n.server) && e.tool === n.tool));
      const answered = (server: string): boolean => registered.some((e) => e && serverKey(e.server) === serverKey(server));
      const label = (n: { server: string; tool: string }): string => `${n.server}/${n.tool}`;
      const unanswered = missingEntries.filter((n) => !answered(n.server));
      const quiet = unanswered.filter((n) => !this.dropped.has(serverKey(n.server)));
      this.stage = {
        upfront: [],
        count: activeNamed.length + named.length,
        missing: missingEntries.filter((n) => answered(n.server)).map(label),
        // registered but neither deferred nor codemode, and a server the filter dropped because its named tools are all hidden
        hidden: [...inactive.filter((name) => isNamed(name) && !named.includes(name)).map((name) => this.labels.get(name) ?? name), ...unanswered.filter((n) => this.dropped.has(serverKey(n.server))).map(label)],
        silent: [...new Set(quiet.map((n) => n.server))].map((server) => ({ server, tools: quiet.filter((n) => n.server === server).map(label) })),
      };
    }
    const count = this.stage?.count ?? 0;
    const declared: string[] = [];
    let bulkDeclared = false;
    if (count > cap) {
      this.namedOver = { count, cap };
      this.bulkDone = true;
      this.trace({ event: "mcp_child_named_capped", provider, count, cap });
    } else {
      bulkDeclared = bulk.length > 0 && count + bulk.length <= cap;
      // in the order Pi registered them
      declared.push(...inactive.filter((name) => named.includes(name) || (bulkDeclared && bulk.includes(name))));
      if (this.stage && doNamed) this.stage.upfront = wanted().filter((name) => activeNamed.includes(name) || named.includes(name));
      if (direct) this.bulkDone = true;
      if (declared.length > 0) {
        this.pi.setActiveTools([...active, ...declared]);
        const servers = [...new Set(declared.map((name) => this.labels.get(name)?.split("/", 1)[0] ?? ""))].sort();
        this.trace({ event: "mcp_child_direct", provider, servers: servers.join(","), count: declared.length });
      }
      if (bulk.length > 0 && !bulkDeclared) {
        this.capped = { count: count + bulk.length, cap };
        this.trace({ event: "mcp_child_direct_capped", provider, count: count + bulk.length, cap });
      }
    }
    if (!this.namedOver && entries.length === 0 && this.capped) {
      this.line = null;
    } else if (!this.namedOver) {
      const bulkServers = new Set(bulkDeclared ? bulk.map(serverOf) : []);
      const search = this.allowed.servers.filter((server) => !bulkServers.has(serverKey(server)));
      const whole = [...bulkServers].map((key) => ({ server: this.allowed.servers.find((s) => serverKey(s) === key) ?? key, count: bulk.filter((name) => serverOf(name) === key).length }));
      this.line = upfrontLine(this.stage?.upfront ?? [], search, this.stage?.missing ?? [], whole, this.stage?.silent ?? [], this.capped ? { named: count, bulk: bulk.length, cap } : null, this.stage?.hidden ?? []);
    }
  }

  /**
   * The child's session_start: compute the allowed set from the captured binding and the role config, wait for the
   * loader import, and take `tool_search` out of the active set when no MCP is available so no declaration is sent.
   * `preload` declares the launch's named tools up front on every provider, and on a provider listed in
   * `mcp.directProviders` (`configuredDirect`) also the tools of a server named whole without named tools (a provider
   * that fixes its tool list per turn cannot call a tool that `tool_search` loads mid-turn), up to `mcp.directMaxTools`
   * (`configuredMax`).
   */
  async start(configRoles: unknown, trace: (record: Record<string, unknown>) => void, configuredDirect?: unknown, configuredMax?: unknown): Promise<void> {
    const binding = this.opts.binding;
    this.trace = trace;
    this.configuredDirect = configuredDirect;
    this.configuredMax = configuredMax;
    this.allowed = allowedMcpNamed(configRoles, binding?.role, binding?.mcp);
    const { load, reason } = await this.loading;
    this.loader = load;
    if (!mcpEmpty(this.allowed)) {
      const why = this.setupError ?? (load ? null : reason);
      if (why) {
        this.unsupported = why;
        trace({ event: "mcp_child_unsupported", role: binding?.role ?? null, reason: why });
      }
    }
    // The search stays on when the child has something besides MCP to find: searchable tools or hidden skills.
    const findable = searchableOf(configRoles, binding?.role).length > 0 || (this.opts.hiddenSkills?.() ?? 0) > 0;
    if ((mcpEmpty(this.allowed) || this.unsupported) && !findable) {
      try {
        const active = this.pi.getActiveTools();
        if (active.includes(TOOL_SEARCH)) this.pi.setActiveTools(active.filter((name) => name !== TOOL_SEARCH));
      } catch {
        // a host without the active-tool api keeps what it has
      }
    }
  }

  /** The prompt line of a child whose MCP is refused, whose named tools were over the cap, whose launch named MCP (after `preload`), or whose up-front declaration was over the cap, else null. */
  note(): string | null {
    if (this.unsupported) return unsupportedNote(this.unsupported);
    if (this.namedOver) return namedCapNote(this.namedOver.count, this.namedOver.cap);
    if (this.line) return this.line;
    return this.capped ? cappedNote(this.capped.count, this.capped.cap) : null;
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
