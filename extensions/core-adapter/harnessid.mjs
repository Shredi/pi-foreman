// Which pi-foreman code a session runs, and which running sessions run older code than the installed one. Shared by the adapter (the live file's
// `harness` stamp), setup.mjs (the list at the end of `foreman setup`) and, as a Python twin, scripts/foreman_update_check.py. Plain JS with
// `node:*` imports only, so setup.mjs can import it.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** A live file whose heartbeat is older than this is a dead or frozen session (three 30 s heartbeats). */
const DEAD_MS = 90_000;

/** `{version, commit}` of the package at `pkgRoot`: the package.json version and the checkout's HEAD (null when unreadable). Never throws. */
export function harnessId(pkgRoot) {
  let version = null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version;
    if (typeof v === "string" && v) version = v;
  } catch {
    // no package.json: version unknown
  }
  let commit = null;
  try {
    const r = spawnSync("git", ["-C", pkgRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    const c = r.status === 0 ? r.stdout.trim() : "";
    if (/^[0-9a-f]{7,64}$/.test(c)) commit = c;
  } catch {
    // no git: commit unknown
  }
  return { version, commit };
}

const same = (a, b) => !!a && typeof a === "object" && a.version === b.version && a.commit === b.commit;

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
};

/** The restart line of a session: an opened child has the restart command, any other session is quit and resumed by id. */
export function restartLine(rec) {
  if (rec.label && rec.parentIntercom) return `foreman session restart ${rec.label}`;
  return `quit it (/quit), then in ${rec.cwd}: pi --session ${rec.sessionId}`;
}

/**
 * The running sessions (live file with a fresh heartbeat and a pid that lives) whose `harness` stamp differs from `current` or is missing,
 * each `{sessionId, label, cwd, pid, restart}`; the file of this very process is skipped. Never throws.
 */
export function olderSessions(agentDir, current, { now = Date.now(), alive = pidAlive, self = process.pid } = {}) {
  const dir = path.join(agentDir, "pi-foreman", "state", "live");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.sort()) {
    let f;
    try {
      f = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
    } catch {
      continue;
    }
    if (!f || typeof f !== "object" || typeof f.sessionId !== "string" || !Number.isInteger(f.pid) || f.pid === self) continue;
    const beat = typeof f.heartbeatAt === "string" ? Date.parse(f.heartbeatAt) : NaN;
    if (!Number.isFinite(beat) || now - beat > DEAD_MS || f.state === "done" || !alive(f.pid)) continue;
    if (same(f.harness, current)) continue;
    const rec = { sessionId: f.sessionId, label: typeof f.label === "string" ? f.label : null, cwd: typeof f.cwd === "string" ? f.cwd : "", pid: f.pid, parentIntercom: typeof f.parentIntercom === "string" ? f.parentIntercom : null };
    out.push({ sessionId: rec.sessionId, label: rec.label, cwd: rec.cwd, pid: rec.pid, restart: restartLine(rec) });
  }
  return out;
}

/** The lines `foreman setup` prints after an update: empty when nothing runs older code. */
export function olderSessionsLines(sessions) {
  if (sessions.length === 0) return [];
  return [
    `${sessions.length} running session${sessions.length === 1 ? "" : "s"} still run${sessions.length === 1 ? "s" : ""} older pi-foreman code (an update does not reach a running session); restart ${sessions.length === 1 ? "it" : "each"}:`,
    ...sessions.map((s) => `  ${s.label ?? s.sessionId}: ${s.restart}`),
  ];
}
