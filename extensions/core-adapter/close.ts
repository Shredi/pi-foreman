// Remote session close (plan D5, ledger items 9, 42).
//
// Triggers: `/foreman close [result-path]` (when "herdr" is in close.from: the typed command is the
// pane keyboard, which `herdr agent prompt` drives), and an inbound pi-intercom message whose text
// is exactly `foreman:close` or `foreman:close <path>` (when "intercom-parent" is in close.from and
// the sender's session id equals PI_FOREMAN_PARENT_INTERCOM, the parent recorded at spawn). A
// refused request is traced and otherwise stays plain data.
//
// Sequence: refuse while any foreman_wait is active (never cancels one); wait until the agent is
// idle (agent_settled + ctx.isIdle(); an open dialog just keeps the session busy, nothing answers
// it); one ordinary close turn asks the model to write the result file; on the next agent_settled
// run foreman_sync.py, write a stub result when the file is still missing, then ctx.shutdown().
// The close turn passes the permission system, triage gate and drift checks like any other turn.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { get } from "./config.ts";
import { workspaceOf } from "./python.ts";
import { realDeep, under } from "./triage.ts";

export const CLOSE_TEXT = "foreman:close";
export const PARENT_INTERCOM_ENV = "PI_FOREMAN_PARENT_INTERCOM";
export const INTERCOM_INBOUND_TYPE = "intercom_message";
/** pi-intercom's idle wake prompt after an inbound message (pi-intercom 0.16.1 index.ts). */
export const INTERCOM_WAKE_TEXT = "New intercom message above.";
/** pi-intercom 0.16.1 extension-api.ts: outbox request event (reply to the sender). */
export const INTERCOM_OUTBOX_EVENT = "intercom:outbox-request";
export const CLOSE_SOURCES = ["herdr", "intercom-parent"] as const;
export type CloseSource = (typeof CLOSE_SOURCES)[number];

export function closePrompt(file: string): string {
  return `pi-foreman close: write your result file now at ${file} (summary, commits, open items). Do not start new work.`;
}

/** Allowed sources (`close.from`); a malformed value allows none. */
export function closeFrom(cfg: unknown): Set<CloseSource> {
  const v = get(cfg, "close.from");
  if (v === undefined) return new Set(CLOSE_SOURCES);
  if (!Array.isArray(v)) return new Set();
  return new Set(v.filter((x): x is CloseSource => (CLOSE_SOURCES as readonly string[]).includes(x)));
}

/** `foreman:close` / `foreman:close <path>` (the whole text, trimmed); null = not a close request. */
export function parseCloseText(text: unknown): { path?: string } | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t === CLOSE_TEXT) return {};
  const m = /^foreman:close (\S[^\r\n]*)$/.exec(t);
  return m ? { path: m[1].trim() } : null;
}

export type IntercomClose = { kind: "close"; path?: string; sender: string } | { kind: "refused"; reason: string; sender?: string };

