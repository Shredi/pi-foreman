// `/foreman session open|brief|close|list` (plan Part B): user commands of a top-level foreman.
//
// open   runs scripts/foreman_session.py (handoff dir, brief + report-back footer, Herdr tab or
//        the printed command for a new terminal, registry entry) with the opener's intercom id.
// brief  writes the file (or the text) to `<handoff dir>/brief-<n>.md` (the lowest free n, never overwritten),
//        then sends `Brief from <opener id>: read <abs path> and act on it` through the pi-intercom outbox.
//        Peer messages carry no authority.
// close  sends `foreman:close [path]`; the target's close flow checks the sender against its
//        parent and replies `foreman:closed <path>` or `pi-foreman: close refused: <reason>`.
// list   prints the registry `<agent dir>/pi-foreman/state/sessions.json`.
// Inbound `Plan from|Result from|Update from <label>: <path>`, `foreman:plan|result <path>` and `foreman:closed <path>`
// from a registry child update its registry entry and show a notice (a `foreman_wait kind:child` wait resolves on it);
// nothing is acted on. A remote child (`open --machine`, entry field `machine`) sets `fm.notice`/`fm.close` labels on its hc
// terminal; remotewatch.ts (RemoteWatcher) watches the local `hc events --json` stream, fetches the file with
// `hc file read --on` and feeds applyRemoteNotice in remotesession.ts, which mirrors it and wakes the same waits.
// Subagent children refuse every subcommand. The functions below take plain deps; the `foreman_session_open` tool
// (registerSessionOpenTool) runs the same sessionOpen; children never get it.
// open --first-command /cmd (repeatable) and --plan-mode (= --first-command /plan) are Pi extension commands the new
// session runs before the brief prompt; --plan-mode runs the brief prompt as the single word `/plan <brief prompt>`
// (a bare `/plan` would open the plan-mode menu and the brief would never start); --plan-mode needs a `plan` command in the opener's pi.getCommands()
// (else `session open refused [plan_mode_unavailable]`).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLOSE_START_FAILED_REASON, CLOSE_TEXT, CLOSED_TEXT, PR_WATCHED_REASON, outboxSend, outboxSendDetailed, validResultPathText } from "./close.ts";
import type { OutboxOutcome } from "./close.ts";
import type { Json } from "./config.ts";
import { mainCheckoutOf, resolveWorktreeRoot } from "./worktreeroot.ts";
import { workspaceTop } from "./gitdrift.ts";
import type { ManifestEntry } from "./manifest.ts";
import { readLive } from "./identity.ts";
import { intercomConfigPath, intercomInbound } from "./intercomguard.ts";
import { applyRemoteNotice, parseRemoteNotice, remoteOrigin } from "./remotesession.ts";
import { blockedConfirm } from "./herdr.ts";
import type { EventBus } from "./herdr.ts";
import { SESSION_FOREMAN } from "./roles.ts";
import type { SpawnResult, Spawner } from "./spawn.ts";

export const SESSION_USAGE =
  "Usage: /foreman session open <label> <brief-file> [--cwd DIR] [--model ID] [--plan-first] [--plan-mode] [--first-command /CMD]… [--focus] [--dry-run] [--worktree [--base REF]] [--machine NAME [--trust]] | /foreman session brief <target> <file|text…> | /foreman session close <target> [result-path] | /foreman session list";
export const CHILD_REFUSAL = "/foreman session is for a top-level foreman session only; refused in subagent children.";
/** Seconds an outbox send waits for pi-intercom's result (a confirmation dialog may be open). */
export const SEND_WAIT_MS = 15_000;
const OPEN_TIMEOUT_MS = 180_000;
/** A `--worktree` open also fetches and runs `npm ci` (up to 540 s in foreman_worktree_setup.py). */
const OPEN_WORKTREE_TIMEOUT_MS = 660_000;
/** The line `foreman session open --worktree` prints with the worktree's JSON (foreman_session.py WORKTREE_MARK). */
export const WORKTREE_MARK = "session worktree: ";

export type SessionCommand =
  | { sub: "open"; label: string; brief: string; cwd?: string; model?: string; planFirst: boolean; focus: boolean; dryRun: boolean; planMode?: boolean; firstCommands?: string[]; machine?: string; trust?: boolean; worktree?: boolean; base?: string }
  | { sub: "brief"; target: string; body: string }
  | { sub: "close"; target: string; path?: string }
  | { sub: "list" }
  | { error: string };

/** Parse the text after `/foreman session`. */
export function parseSessionArgs(args: string): SessionCommand {
  const t = args.trim();
  const [sub = "", ...rest] = t.split(/\s+/);
  if (sub === "list") return rest.length ? { error: SESSION_USAGE } : { sub: "list" };
  if (sub === "brief") {
    const m = /^brief\s+(\S+)\s+(\S[\s\S]*)$/.exec(t);
    return m ? { sub: "brief", target: m[1], body: m[2].trim() } : { error: SESSION_USAGE };
  }
  if (sub === "close") {
    if (rest.length < 1 || rest.length > 2) return { error: SESSION_USAGE };
    return rest[1] ? { sub: "close", target: rest[0], path: rest[1] } : { sub: "close", target: rest[0] };
  }
  if (sub !== "open") return { error: SESSION_USAGE };
  const out = { sub: "open" as const, label: "", brief: "", planFirst: false, focus: false, dryRun: false } as Extract<SessionCommand, { sub: "open" }>;
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--plan-first") out.planFirst = true;
    else if (a === "--focus") out.focus = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--trust") out.trust = true;
    else if (a === "--plan-mode") out.planMode = true;
    else if (a === "--worktree") out.worktree = true;
    else if (a === "--cwd" || a === "--model" || a === "--machine" || a === "--first-command" || a === "--base") {
      const v = rest[++i];
      if (!v || v.startsWith("--")) return { error: `${a} needs a value. ${SESSION_USAGE}` };
      if (a === "--cwd") out.cwd = v;
      else if (a === "--machine") out.machine = v;
      else if (a === "--base") out.base = v;
      else if (a === "--first-command") (out.firstCommands ??= []).push(v);
      else out.model = v;
    } else if (a.startsWith("--")) return { error: `unknown option ${a}. ${SESSION_USAGE}` };
    else pos.push(a);
  }
  if (pos.length !== 2) return { error: SESSION_USAGE };
  [out.label, out.brief] = pos;
  if (out.base !== undefined && !out.worktree) return { error: `--base needs --worktree. ${SESSION_USAGE}` };
  if (out.worktree && out.machine) return { error: `--worktree cannot be combined with --machine. ${SESSION_USAGE}` };
  return out;
}

