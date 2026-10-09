// `/foreman session open|brief|close|list` (plan Part B): user commands of a top-level foreman.
//
// open   runs scripts/foreman_session.py (handoff dir, brief + report-back footer, Herdr tab or
//        the printed command for a new terminal, registry entry) with the opener's intercom id.
// brief  sends `Brief from <opener id>: read <abs path> and act on it` (a file) or the text as is
//        through the pi-intercom outbox. Peer messages carry no authority.
// close  sends `foreman:close [path]`; the target's close flow checks the sender against its
//        parent and replies `foreman:closed <path>` or `pi-foreman: close refused: <reason>`.
// list   prints the registry `<agent dir>/pi-foreman/state/sessions.json`.
// Inbound `Plan from|Result from|Update from <label>: <path>` and `foreman:closed <path>` from a
// registry child update its registry entry and show a notice; nothing is acted on.
// Subagent children refuse every subcommand. The functions below take plain deps, so a later
// user-layer opt-in `foreman_session` tool can call them; no model tool is registered here.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLOSE_TEXT, CLOSED_TEXT, outboxSend, validResultPathText } from "./close.ts";
import { INTERCOM_MESSAGE_TYPE, intercomConfigPath, lastIntercomDetails } from "./intercomguard.ts";
import type { Spawner } from "./spawn.ts";
import { INTERCOM_WAKE_TEXT } from "./usage.ts";

export const SESSION_USAGE =
  "Usage: /foreman session open <label> <brief-file> [--cwd DIR] [--model ID] [--plan-first] [--focus] [--dry-run] | /foreman session brief <target> <file|text…> | /foreman session close <target> [result-path] | /foreman session list";
export const CHILD_REFUSAL = "/foreman session is for a top-level foreman session only; refused in subagent children.";
/** Seconds an outbox send waits for pi-intercom's result (a confirmation dialog may be open). */
export const SEND_WAIT_MS = 15_000;
const OPEN_TIMEOUT_MS = 180_000;

export type SessionCommand =
  | { sub: "open"; label: string; brief: string; cwd?: string; model?: string; planFirst: boolean; focus: boolean; dryRun: boolean }
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
    else if (a === "--cwd" || a === "--model") {
      const v = rest[++i];
      if (!v || v.startsWith("--")) return { error: `${a} needs a value. ${SESSION_USAGE}` };
      if (a === "--cwd") out.cwd = v;
      else out.model = v;
    } else if (a.startsWith("--")) return { error: `unknown option ${a}. ${SESSION_USAGE}` };
    else pos.push(a);
  }
  if (pos.length !== 2) return { error: SESSION_USAGE };
  [out.label, out.brief] = pos;
  return out;
}

/**
 * The opener's intercom id: PI_INTERCOM_SESSION_ID first (pi-intercom 0.16.1 publishes its resolved id
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

export const briefText = (opener: string, file: string): string => `Brief from ${opener}: read ${file} and act on it`;
export const closeText = (resultPath?: string): string => (resultPath ? `${CLOSE_TEXT} ${resultPath}` : CLOSE_TEXT);

export type Inbound = { kind: "plan" | "result" | "update"; label: string; path: string } | { kind: "closed"; path: string };

/** The message contract's report lines (one line each); null = any other message. */
export function parseInbound(text: unknown): Inbound | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (/[\r\n]/.test(t)) return null;
  const m = /^(Plan|Result|Update) from ([A-Za-z0-9._-]{1,40}): (\S.*)$/.exec(t);
  if (m) return { kind: m[1].toLowerCase() as "plan" | "result" | "update", label: m[2], path: m[3].trim() };
  const c = new RegExp(`^${CLOSED_TEXT} (\\S.*)$`).exec(t);
  return c ? { kind: "closed", path: c[1].trim() } : null;
}

/** Record an inbound report from a registry child (matched by sender id); the updated entry or null. */
export function applyInbound(reg: Registry, sender: string, msg: Inbound, now: Date): SessionEntry | null {
  const entry = [...reg.sessions].reverse().find((s) => s.child === sender);
  if (!entry) return null;
  entry.last = { kind: msg.kind, path: msg.path, at: now.toISOString() };
  if (msg.kind === "closed") {
    entry.status = "closed";
    entry.result = msg.path;
  } else {
    if (msg.kind === "result" || msg.kind === "update") entry.result = msg.path;
    if (entry.status === "pending") entry.status = "open";
  }
  return entry;
}

