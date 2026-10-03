// The core's per-session marker `<tmp>/fable-orch-model-<sid>.json` (core 0.22.0).
// pi-foreman writes it at session_start because the core's injector is not used; see
// .workflow/scratch/adapter-marker.md for why the minimal marker is not enough.
import * as fs from "node:fs";
import * as path from "node:path";

/** Same filter as the core: keep alphanumerics, `-` and `_` (Pi session ids are ASCII). */
export function safeSessionId(sessionId: string): string {
  return Array.from(sessionId).filter((c) => /[A-Za-z0-9_-]/.test(c)).join("");
}

export function markerPath(dir: string, sessionId: string): string {
  return path.join(dir, `fable-orch-model-${safeSessionId(sessionId)}.json`);
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp.json`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Create the marker if missing, keeping an existing one (and its immutable `started`)
 * untouched, like the core injector on resume. A corrupt marker is rewritten with its
 * mtime as `started` (never "now", which would disown ledgers touched earlier).
 */
export function ensureSessionMarker(dir: string, sessionId: string, nowSeconds: number): { path: string; created: boolean } {
  fs.mkdirSync(dir, { recursive: true });
  const file = markerPath(dir, sessionId);
  if (fs.existsSync(file)) {
    try {
      const data = readJson(file);
      if (data && typeof data === "object" && !Array.isArray(data)) return { path: file, created: false };
    } catch {
      // fall through: rewrite
    }
    const started = fs.statSync(file).mtimeMs / 1000;
    writeAtomic(file, { session_id: sessionId, started: Math.round(started * 1000) / 1000 });
    return { path: file, created: true };
  }
  writeAtomic(file, { session_id: sessionId, started: Math.round(nowSeconds * 1000) / 1000 });
  return { path: file, created: true };
}

/** The ledger path this session is bound to, if the marker names one that still exists. */
export function boundLedger(dir: string, sessionId: string): string | null {
  try {
    const data = readJson(markerPath(dir, sessionId)) as Record<string, unknown>;
    const ledger = data?.ledger;
    if (typeof ledger === "string" && ledger && fs.existsSync(ledger)) return ledger;
  } catch {
    // no marker / unreadable
  }
  return null;
}

/** The core's live-ledger name filter: `ledger[-._]*.md`, not `*-archive.md`/`*_archive.md`. */
export function isLiveLedgerName(name: string): boolean {
  const low = name.toLowerCase();
  if (!(low.startsWith("ledger") && low.endsWith(".md"))) return false;
  if (![".", "-", "_"].includes(low.slice(6, 7))) return false;
  return !(low.endsWith("-archive.md") || low.endsWith("_archive.md"));
}

/** True when an absolute path names a live ledger directly inside a `.workflow` directory. */
export function isLedgerTarget(absPath: string): boolean {
  if (!isLiveLedgerName(path.basename(absPath))) return false;
  if (path.basename(path.dirname(absPath)).toLowerCase() === ".workflow") return true;
  try {
    const real = fs.realpathSync(absPath);
    return path.basename(path.dirname(real)).toLowerCase() === ".workflow";
  } catch {
    return false;
  }
}
