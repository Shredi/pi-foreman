// foreman_wait across a restart (docs/sessions.md): the active waits are written to a custom session entry on every change; at
// session_start of the same Pi session id a non-empty stored set means those waits died with the old process, so the agent gets
// ONE visible notice naming them (no reattach: a pid cannot be reattached safely). The entry carries the Pi session id (a fork or a
// copied session file has another id and is ignored, as identity.ts). Pressure waits are not stored (the sampler re-arms them).
import { WAKE_MESSAGE_TYPE } from "./usage.ts";

export const WAITS_ENTRY = "pi-foreman-waits";

export interface WaitDescriptor {
  id: string;
  kind: string;
  note: string;
  /** Set on a wait that resolved but whose wake was not delivered yet: its outcome line (absent on older entries = still unresolved). */
  outcome?: string;
}
export interface WaitsEntry {
  v: 1;
  piSessionId: string;
  waits: WaitDescriptor[];
}
export type WaitsRestore = { status: "none" } | { status: "other_session" } | { status: "malformed" } | { status: "ok"; waits: WaitDescriptor[] };

const str = (v: unknown): v is string => typeof v === "string";

export function waitsEntry(piSessionId: string, active: { id: string; kind: string; note: string; outcome?: string }[]): WaitsEntry {
  return { v: 1, piSessionId, waits: active.filter((w) => w.kind !== "pressure").map((w) => ({ id: w.id, kind: w.kind, note: w.note, ...(w.outcome !== undefined ? { outcome: w.outcome } : {}) })) };
}

/** The latest `pi-foreman-waits` entry of the branch for this Pi session id. Pure. */
export function latestWaits(entries: unknown[], piSessionId: string): WaitsRestore {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (!e || e.type !== "custom" || e.customType !== WAITS_ENTRY) continue;
    const d = e.data as Record<string, unknown> | null | undefined;
    if (!d || typeof d !== "object" || d.v !== 1 || !str(d.piSessionId) || !d.piSessionId) return { status: "malformed" };
    if (d.piSessionId !== piSessionId) return { status: "other_session" };
    if (!Array.isArray(d.waits)) return { status: "malformed" };
    const waits: WaitDescriptor[] = [];
    for (const w of d.waits as Record<string, unknown>[]) {
      if (!w || !str(w.id) || !str(w.kind)) return { status: "malformed" };
      waits.push({ id: w.id, kind: w.kind, note: str(w.note) ? w.note : "", ...(str(w.outcome) ? { outcome: w.outcome } : {}) });
    }
    return { status: "ok", waits };
  }
  return { status: "none" };
}

/** The one notice for the waits a restart lost, or null when there is nothing to say. */
export function lostWaitsMessage(r: WaitsRestore): { customType: string; content: string; display: true; details: { lost: string[]; undelivered?: string[] } } | null {
  if (r.status === "none" || r.status === "other_session") return null;
  if (r.status === "malformed") return { customType: WAKE_MESSAGE_TYPE, content: "foreman_wait lost on restart: the stored wait state is unreadable; start any wait you still need again.", display: true, details: { lost: [] } };
  if (r.waits.length === 0) return null;
  const line = (w: WaitDescriptor): string => `- ${w.id} (${w.kind})${w.note ? ` "${w.note.replace(/\s+/g, " ").slice(0, 120)}"` : ""}`;
  const lost = r.waits.filter((w) => w.outcome === undefined);
  const done = r.waits.filter((w) => w.outcome !== undefined);
  const out: string[] = [];
  if (lost.length) out.push(`foreman_wait lost on restart: ${lost.length} wait${lost.length === 1 ? "" : "s"} died with the old process and will not wake you; start again what you still need (foreman_wait / bg_run).`, ...lost.map(line));
  if (done.length) out.push(`foreman_wait finished before the restart, result not delivered: ${done.length} wait${done.length === 1 ? "" : "s"}.`, ...done.map((w) => `${line(w)}: ${w.outcome!.replace(/\s+/g, " ").slice(0, 300)}`));
  return { customType: WAKE_MESSAGE_TYPE, content: out.join("\n"), display: true, details: { lost: lost.map((w) => w.id), undelivered: done.map((w) => w.id) } };
}