/**
 * The opener's intercom id: PI_INTERCOM_SESSION_ID first (pi-intercom publishes its resolved id
 * there, index.ts ~1072, which also covers ids claimed via intercom:session-identity), else its own
 * rule (index.ts:597): PI_INTERCOM_STABLE_ID, else `stableId` in <agent dir>/intercom/config.json,
 * else the Pi session id.
 */
export function openerIntercomId(env: Record<string, string | undefined>, agentDir: string, piSessionId: string): string {
  const published = env.PI_INTERCOM_SESSION_ID?.trim();
  if (published) return published;
  const fromEnv = env.PI_INTERCOM_STABLE_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(intercomConfigPath(agentDir), "utf8")) as { stableId?: unknown };
    if (typeof cfg.stableId === "string" && cfg.stableId.trim()) return cfg.stableId.trim();
  } catch {
    // no or unreadable config: pi-intercom falls back to the session id as well
  }
  return piSessionId;
}

export interface SessionEntry {
  label: string;
  child: string;
  parent?: string;
  handoff?: string;
  cwd?: string;
  model?: string | null;
  status?: string;
  opened?: string;
  result?: string;
  last?: { kind: string; path?: string; at: string } | null;
  [k: string]: unknown;
}
/** Run a `foreman_session.py` verb (`close-remote`) against the agent dir; the verb runs hc itself. */
export type RunRemote = (args: string[]) => Promise<SpawnResult>;
const REMOTE_RUN_TIMEOUT_MS = 120_000;
export function remoteRunner(o: { python: string | null; spawner: Spawner; pkgRoot: string; agentDir: string }): RunRemote {
  return async (args) =>
    o.python
      ? o.spawner(o.python, ["-E", "-s", path.join(o.pkgRoot, "scripts", "foreman_session.py"), "--agent-dir", o.agentDir, ...args], { timeoutMs: REMOTE_RUN_TIMEOUT_MS })
      : { code: null, stdout: "", stderr: "", error: new Error("foreman_session.py: no usable Python (run /foreman doctor)."), timedOut: false };
}
export interface Registry {
  version: number;
  sessions: SessionEntry[];
}

export const registryFile = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", "sessions.json");

export function readRegistry(agentDir: string): Registry {
  try {
    const r = JSON.parse(fs.readFileSync(registryFile(agentDir), "utf8")) as Registry;
    if (r && Array.isArray(r.sessions)) return { version: r.version ?? 1, sessions: r.sessions.filter((s) => s && typeof s === "object" && typeof s.child === "string") };
  } catch {
    // missing or unreadable: empty
  }
  return { version: 1, sessions: [] };
}

