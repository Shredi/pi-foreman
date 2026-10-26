// `/foreman session open|brief|close|list` (plan Part B): user commands of a top-level foreman.
//
// open   runs scripts/foreman_session.py (handoff dir, brief + report-back footer, Herdr tab or
//        the printed command for a new terminal, registry entry) with the opener's intercom id.
// brief  writes the file (or the text) to `<handoff dir>/brief-<n>.md` (the lowest free n, never overwritten),
//        then sends `Brief from <opener id>: read <abs path> and act on it` through the pi-intercom outbox.
//        Peer messages carry no authority.
// close  sends `foreman:close [path]`; the target's close flow checks the sender against its
//        parent and replies `foreman:closed <path>` or `pi-foreman: close refused: <reason>`.
// pull   polls the outbox of pull-mode remote children now (remotepull.ts; the same poll runs on a timer).
// list   prints the registry `<agent dir>/pi-foreman/state/sessions.json`.
// Inbound `Plan from|Result from|Update from <label>: <path>`, `foreman:plan|result <path>` and `foreman:closed <path>`
// from a registry child update its registry entry and show a notice (a `foreman_wait kind:child` wait resolves on it);
// nothing is acted on. A remote child (`open --machine`, entry field `machine`) reports through pi-intercom's cross-machine
// relay: remotesession.ts matches the structured origin to the entry, mirrors the file and wakes the same waits.
// Subagent children refuse every subcommand. The functions below take plain deps; the `foreman_session_open` tool
// (registerSessionOpenTool) runs the same sessionOpen; children never get it.
// open --first-command /cmd (repeatable) and --plan-mode (= --first-command /plan) are Pi extension commands the new
// session runs before the brief prompt; --plan-mode needs a `plan` command in the opener's pi.getCommands()
// (else `session open refused [plan_mode_unavailable]`).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ageText } from "./childwidget.ts";
import { CLOSE_TEXT, CLOSED_TEXT, outboxSend, validResultPathText } from "./close.ts";
import type { Json } from "./config.ts";
import { INTERCOM_MESSAGE_TYPE, intercomConfigPath, lastIntercomDetails } from "./intercomguard.ts";
import type { PullNow, RunRemote } from "./remotepull.ts";
import { applyRemoteNotice, parseRemoteNotice, pullSummary, remoteOrigin } from "./remotesession.ts";
import { sessionRankRefusal } from "./ranks.ts";
import { SESSION_FOREMAN } from "./roles.ts";
import type { Spawner } from "./spawn.ts";
import { INTERCOM_WAKE_TEXT } from "./usage.ts";

export const SESSION_USAGE =
  "Usage: /foreman session open <label> <brief-file> [--cwd DIR] [--model ID] [--plan-first] [--plan-mode] [--first-command /CMD]… [--focus] [--dry-run] [--machine NAME [--trust]] | /foreman session brief <target> <file|text…> | /foreman session close <target> [result-path] | /foreman session pull [label] | /foreman session list";
export const CHILD_REFUSAL = "/foreman session is for a top-level foreman session only; refused in subagent children.";
/** Seconds an outbox send waits for pi-intercom's result (a confirmation dialog may be open). */
export const SEND_WAIT_MS = 15_000;
const OPEN_TIMEOUT_MS = 180_000;

export type SessionCommand =
  | { sub: "open"; label: string; brief: string; cwd?: string; model?: string; planFirst: boolean; focus: boolean; dryRun: boolean; planMode?: boolean; firstCommands?: string[]; machine?: string; trust?: boolean }
  | { sub: "brief"; target: string; body: string }
  | { sub: "close"; target: string; path?: string }
  | { sub: "pull"; target?: string }
  | { sub: "list" }
  | { error: string };

/** Parse the text after `/foreman session`. */
export function parseSessionArgs(args: string): SessionCommand {
  const t = args.trim();
  const [sub = "", ...rest] = t.split(/\s+/);
  if (sub === "list") return rest.length ? { error: SESSION_USAGE } : { sub: "list" };
  if (sub === "pull") return rest.length > 1 ? { error: SESSION_USAGE } : rest[0] ? { sub: "pull", target: rest[0] } : { sub: "pull" };
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
    else if (a === "--cwd" || a === "--model" || a === "--machine" || a === "--first-command") {
      const v = rest[++i];
      if (!v || v.startsWith("--")) return { error: `${a} needs a value. ${SESSION_USAGE}` };
      if (a === "--cwd") out.cwd = v;
      else if (a === "--machine") out.machine = v;
      else if (a === "--first-command") (out.firstCommands ??= []).push(v);
      else out.model = v;
    } else if (a.startsWith("--")) return { error: `unknown option ${a}. ${SESSION_USAGE}` };
    else pos.push(a);
  }
  if (pos.length !== 2) return { error: SESSION_USAGE };
  [out.label, out.brief] = pos;
  return out;
}

