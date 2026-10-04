// pi-foreman core adapter: wires the vendored Python core into Pi (design §§5-7, 9).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterSpawn, beforeSpawn, escalate, gateThreshold, initialCeremony, isTier, ledgerTier, onFileChanged, promptSignals, tierLine, userOverride } from "./ceremony.ts";
import type { CeremonyState } from "./ceremony.ts";
import { canonical, generateSubagents, get, loadMergedConfig, pythonPathHint } from "./config.ts";
import type { MergedConfig } from "./config.ts";
import { loadRegister, normaliseChildExtensions, registrationPathLabel } from "./childext.ts";
import { buildOverlayRules, checkToolCall, isOverlayTool, OVERLAY_UNAVAILABLE, readBaseline, resolveDecision } from "./permoverlay.ts";
import type { OverlayRules } from "./permoverlay.ts";
import { permFileState, PS_CHILD_ID, PS_PACKAGE, psProjectConfigPath, renderPermissions, resolvePermissionSystem } from "./permsys.ts";
import type { Registration } from "./childext.ts";
import { forceDetached } from "./detach.ts";
import { recordLaunch, subagentActionCheck } from "./actions.ts";
import type { RunRegistry } from "./actions.ts";
import { dropDeadPathRewrite, guardPayloadBlock } from "./guardgaps.ts";
import { RUN_END_EVENTS, SUPERVISOR_TOOL, SupervisorWindow, roleToolsFrom } from "./supervisor.ts";
import { gitGuardPayload, mainNeedsGitGuard, runGitGuard } from "./gitguard.ts";
import { childRoleIds, roleLaunchBlock, roleModelBlock } from "./roles.ts";
import { BridgeIsolation, isolationDir, isolationDoctor, isolationOn } from "./bridgeiso.ts";
import { applyLaunchModels } from "./launchmodel.ts";
import { ForemanReview, REVIEW_LINK, reviewTarget } from "./review.ts";
import type { RoleResolution } from "./roles.ts";
import { buildGuardEnv, patchShellEnv, piAgentDir } from "./env.ts";
import { patchChildGitEnv } from "./childenv.ts";
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
  notified: Set<string>;
  trace: TraceWriter | null;
  /** Runs this session launched (resume provenance, actions.ts). */
  runs: RunRegistry;
  /** Open child supervisor requests (supervisor.ts). */
  supervisor: SupervisorWindow;
}

export interface AdapterDeps {
  spawner?: Spawner;
  platform?: string;
}