export function formatList(reg: Registry): string {
  if (!reg.sessions.length) return "pi-foreman sessions: none opened yet.";
  const rows = reg.sessions.map((s) => {
    const last = s.last ? ` · last: ${s.last.kind}${s.last.path ? ` ${s.last.path}` : ""} (${s.last.at})` : "";
    return `${s.label}  ${s.child}  ${s.status ?? "?"}  ${s.handoff ?? ""}${last}`;
  });
  return ["pi-foreman sessions (label, child id, status, handoff dir):", ...rows].join("\n");
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
}

export type SessionResult = { text: string; ok: boolean };

export async function sessionOpen(d: SessionDeps, c: Extract<SessionCommand, { sub: "open" }>): Promise<SessionResult> {
  if (!d.python) return { text: "foreman_session.py: no usable Python (run /foreman doctor).", ok: false };
  const opener = openerIntercomId(d.env, d.agentDir, d.piSessionId);
  const argv = [path.join(d.pkgRoot, "scripts", "foreman_session.py"), "--agent-dir", d.agentDir, "open", c.label, path.resolve(d.cwd, c.brief), "--cwd", path.resolve(d.cwd, c.cwd ?? "."), "--parent-id", opener];
  if (c.model) argv.push("--model", c.model);
  if (c.planFirst) argv.push("--plan-first");
  if (c.focus) argv.push("--focus");
  if (c.dryRun) argv.push("--dry-run");
  const r = await d.spawner(d.python, ["-E", "-s", ...argv], { timeoutMs: OPEN_TIMEOUT_MS, cwd: d.cwd });
  const text = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n") || (r.error ? r.error.message : r.timedOut ? "foreman_session.py timed out" : "foreman_session.py produced no output.");
  return { text, ok: !r.error && !r.timedOut && r.code === 0 };
}

async function sendTo(d: SessionDeps, to: string, message: string, what: string): Promise<SessionResult> {
  const status = await d.send(to, message);
  if (status === "sent") return { text: `pi-foreman session: ${what} sent to ${to}.`, ok: true };
  if (status === "timeout") return { text: `pi-foreman session: ${what} for ${to} handed to pi-intercom; no send result yet (a confirmation may be open).`, ok: true };
  return { text: `pi-foreman session: ${what} to ${to} not sent (${status}). Is pi-intercom installed and the target connected?`, ok: false };
}

export async function sessionBrief(d: SessionDeps, target: string, body: string): Promise<SessionResult> {
  const to = resolveTarget(readRegistry(d.agentDir), target);
  const file = /\s/.test(body) ? null : path.resolve(d.cwd, body);
  const isFile = file !== null && fs.existsSync(file) && fs.statSync(file).isFile();
  const message = isFile ? briefText(openerIntercomId(d.env, d.agentDir, d.piSessionId), file!) : body;
  return sendTo(d, to, message, isFile ? "brief file" : "message");
}

export async function sessionClose(d: SessionDeps, target: string, resultPath?: string): Promise<SessionResult> {
  if (resultPath !== undefined && !validResultPathText(resultPath)) return { text: "pi-foreman session: the result path may use only A-Z a-z 0-9 . _ / - (at most 200 characters) and must end in .md", ok: false };
  const reg = readRegistry(d.agentDir);
  const to = resolveTarget(reg, target);
  const r = await sendTo(d, to, closeText(resultPath), "close request");
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

export interface SessionHost {
  id: string;
  isChild: boolean;
  cwd: string;
  agentDir: string;
  python: string | null;
}

/** Inbound report recognition plus the `/foreman session` handler. */
export function registerSession(
  pi: ExtensionAPI,
  deps: { session: (ctx: ExtensionContext) => Promise<SessionHost>; spawner: Spawner; pkgRoot: string },
): { command: (args: string, ctx: ExtensionContext) => Promise<void> } {
  const seen = new Set<string>();
  const onInbound = async (ctx: ExtensionContext, details: unknown): Promise<void> => {
    const d = (details && typeof details === "object" ? details : {}) as { from?: { id?: unknown }; message?: { id?: unknown; content?: { text?: unknown } } };
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
        },
        args,
      );
      ctx.ui.notify(r.text, r.ok ? "info" : "warning");
    },
  };
}