/** Atomic write (temp file in the same dir, then rename). */
export function writeRegistry(agentDir: string, reg: Registry): void {
  const file = registryFile(agentDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(reg, null, 1)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** The newest local registry entry whose handoff `live.json` names this Pi session id (the adapter wrote it; a model cannot). */
function entryByPiSession(reg: Registry, piSessionId: string): SessionEntry | undefined {
  return [...reg.sessions].reverse().find((s) => s.machine === undefined && !!s.handoff && readLive(s.handoff)?.piSessionId === piSessionId);
}

/** A registry label (newest entry wins), child id or Pi session id (via the handoff's live.json) → the child's intercom id; anything else passes through. */
export function resolveTarget(reg: Registry, target: string): string {
  for (let i = reg.sessions.length - 1; i >= 0; i--) {
    const s = reg.sessions[i];
    if (s.label === target || s.child === target) return s.child;
  }
  return entryByPiSession(reg, target)?.child ?? target;
}

/** The handoff dir of the newest registry entry for a label, child id or Pi session id; undefined when none is recorded. */
export function resolveHandoff(reg: Registry, target: string): string | undefined {
  for (let i = reg.sessions.length - 1; i >= 0; i--) {
    const s = reg.sessions[i];
    if (s.label === target || s.child === target) return s.handoff;
  }
  return entryByPiSession(reg, target)?.handoff;
}

/** The handoff dir a retry may read `live.json` from: always the one a registry entry names for the target (never a free id). */
function retryHandoff(reg: Registry, target: string, to: string): string | undefined {
  const e = [...reg.sessions].reverse().find((s) => !!s.handoff && (s.label === target || s.child === target || s.child === to || path.resolve(s.handoff) === target)) ?? entryByPiSession(reg, target);
  return e?.handoff;
}

/** pi-intercom's answer for a target that is gone: `target_not_found`, or `delivery_failed` with a not-found/not-connected reason. */
export function targetMissing(o: OutboxOutcome): boolean {
  return o.code === "target_not_found" || (o.status === "failed" && o.code === "delivery_failed" && /not (found|connected)/i.test(o.detail ?? ""));
}

/**
 * Writes `data` to the lowest free `brief-<n>.md` in `dir` (flag "wx": an existing file is never overwritten, the write
 * throws instead). Returns the file path with posix separators.
 */
export function writeBrief(dir: string, data: string | Uint8Array): string {
  let n = 1;
  while (fs.existsSync(path.join(dir, `brief-${n}.md`))) n++;
  const file = path.join(dir, `brief-${n}.md`);
  fs.writeFileSync(file, data, { flag: "wx" });
  return file.split(path.sep).join("/");
}

export const briefText = (opener: string, file: string): string => `Brief from ${opener}: read ${file} and act on it`;
export const closeText = (resultPath?: string): string => (resultPath ? `${CLOSE_TEXT} ${resultPath}` : CLOSE_TEXT);

export type Inbound = { kind: "plan" | "result" | "update"; label: string; path: string } | { kind: "closed"; path: string } | { kind: "refused"; path: string };

/** The message contract's report lines (one line each); null = any other message. */
export function parseInbound(text: unknown): Inbound | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (/[\r\n]/.test(t)) return null;
  const m = /^(Plan|Result|Update) from ([A-Za-z0-9._-]{1,40}): (\S.*)$/.exec(t);
  if (m) return { kind: m[1].toLowerCase() as "plan" | "result" | "update", label: m[2], path: m[3].trim() };
  const a = /^foreman:(plan|result) (\S.*)$/.exec(t); // intra-Pi aliases: the child label comes from the registry sender
  if (a) return { kind: a[1] as "plan" | "result", label: "", path: a[2].trim() };
  const c = new RegExp(`^${CLOSED_TEXT} (\\S.*?)(?: CLOSE: (?:ready|open))?$`).exec(t); // optional CLOSE tail (close.md)
  if (c) return { kind: "closed", path: c[1].trim() };
  const r = /^pi-foreman: close refused: (\S.*)$/.exec(t); // a child's refusal of our close; `path` carries the reason
  return r ? { kind: "refused", path: r[1].trim() } : null;
}

/** Record an inbound report from a registry child (matched by sender id); the updated entry or null. */
export function applyInbound(reg: Registry, sender: string, msg: Inbound, now: Date): SessionEntry | null {
  const entry = [...reg.sessions].reverse().find((s) => s.child === sender && s.machine === undefined); // remote entries take only cross-machine notices (remotesession.ts)
  if (!entry) return null;
  entry.last = { kind: msg.kind, path: msg.path, at: now.toISOString() };
  if (msg.kind === "closed") {
    entry.status = "closed";
    entry.result = msg.path;
  } else if (msg.kind === "refused") {
    if (entry.status === "closing") entry.status = "open";
  } else {
    if (msg.kind === "result" || msg.kind === "update") entry.result = msg.path;
    if (entry.status === "pending") entry.status = "open";
  }
  return entry;
}

/**
 * A child's own close: its registry entry (matched by its handoff dir, the one `foreman session open` sets for it)
 * becomes `closed` before the parent's `foreman:closed` arrives. True when the registry changed.
 */
export function markOwnClosed(agentDir: string, env: Record<string, string | undefined>): boolean {
  const handoff = env.PI_FOREMAN_HANDOFF_DIR?.trim();
  if (!handoff) return false;
  const reg = readRegistry(agentDir);
  let changed = false;
  for (const s of reg.sessions) {
    if (s.handoff && path.basename(s.handoff) === path.basename(handoff) && s.status !== "closed") {
      s.status = "closed";
      changed = true;
    }
  }
  if (changed) writeRegistry(agentDir, reg);
  return changed;
}

/** The fixed slug of a close refusal reason (`remote notice refused --reason` takes `[a-z0-9-]{1,40}`, free text is rejected). */
export function refuseSlug(reason: string): string {
  const rules: [RegExp, string][] = [
    [/child run\(s\) still active/, "runs-active"],
    [/foreman_wait pending/, "waits-pending"],
    [/already in progress/, "in-progress"],
    [/did not start within/, "not-started"],
    [/stopped before it produced/, "stopped"],
    [/close\.from does not include/, "close-from"],
  ];
  if (reason.endsWith(PR_WATCHED_REASON)) return "pr-watched";
  if (reason.startsWith(CLOSE_START_FAILED_REASON)) return "not-started";
  return rules.find(([re]) => re.test(reason))?.[1] ?? "refused";
}

/** The argv tail of `foreman_session.py remote notice` for a close reply: `closed [--close ready|open]` or `refused --reason <slug>`. */
export function remoteNoticeArgs(kind: "closed" | "refused", arg?: string): string[] {
  return kind === "refused" ? ["remote", "notice", "refused", `--reason=${refuseSlug(arg ?? "")}`] : ["remote", "notice", "closed", ...(arg ? ["--close", arg] : [])];
}

/** Records `message` as `lastError` of this child's own entry (matched by its handoff dir, as `markOwnClosed`). */
export function markOwnError(agentDir: string, env: Record<string, string | undefined>, message: string): boolean {
  const handoff = env.PI_FOREMAN_HANDOFF_DIR?.trim();
  if (!handoff) return false;
  const reg = readRegistry(agentDir);
  let changed = false;
  for (const s of reg.sessions) {
    if (s.handoff && path.basename(s.handoff) === path.basename(handoff)) {
      s.lastError = message;
      changed = true;
    }
  }
  if (changed) writeRegistry(agentDir, reg);
  return changed;
}

/**
 * The reply of a remote-parent close: runs `remote notice` (the label on this child's hc terminal). A non-zero exit becomes
 * `lastError` of the own entry and is thrown, so the caller can notify.
 */
export function remoteReplier(o: { python: string | null; spawner: Spawner; pkgRoot: string; agentDir: string; cwd: string; env: Record<string, string | undefined> }): (kind: "closed" | "refused", arg?: string) => Promise<void> {
  return async (kind, arg) => {
    if (!o.python) return;
    const r = await o.spawner(o.python, ["-E", "-s", path.join(o.pkgRoot, "scripts", "foreman_session.py"), "--agent-dir", o.agentDir, ...remoteNoticeArgs(kind, arg)], { timeoutMs: 60_000, cwd: o.cwd });
    if (r.code === 0 && !r.error) return;
    let why = r.error?.message ?? (r.stderr.trim() || `exit ${String(r.code)}`);
    try {
      const j = JSON.parse(r.stdout) as { error?: unknown };
      if (typeof j.error === "string") why = j.error;
    } catch {
      // not JSON: keep the stderr text
    }
    const message = `${kind} notice failed: ${why.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 200)}`;
    markOwnError(o.agentDir, o.env, message);
    throw new Error(message);
  };
}

export function formatList(reg: Registry): string {
  if (!reg.sessions.length) return "pi-foreman sessions: none opened yet.";
  const rows = reg.sessions.map((s) => {
    const last = s.last ? ` · last: ${s.last.kind}${s.last.path ? ` ${s.last.path}` : ""} (${s.last.at})` : "";
    return `${s.label}  ${typeof s.model === "string" && s.model ? s.model : "-"}  ${s.status ?? "?"}  ${s.handoff ?? ""}  ${s.child}${last}`;
  });
  return ["pi-foreman sessions (label, model, status, handoff dir, child id):", ...rows].join("\n");
}

/** What the session functions need; plain values, so a later model tool can supply them too. */
export interface SessionDeps {
  isChild: boolean;
  env: Record<string, string | undefined>;
  agentDir: string;
  cwd: string;
  piSessionId: string;
  pkgRoot: string;
  python: string | null;
  spawner: Spawner;
  send: (to: string, text: string) => Promise<string>;
  /** Like `send`, with the outbox result's code and detail; when present it decides the retry via live.json. */
  sendDetailed?: (to: string, text: string) => Promise<OutboxOutcome>;
  /** The owner's yes/no for a real open (see ownerConfirm); absent = no interactive session, so an open is refused. */
  confirm?: (title: string, message: string) => Promise<boolean>;
  /** This session's own model, `<provider>/<id>`; with `config` it enables the session-foreman model. */
  model?: string;
  /** Merged config (providers.<p>.roles.session-foreman.model, ranks, ladder.childPolicy). */
  config?: Json;
  /** Names of this session's slash commands (pi.getCommands()); planMode needs `plan` among them. */
  commands?: string[];
  /** Trace event emitter of this session (a `--worktree` open emits `session_worktree`). */
  trace?: (rec: Record<string, unknown>) => void;
  /** Record a worktree this open created in the opener's manifest. */
  recordWorktree?: (entry: ManifestEntry) => Promise<void>;
  /** Run a `foreman_session.py` verb (see remoteRunner). */
  runRemote?: RunRemote;
}

export const PLAN_MODE_UNAVAILABLE = "session open refused [plan_mode_unavailable]: this session has no /plan command (install a plan-mode package), so the new session cannot open in plan mode. Open it without planMode, or pass the first command your setup provides.";

export type SessionResult = { text: string; ok: boolean };

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** The mapped session-foreman model: the own provider's map first, then its fallback provider's. */
export function sessionForemanModel(config: Json | undefined, ownModel: string | undefined): string | undefined {
  const providers = config?.providers;
  const slash = ownModel ? ownModel.indexOf("/") : -1;
  if (!isObj(providers) || slash <= 0) return undefined;
  const modelOf = (p: unknown): string | undefined => {
    const roles = isObj(p) && isObj(p.roles) ? p.roles : undefined;
    const e = roles?.[SESSION_FOREMAN];
    return isObj(e) && typeof e.model === "string" && e.model !== "" ? e.model : undefined;
  };
  const own = providers[ownModel!.slice(0, slash)];
  const fb = isObj(own) && isObj(own.fallback) && typeof own.fallback.provider === "string" ? own.fallback.provider : undefined;
  return modelOf(own) ?? (fb ? modelOf(providers[fb]) : undefined);
}

/** Env var `foreman session open --model` sets in the child: the model the session was opened on. */
export const SESSION_MODEL_ENV = "PI_FOREMAN_SESSION_MODEL";

/** The model this session was opened on (`foreman session open --model`), or undefined. */
export function sessionModelOf(env: Record<string, string | undefined>): string | undefined {
  const v = env[SESSION_MODEL_ENV]?.trim();
  return v ? v : undefined;
}

/** The mapped foreman role model to apply at start; null when the session was opened on its own model (Pi already runs it). */
export function foremanModelSpec(roleModel: string, sessionModel: string | undefined, cliModel?: string): string | null {
  return sessionModel || cliModel ? null : roleModel;
}

/** The value of a `--model <id>` / `--model=<id>` flag in the process arguments (a model picked at startup counts as user-picked). */
export function cliModelOf(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") return argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[i + 1] : undefined;
    if (a.startsWith("--model=") && a.length > 8) return a.slice(8);
  }
  return undefined;
}

