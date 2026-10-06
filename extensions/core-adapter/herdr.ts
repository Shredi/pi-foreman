// Herdr "blocked" state (Phase 4 smoke): Herdr's Pi integration listens on `pi.events`
// `herdr:blocked {active, label}` (counter based) and otherwise shows `working` while a UI ask is open.
// pi-foreman's own asks are wrapped in `withBlocked`; pi-permission-system's asks are mapped from its
// `permissions:ui_prompt` / `permissions:decision` broadcasts by `bridgePermissionBlocked`.
export const HERDR_BLOCKED_CHANNEL = "herdr:blocked";
export const PERMISSIONS_UI_PROMPT = "permissions:ui_prompt";
export const PERMISSIONS_DECISION = "permissions:decision";

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): (() => void) | void;
}

function signal(events: EventBus | undefined, active: boolean, label: string): void {
  try {
    events?.emit(HERDR_BLOCKED_CHANNEL, { active, label });
  } catch {
    // cosmetic
  }
}

/** Run `fn` with herdr:blocked active:true before and active:false after (also when it throws). */
export async function withBlocked<T>(events: EventBus | undefined, label: string, fn: () => Promise<T>): Promise<T> {
  signal(events, true, label);
  try {
    return await fn();
  } finally {
    signal(events, false, label);
  }
}

/** Wrap a `ctx.ui.confirm`-style function so each ask shows as blocked in Herdr. */
export function blockedConfirm(events: EventBus | undefined, confirm: (title: string, msg: string) => Promise<boolean>): (title: string, msg: string) => Promise<boolean> {
  return (title, msg) => withBlocked(events, title, () => confirm(title, msg));
}

/**
 * pi-permission-system 39.0.2 emits `permissions:ui_prompt` {requestId, surface, value, ...} right before its
 * dialog and `permissions:decision` {requestId, ...} after every gate resolution. Only requestIds seen in a
 * ui_prompt close a block, so active:true / active:false stay balanced. Returns an unsubscribe.
 */
export function bridgePermissionBlocked(events: EventBus | undefined): () => void {
  if (!events) return () => {};
  const open = new Set<string>();
  const off1 = events.on(PERMISSIONS_UI_PROMPT, (data) => {
    const d = (data ?? {}) as { requestId?: unknown; surface?: unknown };
    if (typeof d.requestId !== "string" || open.has(d.requestId)) return;
    open.add(d.requestId);
    signal(events, true, `permission: ${typeof d.surface === "string" && d.surface ? d.surface : "ask"}`);
  });
  const off2 = events.on(PERMISSIONS_DECISION, (data) => {
    const id = (data as { requestId?: unknown } | undefined)?.requestId;
    if (typeof id !== "string" || !open.delete(id)) return;
    signal(events, false, "permission");
  });
  return () => {
    if (typeof off1 === "function") off1();
    if (typeof off2 === "function") off2();
  };
}
