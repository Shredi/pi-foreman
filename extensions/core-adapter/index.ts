// pi-foreman core adapter: wires the vendored Python core into Pi (design §§5-7, 9).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterSpawn, beforeSpawn, escalate, gateThreshold, initialCeremony, isTier, onFileChanged, parseTierHeader, promptSignals, tierLine, userOverride } from "./ceremony.ts";
import type { CeremonyState } from "./ceremony.ts";
import { canonical, generateSubagents, get, loadMergedConfig, pythonPathHint } from "./config.ts";
import type { MergedConfig } from "./config.ts";
import { loadRegister, normaliseChildExtensions } from "./childext.ts";
import type { Registration } from "./childext.ts";
import { buildGuardEnv, patchShellEnv, piAgentDir } from "./env.ts";
import { boundLedger, ensureSessionMarker, isLedgerTarget, markerPath } from "./marker.ts";
import { postToolPayload, preToolPayload, resolveToolPath, stopPayload, subagentAgents } from "./payload.ts";
import type { PayloadContext } from "./payload.ts";
import { NO_PYTHON_FIX, PythonCache, resolvePython } from "./python.ts";
import type { PythonResolution } from "./python.ts";
import { runGuard } from "./runguard.ts";
import { defaultSpawner } from "./spawn.ts";
import type { Spawner } from "./spawn.ts";
import { mapTool } from "./toolmap.ts";
import type { GuardName } from "./toolmap.ts";
import { evaluateRun, translateStop, translateToolCall } from "./translate.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = fileURLToPath(import.meta.url);
const PKG_ROOT = path.resolve(HERE, "..", "..");
const CORE_DIR = path.join(PKG_ROOT, "core");
const BIN_DIR = path.join(PKG_ROOT, "bin");
const ADAPTER_ID = "pi-foreman-core-adapter";
const ORIGINAL_PI_FOREMAN_PYTHON = process.env.PI_FOREMAN_PYTHON;

interface Session {
  id: string;
  cwd: string;
  isChild: boolean;
  agentDir: string;
  markerDir: string;
  python: PythonResolution;
  config: MergedConfig;
  ceremony: CeremonyState;
  registration?: Registration;
  registrationError?: string;
  registrationVia?: string;
  childExtensions: { id: string; path: string }[];
  stopContinued: boolean;
  notified: Set<string>;
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

    const hint = pythonPathHint(PKG_ROOT, agentDir, cwd, trusted);
    let python = await pythonCache.get(id, () => resolvePython({ configPath: hint, envPath: ORIGINAL_PI_FOREMAN_PYTHON, platform, spawner }));
    const config = await loadMergedConfig({ python: python.ok ? python.info.executable : null, pkgRoot: PKG_ROOT, provider: ctx.model?.provider, agentDir, projectDir: cwd, trusted, spawner });
    const merged = get(config.config, "python.path");
    if (typeof merged === "string" && merged.trim() && merged !== hint) {
      // python.path came from a layer the hint does not read (L3, session): honour it.
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
      ceremony: initialCeremony(get(config.config, "ceremony.default")),
      childExtensions: [],
      stopContinued: false,
      notified: new Set(),
    };
    sessions.set(id, s);

    try {
      ensureSessionMarker(markerDir, id, Date.now() / 1000);
    } catch (err) {
      ctx.ui.notify(`pi-foreman: could not write the session marker in ${markerDir} (${(err as Error).message}); the ledger gates treat this session as unbound.`, "warning");
    }
    refreshLedgerTier(s);
    patchShellEnv({ env: process.env, binDir: BIN_DIR, python: pyPath(s), markerDir });

    if (!python.ok) ctx.ui.notify(`pi-foreman: no Python ≥ 3.9 found — shell commands and subagent launches are blocked until it is fixed. ${NO_PYTHON_FIX}`, "error");
    for (const e of config.errors) ctx.ui.notify(e, "error");
    if (config.safetyFallback && config.source === "cli") ctx.ui.notify("pi-foreman: invalid safety config; L1 safety values apply.", "warning");
    for (const w of config.warnings) ctx.ui.notify(`pi-foreman config: ${w}`, "warning");
    return s;
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
      const tier = parseTierHeader(fs.readFileSync(ledger, "utf8"));
      if (tier) s.ceremony = escalate(s.ceremony, tier, "ledger", `ledger header Tier: ${tier}`);
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
    for (const e of extra.errors) ctx.ui.notify(`pi-foreman: ${e}`, "error");
    s.childExtensions = [{ id: ADAPTER_ID, path: ENTRY }, ...extra.list.filter((e) => e.id !== ADAPTER_ID)];
    try {
      const { fn, via } = await loadRegister();
      s.registration = fn({ sessionId: s.id, extensions: s.childExtensions, requireForAllRunners: true });
      s.registrationVia = via;
    } catch (err) {
      s.registrationError = (err as Error).message;
      ctx.ui.notify(`pi-foreman: could not register required child extensions (${s.registrationError}). Children would run without the guards; run /foreman doctor.`, "error");
    }
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