export const NO_UI_REFUSAL = "session open refused [no_ui]: opening a session needs the owner's confirmation in an interactive Pi session; run `foreman session open ...` in a terminal instead";

/** The owner-confirm hook of one Pi context: a yes/no dialog without timeout; absent without an interactive UI; a thrown dialog counts as No. */
export function ownerConfirm(ctx: ExtensionContext, events: EventBus | undefined): SessionDeps["confirm"] {
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return undefined;
  const ask = blockedConfirm(events, (title, message) => ctx.ui.confirm(title, message));
  return async (title, message) => {
    try {
      return (await ask(title, message)) === true;
    } catch {
      return false;
    }
  };
}

/** The summary the owner confirms: label, model, cwd, worktree and base, plan-first, machine, first 3 non-empty brief lines. */
function openSummary(d: SessionDeps, c: Extract<SessionCommand, { sub: "open" }>, model: string | undefined, cwd: string): string {
  let brief: string;
  try {
    brief = fs.readFileSync(path.resolve(d.cwd, c.brief), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 3).join("\n");
  } catch {
    brief = "(brief unreadable)";
  }
  return [
    `label: ${c.label}`,
    `model: ${model ?? "(default)"}`,
    `cwd: ${cwd}`,
    `worktree: ${c.worktree ? `yes (base ${c.base ?? "default branch"})` : "no"}`,
    `plan-first: ${c.planFirst ? "yes" : "no"}`,
    `machine: ${c.machine ?? "local"}`,
    "brief:",
    brief,
  ].join("\n");
}

