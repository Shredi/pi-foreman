// Herdr "blocked" state. Herdr's Pi integration (v9) listens on `pi.events` `herdr:blocked {active, label}`
// with a counter and otherwise shows `working` while a dialog is open. One BlockedTracker per Pi process
// owns every open "waiting for the owner" source and emits only on empty->non-empty (active:true) and
// non-empty->empty (active:false), so Herdr's counter stays balanced however the sources overlap or nest:
//   ui           Pi's ui_prompt_start .. ui_prompt_end (ANY extension's dialog; Pi collapses nesting and
//                delivers both via microtask, so ui_prompt_end may arrive before permissions:decision)
//   perm:<id>    pi-permission-system `permissions:ui_prompt` .. `permissions:decision` with the same requestId
//   own:<n>      pi-foreman's own asks (`withBlocked` / `blockedConfirm`)
// Own asks also reach `onOwn` hooks (the radar presence file), with or without Herdr: Pi suppresses
// ui_prompt_start while an earlier dialog is still unsettled (uiPromptDepth > 0, e.g. an orphaned one).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "./env.ts";

export const HERDR_BLOCKED_CHANNEL = "herdr:blocked";
export const PERMISSIONS_UI_PROMPT = "permissions:ui_prompt";
export const PERMISSIONS_DECISION = "permissions:decision";
// The upstream patch prepared for Herdr's Pi integration bumps HERDR_INTEGRATION_VERSION to 10 and maps
// ui_prompt_* and the permission events natively; once that integration is installed this shim steps aside.
export const HERDR_NATIVE_PROMPT_VERSION = 10;
const LABEL_MAX = 80;

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): (() => void) | void;
}