/**
 * The opener's intercom id: PI_INTERCOM_SESSION_ID first (pi-intercom 0.17.0 publishes its resolved id
 * there, index.ts ~1030, which also covers ids claimed via intercom:session-identity), else its own
 * rule (index.ts:556): PI_INTERCOM_STABLE_ID, else `stableId` in <agent dir>/intercom/config.json,
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

/** A registry label (newest entry wins) or child id → the child's intercom id; anything else passes through. */
export function resolveTarget(reg: Registry, target: string): string {
  for (let i = reg.sessions.length - 1; i >= 0; i--) {
    const s = reg.sessions[i];
    if (s.label === target || s.child === target) return s.child;
  }
  return target;
}

/** The close line for a remote entry: P1 cannot close a remote session. */
export const remoteNotClosed = (s: SessionEntry): string => `${s.label}@${String(s.machine)}: not closed (remote close comes in P2; close it on ${String(s.machine)})`;

/** The handoff dir of the newest registry entry for a label or child id; undefined when none is recorded. */
export function resolveHandoff(reg: Registry, target: string): string | undefined {
  for (let i = reg.sessions.length - 1; i >= 0; i--) {
    const s = reg.sessions[i];
    if (s.label === target || s.child === target) return s.handoff;
  }
  return undefined;
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

export function formatList(reg: Registry): string {
  const nowMs = Date.now();
  if (!reg.sessions.length) return "pi-foreman sessions: none opened yet.";
  const rows = reg.sessions.map((s) => {
    const last = s.last ? ` · last: ${s.last.kind}${s.last.path ? ` ${s.last.path}` : ""} (${s.last.at})` : "";
    const pull = pullSummary(s, nowMs, (ms) => `${ageText(ms)} ago`);
    return `${s.label}  ${typeof s.model === "string" && s.model ? s.model : "-"}  ${s.status ?? "?"}  ${s.handoff ?? ""}  ${s.child}${last}${pull ? ` · ${pull}` : ""}`;
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
  /** This session's own model, `<provider>/<id>`; with `config` it enables the session-foreman model and the rank check. */
  model?: string;
  /** Merged config (providers.<p>.roles.session-foreman.model, ranks, ladder.childPolicy). */
  config?: Json;
  /** Names of this session's slash commands (pi.getCommands()); planMode needs `plan` among them. */
  commands?: string[];
  /** Poll a remote child's outbox now (remotepull.ts); absent where no pull module runs. */
  pullNow?: PullNow;
  /** Run a `foreman_session.py` verb through the pull queue (remotepull.ts). */
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

export async function sessionOpen(d: SessionDeps, c: Extract<SessionCommand, { sub: "open" }>): Promise<SessionResult> {
  if (!d.python) return { text: "foreman_session.py: no usable Python (run /foreman doctor).", ok: false };
  if (c.planMode && !d.commands?.includes("plan")) return { text: PLAN_MODE_UNAVAILABLE, ok: false };
  const explicit = c.model ?? sessionForemanModel(d.config, d.model);
  const model = explicit ?? d.model;
  if (d.config && (model || d.model === undefined)) {
    const refused = sessionRankRefusal(d.config, d.model, model ?? "the new session's default model");
    if (refused) return { text: refused, ok: false };
  }
  const opener = openerIntercomId(d.env, d.agentDir, d.piSessionId);
  if (c.machine && !c.cwd) return { text: "pi-foreman session: open --machine needs --cwd (the directory on the remote machine).", ok: false };
  // a remote cwd is a path on the other machine: passed verbatim, never resolved here; the brief file is local
  const cwdArg = c.machine ? c.cwd! : path.resolve(d.cwd, c.cwd ?? ".");
  const argv = [path.join(d.pkgRoot, "scripts", "foreman_session.py"), "--agent-dir", d.agentDir, "open", c.label, path.resolve(d.cwd, c.brief), "--cwd", cwdArg, "--parent-id", opener];
  if (c.machine) argv.push("--machine", c.machine);
  if (c.trust) argv.push("--trust");
  if (d.model) argv.push("--own-model", d.model);
  // only an explicit choice (--model or the session-foreman mapping) sets PI_FOREMAN_SESSION_MODEL in the child; the opener's own model is just displayed
  if (explicit) argv.push("--model", explicit);
  if (c.planFirst) argv.push("--plan-first");
  if (c.planMode) argv.push("--plan-mode");
  for (const f of c.firstCommands ?? []) argv.push("--first-command", f);
  if (c.focus) argv.push("--focus");
  if (c.dryRun) argv.push("--dry-run");
  const r = await d.spawner(d.python, ["-E", "-s", ...argv], { timeoutMs: OPEN_TIMEOUT_MS, cwd: d.cwd });
  const out = r.stdout.trim();
  const text = [model && !/^session model: /m.test(out) ? `session model: ${model}` : "", out, r.stderr.trim()].filter(Boolean).join("\n") || (r.error ? r.error.message : r.timedOut ? "foreman_session.py timed out" : "foreman_session.py produced no output.");
  return { text, ok: !r.error && !r.timedOut && r.code === 0 };
}

async function sendTo(d: SessionDeps, to: string, message: string, what: string): Promise<SessionResult> {
  const status = await d.send(to, message);
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
    // a remote child is briefed over ssh by the script (`remote deliver`), not over the local intercom
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
  return sendTo(d, to, briefText(openerIntercomId(d.env, d.agentDir, d.piSessionId), brief), "brief");
}

export async function sessionClose(d: SessionDeps, target: string, resultPath?: string): Promise<SessionResult> {
  if (resultPath !== undefined && !validResultPathText(resultPath)) return { text: "pi-foreman session: the result path may use only A-Z a-z 0-9 . _ / - (at most 200 characters) and must end in .md", ok: false };
  const reg = readRegistry(d.agentDir);
  const to = resolveTarget(reg, target);
  const remote = [...reg.sessions].reverse().find((s) => s.child === to && typeof s.machine === "string");
  if (remote) return { text: remoteNotClosed(remote), ok: false };
  const r = await sendTo(d, to, closeText(resultPath), "close request");
  const entry = reg.sessions.find((s) => s.child === to);
  if (r.ok && entry && entry.status !== "closed") {
    entry.status = "closing";
    writeRegistry(d.agentDir, reg);
  }
  return r;
}

/** `/foreman session pull [label]`: polls the pull-mode remote entries of this session (or the one named) now. */
export async function sessionPull(d: SessionDeps, target?: string): Promise<SessionResult> {
  if (!d.pullNow) return { text: "pi-foreman session: pull is not available in this session.", ok: false };
  const reg = readRegistry(d.agentDir);
  const opener = openerIntercomId(d.env, d.agentDir, d.piSessionId);
  const rows = target
    ? [...reg.sessions].reverse().filter((s) => s.label === target || s.child === target).slice(0, 1)
    : reg.sessions.filter((s) => s.parent === opener);
  const eligible = rows.filter((s) => typeof s.machine === "string" && s.returnPath === "pull" && (s.status === "open" || s.status === "pending" || s.status === "closing"));
  if (!eligible.length) return { text: target ? `pi-foreman session: ${target} is not an open pull session on a remote machine.` : "pi-foreman session: no open pull sessions.", ok: !target };
  const lines: string[] = [];
  let ok = true;
  for (const s of eligible) {
    const r = await d.pullNow(s.child);
    const who = `${s.label}@${String(s.machine)}`;
    if (r.ok) lines.push(`${who}: pulled ${r.entries} entr${r.entries === 1 ? "y" : "ies"}${r.skipped ? `, ${r.skipped} skipped` : ""}${r.closed ? ", closed" : ""}`);
    else {
      ok = false;
      lines.push(`${who}: pull failed (${r.error ?? "unknown"})`);
    }
  }
  return { text: lines.join("\n"), ok };
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
  if (c.sub === "pull") return sessionPull(d, c.target);
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
}

const commandNames = (pi: ExtensionAPI): string[] => pi.getCommands?.().map((c) => c.name) ?? [];

/** Inbound report recognition plus the `/foreman session` handler. */
export function registerSession(
  pi: ExtensionAPI,
  deps: { session: (ctx: ExtensionContext) => Promise<SessionHost>; spawner: Spawner; pkgRoot: string; onChildNotice?: (sessionId: string, label: string, kind: string, notePath: string) => void; pullNow?: PullNow; runRemote?: RunRemote },
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
    const m = event.message as { role?: string; customType?: string; details?: unknown };
    if (m.role !== "custom" || m.customType !== INTERCOM_MESSAGE_TYPE || process.env.PI_SUBAGENT_CHILD === "1") return;
    await onInbound(ctx, m.details);
  });
  // An idle session gets the message without an extension message_end (see close.ts); display only.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" && event.text === INTERCOM_WAKE_TEXT && process.env.PI_SUBAGENT_CHILD !== "1") {
      const hit = lastIntercomDetails(ctx.sessionManager.getBranch());
      if (hit) await onInbound(ctx, hit.details);
    }
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
          send: (to, text) => outboxSend(pi.events, to, text, "session", SEND_WAIT_MS),
          model: s.model,
          config: s.config,
          commands: commandNames(pi),
          pullNow: deps.pullNow,
          runRemote: deps.runRemote,
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
    model: { type: "string", description: "Model of the new session, <provider>/<id>; the rank rule applies." },
    planFirst: { type: "boolean", description: "The brief asks the session to write a plan first." },
    planMode: { type: "boolean", description: "Open the session in plan mode (first command /plan); refused when this session has no /plan command." },
    firstCommand: { type: "array", items: { type: "string" }, maxItems: 4, description: "Extension commands (each starting with /) the new session runs before the brief prompt." },
    focus: { type: "boolean", description: "Focus the new Herdr tab." },
    dryRun: { type: "boolean", description: "Print the handoff dir, child id and command; open nothing." },
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
      "Open a new foreman session in a Herdr tab (or print the command for a new terminal) with a brief file: same as `/foreman session open`. Design or new-topic sessions: planMode true; a session with an approved plan: no planMode. Refused in subagent children.",
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
          send: async () => "unavailable",
          model: s.model,
          config: s.config,
          commands: commandNames(pi),
        },
        params,
      );
      return { content: [{ type: "text" as const, text: r.text }], details: { decision: r.ok ? "opened" : "refused" }, ...(r.ok ? {} : { isError: true }) };
    },
  } as never);
}