export async function sessionOpen(d: SessionDeps, c: Extract<SessionCommand, { sub: "open" }>): Promise<SessionResult> {
  if (!d.python) return { text: "foreman_session.py: no usable Python (run /foreman doctor).", ok: false };
  if (c.planMode && !c.machine && !d.commands?.includes("plan")) return { text: PLAN_MODE_UNAVAILABLE, ok: false };
  const explicit = c.model ?? sessionForemanModel(d.config, d.model);
  const model = explicit ?? d.model;
  const opener = openerIntercomId(d.env, d.agentDir, d.piSessionId);
  if (c.machine && !c.cwd) return { text: "pi-foreman session: open --machine needs --cwd (the directory on the remote machine).", ok: false };
  if (c.worktree && !c.machine) {
    // the root the new worktree lands in is checked here, before anything is spawned (worktreeroot.ts resolver; the Python side repeats it)
    if (c.label === "worktrees") return { text: "session open refused [label_reserved]: the label `worktrees` is the folder of pi-subagents isolation worktrees; choose another label", ok: false };
    const top = workspaceTop(path.resolve(d.cwd, c.cwd ?? "."));
    const main = top ? mainCheckoutOf(top) : null;
    const raw = (d.config as { close?: { worktreeDir?: unknown } } | undefined)?.close?.worktreeDir;
    const root = main ? resolveWorktreeRoot(main, raw) : null;
    if (root?.error) return { text: `session open refused [${root.error.code}]: ${root.error.message}`, ok: false };
  }
  // a remote cwd is a path on the other machine: passed verbatim, never resolved here; the brief file is local
  const cwdArg = c.machine ? c.cwd! : path.resolve(d.cwd, c.cwd ?? ".");
  const argv = [path.join(d.pkgRoot, "scripts", "foreman_session.py"), "--agent-dir", d.agentDir, "open", c.label, path.resolve(d.cwd, c.brief), "--cwd", cwdArg, "--parent-id", opener];
  if (c.machine) argv.push("--machine", c.machine);
  if (c.trust) argv.push("--trust");
  // only an explicit choice (--model or the session-foreman mapping) sets PI_FOREMAN_SESSION_MODEL in the child; the opener's own model is just displayed
  if (explicit) argv.push("--model", explicit);
  if (c.planFirst) argv.push("--plan-first");
  if (c.planMode) argv.push("--plan-mode");
  for (const f of c.firstCommands ?? []) argv.push("--first-command", f);
  if (c.focus) argv.push("--focus");
  if (c.dryRun) argv.push("--dry-run");
  if (c.worktree) argv.push("--worktree");
  if (c.base !== undefined) argv.push("--base", c.base);
  if (!c.dryRun) {
    if (!d.confirm) return { text: NO_UI_REFUSAL, ok: false };
    const yes = await d.confirm(`pi-foreman: open session ${c.label}?`, openSummary(d, c, model, cwdArg));
    if (yes !== true) return { text: `session open refused [owner_declined]: the owner declined to open session ${c.label}`, ok: false };
  }
  const r = await d.spawner(d.python, ["-E", "-s", ...argv], { timeoutMs: c.worktree ? OPEN_WORKTREE_TIMEOUT_MS : OPEN_TIMEOUT_MS, cwd: d.cwd });
  const out = r.stdout.trim();
  if (c.worktree && !c.dryRun && !r.error && !r.timedOut && r.code === 0) await noteWorktree(d, c.label, out);
  const text = [model && !/^session model: /m.test(out) ? `session model: ${model}` : "", out, r.stderr.trim()].filter(Boolean).join("\n") || (r.error ? r.error.message : r.timedOut ? "foreman_session.py timed out" : "foreman_session.py produced no output.");
  return { text, ok: !r.error && !r.timedOut && r.code === 0 };
}

