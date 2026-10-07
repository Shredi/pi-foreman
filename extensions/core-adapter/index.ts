// pi-foreman core adapter: wires the vendored Python core into Pi (design §§5-7, 9).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterSpawn, beforeSpawn, changedFileOf, escalate, gateThreshold, initialCeremony, isTier, ledgerTier, onFileChanged, promptSignals, tierLine, userOverride } from "./ceremony.ts";
import type { CeremonyState } from "./ceremony.ts";
import { canonical, generateSubagents, get, loadMergedConfig, pythonPathHint } from "./config.ts";
import type { MergedConfig } from "./config.ts";
import { loadRegister, normaliseChildExtensions, registrationPathLabel } from "./childext.ts";
import { buildOverlayRules, checkToolCall, isOverlayTool, OVERLAY_UNAVAILABLE, readBaseline, resolveDecision } from "./permoverlay.ts";
import type { OverlayRules } from "./permoverlay.ts";
import { permFileState, PS_CHILD_ID, PS_PACKAGE, psProjectConfigPath, renderPermissions, resolvePermissionSystem } from "./permsys.ts";
import type { Registration } from "./childext.ts";
import { forceDetached } from "./detach.ts";
import { forceUserScope, SHADOW_FIX, shadowedRoles } from "./agentscope.ts";
import { actionOf, endActive, recordLaunch, trackActive, roundSteps, subagentActionCheck } from "./actions.ts";
import type { RunRegistry } from "./actions.ts";
import { dropDeadPathRewrite, guardPayloadBlock } from "./guardgaps.ts";
import { RUN_END_EVENTS, SUPERVISOR_TOOL, SupervisorWindow, roleToolsFrom } from "./supervisor.ts";
import { gitGuardPayload, mainNeedsGitGuard, runGitGuard } from "./gitguard.ts";
import { childRoleIds, roleLaunchBlock, roleModelBlock } from "./roles.ts";
import { BRIDGE_PROVIDER, BridgeIsolation, bridgeLoadOrder, isolationDir, isolationDoctor, isolationOn, loadOrderNotice, PROJECT_BRIDGE_FIX, PROJECT_CLAUDE_FIX, projectBridgeConfigRisks, projectClaudeRisks, userBridgeConfigRisks } from "./bridgeiso.ts";
import { applyLaunchModels, applyLaunchTimeouts, splitLevel, STRENGTHS } from "./launchmodel.ts";
import { ForemanReview, REVIEW_LINK, reviewTarget } from "./review.ts";
import type { RoleResolution } from "./roles.ts";
import { buildGuardEnv, patchShellEnv, piAgentDir } from "./env.ts";
import { patchChildGitEnv, stripChildIntercomEnv } from "./childenv.ts";
import { GitDriftWatch, patchForemanGitEnv, safeOpDriftPreflight } from "./gitdrift.ts";
import { ClaudeConfigWatch } from "./claudedrift.ts";
import { boundLedger, ensureSessionMarker, isLedgerTarget, markerPath } from "./marker.ts";
import { postToolPayload, preToolPayload, resolveToolPath, stopPayload, subagentAgents } from "./payload.ts";
import type { PayloadContext } from "./payload.ts";
import { NO_PYTHON_FIX, PythonCache, resolvePython } from "./python.ts";
import type { PythonResolution } from "./python.ts";
import { runGuard } from "./runguard.ts";
import { registerSafeOps } from "./safeops.ts";
import { defaultSpawner } from "./spawn.ts";
import type { Spawner } from "./spawn.ts";
import { mapTool } from "./toolmap.ts";
import type { GuardName } from "./toolmap.ts";
import { evaluateRun, translateStop, translateToolCall } from "./translate.ts";
import { openTrace } from "./trace.ts";
import type { TraceWriter } from "./trace.ts";
import { appendUsage, aggregate, bindLaunch, stripBinding, causeOfCustom, causeOfInput, formatSummary, keepSection, PARENT_SESSION_ENV, readBinding, readUsage, recordUsageLaunch, singleLaunchRole, usageFile, usageLine } from "./usage.ts";
import type { LaunchBinding, LaunchKind, LineContext, TurnCause } from "./usage.ts";
import { workspaceOf } from "./python.ts";
import { CompactionGate } from "./compaction.ts";
import { UsageFooter } from "./footer.ts";
import { blockedConfirm, bridgePermissionBlocked } from "./herdr.ts";
import type { EventBus } from "./herdr.ts";

/** pi.events of the loaded extension, for the Herdr blocked signal (set in the factory). */
let herdrEvents: EventBus | undefined;
import { checkLaunch, completedAgents, initialRounds, NOTIFY_TYPE, onReviewDone, onTierChange, REVIEW_ROLES, verdictOf } from "./rounds.ts";
import type { LaunchRounds, RoundState } from "./rounds.ts";
import { registerWait } from "./wait.ts";
import { registerClose, syncCommand } from "./close.ts";
import { foremanTriage, GATED_TOOLS, triageAdvice, triageGateBlock, TRIAGE_TOOL } from "./triage.ts";
import { familyWarnings, modelGaps } from "./modelcheck.ts";
import type { RegistryLike } from "./modelcheck.ts";
import { INTERCOM_MESSAGE_TYPE, INTERCOM_TOOL, intercomBlock, intercomDoctor, intercomSender, lastIntercomSender } from "./intercomguard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = fileURLToPath(import.meta.url);
const PKG_ROOT = path.resolve(HERE, "..", "..");
const CORE_DIR = path.join(PKG_ROOT, "core");
const BIN_DIR = path.join(PKG_ROOT, "bin");
const ADAPTER_ID = "pi-foreman-core-adapter";
const GIT_GUARD_ID = "pi-foreman-git-guard";
const GIT_GUARD_ENTRY = path.join(PKG_ROOT, "extensions", "git-guard", "index.ts");
const ORIGINAL_PI_FOREMAN_PYTHON = process.env.PI_FOREMAN_PYTHON;

interface Session {
  id: string;
  cwd: string;
  isChild: boolean;
  agentDir: string;
  markerDir: string;
  python: PythonResolution;
  config: MergedConfig;
  /** Provider `config.roles` was resolved for (re-resolved on a provider switch). */
  configProvider: string | undefined;
  ceremony: CeremonyState;
  registration?: Registration;
  registrationError?: string;
  childExtensionErrors?: string[];
  /** Set when the permission system cannot be resolved: child launches are refused. */
  permissionSystemError?: string;
  /** Deny/ask rules enforced before the permission system; null = baseline unreadable (fail closed). */
  overlay: OverlayRules | null;
  registrationVia?: string;
  childExtensions: { id: string; path: string }[];
  stopContinued: boolean;
  /** The pi-foreman section text the last before_agent_start set (review N2: put back after a compaction). */
  foremanSection?: string;
  notified: Set<string>;
  trace: TraceWriter | null;
  /** Runs this session launched (resume provenance, actions.ts). */
  runs: RunRegistry;
  /** Child runs launched by this session that have not ended (actions.ts trackActive; /sync and close refuse while any). */
  activeRuns: Set<string>;
  /** Foreman bash calls made while a child run was active, since the last trace emit (D5; delta, reset on emit). */
  pollBash: number;
  /** Launch notices (strong model asked for but unmapped) by tool call id, added to the subagent result. */
  launchNotices: Map<string, string[]>;
  /** Open child supervisor requests (supervisor.ts). */
  supervisor: SupervisorWindow;
  /** Git config/hooks snapshot taken at child launches, checked before foreman git (gitdrift.ts). */
  gitDrift: GitDriftWatch;
  /** Project Claude Code config snapshot, checked before claude-bridge prompts (claudedrift.ts). */
  claudeCfg: ClaudeConfigWatch;
  /** Usage log (usage.ts): file and the fields every line of this session carries. */
  usage: { file: string; line: LineContext };
  /** Launches this session recorded (launch id -> binding), for later kinds (revision, strong-relaunch). */
  launches: Map<string, LaunchBinding>;
  /** Foreman only: last trigger of the current run and its cache tokens, for the `turn` trace event. */
  turn: { cause: TurnCause; cacheRead: number; cacheWrite: number; wakeKinds?: string; intercomFrom?: string };
  /** Foreman only: builder revision rounds since the last user prompt or /ceremony tier change (rounds.ts). */
  rounds: RoundState;
}

export interface AdapterDeps {
  spawner?: Spawner;
  platform?: string;
}