/** Strip control chars, collapse whitespace, cap at 80 chars. */
export function cleanLabel(s: string): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1)}…` : t;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Quotes and `$(`/`)` of a shell word group are balanced (a value that spans words is complete). */
function balanced(w: string): boolean {
  const n = (re: RegExp): number => (w.match(re) ?? []).length;
  return n(/"/g) % 2 === 0 && n(/'/g) % 2 === 0 && n(/\(/g) <= n(/\)/g);
}

/** Label of a permission ask: `<agent> · <tool> <head>`; head is the first word of the value after `env` and `NAME=value` assignments (a path's basename), never the full value. */
export function permissionLabel(data: unknown): string {
  const d = (data ?? {}) as { agentName?: unknown; surface?: unknown; value?: unknown; request?: { toolName?: unknown } | null; forwarding?: { requesterAgentName?: unknown } | null };
  const agent = str(d.forwarding?.requesterAgentName) || str(d.agentName);
  const tool = str(d.request?.toolName) || str(d.surface) || "permission";
  // Skip `env` and leading `NAME=value` assignments (they can carry secrets); drop anything after an `=` in the head.
  // A quoted or `$(…)` assignment value can span words: skip until its quotes and parens balance. A head that is
  // not a plain command word (quotes, `$`, parens left over) is dropped.
  const words = str(d.value).split(/\s+/).filter(Boolean);
  let i = words[0] === "env" ? 1 : 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
    let open = words[i];
    while (!balanced(open) && i + 1 < words.length) open += ` ${words[++i]}`;
    i++;
  }
  let head = (words[i] ?? "").split("=")[0];
  if (!/^[\w.@+\/\\:-]+$/.test(head)) head = "";
  if (/[\\/]/.test(head)) head = head.split(/[\\/]+/).filter(Boolean).pop() ?? "";
  const ask = head ? `${tool} ${head}` : tool;
  return cleanLabel(agent ? `${agent} · ${ask}` : ask);
}

/** Version from the `// HERDR_INTEGRATION_VERSION=<n>` header of the installed Herdr Pi integration; 0 when unreadable. */
export function herdrIntegrationVersion(agentDir: string): number {
  try {
    const head = fs.readFileSync(path.join(agentDir, "extensions", "herdr-agent-state.ts"), "utf8").slice(0, 4096);
    const m = /^\s*\/\/\s*HERDR_INTEGRATION_VERSION=(\d+)/m.exec(head);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** Label priority: permission ask, Pi dialog title, own-ask title, dialog kind. */
const RANK = { perm: 0, title: 1, own: 2, kind: 3 } as const;
type Rank = keyof typeof RANK;

export class BlockedTracker {
  private readonly open = new Map<string, { label: string; rank: Rank }>();
  private readonly listeners = new Set<(active: boolean, label?: string) => void>();
  private readonly ownHooks = new Set<(label: string) => (() => void) | void>();
  private seq = 0;
  private readonly events: EventBus | undefined;
  private readonly enabled: () => boolean;

  /** `enabled` is asked before a source is added (a disabled shim adds nothing; releases always run). */
  constructor(events: EventBus | undefined, enabled: () => boolean = () => true) {
    this.events = events;
    this.enabled = enabled;
  }

  get active(): boolean {
    return this.open.size > 0;
  }

  /** Called on every empty<->non-empty transition (the same moments herdr:blocked is emitted). Returns an unsubscribe. */
  onChange(fn: (active: boolean, label?: string) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  add(source: string, label: string, rank: Rank): void {
    if (this.open.has(source) || !this.enabled()) return;
    this.open.set(source, { label: cleanLabel(label) || "waiting", rank });
    // A label that changes while already blocked is not re-emitted: Herdr keeps the first one (acceptable).
    if (this.open.size === 1) this.signal(true, this.label());
  }

  remove(source: string): void {
    if (this.open.delete(source) && this.open.size === 0) this.signal(false);
  }

  /** Release everything with one active:false; `keepUi` keeps an open Pi dialog (Pi still sends its ui_prompt_end). */
  clear(opts: { keepUi?: boolean } = {}): void {
    if (!this.open.size) return;
    for (const k of [...this.open.keys()]) if (!(opts.keepUi && k === "ui")) this.open.delete(k);
    if (this.open.size === 0) this.signal(false);
  }

  /** Called on every own ask, enabled or not; the hook's return value is that ask's release. Returns an unsubscribe. */
  onOwn(fn: (label: string) => (() => void) | void): () => void {
    this.ownHooks.add(fn);
    return () => void this.ownHooks.delete(fn);
  }

  /** Open an own-ask source (Herdr when enabled, plus every `onOwn` hook); returns its release (idempotent). */
  own(label: string): () => void {
    const key = `own:${++this.seq}`;
    this.add(key, label, "own");
    const releases: (() => void)[] = [];
    for (const fn of this.ownHooks) {
      try {
        const r = fn(label);
        if (r) releases.push(r);
      } catch {
        // a hook never breaks the ask
      }
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.remove(key);
      for (const r of releases) {
        try {
          r();
        } catch {
          // as above
        }
      }
    };
  }

  private label(): string {
    let best: { label: string; rank: Rank } | undefined;
    for (const v of this.open.values()) if (!best || RANK[v.rank] < RANK[best.rank]) best = v;
    return best?.label ?? "waiting";
  }

  private signal(active: boolean, label?: string): void {
    try {
      this.events?.emit(HERDR_BLOCKED_CHANNEL, active ? { active, label } : { active });
    } catch {
      // cosmetic
    }
    for (const fn of this.listeners) {
      try {
        fn(active, label);
      } catch {
        // a listener never breaks the shim
      }
    }
  }
}

// The tracker of each event bus, so `withBlocked(pi.events, ...)` call sites need no tracker handle.
const trackers = new WeakMap<object, BlockedTracker>();

/** Run `fn` as an own-ask source of the bus's tracker (no tracker: just run it). */
export async function withBlocked<T>(events: EventBus | undefined, label: string, fn: () => Promise<T>): Promise<T> {
  const release = events ? trackers.get(events)?.own(label) : undefined;
  try {
    return await fn();
  } finally {
    release?.();
  }
}

/** Wrap a `ctx.ui.confirm`-style function so each ask shows as blocked in Herdr. */
export function blockedConfirm(events: EventBus | undefined, confirm: (title: string, msg: string) => Promise<boolean>): (title: string, msg: string) => Promise<boolean> {
  return (title, msg) => withBlocked(events, title, () => confirm(title, msg));
}

export interface ShimOptions {
  env?: Record<string, string | undefined>;
  agentDir?: string;
  /** Runtime config gate (`herdr.blockedShim`), asked when a source opens. */
  enabled?: () => boolean;
}

/**
 * Install the tracker on `pi`. A no-op tracker (nothing subscribed, nothing emitted) when HERDR_ENV !== "1"
 * or the installed Herdr integration is >= HERDR_NATIVE_PROMPT_VERSION (header read once, here).
 */
export function installBlockedShim(pi: Pick<ExtensionAPI, "on" | "events">, opts: ShimOptions = {}): BlockedTracker {
  const env = opts.env ?? process.env;
  const events = pi.events as EventBus | undefined;
  const agentDir = opts.agentDir ?? piAgentDir(env, os.homedir());
  const live = env.HERDR_ENV === "1" && !!events && herdrIntegrationVersion(agentDir) < HERDR_NATIVE_PROMPT_VERSION;
  const tracker = new BlockedTracker(live ? events : undefined, live ? opts.enabled : () => false);
  // Registered even when Herdr is off, so `withBlocked` still reaches the `onOwn` hooks.
  if (events) trackers.set(events, tracker);
  if (!live || !events) return tracker;
  pi.on("ui_prompt_start", async (e) => {
    const title = str(e.title);
    tracker.add("ui", title || e.kind, title ? "title" : "kind");
  });
  pi.on("ui_prompt_end", async () => tracker.remove("ui"));
  // Pi 1.1 can orphan a dialog (a second one opened while the first is up replaces it without settling it), so its
  // ui_prompt_end never comes. Typed input proves no dialog holds the editor: release a stale "ui" source then.
  pi.on("input", async (e) => {
    if ((e as { source?: unknown }).source === "interactive") tracker.remove("ui");
  });
  events.on(PERMISSIONS_UI_PROMPT, (data) => {
    const id = (data as { requestId?: unknown } | undefined)?.requestId;
    if (typeof id === "string") tracker.add(`perm:${id}`, permissionLabel(data), "perm");
  });
  // A decision for an unseen requestId clears nothing (remove of an unknown source is a no-op).
  events.on(PERMISSIONS_DECISION, (data) => {
    const id = (data as { requestId?: unknown } | undefined)?.requestId;
    if (typeof id === "string") tracker.remove(`perm:${id}`);
  });
  // agent_end: a permission prompt released without a decision, or an own ask cut short, must not leave Herdr
  // blocked. An open Pi dialog is kept: it can outlive a turn (a command's dialog, or one an extension opens
  // from its own agent_end handler) and Pi always sends its ui_prompt_end, which then releases it.
  pi.on("agent_end", async () => tracker.clear({ keepUi: true }));
  pi.on("session_shutdown", async () => tracker.clear());
  return tracker;
}
