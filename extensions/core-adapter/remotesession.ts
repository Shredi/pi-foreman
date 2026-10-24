// Inbound notices of a remote child session (round 40): `foreman session open --machine NAME` children report with
// `foreman session remote notice`, which sends pi-intercom's `send --to <uuid>@<machine>`; pi-intercom relays it with a
// structured `crossMachine` origin. This module is pure matching and mirroring, no authentication: the broker checks
// only the shape of `crossMachine`, so a notice is data (a registry update and a mirror file), never acted on.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Registry, SessionEntry } from "./session.ts";

export const UNVERIFIED_PREFIX = "[Unverified cross-machine origin]\n";
const MIRRORED = new Set(["plan.md", "result.md", "ask.md"]);

export interface RemoteOrigin {
  machine: string;
  sessionId: string;
}

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The structured origin of a relayed message (`details.message.crossMachine`); null without it (a hard stop, never parsed from text). */
export function remoteOrigin(details: unknown): RemoteOrigin | null {
  const m = (details as { message?: { crossMachine?: unknown } } | null | undefined)?.message;
  const x = m && typeof m === "object" ? (m.crossMachine as Record<string, unknown> | null | undefined) : undefined;
  if (!x || typeof x !== "object" || x.type !== "ssh-relay" || x.version !== 1 || x.trust !== "ssh-asserted") return null;
  const o = x.origin as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== "object" || !str(o.machine) || !str(o.sessionId)) return null;
  return { machine: o.machine, sessionId: o.sessionId };
}

export type RemoteNotice =
  | { kind: "plan" | "result" | "update" | "ask"; label: string; path: string; sha256: string; bytes: number; truncated: boolean; content: string }
  | { kind: "closed"; path?: string; close?: string };

/** The notice contract of `remote notice` (scripts/foreman_session.py): `<Kind> from <label>: <path> sha256:<hex> bytes:<n>[ truncated]`, `---`, content; or `foreman:closed [path] [CLOSE: ready|open]`. */
export function parseRemoteNotice(text: unknown): RemoteNotice | null {
  if (typeof text !== "string") return null;
  const t = text.startsWith(UNVERIFIED_PREFIX) ? text.slice(UNVERIFIED_PREFIX.length) : text;
  const nl = t.indexOf("\n");
  const head = (nl < 0 ? t : t.slice(0, nl)).replace(/\r$/, "");
  const h = /^(Plan|Result|Update|Ask) from (\S+): (\S.*?) sha256:([0-9a-f]{64}) bytes:(\d+)( truncated)?$/.exec(head);
  if (h) {
    const rest = nl < 0 ? "" : t.slice(nl + 1);
    if (!/^---(\r?\n|$)/.test(rest)) return null;
    const content = rest.replace(/^---\r?\n?/, "");
    return { kind: h[1].toLowerCase() as "plan" | "result" | "update" | "ask", label: h[2], path: h[3], sha256: h[4], bytes: Number(h[5]), truncated: !!h[6], content };
  }
  if (nl >= 0 && t.slice(nl).trim() !== "") return null; // the closed notice has no body
  const c = /^foreman:closed(?: (?!CLOSE: )(\S.*?))?(?: CLOSE: (ready|open))?$/.exec(head.trim());
  if (!c) return null;
  return { kind: "closed", ...(c[1] ? { path: c[1] } : {}), ...(c[2] ? { close: c[2] } : {}) };
}

export interface RemoteApplied {
  entry: SessionEntry;
  kind: string;
  /** The mirror path (empty for a closed notice without a mirrored result). */
  path: string;
  /** A one-line note for the owner (truncated, ignored, mismatch). */
  message?: string;
  /** Registry changed. */
  changed: boolean;
}

const norm = (p: string, ci: boolean): string => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return ci ? s.toLowerCase() : s;
};

/** Atomic file write (temp file in the same dir, then rename). */
export function writeMirror(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Apply a notice from a cross-machine sender to the registry entry it matches: `machine` set, `originMachine` equal to
 * the origin machine (case-insensitive), `child` equal to the origin session id, status open, pending or closing.
 * Returns null when nothing matches (silently ignored); a result with `changed: false` and a `message` is shown only.
 */
export function applyRemoteNotice(reg: Registry, origin: RemoteOrigin, notice: RemoteNotice, write: (file: string, data: string) => void = writeMirror, now: Date = new Date()): RemoteApplied | null {
  const entry = [...reg.sessions].reverse().find(
    (s) =>
      typeof s.machine === "string" &&
      typeof s.originMachine === "string" &&
      s.originMachine.toLowerCase() === origin.machine.toLowerCase() &&
      s.child === origin.sessionId &&
      (s.status === "open" || s.status === "pending" || s.status === "closing"),
  );
  if (!entry) return null;
  const at = now.toISOString();
  const mirror = typeof entry.mirror === "string" && entry.mirror ? entry.mirror : "";
  const who = `${entry.label}@${entry.machine as string}`;
  if (notice.kind === "closed") {
    // origin check only; the remote-supplied path is never stored or shown
    const result = mirror ? [path.join(mirror, "result.md"), path.join(mirror, "result.md.partial")].find((p) => fs.existsSync(p)) : undefined;
    entry.status = "closed";
    entry.last = { kind: "closed", ...(result ? { path: result } : {}), at };
    if (result) entry.result = result;
    return { entry, kind: "closed", path: result ?? "", changed: true };
  }
  const win = (entry.remote as { platform?: unknown } | undefined)?.platform === "win32";
  const sep = Math.max(notice.path.lastIndexOf("/"), notice.path.lastIndexOf("\\"));
  const base = notice.path.slice(sep + 1);
  const dir = sep >= 0 ? notice.path.slice(0, sep) : "";
  if (!MIRRORED.has(base) || !mirror || typeof entry.remoteHandoff !== "string" || norm(dir, win) !== norm(entry.remoteHandoff, win)) {
    return { entry, kind: notice.kind, path: "", message: `remote notice from ${who}: ${notice.kind} ignored (its path is not a file of the remote handoff dir)`, changed: false };
  }
  if (!notice.truncated) {
    const bytes = Buffer.from(notice.content, "utf8");
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (hash !== notice.sha256 || bytes.length !== notice.bytes) {
      return { entry, kind: notice.kind, path: "", message: `remote notice from ${who}: hash mismatch, not mirrored`, changed: false };
    }
  }
  const file = path.join(mirror, notice.truncated ? `${base}.partial` : base);
  try {
    write(file, notice.content);
  } catch (err) {
    return { entry, kind: notice.kind, path: "", message: `remote notice from ${who}: could not mirror (${(err as Error).message})`, changed: false };
  }
  entry.last = { kind: notice.kind, path: file, at };
  if (notice.kind === "result" || notice.kind === "update") entry.result = file;
  entry.status = "open";
  return { entry, kind: notice.kind, path: file, ...(notice.truncated ? { message: `remote notice from ${who}: ${notice.kind} truncated (${notice.bytes} bytes remote), partial copy mirrored` } : {}), changed: true };
}