/** After a successful `--worktree` open: record the worktree in the opener's manifest and trace `session_worktree`. */
async function noteWorktree(d: SessionDeps, label: string, out: string): Promise<void> {
  const line = out.split(/\r?\n/).find((l) => l.startsWith(WORKTREE_MARK));
  if (!line) return;
  let w: Json;
  try {
    w = JSON.parse(line.slice(WORKTREE_MARK.length)) as Json;
  } catch {
    return;
  }
  if (typeof w.path !== "string" || typeof w.branch !== "string") return;
  try {
    await d.recordWorktree?.({ kind: "worktree", path: w.path, branch: w.branch });
  } catch {
    // best effort: the sweep still finds the worktree by convention
  }
  d.trace?.({ event: "session_worktree", label, path: w.path, branch: w.branch, base: w.base, install: w.install });
}

/** One send; a missing target is retried once with the intercom id in the registry entry's handoff `live.json` when it differs. */
async function sendTo(d: SessionDeps, to: string, message: string, what: string, handoff?: string): Promise<SessionResult> {
  const send = async (target: string): Promise<OutboxOutcome> => (d.sendDetailed ? d.sendDetailed(target, message) : { status: await d.send(target, message) });
  let out = await send(to);
  if (handoff && targetMissing(out)) {
    const live = readLive(handoff);
    if (live && live.intercomId !== to) {
      to = live.intercomId;
      out = await send(to);
    }
  }
  const status = out.status;
  if (status === "sent") return { text: `pi-foreman session: ${what} sent to ${to}.`, ok: true };
  if (status === "timeout") return { text: `pi-foreman session: ${what} for ${to} handed to pi-intercom; no send result yet (a confirmation may be open).`, ok: true };
  return { text: `pi-foreman session: ${what} to ${to} not sent (${status}). Is pi-intercom installed and the target connected?`, ok: false };
}

/** A handoff dir (its `child` file, as the Python side reads it), else a registry label or child id. */
function briefTarget(reg: Registry, dir: string, target: string): { to: string; handoff?: string } {
  let child: string | undefined;
  try {
    child = fs.readFileSync(path.join(dir, "child"), "utf8").trim() || undefined;
  } catch {
    child = undefined; // not a handoff dir
  }
  return child ? { to: child, handoff: dir } : { to: resolveTarget(reg, target), handoff: resolveHandoff(reg, target) };
}

export async function sessionBrief(d: SessionDeps, target: string, body: string): Promise<SessionResult> {
  const reg = readRegistry(d.agentDir);
  const newest = [...reg.sessions].reverse().find((s) => s.label === target || s.child === target); // as find_entry in the script
  if (newest && typeof newest.machine === "string") {
    // a remote child is briefed over hc exec by the script (`remote deliver`), not over the local intercom
    if (!d.python) return { text: "foreman_session.py: no usable Python (run /foreman doctor).", ok: false };
    const file = /\s/.test(body) ? body : path.resolve(d.cwd, body);
    const r = await d.spawner(d.python, ["-E", "-s", path.join(d.pkgRoot, "scripts", "foreman_session.py"), "--agent-dir", d.agentDir, "brief", target, fs.existsSync(file) ? file : body], { timeoutMs: OPEN_TIMEOUT_MS, cwd: d.cwd });
    const text = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n") || (r.error ? r.error.message : r.timedOut ? "foreman_session.py timed out" : "foreman_session.py produced no output.");
    return { text, ok: !r.error && !r.timedOut && r.code === 0 };
  }
  const { to, handoff } = briefTarget(reg, path.resolve(d.cwd, target), target);
  if (!handoff) return { text: `pi-foreman session: brief to ${target} refused: no handoff dir to write it to (see: /foreman session list)`, ok: false };
  const file = /\s/.test(body) ? null : path.resolve(d.cwd, body);
  const isFile = file !== null && fs.existsSync(file) && fs.statSync(file).isFile();
  let brief: string;
  try {
    brief = writeBrief(handoff, isFile ? fs.readFileSync(file!) : `${body}\n`);
  } catch (err) {
    return { text: `pi-foreman session: brief to ${target} refused: ${(err as Error).message}`, ok: false };
  }
  return sendTo(d, to, briefText(openerIntercomId(d.env, d.agentDir, d.piSessionId), brief), "brief", retryHandoff(reg, target, to) ?? retryHandoff(reg, path.resolve(d.cwd, target), to));
}