/** A close request in an inbound pi-intercom message's details ({from, message}); null = ordinary message. */
export function intercomClose(details: unknown, parentId: string | undefined, from: Set<CloseSource>): IntercomClose | null {
  const d = (details && typeof details === "object" ? details : {}) as { from?: { id?: unknown }; message?: { content?: { text?: unknown }; crossMachine?: unknown } };
  const req = parseCloseText(d.message?.content?.text);
  if (!req) return null;
  const sender = typeof d.from?.id === "string" ? d.from.id : undefined;
  if (!from.has("intercom-parent")) return { kind: "refused", reason: "close.from does not include intercom-parent", sender };
  if (!parentId) return { kind: "refused", reason: `${PARENT_INTERCOM_ENV} is not set (no parent recorded at spawn)`, sender };
  if (d.message?.crossMachine) return { kind: "refused", reason: "cross-machine messages cannot close a session", sender };
  if (!sender || sender !== parentId) return { kind: "refused", reason: "the sender is not the parent recorded at spawn", sender };
  return { kind: "close", path: req.path, sender };
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** The result file: default `<ws>/.workflow/result-<stamp>-<id8>.md`; a given one must resolve inside `<ws>/.workflow/`. */
export function resultPath(raw: string | undefined, o: { cwd: string; sessionId: string; now: Date; platform: string }): { path: string } | { error: string } {
  const root = workspaceOf(o.cwd).root;
  const wf = path.join(realDeep(path.resolve(root)), ".workflow");
  const abs = raw ? path.resolve(o.cwd, raw) : path.join(root, ".workflow", `result-${stamp(o.now)}-${o.sessionId.slice(0, 8)}.md`);
  const real = realDeep(abs);
  if (!under(wf, real, o.platform) || real === wf) return { error: `the result path must be inside ${wf}` };
  return { path: real };
}

export interface CloseDeps {
  activeWaits: () => { id: string; kind: string; note: string }[];
  sendUserMessage: (text: string) => void;
  runSync: () => Promise<{ text: string; ok: boolean }>;
  /** Retro numbers for a stub ("" when the sync output already carries them). */
  retro: () => Promise<string>;
  reply: (to: string, text: string) => void;
  notify: (text: string, level: "info" | "warning" | "error") => void;
  trace: (rec: Record<string, unknown>) => void;
  /** Mark the current run's turn cause as `close`. */
  markCause: () => void;
  writeStub: (file: string, text: string) => void;
  exists: (file: string) => boolean;
}

export interface CloseRequest {
  source: CloseSource;
  file: string;
  /** Intercom sender to answer a refusal to. */
  replyTo?: string;
}

type Phase = "idle-wait" | "result-turn" | "finishing";

/** One session's close sequence. */
export class CloseFlow {
  private phase: Phase | null = null;
  private req: CloseRequest | null = null;
  private wakePending = false;
  private promptPending = false;
  private readonly d: CloseDeps;

  constructor(d: CloseDeps) {
    this.d = d;
  }

  get active(): boolean {
    return this.phase !== null;
  }

  refuse(reason: string, source: CloseSource, replyTo?: string): void {
    this.d.trace({ event: "close", cause: source, decision: "refused" });
    const text = `pi-foreman: close refused: ${reason}`;
    this.d.notify(text, "warning");
    if (replyTo) this.d.reply(replyTo, text);
  }

  private waitsBlock(source: CloseSource, replyTo?: string): boolean {
    const waits = this.d.activeWaits();
    if (waits.length === 0) return false;
    this.refuse(`${waits.length} foreman_wait pending (${waits.map((w) => `${w.id} ${w.kind}${w.note ? ` "${w.note}"` : ""}`).join(", ")}); cancel or let them finish, then close again`, source, replyTo);
    return true;
  }

  /** Start a close (validated source and path). */
  request(req: CloseRequest, ctx: { isIdle(): boolean }, viaIntercomWake = false): void {
    if (this.phase) return this.refuse("a close is already in progress", req.source, req.replyTo);
    if (this.waitsBlock(req.source, req.replyTo)) return;
    this.req = req;
    this.wakePending = viaIntercomWake;
    this.d.trace({ event: "close", cause: req.source, decision: "accepted" });
    this.d.notify(`pi-foreman: closing this session (result file ${req.file}).`, "info");
    if (ctx.isIdle()) this.closeTurn();
    else this.phase = "idle-wait";
  }

  private closeTurn(): void {
    if (!this.req) return;
    if (this.waitsBlock(this.req.source, this.req.replyTo)) return this.reset();
    this.phase = "result-turn";
    this.promptPending = true;
    this.d.trace({ event: "close", cause: this.req.source, decision: "turn" });
    this.d.sendUserMessage(closePrompt(this.req.file));
  }

  /**
   * `input` hook: suppress pi-intercom's idle wake prompt for an accepted intercom close (the
   * close turn replaces it); mark the close prompt's turn cause. true = handled (no run).
   */
  onInput(text: string, source: string): boolean {
    if (source !== "extension") return false;
    if (this.wakePending && text === INTERCOM_WAKE_TEXT) {
      this.wakePending = false;
      return true;
    }
    if (this.promptPending && this.req && text === closePrompt(this.req.file)) {
      this.promptPending = false;
      this.d.markCause();
    }
    return false;
  }

  /** `agent_settled`: advance the sequence. */
  async onSettled(ctx: { isIdle(): boolean; shutdown(): void }): Promise<void> {
    if (!this.phase || !this.req) return;
    if (!ctx.isIdle()) return;
    if (this.phase === "idle-wait") return this.closeTurn();
    if (this.phase !== "result-turn") return;
    this.phase = "finishing";
    const req = this.req;
    if (this.waitsBlock(req.source, req.replyTo)) return this.reset();
    const sync = await this.d.runSync();
    this.d.trace({ event: "close", cause: req.source, decision: sync.ok ? "synced" : "sync-incomplete" });
    if (!this.d.exists(req.file)) {
      const retro = await this.d.retro();
      const body = ["# pi-foreman close result (stub)", "", "The session did not write its result file; pi-foreman wrote this stub.", "", "## Sync", "", "```", sync.text, "```", ...(retro ? ["", "## Retro", "", "```", retro, "```"] : []), ""].join("\n");
      try {
        this.d.writeStub(req.file, body);
        this.d.trace({ event: "close", cause: req.source, decision: "stub" });
      } catch (err) {
        this.d.notify(`pi-foreman: could not write the stub result ${req.file}: ${(err as Error).message}`, "error");
      }
    }
    this.d.notify(`pi-foreman: close: ${sync.text.split("\n").slice(0, 3).join(" | ")}`, sync.ok ? "info" : "warning");
    this.d.trace({ event: "close", cause: req.source, decision: "shutdown" });
    this.reset();
    ctx.shutdown();
  }

  reset(): void {
    this.phase = null;
    this.req = null;
    this.wakePending = false;
    this.promptPending = false;
  }
}

/** Stub writer: create-only, and only while the path still resolves inside `.workflow/`. */
export function writeStubFile(file: string, text: string, cwd: string, platform: string): void {
  const again = resultPath(file, { cwd, sessionId: "", now: new Date(), platform });
  if ("error" in again || again.path !== file) throw new Error("the result path no longer resolves inside .workflow/");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
}

export interface CloseSession {
  id: string;
  isChild: boolean;
  cwd: string;
  config: () => unknown;
  trace: (rec: Record<string, unknown>) => void;
  markCause: () => void;
  runSync: (ctx: ExtensionContext) => Promise<{ text: string; ok: boolean }>;
  retro: (ctx: ExtensionContext) => Promise<string>;
}

/** Wire the intercom trigger and the sequence events; returns the `/foreman close` handler. */
export function registerClose(
  pi: ExtensionAPI,
  deps: { session: (ctx: ExtensionContext) => Promise<CloseSession>; activeWaits: (sessionId: string) => { id: string; kind: string; note: string }[]; platform: string },
): { command: (args: string, ctx: ExtensionContext) => Promise<void> } {
  const flows = new Map<string, { flow: CloseFlow; ctx: ExtensionContext }>();
  const flowFor = (s: CloseSession, ctx: ExtensionContext): CloseFlow => {
    const slot = flows.get(s.id);
    if (slot) {
      slot.ctx = ctx;
      return slot.flow;
    }
    const holder = { ctx } as { flow: CloseFlow; ctx: ExtensionContext };
    holder.flow = new CloseFlow({
      activeWaits: () => deps.activeWaits(s.id),
      sendUserMessage: (text) => pi.sendUserMessage(text),
      runSync: () => s.runSync(holder.ctx),
      retro: () => (get(s.config(), "sync.runRetro") === false ? s.retro(holder.ctx) : Promise.resolve("")),
      reply: (to, text) => pi.events?.emit(INTERCOM_OUTBOX_EVENT, { version: 1, requestId: `pi-foreman-close-${Date.now()}`, extensionId: "pi-foreman", extensionName: "pi-foreman", to, message: text }),
      notify: (text, level) => {
        try {
          holder.ctx.ui.notify(text, level);
        } catch {
          // stale context
        }
        if (!holder.ctx.hasUI) process.stderr.write(`${text}\n`);
      },
      trace: s.trace,
      markCause: s.markCause,
      writeStub: (file, text) => writeStubFile(file, text, s.cwd, deps.platform),
      exists: (file) => fs.existsSync(file),
    });
    flows.set(s.id, holder);
    return holder.flow;
  };
  const sid = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();

  pi.on("session_shutdown", async (_event, ctx) => {
    flows.delete(sid(ctx));
  });
  pi.on("message_end", async (event, ctx) => {
    const m = event.message as { role?: string; customType?: string; details?: unknown };
    if (m.role !== "custom" || m.customType !== INTERCOM_INBOUND_TYPE || process.env.PI_SUBAGENT_CHILD === "1") return;
    const s = await deps.session(ctx);
    if (s.isChild) return;
    const r = intercomClose(m.details, process.env[PARENT_INTERCOM_ENV] || undefined, closeFrom(s.config()));
    if (!r) return;
    const flow = flowFor(s, ctx);
    if (r.kind === "refused") return flow.refuse(r.reason, "intercom-parent", r.sender);
    const file = resultPath(r.path, { cwd: s.cwd, sessionId: s.id, now: new Date(), platform: deps.platform });
    if ("error" in file) return flow.refuse(file.error, "intercom-parent", r.sender);
    flow.request({ source: "intercom-parent", file: file.path, replyTo: r.sender }, ctx, true);
  });
  pi.on("input", async (event, ctx) => {
    const slot = flows.get(sid(ctx));
    if (slot?.flow.active && slot.flow.onInput(event.text, event.source)) return { action: "handled" as const };
    return { action: "continue" as const };
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const slot = flows.get(sid(ctx));
    if (!slot?.flow.active) return;
    slot.ctx = ctx;
    await slot.flow.onSettled(ctx);
  });

  return {
    command: async (args, ctx) => {
      const s = await deps.session(ctx);
      if (s.isChild) {
        ctx.ui.notify("/foreman close is for the foreman only.", "warning");
        return;
      }
      const flow = flowFor(s, ctx);
      if (!closeFrom(s.config()).has("herdr")) return flow.refuse("close.from does not include herdr", "herdr");
      const raw = args.trim();
      const file = resultPath(raw || undefined, { cwd: s.cwd, sessionId: s.id, now: new Date(), platform: deps.platform });
      if ("error" in file) return flow.refuse(file.error, "herdr");
      flow.request({ source: "herdr", file: file.path }, ctx);
    },
  };
}