export default function coreAdapter(pi: ExtensionAPI, deps: AdapterDeps = {}): void {
  const spawner = deps.spawner ?? defaultSpawner;
  const platform = deps.platform ?? process.platform;
  const pythonCache = new PythonCache();
  const sessions = new Map<string, Session>();
  let userPickedModel = false;
  let applyingModel = false;
  let instructionsCache: string | null | undefined;
  const bridgeIso = new BridgeIsolation();
  const review = new ForemanReview();
  pi.events?.on("permissions:ready", (payload: unknown) => review.onReady(payload));
  let isoSetting: unknown = "auto";
  const baseline = readBaseline(PKG_ROOT);

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
    let python = await pythonCache.get(id, () => resolvePython({ configPath: hint, envPath: ORIGINAL_PI_FOREMAN_PYTHON, platform, spawner }));
    const provider = ctx.model?.provider;
    const config = await loadMergedConfig({ python: python.ok ? python.info.executable : null, pkgRoot: PKG_ROOT, provider, agentDir, projectDir: cwd, trusted, spawner });
    const merged = get(config.config, "python.path");
    if (typeof merged === "string" && merged.trim() && merged !== hint) {
      // python.path came from a layer the hint does not read (L3): honour it.
      pythonCache.drop(id);
      python = await pythonCache.get(id, () => resolvePython({ configPath: merged, envPath: ORIGINAL_PI_FOREMAN_PYTHON, platform, spawner }));
    }

    const s: Session = {
      id,
      cwd,
      isChild: process.env.PI_SUBAGENT_CHILD === "1",
      agentDir,
      markerDir,
      python,
      config,
      configProvider: provider,
      overlay: baseline ? buildOverlayRules(baseline, get(config.config, "safety.permissions"), config.basePermissions, agentDir) : null,
      ceremony: initialCeremony(get(config.config, "ceremony.default")),
      childExtensions: [],
      stopContinued: false,
      notified: new Set(),
      runs: new Map(),
      supervisor: new SupervisorWindow(),
      trace: openTrace({ enabled: get(config.config, "trace.enabled"), dir: get(config.config, "trace.dir"), stateDir: markerDir, sessionId: id }),
    };
    sessions.set(id, s);
    isoSetting = get(config.config, "bridge.isolateClaudeConfig");
    try {
      bridgeIso.apply(process.env, agentDir, isoSetting, provider);
    } catch (err) {
      ctx.ui.notify(`pi-foreman: could not prepare the bridge config folder (${(err as Error).message}).`, "warning");
    }
    s.trace?.emit({ event: "session_start", role: s.isChild ? "child" : "foreman", model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, tier: s.ceremony.tier });

    try {
      ensureSessionMarker(markerDir, id, Date.now() / 1000);
    } catch (err) {
      ctx.ui.notify(`pi-foreman: could not write the session marker in ${markerDir} (${(err as Error).message}); the ledger gates treat this session as unbound.`, "warning");
    }
    refreshLedgerTier(s);
    patchShellEnv({ env: process.env, binDir: BIN_DIR, python: pyPath(s), markerDir });
    if (s.isChild && get(config.config, "safety.children.mayPush") !== true) patchChildGitEnv(process.env);

    if (!python.ok) ctx.ui.notify(`pi-foreman: no Python ≥ 3.9 found — shell commands and subagent launches are blocked until it is fixed. ${NO_PYTHON_FIX}`, "error");
    for (const e of config.errors) ctx.ui.notify(e, "error");
    if (config.safetyFallback && config.source === "cli") ctx.ui.notify("pi-foreman: invalid safety config; L1 safety values apply.", "warning");
    for (const w of config.warnings) ctx.ui.notify(`pi-foreman config: ${w}`, "warning");
    return s;
  }

  /** Every tier change goes through here so the trace sees it. */
  function setCeremony(s: Session, next: CeremonyState): void {
    const before = s.ceremony.tier;
    s.ceremony = next;
    if (next.tier !== before) s.trace?.emit({ event: "tier", tier: next.tier });
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
    review.upsert(s.id, { isChild: s.isChild, cwd: s.cwd, provider: ctx.model?.provider, config: () => sessions.get(s.id)?.config.config, registry: ctx.modelRegistry as never, intent: "", trace: (r) => sessions.get(s.id)?.trace?.emit(r) });
    if (!s.isChild && (event.reason === "startup" || event.reason === "new")) await applyForemanModel(s, ctx);
    await registerChildExtensions(s, ctx);
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
    if (applyingModel) return;
    if (event.source === "set" || event.source === "cycle") userPickedModel = true;
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
      for (const s of sessions.values()) s.supervisor.onRunEnd(data);
    });
  }

  /** Overlay check (see permoverlay.ts); undefined = let the call go on. */
  async function overlayBlock(s: Session, ctx: ExtensionContext, toolName: string, input: Record<string, unknown>) {
    if (!s.overlay) return { block: true as const, reason: OVERLAY_UNAVAILABLE };
    const d = checkToolCall(s.overlay, toolName, input, { cwd: ctx.cwd, home: os.homedir(), platform });
    const r = await resolveDecision(d, { isChild: s.isChild, mode: ctx.mode, hasUI: ctx.hasUI, confirm: (title, msg) => ctx.ui.confirm(title, msg) });
    if (d) s.trace?.emit({ event: "overlay", toolFamily: toolName, decision: r ? (d.kind === "deny" ? "deny" : "ask-denied") : "ask-approved" });
    return r;
  }

  pi.on("tool_call", async (event, ctx) => {
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
    const mapping = mapTool(event.toolName);
    if (mapping.pre.length === 0) return undefined;
    try {
      const s = await ensureSession(ctx);
      const input = event.input as Record<string, unknown>;
      const blocked = childLaunchBlock(s, event.toolName);
      if (blocked) return { block: true, reason: blocked };
      if (event.toolName === "subagent") {
        const resolution = await currentRoles(s, ctx);
        const allowWorkflow = get(s.config.config, "safety.subagents.allowWorkflow") === true;
        const act = subagentActionCheck(input, { allowWorkflow, runs: s.runs, allowed: childRoleIds(get(s.config.config, "roles")), resolution, maxThinking: get(s.config.config, "maxThinking") });
        if (act.block) return { block: true, reason: act.block };
        if (act.unchecked) notifyOnce(s, ctx, `workflow:${act.unchecked}`, `pi-foreman: safety.subagents.allowWorkflow is on; '${act.unchecked}' launches are not checked against the role allowlist or the role map.`);
      }
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
        for (const o of applyLaunchModels(input, resolution.roles, get(s.config.config, "maxThinking"))) {
          s.trace?.emit({ event: "model_override", role: o.role, model: o.model });
        }
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
          ask: { isChild: s.isChild, mode: ctx.mode, hasUI: ctx.hasUI, confirm: (title, msg) => ctx.ui.confirm(title, msg) },
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
      return undefined;
    } catch (err) {
      return { block: true, reason: `pi-foreman: adapter error before ${event.toolName} (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const m = event.message as { role?: string; provider?: string; model?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } };
    if (m.role === "custom") {
      const s = sessionFor(ctx);
      const opened = s?.supervisor.onMessage(event.message);
      if (opened) s?.trace?.emit({ event: "supervisor_request", role: opened.role, decision: "open" });
    }
    if (m.role !== "assistant") return undefined;
    sessionFor(ctx)?.trace?.emit({ event: "llm", model: m.provider && m.model ? `${m.provider}/${m.model}` : null, tokensIn: m.usage?.input, tokensOut: m.usage?.output, cost: m.usage?.cost?.total });
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === SUPERVISOR_TOOL) {
      const s = sessionFor(ctx);
      const closed = s?.supervisor.onSupervisorResult(event.details, event.isError);
      if (closed) s?.trace?.emit({ event: "supervisor_request", role: closed.role, decision: "replied" });
    }
    if (event.toolName === "subagent") {
      const s = sessionFor(ctx);
      if (s) recordLaunch(s.runs, event.input, event.details, event.isError);
      for (const role of subagentAgents(event.input as Record<string, unknown>)) s?.trace?.emit({ event: "role_result", role, exit: event.isError ? 1 : 0 });
    }
    const mapping = mapTool(event.toolName);
    if (mapping.post.length === 0 || event.isError) return undefined;
    try {
      const s = await ensureSession(ctx);
      const input = event.input as Record<string, unknown>;
      for (const guard of mapping.post) {
        const outcome = await run(s, ctx, guard, postToolPayload(event.toolName, input, payloadCtx(s, ctx), event.isError), mapping.coreName);
        if (outcome.kind === "failure") notifyOnce(s, ctx, `open:${guard}`, outcome.message);
      }
      const file = resolveToolPath(input.path, ctx.cwd, os.homedir());
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
    spawner,
    env: () => Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string")),
  });

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

  pi.registerCommand("foreman", {
    description: "pi-foreman commands: /foreman doctor",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      if (sub !== "doctor") {
        ctx.ui.notify("Usage: /foreman doctor", "warning");
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
    }

    if (isolationOn(isoSetting, ctx.model?.provider)) out.push(...isolationDoctor({ dir: isolationDir(s.agentDir), env: process.env, platform }));
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

function safeTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