export async function sessionClose(d: SessionDeps, target: string, resultPath?: string): Promise<SessionResult> {
  if (resultPath !== undefined && !validResultPathText(resultPath)) return { text: "pi-foreman session: the result path may use only A-Z a-z 0-9 . _ / - (at most 200 characters) and must end in .md", ok: false };
  const reg = readRegistry(d.agentDir);
  const to = resolveTarget(reg, target);
  const remote = [...reg.sessions].reverse().find((s) => s.child === to && typeof s.machine === "string");
  if (remote) {
    const who = `${remote.label}@${String(remote.machine)}`;
    if (!d.runRemote) return { text: `${who}: not closed (no remote runner)`, ok: false };
    const r = await d.runRemote(["close-remote", remote.child, ...(resultPath ? ["--path", resultPath] : [])]);
    const ok = !r.error && !r.timedOut && r.code === 0;
    const text = ok ? `pi-foreman session: close request sent to ${who}.` : [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join("\n") || (r.error ? r.error.message : r.timedOut ? "foreman_session.py timed out" : `${who}: close not sent`);
    return { text, ok };
  }
  const r = await sendTo(d, to, closeText(resultPath), "close request", retryHandoff(reg, target, to));
  const entry = reg.sessions.find((s) => s.child === to);
  if (r.ok && entry && entry.status !== "closed") {
    entry.status = "closing";
    writeRegistry(d.agentDir, reg);
  }
  return r;
}

export function sessionList(d: SessionDeps): SessionResult {
  return { text: formatList(readRegistry(d.agentDir)), ok: true };
}

/** One `/foreman session …` command. */
export async function runSessionCommand(d: SessionDeps, args: string): Promise<SessionResult> {
  if (d.isChild || d.env.PI_SUBAGENT_CHILD === "1") return { text: CHILD_REFUSAL, ok: false };
  const c = parseSessionArgs(args);
  if ("error" in c) return { text: c.error, ok: false };
  if (c.sub === "open") return sessionOpen(d, c);
  if (c.sub === "brief") return sessionBrief(d, c.target, c.body);
  if (c.sub === "close") return sessionClose(d, c.target, c.path);
  return sessionList(d);
}

/** The `foreman_session_open` tool call: the same sessionOpen as the command; refused in subagent children. */
export async function runSessionOpenTool(d: SessionDeps, params: Record<string, unknown>): Promise<SessionResult> {
  if (d.isChild || d.env.PI_SUBAGENT_CHILD === "1") return { text: CHILD_REFUSAL, ok: false };
  const str = (k: string): string | undefined => (typeof params[k] === "string" && params[k] !== "" ? (params[k] as string) : undefined);
  const label = str("label");
  const brief = str("brief");
  if (!label || !brief) return { text: `${SESSION_OPEN_TOOL}: label and brief are required.`, ok: false };
  const first = params.firstCommand;
  if (first !== undefined && (!Array.isArray(first) || first.some((f) => typeof f !== "string"))) return { text: `${SESSION_OPEN_TOOL}: firstCommand must be an array of strings.`, ok: false };
  const c: Extract<SessionCommand, { sub: "open" }> = { sub: "open", label, brief, planFirst: params.planFirst === true, focus: params.focus === true, dryRun: params.dryRun === true };
  const cwd = str("cwd");
  const model = str("model");
  if (cwd) c.cwd = cwd;
  if (model) c.model = model;
  const machine = str("machine");
  if (machine) c.machine = machine;
  if (params.worktree !== undefined && typeof params.worktree !== "boolean") return { text: `${SESSION_OPEN_TOOL}: worktree must be a boolean.`, ok: false };
  if (params.worktree === true) c.worktree = true;
  const base = str("base");
  if (base) c.base = base;
  if (c.base !== undefined && !c.worktree) return { text: `${SESSION_OPEN_TOOL}: base needs worktree: true.`, ok: false };
  if (c.worktree && c.machine) return { text: `${SESSION_OPEN_TOOL}: worktree cannot be combined with machine.`, ok: false };
  if (params.trust === true) c.trust = true;
  if (params.planMode === true) c.planMode = true;
  if (Array.isArray(first) && first.length) c.firstCommands = first as string[];
  return sessionOpen(d, c);
}

export const SESSION_OPEN_TOOL = "foreman_session_open";

export interface SessionHost {
  id: string;
  isChild: boolean;
  cwd: string;
  agentDir: string;
  python: string | null;
  model?: string;
  config?: Json;
  trace?: (rec: Record<string, unknown>) => void;
  recordWorktree?: (entry: ManifestEntry) => Promise<void>;
}

const commandNames = (pi: ExtensionAPI): string[] => pi.getCommands?.().map((c) => c.name) ?? [];

/** Inbound report recognition plus the `/foreman session` handler. */
export function registerSession(
  pi: ExtensionAPI,
  deps: { session: (ctx: ExtensionContext) => Promise<SessionHost>; spawner: Spawner; pkgRoot: string; onChildNotice?: (sessionId: string, label: string, kind: string, notePath: string) => void },
): { command: (args: string, ctx: ExtensionContext) => Promise<void> } {
  const seen = new Set<string>();
  const onInbound = async (ctx: ExtensionContext, details: unknown): Promise<void> => {
    const d = (details && typeof details === "object" ? details : {}) as { from?: { id?: unknown }; message?: { id?: unknown; content?: { text?: unknown } } };
    const origin = remoteOrigin(details);
    if (origin) {
      // a cross-machine sender: only the remote branch, never the local route (matching, not authentication)
      const notice = parseRemoteNotice(d.message?.content?.text);
      if (!notice) return;
      const key = typeof d.message?.id === "string" ? d.message.id : `${origin.machine}|${origin.sessionId}|${String(d.message?.content?.text)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const s = await deps.session(ctx);
      if (s.isChild) return;
      const reg = readRegistry(s.agentDir);
      const hit = applyRemoteNotice(reg, origin, notice);
      if (!hit) return;
      if (hit.changed) {
        try {
          writeRegistry(s.agentDir, reg);
        } catch (err) {
          ctx.ui.notify(`pi-foreman session: could not update the registry: ${(err as Error).message}`, "warning");
        }
      }
      ctx.ui.notify(hit.message ?? `pi-foreman session ${hit.entry.label}@${String(hit.entry.machine)}: ${hit.kind}${hit.path ? ` ${hit.path}` : ""}`, hit.changed ? "info" : "warning");
      if (hit.changed) deps.onChildNotice?.(s.id, hit.entry.label, hit.kind, hit.path);
      return;
    }
    const msg = parseInbound(d.message?.content?.text);
    const sender = typeof d.from?.id === "string" ? d.from.id : undefined;
    if (!msg || !sender) return;
    const key = typeof d.message?.id === "string" ? d.message.id : `${sender}|${String(d.message?.content?.text)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const s = await deps.session(ctx);
    if (s.isChild) return;
    const reg = readRegistry(s.agentDir);
    const entry = applyInbound(reg, sender, msg, new Date());
    if (!entry) return;
    try {
      writeRegistry(s.agentDir, reg);
    } catch (err) {
      ctx.ui.notify(`pi-foreman session: could not update the registry: ${(err as Error).message}`, "warning");
    }
    ctx.ui.notify(`pi-foreman session ${entry.label}: ${msg.kind} ${msg.path}`, "info");
    deps.onChildNotice?.(s.id, entry.label, msg.kind, msg.path);
  };
  pi.on("message_end", async (event, ctx) => {
    const hit = intercomInbound({ hook: "message_end", message: event.message });
    if (!hit || process.env.PI_SUBAGENT_CHILD === "1") return;
    await onInbound(ctx, hit.details);
  });
  // Legacy Pi < 1.2.0: an idle session gets the message without an extension message_end, then the
  // wake line (see close.ts); display only. Pi 1.2+ delivers every message through message_end.
  pi.on("input", async (event, ctx) => {
    const hit = process.env.PI_SUBAGENT_CHILD === "1" ? null : intercomInbound({ hook: "input", source: event.source, text: event.text, branch: ctx.sessionManager.getBranch?.() ?? [] });
    if (hit) await onInbound(ctx, hit.details);
    return { action: "continue" as const };
  });

  return {
    command: async (args, ctx) => {
      const s = await deps.session(ctx);
      const r = await runSessionCommand(
        {
          isChild: s.isChild,
          env: process.env,
          agentDir: s.agentDir,
          cwd: s.cwd,
          piSessionId: s.id,
          pkgRoot: deps.pkgRoot,
          python: s.python,
          spawner: deps.spawner,
          confirm: ownerConfirm(ctx, pi.events as EventBus | undefined),
          send: (to, text) => outboxSend(pi.events, to, text, "session", SEND_WAIT_MS),
          sendDetailed: (to, text) => outboxSendDetailed(pi.events, to, text, "session", SEND_WAIT_MS),
          model: s.model,
          config: s.config,
          commands: commandNames(pi),
          trace: s.trace,
          recordWorktree: s.recordWorktree,
          runRemote: remoteRunner({ python: s.python, spawner: deps.spawner, pkgRoot: deps.pkgRoot, agentDir: s.agentDir }),
        },
        args,
      );
      ctx.ui.notify(r.text, r.ok ? "info" : "warning");
    },
  };
}

const OPEN_PARAMS = {
  type: "object",
  properties: {
    label: { type: "string", description: "Session label: 1-40 characters of A-Z a-z 0-9 . _ -." },
    brief: { type: "string", description: "Path of the brief file the new session reads." },
    cwd: { type: "string", description: "Directory the new session runs in (default: this session's)." },
    model: { type: "string", description: "Model of the new session, <provider>/<id>." },
    planFirst: { type: "boolean", description: "Open the session in the plan phase: it writes a plan first, changes files only under .workflow/, launches no builder, and asks questions via ask_user_question until the plan is decision-complete." },
    planMode: { type: "boolean", description: "Open the session in plan mode (the brief prompt runs as `/plan <brief prompt>`); for a local open, refused when this session has no /plan command (a remote open is checked on the remote machine)." },
    firstCommand: { type: "array", items: { type: "string" }, maxItems: 4, description: "Extension commands (each starting with /) the new session runs before the brief prompt." },
    focus: { type: "boolean", description: "Focus the new Herdr tab." },
    dryRun: { type: "boolean", description: "Print the handoff dir, child id and command; open nothing." },
    machine: { type: "string", description: "Open the session on this remote machine (a sessions.machines name); needs cwd, the directory on that machine." },
    worktree: { type: "boolean", description: "Create the session's own linked worktree (<close.worktreeDir>/<label>, branch <sessions.worktree.branchPrefix>/<label> from the fetched default branch; npm ci only when a lockfile is declared) and open the session there. Not with machine." },
    base: { type: "string", description: "With worktree: the branch, tag or commit the new branch starts from (default: the fetched default branch of origin)." },
    trust: { type: "boolean", description: "With machine: record the trust grant for the remote folder on that machine (a stored refusal is not overridden)." },
  },
  required: ["label", "brief"],
  additionalProperties: false,
};

/** Register the `foreman_session_open` tool (foreman sessions only; the caller skips it in children). */
export function registerSessionOpenTool(
  pi: ExtensionAPI,
  deps: { session: (ctx: ExtensionContext) => Promise<SessionHost>; spawner: Spawner; pkgRoot: string },
): void {
  pi.registerTool({
    name: SESSION_OPEN_TOOL,
    label: "Open a session",
    description:
      "Open a new foreman session in a Herdr tab (or print the command for a new terminal) with a brief file: same as `/foreman session open`. Design or new-topic sessions: planFirst true (the new session starts in the plan phase: .workflow-only writes, explorers, no builders until its plan is approved); a session with an approved plan: no planFirst. Refused in subagent children.",
    parameters: OPEN_PARAMS as never,
    async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const s = await deps.session(ctx);
      const r = await runSessionOpenTool(
        {
          isChild: s.isChild,
          env: process.env,
          agentDir: s.agentDir,
          cwd: s.cwd,
          piSessionId: s.id,
          pkgRoot: deps.pkgRoot,
          python: s.python,
          spawner: deps.spawner,
          confirm: ownerConfirm(ctx, pi.events as EventBus | undefined),
          send: async () => "unavailable",
          model: s.model,
          config: s.config,
          commands: commandNames(pi),
          trace: s.trace,
          recordWorktree: s.recordWorktree,
        },
        params,
      );
      return { content: [{ type: "text" as const, text: r.text }], details: { decision: r.ok ? "opened" : "refused" }, ...(r.ok ? {} : { isError: true }) };
    },
  } as never);
}