export default function coreAdapter(pi: ExtensionAPI, deps: AdapterDeps = {}): void {
  const spawner = deps.spawner ?? defaultSpawner;
  const platform = deps.platform ?? process.platform;
  // Before any session_start (pi-intercom reads PI_INTERCOM_STABLE_ID when it connects): review S6.
  if (process.env.PI_SUBAGENT_CHILD === "1") stripChildIntercomEnv(process.env);
  const pythonCache = new PythonCache();
  const sessions = new Map<string, Session>();
  let userPickedModel = false;
  let applyingModel = false;
  let instructionsCache: string | null | undefined;
  const bridgeIso = new BridgeIsolation();
  const review = new ForemanReview();
  const usageFooter = new UsageFooter();
  const compactionGate = new CompactionGate();
  herdrEvents = pi.events as EventBus | undefined;
  const permBlocked = bridgePermissionBlocked(herdrEvents);
  pi.on("agent_end", async () => permBlocked.clear());
  pi.on("session_shutdown", async () => permBlocked.clear());
  pi.events?.on("permissions:ready", (payload: unknown) => review.onReady(payload));
  let isoSetting: unknown = "auto";
  const baseline = readBaseline(PKG_ROOT);
  // A child's launch binding is in the env while its extensions load (usage.ts); read it now.
  const launchBinding = readBinding(process.env);

  const pyPath = (s: Session): string | null => (s.python.ok ? s.python.info.executable : null);

  const notifyOnce = (s: Session, ctx: ExtensionContext, key: string, msg: string, level: "info" | "warning" | "error" = "warning"): void => {
    if (s.notified.has(key)) return;
    s.notified.add(key);
    ctx.ui.notify(msg, level);
  };

  async function startSession(ctx: ExtensionContext): Promise<Session> {
    const id = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;
    const home = os.homedir();
    const agentDir = piAgentDir(process.env, home);
    const trusted = safeTrusted(ctx);
    let markerDir = path.join(agentDir, "pi-foreman", "state");
    try {
      fs.mkdirSync(markerDir, { recursive: true });
    } catch {
      markerDir = os.tmpdir();
    }

    const hint = pythonPathHint(PKG_ROOT, agentDir);
    let python = await pythonCache.get(id, () => resolvePython({ configPath: hint, envPath: ORIGINAL_PI_FOREMAN_PYTHON, platform, spawner, cwd }));
    const provider = ctx.model?.provider;
    const config = await loadMergedConfig({ python: python.ok ? python.info.executable : null, pkgRoot: PKG_ROOT, provider, agentDir, projectDir: cwd, trusted, spawner });
    const merged = get(config.config, "python.path");
    if (typeof merged === "string" && merged.trim() && merged !== hint) {
      // python.path came from a layer the hint does not read (L3): honour it.
      pythonCache.drop(id);
      python = await pythonCache.get(id, () => resolvePython({ configPath: merged, envPath: ORIGINAL_PI_FOREMAN_PYTHON, platform, spawner, cwd }));
    }

    const isChild = process.env.PI_SUBAGENT_CHILD === "1";
    const b = isChild ? launchBinding : null;
    const foremanSession = isChild ? b?.foremanSession ?? process.env[PARENT_SESSION_ENV] ?? id : id;
    const line: LineContext = { workspace: b?.workspace || workspaceOf(cwd).root, foremanSession, role: isChild ? b?.role ?? "child" : "foreman", launchId: b?.launchId ?? null, kind: isChild ? b?.kind ?? "first" : "foreman" };
    const s: Session = {
      id,
      cwd,
      isChild,
      agentDir,
      markerDir,
      python,
      config,
      configProvider: provider,
      overlay: baseline ? buildOverlayRules(baseline, get(config.config, "safety.permissions"), config.basePermissions, agentDir, PKG_ROOT) : null,
      ceremony: initialCeremony(get(config.config, "ceremony.default")),
      childExtensions: [],
      stopContinued: false,
      notified: new Set(),
      runs: new Map(),
      activeRuns: new Set(),
      pollBash: 0,
      launchNotices: new Map(),
      supervisor: new SupervisorWindow(),
      gitDrift: new GitDriftWatch(),
      claudeCfg: new ClaudeConfigWatch(),
      trace: openTrace({ enabled: get(config.config, "trace.enabled"), dir: get(config.config, "trace.dir"), stateDir: markerDir, sessionId: id }),
      usage: { file: usageFile(agentDir, foremanSession), line },
      launches: new Map(),
      turn: { cause: "other", cacheRead: 0, cacheWrite: 0 },
      rounds: initialRounds(),
    };
    sessions.set(id, s);
    isoSetting = get(config.config, "bridge.isolateClaudeConfig");
    try {
      bridgeIso.apply(process.env, agentDir, isoSetting, provider);
    } catch (err) {
      ctx.ui.notify(`pi-foreman: could not prepare the bridge config folder (${(err as Error).message}).`, "warning");
    }
    const claudeRisks = provider === BRIDGE_PROVIDER ? projectClaudeRisks(cwd) : [];
    if (claudeRisks.length) ctx.ui.notify(`pi-foreman: project Claude Code config runs in claude-bridge turns: ${claudeRisks.join(", ")}. Fix: ${PROJECT_CLAUDE_FIX}`, "error");
    const bridgeCfgRisks = projectBridgeConfigRisks(cwd);
    if (bridgeCfgRisks.length) ctx.ui.notify(`pi-foreman: the project's claude-bridge config makes the bridge run what the project chose: ${bridgeCfgRisks.join(", ")}. Fix: ${PROJECT_BRIDGE_FIX}`, "error");
    s.trace?.emit({ event: "session_start", role: s.isChild ? "child" : "foreman", model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, tier: s.ceremony.tier });

    try {
      ensureSessionMarker(markerDir, id, Date.now() / 1000);
    } catch (err) {
      ctx.ui.notify(`pi-foreman: could not write the session marker in ${markerDir} (${(err as Error).message}); the ledger gates treat this session as unbound.`, "warning");
    }
    refreshLedgerTier(s);
    patchShellEnv({ env: process.env, binDir: BIN_DIR, python: pyPath(s), markerDir });
    if (s.isChild && get(config.config, "safety.children.mayPush") !== true) patchChildGitEnv(process.env);
    if (!s.isChild) patchForemanGitEnv(process.env);
    if (!s.isChild) {
      const gitLines = s.gitDrift.bind(markerDir, cwd, home);
      if (gitLines.length) ctx.ui.notify(`pi-foreman: the repository's git config or hooks changed since the last session; the next foreman git run or child launch asks.\n${gitLines.join("\n")}`, "warning");
      const cfgLines = s.claudeCfg.bind(markerDir, cwd, agentDir);
      if (cfgLines.length) ctx.ui.notify(`pi-foreman: project Claude Code or claude-bridge config changed since the last session; the next claude-bridge request or summary asks.\n${cfgLines.join("\n")}`, "warning");
      const first = [s.gitDrift.firstBaseline ? "the repository's git config and hooks" : "", s.claudeCfg.firstBaseline ? "the project's Claude Code config" : ""].filter(Boolean);
      if (first.length) ctx.ui.notify(`pi-foreman: first session on this workspace: took the baseline snapshot of ${first.join(" and ")}. Later changes ask before the foreman's git runs, child launches and claude-bridge requests.`, "info");
    }

    if (!python.ok) ctx.ui.notify(`pi-foreman: no Python ≥ 3.9 found — shell commands and subagent launches are blocked until it is fixed. ${NO_PYTHON_FIX}`, "error");
    for (const e of config.errors) ctx.ui.notify(e, "error");
    if (config.safetyFallback && config.source === "cli") ctx.ui.notify("pi-foreman: invalid safety config; L1 safety values apply.", "warning");
    for (const w of config.warnings) ctx.ui.notify(`pi-foreman config: ${w}`, "warning");
    if (!s.isChild) for (const sh of shadowedRoles(cwd, childRoleIds(get(config.config, "roles")), home)) ctx.ui.notify(`pi-foreman: project agent shadows a role (${sh}); ${SHADOW_FIX}`, "warning");
    return s;
  }

  /** Every tier change goes through here so the trace sees it. Only a change by the user (/ceremony) resets the revision rounds. */
  function setCeremony(s: Session, next: CeremonyState): void {
    const before = s.ceremony.tier;
    s.ceremony = next;
    if (next.tier !== before) {
      s.trace?.emit({ event: "tier", tier: next.tier });
      s.rounds = onTierChange(s.rounds, next.source);
    }
  }

  function sessionFor(ctx: ExtensionContext): Session | undefined {
    return sessions.get(ctx.sessionManager.getSessionId());
  }

  async function ensureSession(ctx: ExtensionContext): Promise<Session> {
    return sessionFor(ctx) ?? (await startSession(ctx));
  }

  function refreshLedgerTier(s: Session): void {
    const ledger = boundLedger(s.markerDir, s.id);
    if (!ledger) return;
    try {
      const { tier, reason } = ledgerTier(fs.readFileSync(ledger, "utf8"));
      setCeremony(s, escalate(s.ceremony, tier, "ledger", reason));
    } catch {
      // unreadable ledger: keep the tier
    }
  }

  async function applyForemanModel(s: Session, ctx: ExtensionContext): Promise<void> {
    const role = s.config.roles.foreman;
    const codemode = role && typeof role.codemode === "boolean" ? role.codemode : get(s.config.config, "roles.foreman.codemode") === true;
    if (codemode) {
      const active = pi.getActiveTools();
      if (!active.includes("codemode")) pi.setActiveTools([...active, "codemode"]);
    }
    if (!role || typeof role.model !== "string") {
      // Only worth a warning when the map names this provider; an empty map is a fresh install.
      const provider = ctx.model?.provider;
      if (role && typeof role.error === "string" && provider && get(s.config.config, `providers.${provider}`)) ctx.ui.notify(`pi-foreman: foreman model not applied: ${role.error}`, "warning");
      return;
    }
    if (userPickedModel) return;
    const spec = role.model;
    const slash = spec.indexOf("/");
    const provider = slash > 0 ? spec.slice(0, slash) : ctx.model?.provider ?? "";
    const modelId = slash > 0 ? spec.slice(slash + 1) : spec;
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model) {
      ctx.ui.notify(`pi-foreman: foreman model ${spec} is not in the model registry; keeping the current model.`, "warning");
    } else {
      applyingModel = true;
      try {
        const ok = await pi.setModel(model);
        if (!ok) ctx.ui.notify(`pi-foreman: no auth for ${provider}; keeping the current model. Log in or set the API key, then /foreman doctor.`, "warning");
      } finally {
        applyingModel = false;
      }
    }
    if (typeof role.thinking === "string" && role.thinking) pi.setThinkingLevel(role.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
  }

  async function registerChildExtensions(s: Session, ctx: ExtensionContext): Promise<void> {
    const extra = normaliseChildExtensions(get(s.config.config, "safety.requiredChildExtensions"), s.agentDir);
    s.childExtensionErrors = extra.errors;
    for (const e of extra.errors) ctx.ui.notify(`pi-foreman: ${e}`, "error");
    // The permission system is required in every child (design section 5): unresolvable = launches refused.
    const ps = resolvePermissionSystem({ agentDir: s.agentDir, cwd: s.cwd, pkgRoot: PKG_ROOT });
    s.permissionSystemError = ps ? undefined : `${PS_PACKAGE} is not installed or not resolvable`;
    if (s.permissionSystemError) ctx.ui.notify(`pi-foreman: ${s.permissionSystemError}. Children would run without permission checks, so launches are blocked. Run the installer (node setup.mjs), restart and run /foreman doctor.`, "error");
    s.childExtensions = [{ id: ADAPTER_ID, path: ENTRY }, { id: GIT_GUARD_ID, path: GIT_GUARD_ENTRY }, ...(ps ? [{ id: PS_CHILD_ID, path: ps }] : []), ...extra.list.filter((e) => e.id !== ADAPTER_ID && e.id !== GIT_GUARD_ID && e.id !== PS_CHILD_ID)];
    try {
      const { fn, via } = await loadRegister();
      s.registration = fn({ sessionId: s.id, extensions: s.childExtensions, requireForAllRunners: true });
      s.registrationVia = via;
    } catch (err) {
      s.registrationError = (err as Error).message;
      ctx.ui.notify(`pi-foreman: could not register required child extensions (${s.registrationError}). Children would run without the guards; run /foreman doctor.`, "error");
    }
  }

  // Fail closed: a child must never start without every required child extension.
  function childLaunchBlock(s: Session, toolName: string): string | undefined {
    if (toolName !== "subagent") return undefined;
    if (!s.registration) {
      return `pi-foreman: required child extensions are not registered${s.registrationError ? ` (${s.registrationError})` : ""}, so children would run without the guards; the launch is blocked. Fix safety.requiredChildExtensions, restart the session and run /foreman doctor.`;
    }
    if (s.permissionSystemError) {
      return `pi-foreman: ${s.permissionSystemError}, so children would run without permission checks; the launch is blocked. Run the installer (node setup.mjs), restart the session and run /foreman doctor.`;
    }
    if (s.childExtensionErrors && s.childExtensionErrors.length > 0) {
      return `pi-foreman: required child extension config has errors (${s.childExtensionErrors.join("; ")}); the launch is blocked. Fix safety.requiredChildExtensions and restart the session.`;
    }
    return undefined;
  }

  /**
   * Role models for the provider the session is on now. The merged config is resolved for the
   * provider at session start; after a model switch to another provider (user, or the foreman
   * model itself) the roles are resolved again for the new one. A failed re-resolve fails closed.
   */
  async function currentRoles(s: Session, ctx: ExtensionContext): Promise<RoleResolution> {
    const provider = ctx.model?.provider;
    if (s.config.source === "cli" && provider !== s.configProvider) {
      const fresh = await loadMergedConfig({ python: pyPath(s), pkgRoot: PKG_ROOT, provider, agentDir: s.agentDir, projectDir: s.cwd, trusted: safeTrusted(ctx), spawner });
      if (fresh.source !== "cli") return { provider, roles: {}, source: "defaults" };
      s.config.roles = fresh.roles;
      s.configProvider = provider;
    }
    return { provider: s.configProvider, roles: s.config.roles, source: s.config.source };
  }

  function payloadCtx(s: Session, ctx: ExtensionContext): PayloadContext {
    let transcriptPath: string | undefined;
    try {
      transcriptPath = ctx.sessionManager.getSessionFile();
    } catch {
      transcriptPath = undefined;
    }
    return { sessionId: s.id, cwd: ctx.cwd, transcriptPath, home: os.homedir() };
  }

  async function run(s: Session, ctx: ExtensionContext, guard: GuardName, payload: unknown, toolFamily: string | null) {
    const env = buildGuardEnv({ base: process.env, coreDir: CORE_DIR, sessionId: s.id, guard, markerDir: s.markerDir, threshold: guard === "ledger_guard_spawn" ? gateThreshold(s.ceremony) : null });
    const started = Date.now();
    const r = guard === "git_guard"
      ? await runGitGuard({ python: pyPath(s), pkgRoot: PKG_ROOT, mode: "main", payload, env, cwd: ctx.cwd, spawner })
      : await runGuard({ python: pyPath(s), coreDir: CORE_DIR, guard, payload, env, cwd: ctx.cwd, spawner });
    const outcome = evaluateRun(guard, r, pyPath(s));
    s.trace?.emit({ event: "guard", guard, toolFamily, decision: outcome.kind === "failure" ? "error" : outcome.d.decision, latencyMs: Date.now() - started });
    return outcome;
  }

  // ------------------------------------------------------------------ events

  pi.on("session_start", async (event, ctx) => {
    const s = await startSession(ctx);
    review.upsert(s.id, { isChild: s.isChild, cwd: s.cwd, provider: ctx.model?.provider, config: () => sessions.get(s.id)?.config.config, registry: ctx.modelRegistry as never, intent: "", trace: (r) => sessions.get(s.id)?.trace?.emit(r), bridgeDrift: () => sessions.get(s.id)?.claudeCfg.pending(s.cwd) ?? [] });
    if (!s.isChild && (event.reason === "startup" || event.reason === "new")) await applyForemanModel(s, ctx);
    await registerChildExtensions(s, ctx);
    const orderNotice = s.isChild ? null : loadOrderNotice(s.cwd, s.agentDir, PKG_ROOT);
    if (orderNotice) notifyOnce(s, ctx, "load-order", orderNotice, "warning");
    const provider = ctx.model?.provider;
    if (!s.isChild && provider && get(s.config.config, `providers.${provider}`)) {
      const registry = ctx.modelRegistry as unknown as RegistryLike;
      for (const gap of modelGaps(s.config.config, provider, registry)) notifyOnce(s, ctx, `model-gap:${gap}`, `pi-foreman: ${gap}; launches that need it fail. Fix the provider map or the login, then run /foreman doctor.`);
      for (const w of familyWarnings(s.config.roles, provider, registry)) notifyOnce(s, ctx, `family:${w}`, w);
    }
    if (fs.existsSync(psProjectConfigPath(s.cwd))) {
      notifyOnce(s, ctx, "ps-project-file", `pi-foreman: ${psProjectConfigPath(s.cwd)} exists. A project permission file can loosen the permission system's rules (it applies once the project is trusted). pi-foreman still enforces its deny rules itself, but put your rules in foreman.json and remove this file. /foreman doctor fails while it exists.`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s) return;
    try {
      s.registration?.dispose();
    } catch {
      // already gone
    }
    s.registration = undefined;
    review.drop(s.id);
    usageFooter.drop(s.id);
    compactionGate.reset(s.id);
    pythonCache.drop(s.id);
    sessions.delete(s.id);
  });

  pi.on("model_select", async (event, ctx) => {
    const sid = sessionFor(ctx)?.id;
    if (sid) review.setProvider(sid, event.model?.provider);
    try {
      bridgeIso.apply(process.env, sessionFor(ctx)?.agentDir ?? piAgentDir(process.env, os.homedir()), isoSetting, event.model?.provider);
    } catch {
      // doctor reports the folder
    }
    const risks = event.model?.provider === BRIDGE_PROVIDER ? projectClaudeRisks(ctx.cwd) : [];
    if (risks.length) ctx.ui.notify(`pi-foreman: project Claude Code config runs in claude-bridge turns: ${risks.join(", ")}. Fix: ${PROJECT_CLAUDE_FIX}`, "error");
    if (applyingModel) return;
    if (event.source === "set" || event.source === "cycle") userPickedModel = true;
    const ms = sessionFor(ctx);
    if (ms && !ms.isChild && event.model?.provider === BRIDGE_PROVIDER && event.previousModel?.provider !== BRIDGE_PROVIDER) {
      const b = await ms.claudeCfg.check(ctx.cwd, "claude-bridge turns", driftAsk(ctx), (r) => ms.trace?.emit(r));
      if (b) ctx.ui.notify(`${b.reason}\nThe next claude-bridge prompt asks again.`, "error");
    }
  });

  // Project Claude Code config drift: ask before a claude-bridge prompt runs (claudedrift.ts).
  pi.on("input", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild || ctx.model?.provider !== BRIDGE_PROVIDER) return { action: "continue" as const };
    const b = await s.claudeCfg.check(ctx.cwd, "this claude-bridge prompt", driftAsk(ctx), (r) => s.trace?.emit(r));
    if (!b) return { action: "continue" as const };
    ctx.ui.notify(b.reason, "error");
    if (!ctx.hasUI) process.stderr.write(`${b.reason}\n`);
    return { action: "handled" as const };
  });

  // Every model request, so every run start: typed/RPC prompts, runs a child's completion
  // notice starts (triggerTurn), follow-ups, steers (R2-H1). Blocking = abort before the request.
  pi.on("context", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild || ctx.model?.provider !== BRIDGE_PROVIDER) return undefined;
    const b = await s.claudeCfg.check(ctx.cwd, "this claude-bridge run", driftAsk(ctx), (r) => s.trace?.emit(r));
    if (!b) return undefined;
    ctx.abort();
    ctx.ui.notify(b.reason, "error");
    if (!ctx.hasUI) process.stderr.write(`${b.reason}\n`);
    pi.sendMessage({ customType: "pi-foreman-blocked", content: `The claude-bridge run was stopped before the model request.\n${b.reason}`, display: true }, { triggerTurn: false });
    return undefined;
  });

  // Compaction and branch summaries on claude-bridge start a separate Claude Code process that
  // re-reads .pi/claude-bridge.json (bridge src/index.ts:576-596); mid-run compaction comes
  // before the next request's `context` event. Cancel on unapproved drift (R3-H1). Effective
  // only when pi-foreman loads before pi-claude-bridge (the doctor checks the order).
  async function bridgeSummaryGate(ctx: ExtensionContext, what: string): Promise<{ cancel: true } | undefined> {
    const s = sessionFor(ctx);
    if (!s || s.isChild || ctx.model?.provider !== BRIDGE_PROVIDER) return undefined;
    const b = await s.claudeCfg.check(ctx.cwd, `this ${what}`, driftAsk(ctx), (r) => s.trace?.emit(r));
    if (!b) return undefined;
    ctx.ui.notify(`${b.reason}\nThe ${what} was cancelled.`, "error");
    if (!ctx.hasUI) process.stderr.write(`${b.reason}\n`);
    return { cancel: true };
  }
  pi.on("session_before_compact", async (_event, ctx) => bridgeSummaryGate(ctx, "claude-bridge compaction summary"));
  pi.on("turn_end", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s) return;
    const cls = compactionGate.decide(s.id, ctx.model, ctx.getContextUsage(), { tiers: get(s.config.config, "compaction.priceTiers"), thresholds: get(s.config.config, "compaction.threshold") });
    if (!cls) return;
    s.trace?.emit({ event: "compact_tier", tier: cls, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null });
    ctx.compact();
  });
  pi.on("session_compact", async (_event, ctx) => { const s = sessionFor(ctx); if (s) compactionGate.reset(s.id); });
  pi.on("session_compact_failed", async (_event, ctx) => { const s = sessionFor(ctx); if (s) compactionGate.reset(s.id); });
  pi.on("session_before_tree", async (_event, ctx) => bridgeSummaryGate(ctx, "claude-bridge branch summary"));

  // A cache-warming refresh re-sends the last request, which on claude-bridge starts Claude Code.
  pi.on("cache_warming_decision", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (s && !s.isChild && ctx.model?.provider === BRIDGE_PROVIDER && s.claudeCfg.pending(ctx.cwd).length) return { action: "stop" as const };
    return undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const s = await ensureSession(ctx);
    s.stopContinued = false;
    review.setIntent(s.id, event.prompt ?? "");
    const signals = promptSignals(event.prompt ?? "", get(s.config.config, "ceremony.heavySignals"));
    if (signals.length) setCeremony(s, escalate(s.ceremony, "heavy", "auto", `heavy signal in the request: ${signals.join(", ")}`));
    if (s.isChild) return;
    if (instructionsCache === undefined) {
      try {
        instructionsCache = fs.readFileSync(path.join(PKG_ROOT, "instructions", "foreman.md"), "utf8");
      } catch {
        instructionsCache = null;
      }
    }
    if (instructionsCache === null) notifyOnce(s, ctx, "instructions", "pi-foreman: instructions/foreman.md is missing; the foreman runs without its rules.");
    const text = [instructionsCache ?? "", tierLine(s.ceremony)].filter(Boolean).join("\n\n");
    event.systemPromptOptions.sections["pi-foreman"] = text;
    s.foremanSection = text;
  });
  // Review S3: a run a custom message starts (wake, child notice) skips before_agent_start, and
  // its later model calls rebuild the prompt from Pi's base options, which lack the section (Pi
  // records a `pi-foreman: null` patch). Event contexts cannot reach the base options, so the
  // request keeps the section: the null patch is dropped from what the provider gets. After a
  // compaction (its stored head lacks the section, review N2) the cached text is put back.
  pi.on("context_with_system", async (event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild) return undefined;
    const messages = keepSection(event.messages, "pi-foreman", s.foremanSection);
    return messages ? { messages } : undefined;
  });
  // Review S12: each run (a wake or child-notice run too) gets its own single stop-gate continue.
  pi.on("agent_settled", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (s) s.stopContinued = false;
  });

  /** Layer 6: while a child's supervisor request is open, only that role's tools (supervisor.ts). */
  function supervisorBlock(s: Session | undefined, toolName: string, input: unknown): { block: true; reason: string } | undefined {
    if (!s) return undefined;
    const hit = s.supervisor.check(toolName, input, (role) => roleToolsFrom(s.config.roles, get(s.config.config, "roles"), role));
    if (!hit) return undefined;
    s.trace?.emit({ event: "supervisor_request", role: hit.role, decision: "blocked_tool", toolFamily: toolName });
    return { block: true, reason: hit.reason };
  }

  for (const channel of RUN_END_EVENTS) {
    pi.events?.on(channel, (data) => {
      for (const s of sessions.values()) {
        s.supervisor.onRunEnd(data);
        endActive(s.activeRuns, data);
      }
    });
  }

  /** Overlay check (see permoverlay.ts); undefined = let the call go on. */
  async function overlayBlock(s: Session, ctx: ExtensionContext, toolName: string, input: Record<string, unknown>) {
    if (!s.overlay) return { block: true as const, reason: OVERLAY_UNAVAILABLE };
    const d = checkToolCall(s.overlay, toolName, input, { cwd: ctx.cwd, home: os.homedir(), platform, role: s.isChild ? "child" : "main" });
    const r = await resolveDecision(d, { isChild: s.isChild, mode: ctx.mode, hasUI: ctx.hasUI, confirm: blockedConfirm(herdrEvents, (title, msg) => ctx.ui.confirm(title, msg)) });
    if (d) s.trace?.emit({ event: "overlay", toolFamily: toolName, decision: r ? (d.kind === "deny" ? "deny" : "ask-denied") : "ask-approved" });
    return r;
  }

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const ps = sessionFor(ctx);
      if (ps && !ps.isChild && ps.activeRuns.size > 0) ps.pollBash++;
    }
    // First of all, before the permission system and the core guards: the overlay's deny/ask rules.
    if (isOverlayTool(event.toolName)) {
      try {
        const blocked = await overlayBlock(await ensureSession(ctx), ctx, event.toolName, event.input as Record<string, unknown>);
        if (blocked) return blocked;
      } catch (err) {
        return { block: true, reason: `pi-foreman: adapter error in the permission overlay (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
      }
    }
    const sup = supervisorBlock(sessionFor(ctx), event.toolName, event.input);
    if (sup) return sup;
    if (event.toolName === INTERCOM_TOOL) {
      try {
        const s = await ensureSession(ctx);
        const reason = intercomBlock(event.toolName, event.input, { isChild: s.isChild, allowRemote: get(s.config.config, "intercom.allowRemote") === true, allowOpenPane: get(s.config.config, "intercom.allowOpenPane") === true });
        s.trace?.emit({ event: "guard", guard: "intercom", toolFamily: "intercom", decision: reason ? "blocked" : "allowed" });
        if (reason) return { block: true, reason };
      } catch (err) {
        return { block: true, reason: `pi-foreman: adapter error in the intercom guard (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
      }
    }
    if (GATED_TOOLS.has(event.toolName)) {
      const triage = await triageBlock(ctx, event.toolName, event.input as Record<string, unknown>);
      if (triage) return triage;
    }
    const mapping = mapTool(event.toolName);
    if (mapping.pre.length === 0) return undefined;
    try {
      const s = await ensureSession(ctx);
      const input = event.input as Record<string, unknown>;
      const blocked = childLaunchBlock(s, event.toolName);
      if (blocked) return { block: true, reason: blocked };
      let notices: string[] = [];
      let rounds: LaunchRounds | undefined;
      let kind: LaunchKind | undefined;
      if (event.toolName === "subagent") {
        // D8: only the adapter writes the pi-foreman usage binding (single launches, below).
        stripBinding(input);
        const resolution = await currentRoles(s, ctx);
        const allowWorkflow = get(s.config.config, "safety.subagents.allowWorkflow") === true;
        const act = subagentActionCheck(input, { allowWorkflow, runs: s.runs, allowed: childRoleIds(get(s.config.config, "roles")), resolution, maxThinking: get(s.config.config, "maxThinking") });
        if (act.block) return { block: true, reason: act.block };
        if (act.unchecked) notifyOnce(s, ctx, `workflow:${act.unchecked}`, `pi-foreman: safety.subagents.allowWorkflow is on; '${act.unchecked}' launches are not checked against the role allowlist or the role map.`);
      }
      if (event.toolName === "subagent" && forceUserScope(input)) notifyOnce(s, ctx, "agentScope", "pi-foreman: child launches use agentScope \"user\" (project agents cannot redefine a role); the requested scope was overridden");
      if (event.toolName === "subagent" && forceDetached(input)) {
        notifyOnce(s, ctx, "detach", "pi-foreman: child launches are always detached; async:false was overridden");
        s.trace?.emit({ event: "detach_override" });
      }
      if (event.toolName === "subagent") {
        const refused = roleLaunchBlock(input, childRoleIds(get(s.config.config, "roles")));
        if (refused) return { block: true, reason: refused };
        const resolution = await currentRoles(s, ctx);
        const noModel = roleModelBlock(input, resolution);
        if (noModel) return { block: true, reason: noModel };
        // D3/D4: builder runs after a review of built work are revision rounds: every step of a
        // tasks/chain call, and a resume of a builder run (its model stays, so never a strong
        // relaunch). Checked here, on the guarded path; a refused launch counts and records nothing.
        const resumed = actionOf(input) === "resume";
        const steps = s.isChild ? [] : roundSteps(input, s.runs);
        let preferStrong = false;
        if (steps.length > 0) {
          rounds = checkLaunch(s.rounds, steps, s.ceremony.tier, get(s.config.config, "ceremony.revisionRounds"));
          if (rounds.block) {
            s.trace?.emit({ event: "revision", role: "builder", tier: s.ceremony.tier, decision: "blocked" });
            return { block: true, reason: rounds.block };
          }
          const revision = rounds.revisions > 0;
          const keyword = typeof input.model === "string" && (STRENGTHS as readonly string[]).includes(splitLevel(input.model.trim()).base);
          preferStrong = revision && !resumed && !keyword && get(s.config.config, `providers.${resolution.provider}.strongOnRevision`) === true;
          kind = revision ? (preferStrong ? "strong-relaunch" : "revision") : undefined;
        }
        const launched = applyLaunchModels(input, resolution.roles, get(s.config.config, "maxThinking"), { tier: s.ceremony.tier, provider: resolution.provider, preferStrong });
        for (const o of launched.overrides) s.trace?.emit({ event: "model_override", role: o.role, model: o.model, requested: o.requested });
        for (const n of launched.notices) s.trace?.emit({ event: "strong_unmapped", role: n.role, model: n.model, tier: s.ceremony.tier });
        notices = launched.notices.map((n) => n.text);
        applyLaunchTimeouts(input, get(s.config.config, "roles"));
      }
      const pc = payloadCtx(s, ctx);
      for (const guard of mapping.pre) {
        let agents: string[] = [];
        if (guard === "destructive_guard") {
          const bad = guardPayloadBlock(event.toolName, input);
          if (bad) return { block: true, reason: bad };
        }
        if (guard === "ledger_guard_spawn") {
          agents = subagentAgents(input);
          setCeremony(s, beforeSpawn(s.ceremony, agents));
        }
        // Children get the git guard in child mode from extensions/git-guard; main mode is the foreman lint.
        if (guard === "git_guard" && (s.isChild || !mainNeedsGitGuard(input.command))) continue;
        if (guard === "git_guard") {
          const drift = await s.gitDrift.gate(ctx.cwd, os.homedir(), "this git command", driftAsk(ctx), (r) => s.trace?.emit(r), event.toolCallId);
          if (drift) return drift;
        }
        const payload = guard === "git_guard" ? gitGuardPayload(event.toolName, input, pc, get(s.config.config, "safety.git")) : preToolPayload(event.toolName, input, pc);
        const outcome = await run(s, ctx, guard, payload, mapping.coreName);
        if (guard === "destructive_guard" && outcome.kind === "decision" && dropDeadPathRewrite(outcome.d, input.command, os.homedir())) {
          s.trace?.emit({ event: "guard_rewrite_dropped", guard, toolFamily: mapping.coreName });
        }
        const target = guard === "ledger_guard_write" ? resolveToolPath(input.path, ctx.cwd, os.homedir()) : null;
        const t = await translateToolCall({
          guard,
          outcome,
          piTool: event.toolName,
          input,
          ask: { isChild: s.isChild, mode: ctx.mode, hasUI: ctx.hasUI, confirm: blockedConfirm(herdrEvents, (title, msg) => ctx.ui.confirm(title, msg)) },
          ledgerTarget: target ? isLedgerTarget(target) : false,
        });
        if (t.openFailure) notifyOnce(s, ctx, `open:${guard}`, t.openFailure);
        if (outcome.kind === "decision" && outcome.d.decision === "ask") s.trace?.emit({ event: "ask", guard, toolFamily: mapping.coreName, decision: askOutcome(s.isChild, t.result?.reason) });
        if (t.result) return t.result;
        if (guard === "ledger_guard_spawn" && agents.length > 0) {
          setCeremony(s, afterSpawn(s.ceremony));
          for (const role of agents) s.trace?.emit({ event: "role_launch", role });
        }
      }
      if (event.toolName === "subagent" && !s.isChild) {
        // Changes since the last launch are checked first, so a new launch cannot absorb them.
        const drift = await s.gitDrift.gate(ctx.cwd, os.homedir(), "this child launch", driftAsk(ctx), (r) => s.trace?.emit(r));
        if (drift) return drift;
        s.gitDrift.snapshot(ctx.cwd, os.homedir());
      }
      // Kept for the tool result only once the launch passed every check.
      if (notices.length > 0) s.launchNotices.set(event.toolCallId, notices);
      if (rounds) {
        s.rounds = rounds.next;
        for (let i = 0; i < rounds.revisions; i++) s.trace?.emit({ event: "revision", role: "builder", tier: s.ceremony.tier, decision: kind });
      }
      if (event.toolName === "subagent") recordLaunchUsage(s, ctx, input, kind);
      return undefined;
    } catch (err) {
      return { block: true, reason: `pi-foreman: adapter error before ${event.toolName} (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const m = event.message as { role?: string; customType?: string; provider?: string; model?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
    if (m.role === "custom") {
      const s = sessionFor(ctx);
      const opened = s?.supervisor.onMessage(event.message);
      if (opened) s?.trace?.emit({ event: "supervisor_request", role: opened.role, decision: "open" });
      const cause = causeOfCustom(m.customType);
      if (s && !s.isChild && cause) s.turn.cause = cause;
      if (s && !s.isChild && cause === "wake") s.turn.wakeKinds = [...new Set((event.message as { details?: { kinds?: unknown[] } }).details?.kinds ?? [])].map(String).join(",");
      if (s && !s.isChild && m.customType === INTERCOM_MESSAGE_TYPE) s.turn.intercomFrom = intercomSender((event.message as { details?: unknown }).details);
      if (s && !s.isChild && m.customType === NOTIFY_TYPE) onCompletionNotice(s, (event.message as { content?: unknown }).content);
    }
    if (m.role !== "assistant") return undefined;
    const s = sessionFor(ctx);
    s?.trace?.emit({ event: "llm", model: m.provider && m.model ? `${m.provider}/${m.model}` : null, tokensIn: m.usage?.input, tokensOut: m.usage?.output, cacheRead: m.usage?.cacheRead, cacheWrite: m.usage?.cacheWrite, cost: m.usage?.cost?.total });
    if (!s) return undefined;
    if (!appendUsage(s.usage.file, usageLine(s.usage.line, event.message))) notifyOnce(s, ctx, "usage", `pi-foreman: could not append to the usage log ${s.usage.file}; /foreman cost will be incomplete.`);
    if (!s.isChild) {
      s.turn.cacheRead += Number(m.usage?.cacheRead) || 0;
      s.turn.cacheWrite += Number(m.usage?.cacheWrite) || 0;
    }
    usageFooter.update(s.id, ctx, event.message, { enabled: get(s.config.config, "footer.usage"), isChild: s.isChild, children: s.launches.size });
    return undefined;
  });

  // Turn cause (D9, measurement only): the last trigger before or during a foreman run.
  pi.on("input", async (event, ctx) => {
    const s = sessionFor(ctx);
    if (s && !s.isChild) s.turn.cause = causeOfInput(event.source, event.text);
    if (s && !s.isChild && s.turn.cause === "intercom") s.turn.intercomFrom = lastIntercomSender(ctx.sessionManager.getBranch()) ?? s.turn.intercomFrom;
    // D3: the owner is back in the loop, so revision rounds count from zero again.
    if (s && !s.isChild && (event.source === "interactive" || event.source === "rpc")) s.rounds = initialRounds();
    return { action: "continue" as const };
  });

  // Intercom turns get a notice only; every gate applies unchanged (ledger item 4).
  pi.on("agent_start", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild || s.turn.cause !== "intercom" || !s.turn.intercomFrom) return;
    if (ctx.mode === "tui" || ctx.mode === "rpc") ctx.ui.notify(`pi-foreman: this turn was started by an intercom message from ${s.turn.intercomFrom}`, "info");
  });

  pi.on("agent_end", async (_event, ctx) => {
    const s = sessionFor(ctx);
    if (!s || s.isChild) return;
    s.trace?.emit({ event: "turn", cause: s.turn.cause, cacheRead: s.turn.cacheRead, cacheWrite: s.turn.cacheWrite, wakeKinds: s.turn.cause === "wake" ? s.turn.wakeKinds : undefined, pollBash: s.pollBash || undefined });
    s.pollBash = 0;
    s.turn = { cause: "other", cacheRead: 0, cacheWrite: 0 };
  });

  /** D3: a detached child's completion notice; a finished review of built work may open a round. */
  function onCompletionNotice(s: Session, content: unknown): void {
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n") : "";
    const reviews = completedAgents(text).filter((a) => REVIEW_ROLES.includes(a));
    if (reviews.length === 0) return;
    const verdict = verdictOf(text);
    s.rounds = onReviewDone(s.rounds, verdict);
    for (const role of reviews) s.trace?.emit({ event: "review_done", role, decision: verdict ?? "no-verdict" });
  }

  /** D10: the foreman's own file changes inside the workspace need a trivial triage. */
  async function triageBlock(ctx: ExtensionContext, toolName: string, input: Record<string, unknown>): Promise<{ block: true; reason: string } | undefined> {
    try {
      const s = await ensureSession(ctx);
      if (s.isChild || get(s.config.config, "ceremony.requireTriage") === false) return undefined;
      const reason = triageGateBlock(toolName, input, s.ceremony, { cwd: ctx.cwd, home: os.homedir(), platform });
      if (!reason) return undefined;
      s.trace?.emit({ event: "triage_gate", toolFamily: toolName, tier: s.ceremony.tier, decision: "blocked" });
      return { block: true, reason };
    } catch (err) {
      return { block: true, reason: `pi-foreman: adapter error in the triage gate (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
    }
  }

  /** D8: give a single-child launch its usage binding (role, launch id, kind) through extensionBindings. */
  function recordLaunchUsage(s: Session, ctx: ExtensionContext, input: Record<string, unknown>, kind?: LaunchKind): void {
    const role = singleLaunchRole(input);
    if (!role) return;
    const model = typeof input.model === "string" && input.model ? input.model : null;
    const b = recordUsageLaunch(s.launches, { foremanSession: s.usage.line.foremanSession, workspace: s.usage.line.workspace, role, model, kind, activeProvider: ctx.model?.provider });
    bindLaunch(input, b);
  }

  pi.on("tool_result", async (event, ctx) => {
    sessionFor(ctx)?.gitDrift.after(ctx.cwd, os.homedir(), event.toolCallId);
    if (event.toolName === SUPERVISOR_TOOL) {
      const s = sessionFor(ctx);
      const closed = s?.supervisor.onSupervisorResult(event.details, event.isError);
      if (closed) s?.trace?.emit({ event: "supervisor_request", role: closed.role, decision: "replied" });
    }
    if (event.toolName === "subagent") {
      const s = sessionFor(ctx);
      if (s) {
        recordLaunch(s.runs, event.input, event.details, event.isError);
        trackActive(s.activeRuns, event.input, event.details, event.isError);
      }
      for (const role of subagentAgents(event.input as Record<string, unknown>)) s?.trace?.emit({ event: "role_result", role, exit: event.isError ? 1 : 0, pollBash: s.pollBash || undefined });
      if (s) s.pollBash = 0;
      const notices = s?.launchNotices.get(event.toolCallId);
      if (s && notices) {
        s.launchNotices.delete(event.toolCallId);
        // subagent has no post guards (toolmap.ts), so the amended result can be returned here.
        return { content: [...notices.map((text) => ({ type: "text" as const, text })), ...event.content] };
      }
    }
    const mapping = mapTool(event.toolName);
    const changed = event.isError ? undefined : changedFileOf(event.toolName, event.input as Record<string, unknown>);
    if ((mapping.post.length === 0 && changed === undefined) || event.isError) return undefined;
    try {
      const s = await ensureSession(ctx);
      const input = event.input as Record<string, unknown>;
      for (const guard of mapping.post) {
        const outcome = await run(s, ctx, guard, postToolPayload(event.toolName, input, payloadCtx(s, ctx), event.isError), mapping.coreName);
        if (outcome.kind === "failure") notifyOnce(s, ctx, `open:${guard}`, outcome.message);
      }
      const file = resolveToolPath(changed, ctx.cwd, os.homedir());
      if (file) {
        const heavy = Number(get(s.config.config, "ceremony.heavyFileCount"));
        setCeremony(s, onFileChanged(s.ceremony, file, Number.isFinite(heavy) ? heavy : 0));
      }
      refreshLedgerTier(s);
    } catch {
      // side effects only
    }
    return undefined;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed") return undefined;
    const s = await ensureSession(ctx);
    const outcome = await run(s, ctx, "ledger_guard_stop", stopPayload(payloadCtx(s, ctx), s.stopContinued), "Stop");
    const r = translateStop(outcome);
    if (r.openFailure) notifyOnce(s, ctx, "open:ledger_guard_stop", r.openFailure);
    if (!r.hold) return undefined;
    s.stopContinued = true;
    s.trace?.emit({ event: "stop_hold", guard: "ledger_guard_stop", decision: "continue" });
    return {
      entries: [...event.entries, { type: "custom_message" as const, customType: "pi-foreman-stop-gate", content: r.reason ?? "", display: true }],
      continue: true,
    };
  });

  // ------------------------------------------------------------------- tools

  registerSafeOps(pi, {
    isChild: process.env.PI_SUBAGENT_CHILD === "1",
    session: async (ctx) => {
      const s = await ensureSession(ctx);
      return { python: pyPath(s), isChild: s.isChild, opsConfig: get(s.config.config, "safety.ops"), trace: (r) => s.trace?.emit(r) };
    },
    script: path.join(PKG_ROOT, "scripts", "safe_ops.py"),
    preflight: async (ctx, op, callId) => {
      const s = await ensureSession(ctx);
      return safeOpDriftPreflight(s.gitDrift, s.isChild, ctx.cwd, os.homedir(), op, driftAsk(ctx), (r) => s.trace?.emit(r), callId);
    },
    spawner,
    env: () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
  });

  // D9 long wait (wait.ts): foreman only; the wake is an ordinary custom message (no gate bypass).
  const waits = registerWait(pi, {
    home: os.homedir(),
    platform,
    session: async (ctx) => {
      const s = await ensureSession(ctx);
      return { id: s.id, isChild: s.isChild, cwd: s.cwd, agentDir: s.agentDir, overlay: s.overlay, config: () => s.config.config, trace: (r) => s.trace?.emit(r) };
    },
  });

  // D5 remote close (close.ts): `/foreman close` and a parent's intercom `foreman:close`; an ordinary close turn.
  const close = registerClose(pi, {
    platform,
    activeWaits: (id) => waits.active(id),
    activeRuns: (id) => sessions.get(id)?.activeRuns.size ?? 0,
    session: async (ctx) => {
      const s = await ensureSession(ctx);
      return { id: s.id, isChild: s.isChild, cwd: s.cwd, config: () => s.config.config, trace: (r) => s.trace?.emit(r), markCause: () => void (s.turn.cause = "close"), runSync: (c) => runSync(s, c), retro: async (c) => (await runScript(s, "foreman_retro.py", retroInputs(s, c, "--session"))).text };
    },
  });

  // D10: the foreman records its triage; children never get the tool.
  if (process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.registerTool({
      name: TRIAGE_TOOL,
      label: "Record the tier",
      description: "Record the ceremony tier of the current task (trivial, standard or heavy) with a one-line reason, before acting. Required before you change workspace files yourself: only a trivial tier allows that; at standard or heavy a builder makes the changes. Never lowers a tier that is already recorded or escalated.",
      parameters: { type: "object", properties: { tier: { type: "string", enum: ["trivial", "standard", "heavy"] }, reason: { type: "string", minLength: 1, description: "Why this tier, in one line." } }, required: ["tier", "reason"], additionalProperties: false } as never,
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const s = await ensureSession(ctx);
        const refuse = (text: string) => ({ content: [{ type: "text" as const, text }], details: { decision: "refused" }, isError: true });
        if (s.isChild) return refuse(`${TRIAGE_TOOL} is for the foreman only.`);
        const tier = params.tier;
        if (!isTier(tier)) return refuse(`${TRIAGE_TOOL}: tier must be trivial, standard or heavy.`);
        const r = foremanTriage(s.ceremony, tier, typeof params.reason === "string" ? params.reason.slice(0, 200) : "");
        if ("error" in r) {
          s.trace?.emit({ event: "triage", tier, decision: "refused" });
          return refuse(r.error);
        }
        setCeremony(s, r.state);
        s.trace?.emit({ event: "triage", tier, decision: "recorded" });
        return { content: [{ type: "text" as const, text: `${tierLine(s.ceremony)} ${triageAdvice(tier)}` }], details: { decision: "recorded", tier } };
      },
    } as never);
  }

  // ---------------------------------------------------------------- commands

  pi.registerCommand("ceremony", {
    description: "Show or set the ceremony tier: /ceremony [trivial|standard|heavy]",
    handler: async (args, ctx) => {
      const s = await ensureSession(ctx);
      const want = args.trim().toLowerCase();
      if (!want) {
        ctx.ui.notify(tierLine(s.ceremony), "info");
        return;
      }
      if (!isTier(want)) {
        ctx.ui.notify("Usage: /ceremony trivial|standard|heavy", "warning");
        return;
      }
      setCeremony(s, userOverride(s.ceremony, want));
      ctx.ui.notify(tierLine(s.ceremony), "info");
    },
  });

  /** Run one scripts/*.py of the package with the resolved interpreter; the text to show. */
  async function runScript(s: Session, script: string, args: string[], timeoutMs = 60_000): Promise<{ text: string; ok: boolean }> {
    const py = pyPath(s);
    if (!py) return { text: `${script}: no usable Python (run /foreman doctor).`, ok: false };
    const r = await spawner(py, ["-E", "-s", path.join(PKG_ROOT, "scripts", script), ...args], { timeoutMs, cwd: s.cwd });
    const text = (r.stdout.trim() || r.stderr.trim() || `${script} produced no output.`);
    return { text, ok: !r.error && !r.timedOut && r.code === 0 };
  }

  pi.registerCommand("retro", {
    description: "Friction metrics of this session and permission-allow proposals (foreman only)",
    handler: async (_args, ctx) => {
      const s = await ensureSession(ctx);
      if (s.isChild) {
        ctx.ui.notify("/retro is for the foreman only.", "warning");
        return;
      }
      const day = new Date().toISOString().slice(0, 10);
      const args = [...retroInputs(s, ctx, "--session"), "--proposals-out", path.join(s.agentDir, "pi-foreman", "state", "retro", `permission-proposals-${day}.json`)];
      const r = await runScript(s, "foreman_retro.py", args);
      ctx.ui.notify(r.text, r.ok ? "info" : "error");
    },
  });

  /** Retro inputs of this session (agent dir, review log, usage, session file, trace). */
  function retroInputs(s: Session, ctx: ExtensionContext, sessionFlag: string): string[] {
    const args = ["--agent-dir", s.agentDir, "--review-log", path.join(s.agentDir, "extensions", "pi-permission-system", "logs", "pi-permission-system-permission-review.jsonl"), "--usage", s.usage.file];
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) args.push(sessionFlag, sessionFile);
    if (s.trace) args.push("--trace", s.trace.file);
    return args;
  }

  /** scripts/foreman_sync.py for this session (/sync and remote close). */
  function runSync(s: Session, ctx: ExtensionContext): Promise<{ text: string; ok: boolean }> {
    const args = ["--cwd", s.cwd, "--state", path.join(s.agentDir, "pi-foreman", "state"), "--session", s.id, ...retroInputs(s, ctx, "--session-file")];
    if (safeTrusted(ctx)) args.push("--trusted-project");
    return runScript(s, "foreman_sync.py", args, 600_000);
  }

  pi.registerCommand("sync", {
    description: "Pull, commit (explicit paths) and push the configured sync.repos, then the retro (foreman only)",
    handler: async (_args, ctx) => {
      const s = await ensureSession(ctx);
      if (s.isChild) {
        ctx.ui.notify("/sync is for the foreman only.", "warning");
        return;
      }
      await syncCommand({ activeRuns: s.activeRuns.size, run: () => runSync(s, ctx), notify: (t, l) => ctx.ui.notify(t, l) });
    },
  });

  pi.registerCommand("foreman", {
    description: "pi-foreman commands: /foreman doctor | /foreman cost [workspace] | /foreman update-check | /foreman close [result-path]",
    handler: async (args, ctx) => {
      const [sub = "", ...rest] = args.trim().split(/\s+/);
      if (sub === "close") return close.command(args.trim().slice(sub.length), ctx);
      if (sub === "cost") {
        const s = await ensureSession(ctx);
        const ws = rest.join(" ").trim();
        const wsPath = ws ? workspaceOf(path.resolve(ctx.cwd, ws)).root : "";
        const lines = ws ? readUsage(s.agentDir, { workspace: wsPath }) : readUsage(s.agentDir, { session: s.usage.line.foremanSession });
        const title = ws ? `pi-foreman cost: all sessions in ${wsPath}` : `pi-foreman cost: session ${s.usage.line.foremanSession}`;
        ctx.ui.notify(formatSummary(aggregate(lines), title), "info");
        return;
      }
      if (sub === "update-check") {
        const r = await runScript(await ensureSession(ctx), "foreman_update_check.py", []);
        ctx.ui.notify(r.text, r.ok ? "info" : "error");
        return;
      }
      if (sub !== "doctor") {
        ctx.ui.notify("Usage: /foreman doctor | /foreman cost [workspace] | /foreman update-check | /foreman close [result-path]", "warning");
        return;
      }
      const s = await ensureSession(ctx);
      const lines = await doctor(s, ctx);
      const failed = lines.some((l) => l.startsWith("FAIL"));
      ctx.ui.notify(["pi-foreman doctor", ...lines].join("\n"), failed ? "error" : "info");
    },
  });

  async function doctor(s: Session, ctx: ExtensionContext): Promise<string[]> {
    const out: string[] = [];
    const ok = (m: string): void => void out.push(`OK   ${m}`);
    const fail = (m: string, fix: string): void => void out.push(`FAIL ${m} — fix: ${fix}`);

    if (s.python.ok) ok(`Python ${s.python.info.version.join(".")} at ${s.python.info.executable} (${s.python.info.source})`);
    else fail(`no Python ≥ 3.9 (tried: ${s.python.rejected.join("; ") || "nothing"})`, NO_PYTHON_FIX.replace(/; run \/foreman doctor\.$/, "."));
    for (const r of s.python.rejected) if (r.includes("inside the workspace")) out.push(`INFO Python candidate ${r}: the guards never run on an interpreter or venv a child can write; use one outside the project (python.path in your user foreman.json or PI_FOREMAN_PYTHON).`);

    if (fs.existsSync(path.join(CORE_DIR, "scripts", "destructive_guard.py"))) ok(`core scripts at ${CORE_DIR}`);
    else fail(`core scripts missing under ${CORE_DIR}`, "reinstall pi-foreman (core/ is vendored with the package).");

    if (s.config.source === "defaults") fail("config CLI did not run; L1 defaults in use", "fix Python first, then check scripts/foreman_config.py.");
    else if (s.config.errors.length) fail(`config errors: ${s.config.errors.join("; ")}`, "correct the named keys in your foreman.json.");
    else ok(`config loaded (${s.config.warnings.length} warning(s)${s.config.warnings.length ? ": " + s.config.warnings.join("; ") : ""})`);

    const generated = await generateSubagents({ python: pyPath(s), pkgRoot: PKG_ROOT, agentDir: s.agentDir, projectDir: s.cwd, trusted: safeTrusted(ctx), spawner });
    let settings: Record<string, unknown> | null = null;
    try {
      settings = JSON.parse(fs.readFileSync(path.join(s.agentDir, "settings.json"), "utf8"));
    } catch {
      settings = null;
    }
    if (!generated) fail("could not generate the subagents block", "fix Python/config first.");
    else {
      const have = (settings?.subagents ?? {}) as Record<string, unknown>;
      const keys = ["agentOverridesByProvider", "agentOverrides", "forceTopLevelAsync"];
      const same = keys.every((k) => canonical(have[k] ?? null) === canonical((generated as Record<string, unknown>)[k] ?? null));
      if (same) ok("generated subagents block in settings.json is in sync");
      else fail("subagents block in settings.json differs from generate-subagents", "run /foreman apply or the installer to regenerate it.");
    }

    for (const e of s.childExtensions) {
      if (fs.existsSync(e.path) && fs.statSync(e.path).isFile()) ok(`required child extension ${e.id}: ${e.path}`);
      else fail(`required child extension ${e.id} not found at ${e.path}`, "install the package or correct safety.requiredChildExtensions.");
    }
    if (s.registration) ok(`required child extensions registered (${s.registrationVia}, requireForAllRunners)`);
    else fail(`required child extensions not registered${s.registrationError ? `: ${s.registrationError}` : ""}`, "check the paths above and restart the session.");
    out.push(`INFO required child extension registration path: ${registrationPathLabel(s.registrationVia)}`);

    const providers = get(s.config.config, "providers");
    const names = providers && typeof providers === "object" ? Object.keys(providers as object).filter((p) => p !== "allowed") : [];
    if (names.length === 0) out.push("INFO no providers in the provider map");
    for (const p of names) {
      let configured = false;
      try {
        configured = ctx.modelRegistry.getProviderAuthStatus(p).configured;
      } catch {
        configured = false;
      }
      if (configured) ok(`auth for provider ${p}`);
      else fail(`no auth for provider ${p}`, `run /login ${p} or set its API key environment variable.`);
      const missing = modelGaps(s.config.config, p, ctx.modelRegistry as unknown as RegistryLike).filter((g) => g.startsWith("model "));
      for (const g of missing) fail(g, "correct the model id in the provider map; Pi's model list shows what the registry has.");
      if (missing.length === 0) ok(`every model mapped for ${p} is in the model registry`);
    }

    if (isolationOn(isoSetting, ctx.model?.provider)) out.push(...isolationDoctor({ dir: isolationDir(s.agentDir), env: process.env, platform }));
    if (ctx.model?.provider === BRIDGE_PROVIDER) {
      const risks = projectClaudeRisks(s.cwd);
      if (risks.length) fail(`project Claude Code config runs in claude-bridge turns: ${risks.join(", ")}`, PROJECT_CLAUDE_FIX);
      else ok("no project Claude Code hooks, command helpers or .mcp.json");
    }
    const bridgeCfg = projectBridgeConfigRisks(s.cwd);
    if (bridgeCfg.length) fail(`project claude-bridge config: ${bridgeCfg.join(", ")}`, PROJECT_BRIDGE_FIX);
    else ok("no executable path, AskClaude or strictMcpConfig false in .pi/claude-bridge.json");
    const userBridge = userBridgeConfigRisks(s.agentDir);
    const userBridgeFile = path.join(s.agentDir, "claude-bridge.json");
    if (userBridge.fail.length) fail(`user claude-bridge config ${userBridgeFile}: ${userBridge.fail.join(", ")}`, "remove them unless you meant them: AskClaude runs Claude Code with the project's settings and bypassPermissions, and strictMcpConfig false loads project MCP servers in every bridge turn.");
    if (userBridge.warn.length) out.push(`WARN user claude-bridge config ${userBridgeFile} sets ${userBridge.warn.join(", ")}: claude-bridge starts that program for every turn and summary. Fine if you set it on purpose; pi-foreman asks before bridge use when this file changes.`);
    if (!userBridge.fail.length && !userBridge.warn.length) ok("no executable path, AskClaude or strictMcpConfig false in the user claude-bridge config");
    let projectSettings: Record<string, unknown> | null = null;
    try {
      projectSettings = JSON.parse(fs.readFileSync(path.join(s.cwd, ".pi", "settings.json"), "utf8"));
    } catch {
      projectSettings = null;
    }
    const order = bridgeLoadOrder(projectSettings?.packages, settings?.packages, PKG_ROOT, path.join(s.cwd, ".pi"), s.agentDir);
    if (order === "bridge-first") fail("pi-claude-bridge loads before pi-foreman, so its compaction and branch-summary takeover runs before pi-foreman's config-drift check", "list pi-foreman before pi-claude-bridge in settings.json packages.");
    else if (order === "foreman-first") ok("pi-foreman loads before pi-claude-bridge (the drift check precedes the bridge's summaries)");
    else if (order === "unknown") out.push("INFO load order of pi-foreman and pi-claude-bridge not found in settings.json packages");
    out.push(...intercomDoctor(s.agentDir, [settings?.packages, projectSettings?.packages]));
    const rt = reviewTarget(s.config.config, ctx.model?.provider);
    if (!rt) out.push(`WARN no review model for provider ${ctx.model?.provider ?? "(none)"}: model review (${REVIEW_LINK}) is off, every ask goes to you — set providers.<p>.review.model in foreman.json`);
    else if (!ctx.modelRegistry.find(rt.provider, rt.modelId)) fail(`review model ${rt.provider}/${rt.modelId} not in the model registry; asks go to you`, "correct providers.<p>.review.model.");
    else ok(`model review: ${rt.provider}/${rt.modelId} (timeout ${rt.timeoutMs} ms)`);
    if (s.permissionSystemError) fail(s.permissionSystemError, "run the installer (node setup.mjs); the package is pinned in packages.lock.json.");
    else ok(`permission system resolvable (${PS_PACKAGE})`);
    if (s.overlay) ok(`permission overlay active (${s.overlay.bashDeny.length} command deny, ${s.overlay.pathRules.length} path rules, ${s.overlay.bashAsk.length + s.overlay.pathAsk.length} project/session ask)`);
    else fail("permission overlay baseline unreadable (shell and file tools are blocked)", "reinstall pi-foreman: config/permissions.baseline.json is part of the package.");
    if (fs.existsSync(psProjectConfigPath(s.cwd))) fail(`project permission file ${psProjectConfigPath(s.cwd)} exists; it can loosen the permission system's rules`, "delete it and put your rules in foreman.json (the overlay still enforces denies, but asks and allows would be affected).");
    else ok("no project permission file");
    for (const sh of shadowedRoles(s.cwd, childRoleIds(get(s.config.config, "roles")))) out.push(`WARN project agent shadows a role (${sh}) — fix: ${SHADOW_FIX}`);
    const wanted = await renderPermissions({ python: pyPath(s), pkgRoot: PKG_ROOT, agentDir: s.agentDir, cwd: s.cwd, spawner });
    const pf = permFileState(s.agentDir, wanted);
    if (pf.state === "ok") ok("generated permission-system config is in sync");
    else if (pf.state === "missing") fail("generated permission-system config is missing", "run the installer (node setup.mjs).");
    else if (pf.state === "unreadable") fail("generated permission-system config is not valid JSON", "run the installer (node setup.mjs); it backs the file up first.");
    else if (pf.state === "stale") fail(`generated permission-system config is out of date: ${pf.detail}`, "run the installer (node setup.mjs).");
    else fail(`generated permission-system config was edited: ${pf.detail}. The installer owns this file`, "put your rules in foreman.json (safety.permissions) and run the installer; it backs the edited file up.");

    if (fs.existsSync(markerPath(s.markerDir, s.id))) ok(`session marker in ${s.markerDir}`);
    else fail("session marker missing", `make ${s.markerDir} writable and restart the session.`);
    out.push(`INFO ceremony: ${tierLine(s.ceremony)}`);
    return out;
  }
}

/** Trace label for a core-guard ask, from the translated block reason (undefined = approved). */
function askOutcome(isChild: boolean, reason: string | undefined): string {
  if (reason === undefined) return "approved";
  if (isChild) return "child";
  if (reason.startsWith("Denied by the user.")) return "denied";
  return "no-ui";
}

function driftAsk(ctx: ExtensionContext) {
  return { mode: ctx.mode, hasUI: ctx.hasUI, confirm: blockedConfirm(herdrEvents, (title, msg) => ctx.ui.confirm(title, msg)) };
}

function safeTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

