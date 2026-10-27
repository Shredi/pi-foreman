// Session identity that survives a restart (R46 item 1). `foreman session open` hands an opened session its identity through
// env (handoff dir, child intercom id, parent, label, model); a restarted Pi (Herdr restart, plain `pi --continue`) has none of
// it. At session_start the adapter appends one custom session entry `pi-foreman-identity` (only when a value changed) and writes
// `<handoff>/live.json`; a later start without that env restores it from the entry when every check holds:
//   (a) the entry names this Pi session id (a fork or a copied session file has another id),
//   (b) the handoff dir exists and its write-protected `child` file equals the entry's child id,
//   (c) the handoff's write-protected `live.json` names this Pi session id (an entry naming another session's handoff is refused).
// The parent id is always re-read from the handoff `parent` file. Subagent children never write or restore.
import * as fs from "node:fs";
import * as path from "node:path";
import { HANDOFF_DIR_ENV, PARENT_INTERCOM_ENV, REMOTE_PARENT_ENV } from "./close.ts";

export const IDENTITY_ENTRY = "pi-foreman-identity";
export const LIVE_FILE = "live.json";
const STABLE_ID_ENV = "PI_INTERCOM_STABLE_ID";
const PARENT_LABEL_ENV = "PI_FOREMAN_PARENT_LABEL";
const SESSION_MODEL_ENV = "PI_FOREMAN_SESSION_MODEL";

type Env = Record<string, string | undefined>;

export interface IdentityEntry {
  v: 1;
  piSessionId: string;
  child: string;
  parentLabel: string | null;
  handoff: string;
  model: string | null;
  remoteParent: string | null;
  sessionName: string | null;
}

export type IdentityRestore = { status: "none" } | { status: "restored"; entry: IdentityEntry } | { status: "skipped"; reason: string };

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The identity the env describes, or null when this is not an opened session (no handoff dir or child id). */
export function captureIdentity(env: Env, piSessionId: string, sessionName: string | undefined): IdentityEntry | null {
  const handoff = text(env[HANDOFF_DIR_ENV]);
  const child = text(env[STABLE_ID_ENV]);
  if (!handoff || !child) return null;
  return { v: 1, piSessionId, child, parentLabel: text(env[PARENT_LABEL_ENV]), handoff, model: text(env[SESSION_MODEL_ENV]), remoteParent: text(env[REMOTE_PARENT_ENV]), sessionName: text(sessionName) };
}

/** The newest identity entry of a branch, validated field by field, or null. */
export function latestIdentity(entries: unknown[]): IdentityEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
    if (!e || e.type !== "custom" || e.customType !== IDENTITY_ENTRY) continue;
    const d = e.data as Record<string, unknown> | null | undefined;
    if (!d || typeof d !== "object" || d.v !== 1) return null;
    const piSessionId = text(d.piSessionId);
    const child = text(d.child);
    const handoff = text(d.handoff);
    if (!piSessionId || !child || !handoff) return null;
    return { v: 1, piSessionId, child, parentLabel: text(d.parentLabel), handoff, model: text(d.model), remoteParent: text(d.remoteParent), sessionName: text(d.sessionName) }; // key order as captureIdentity (compared as JSON)
  }
  return null;
}

const firstLine = (file: string): string | null => {
  try {
    return text(fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0]);
  } catch {
    return null;
  }
};

/** `<handoff>/live.json`: the intercom id and Pi session id the adapter last wrote there, or null. */
export function readLive(handoff: string): { intercomId: string; piSessionId: string } | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(handoff, LIVE_FILE), "utf8")) as Record<string, unknown>;
    const intercomId = text(d.intercomId);
    const piSessionId = text(d.piSessionId);
    return intercomId && piSessionId ? { intercomId, piSessionId } : null;
  } catch {
    return null;
  }
}

/** The adapter's own write (fs, never a tool) of `<handoff>/live.json`; best effort. */
export function writeLive(handoff: string, intercomId: string, piSessionId: string, now = new Date()): void {
  try {
    const file = path.join(handoff, LIVE_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ intercomId, piSessionId, at: now.toISOString() })}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // the handoff dir is gone or not writable: a later restore finds no live.json and restores nothing
  }
}

/**
 * Restore the identity of the latest entry into `env` when this start has none (no handoff dir env) and every check of the file
 * header holds. A subagent child, or a start that already has the env, restores nothing and says nothing.
 */
export function restoreIdentity(o: { env: Env; reason: string; piSessionId: string; branch: unknown[]; setSessionName?: (name: string) => void; currentName?: string }): IdentityRestore {
  const env = o.env;
  if (env.PI_SUBAGENT_CHILD === "1" || text(env[HANDOFF_DIR_ENV])) return { status: "none" };
  const entry = latestIdentity(o.branch);
  if (!entry) return { status: "none" };
  if (o.reason === "fork") return { status: "skipped", reason: "fork" };
  if (entry.piSessionId !== o.piSessionId) return { status: "skipped", reason: "other_session" };
  if (!path.isAbsolute(entry.handoff)) return { status: "skipped", reason: "handoff_missing" };
  try {
    if (!fs.statSync(entry.handoff).isDirectory()) return { status: "skipped", reason: "handoff_missing" };
  } catch {
    return { status: "skipped", reason: "handoff_missing" };
  }
  if (firstLine(path.join(entry.handoff, "child")) !== entry.child) return { status: "skipped", reason: "child_mismatch" };
  if (readLive(entry.handoff)?.piSessionId !== o.piSessionId) return { status: "skipped", reason: "live_mismatch" };
  const parent = firstLine(path.join(entry.handoff, "parent"));
  env[HANDOFF_DIR_ENV] = entry.handoff;
  env[STABLE_ID_ENV] = entry.child;
  if (parent) env[PARENT_INTERCOM_ENV] = parent;
  if (entry.parentLabel) env[PARENT_LABEL_ENV] = entry.parentLabel;
  if (entry.model) env[SESSION_MODEL_ENV] = entry.model;
  if (entry.remoteParent) env[REMOTE_PARENT_ENV] = entry.remoteParent;
  if (entry.sessionName && !text(o.currentName)) o.setSessionName?.(entry.sessionName);
  return { status: "restored", entry };
}