  async function run(s: Session, ctx: ExtensionContext, guard: GuardName, payload: unknown) {
    const env = buildGuardEnv({ base: process.env, coreDir: CORE_DIR, sessionId: s.id, guard, markerDir: s.markerDir, threshold: guard === "ledger_guard_spawn" ? gateThreshold(s.ceremony) : null });
    const r = await runGuard({ python: pyPath(s), coreDir: CORE_DIR, guard, payload, env, cwd: ctx.cwd, spawner });
    return evaluateRun(guard, r, pyPath(s));
  }

  // ------------------------------------------------------------------ events

  pi.on("session_start", async (event, ctx) => {
    const s = await startSession(ctx);
    if (!s.isChild && (event.reason === "startup" || event.reason === "new")) await applyForemanModel(s, ctx);
    await registerChildExtensions(s, ctx);
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
    pythonCache.drop(s.id);
    sessions.delete(s.id);
  });

  pi.on("model_select", async (event) => {
    if (applyingModel) return;
    if (event.source === "set" || event.source === "cycle") userPickedModel = true;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const s = await ensureSession(ctx);
    s.stopContinued = false;
    const signals = promptSignals(event.prompt ?? "", get(s.config.config, "ceremony.heavySignals"));
    if (signals.length) s.ceremony = escalate(s.ceremony, "heavy", "auto", `heavy signal in the request: ${signals.join(", ")}`);
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

  pi.on("tool_call", async (event, ctx) => {
    const mapping = mapTool(event.toolName);
    if (mapping.pre.length === 0) return undefined;
    try {
      const s = await ensureSession(ctx);
      const input = event.input as Record<string, unknown>;
      const pc = payloadCtx(s, ctx);
      for (const guard of mapping.pre) {
        let agents: string[] = [];
        if (guard === "ledger_guard_spawn") {
          agents = subagentAgents(input);
          s.ceremony = beforeSpawn(s.ceremony, agents);
        }
        const outcome = await run(s, ctx, guard, preToolPayload(event.toolName, input, pc));
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
        if (t.result) return t.result;
        if (guard === "ledger_guard_spawn" && agents.length > 0) s.ceremony = afterSpawn(s.ceremony);
      }
      return undefined;
    } catch (err) {
      return { block: true, reason: `pi-foreman: adapter error before ${event.toolName} (${(err as Error).message}); the call is blocked. Run /foreman doctor.` };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const mapping = mapTool(event.toolName);
    if (mapping.post.length === 0 || event.isError) return undefined;
    try {
      const s = await ensureSession(ctx);
      const input = event.input as Record<string, unknown>;
      for (const guard of mapping.post) {
        const outcome = await run(s, ctx, guard, postToolPayload(event.toolName, input, payloadCtx(s, ctx), event.isError));
        if (outcome.kind === "failure") notifyOnce(s, ctx, `open:${guard}`, outcome.message);
      }
      const file = resolveToolPath(input.path, ctx.cwd, os.homedir());
      if (file) {
        const heavy = Number(get(s.config.config, "ceremony.heavyFileCount"));
        s.ceremony = onFileChanged(s.ceremony, file, Number.isFinite(heavy) ? heavy : 0);
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
    const outcome = await run(s, ctx, "ledger_guard_stop", stopPayload(payloadCtx(s, ctx), s.stopContinued));
    const r = translateStop(outcome);
    if (r.openFailure) notifyOnce(s, ctx, "open:ledger_guard_stop", r.openFailure);
    if (!r.hold) return undefined;
    s.stopContinued = true;
    return {
      entries: [...event.entries, { type: "custom_message" as const, customType: "pi-foreman-stop-gate", content: r.reason ?? "", display: true }],
      continue: true,
    };
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
      s.ceremony = userOverride(s.ceremony, want);
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
      const keys = ["agentOverridesByProvider", "agentOverrides"];
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

    if (fs.existsSync(markerPath(s.markerDir, s.id))) ok(`session marker in ${s.markerDir}`);
    else fail("session marker missing", `make ${s.markerDir} writable and restart the session.`);
    out.push(`INFO ceremony: ${tierLine(s.ceremony)}`);
    return out;
  }
}

function safeTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

